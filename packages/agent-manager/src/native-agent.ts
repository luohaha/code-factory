import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { MutableModels } from '@earendil-works/pi-ai/models';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { AssistantEntry, createRegistry, defineExtension, defineTool, Harness, section, watchEvents, type ConversationId } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { CodingTools } from '@earendil-works/pi-durable/tools';

import { runCodeFactoryCli } from './code-factory-cli.js';
import { createNativeModels, NativeCredentialStore, nativeAuthDatabasePath } from './native-auth.js';
import type { NormalizedAgentEvent } from './adapters/types.js';
import type { AgentReasoningEffort, RunOutcome } from './types.js';

const execFileAsync = promisify(execFile);
const CONTEXT = BACKGROUND_CONTEXT;
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export interface NativeRunInput {
  requirementId: string;
  sessionId: string;
  nativeSessionId: string | null;
  forkSourceNativeSessionId: string | null;
  prompt: string;
  model: string | null;
  reasoningEffort: AgentReasoningEffort | null;
  cwd: string;
  environment: Readonly<Record<string, string>>;
  instructions: string;
  signal: AbortSignal;
  timeoutMs: number;
  onEvent: (event: NormalizedAgentEvent) => void;
  onNativeSession: (id: string) => void;
}

/** One durable Pi storage shared by all native RD conversations in a workspace. */
export class NativeAgentService {
  readonly #databasePath: string;
  #harness: Harness | null = null;
  #opening: Promise<Harness> | null = null;
  readonly #models: MutableModels | null;
  #credentials: NativeCredentialStore | null = null;
  readonly #environments = new Map<ConversationId, Readonly<Record<string, string>>>();
  readonly #active = new Map<string, { submit: (message: string) => Promise<void> }>();

  constructor(databasePath: string, models?: MutableModels) {
    this.#databasePath = databasePath;
    this.#models = models ?? null;
  }

  async #open(): Promise<Harness> {
    if (this.#harness) return this.#harness;
    if (this.#opening) return this.#opening;
    this.#opening = this.#openOnce();
    try { return await this.#opening; } finally { this.#opening = null; }
  }

  async #openOnce(): Promise<Harness> {
    await mkdir(dirname(this.#databasePath), { recursive: true });
    if (!this.#models) this.#credentials = new NativeCredentialStore(nativeAuthDatabasePath(this.#databasePath));
    const models = this.#models ?? createNativeModels(this.#credentials!);
    const registry = createRegistry();
    registry.install(CodingTools);
    const invokeCli = async (args: string[], conversationId: ConversationId): Promise<string> => {
      let stdout = '';
      let stderr = '';
      const status = await runCodeFactoryCli(args, {
        environment: { ...process.env, ...this.#environments.get(conversationId) },
        writeOut: (value) => { stdout += value; },
        writeError: (value) => { stderr += value; },
        runGitHub: async (ghArgs) => (await execFileAsync('gh', ghArgs, { timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout,
      });
      if (status !== 0) throw new Error(stderr.trim() || `Code Factory command failed (${status})`);
      return stdout;
    };
    const output = (text: string) => ({ content: [{ type: 'text' as const, text }] });
    const prRegister = defineTool({ name: 'pr_register',
      description: 'Register a GitHub pull request immediately after creation, or refresh its metadata after your own push or edit. The reconciler owns lifecycle state.',
      parameters: Type.Object({ url: Type.String() }),
      execute: async ({ url }, api) => output(await invokeCli(['pr', 'register', '--from-github', url], api.conversationId)),
    });
    const ghPr = defineTool({ name: 'gh_pr',
      description: 'Run a GitHub PR command in the selected execution environment. Use view for metadata, create for a draft PR, and edit or ready for your own PR. Register afterward with pr_register.',
      parameters: Type.Object({ action: Type.Union([Type.Literal('view'), Type.Literal('create'), Type.Literal('edit'), Type.Literal('ready')]), args: Type.Array(Type.String()) }),
      outputLimits: { retain: 'tail' },
      execute: async ({ action, args }, api, context) => {
        if (!api.env) throw new Error('GitHub PR commands require an execution environment');
        const command = ['gh', 'pr', action, ...args].map(shellQuote).join(' ');
        const result = await api.env.exec(command, {
          cwd: api.env.cwd,
          timeout: 30,
          onOutput: (value) => api.output(value),
        }, context);
        if (!result.ok) throw result.error;
        if (result.value.exitCode !== 0) throw new Error(`gh pr ${action} exited with code ${result.value.exitCode}`);
        return {};
      },
    });
    const propose = defineTool({ name: 'requirement_propose',
      description: 'Propose a separately tracked TODO child requirement. Do not start it unless the human requests that.',
      parameters: Type.Object({ title: Type.String(), description: Type.String() }),
      execute: async ({ title, description }, api) => output(await invokeCli(['requirement', 'propose', '--title', title, '--description', description], api.conversationId)),
    });
    const action = defineTool({ name: 'requirement_action',
      description: 'Manage a child requirement proposed by this RD Agent.',
      parameters: Type.Object({ requirementId: Type.String(), action: Type.Union([Type.Literal('start'), Type.Literal('stop'), Type.Literal('delete'), Type.Literal('done')]) }),
      execute: async ({ requirementId, action }, api) => output(await invokeCli(['requirement', 'action', '--requirement-id', requirementId, `--${action}`], api.conversationId)),
    });
    const related = defineTool({ name: 'requirement_related', description: 'Show direct parent and child requirements and their RD session states.',
      parameters: Type.Object({}), execute: async (_args, api) => output(await invokeCli(['requirement', 'related'], api.conversationId)) });
    const message = defineTool({ name: 'requirement_message', description: 'Send a message to a direct parent or child RD Agent.',
      parameters: Type.Object({ requirementId: Type.String(), message: Type.String() }),
      execute: async ({ requirementId, message }, api) => output(await invokeCli(['requirement', 'message', '--requirement-id', requirementId, '--message', message], api.conversationId)) });
    const timerRegister = defineTool({ name: 'timer_register', description: 'Schedule one wake-up or recurring independent work.',
      parameters: Type.Object({ afterSeconds: Type.Integer({ minimum: 60 }), description: Type.String(), repeat: Type.Optional(Type.Boolean()) }),
      execute: async ({ afterSeconds, description, repeat }, api) => output(await invokeCli(['timer', 'register', '--after-seconds', String(afterSeconds), '--description', description, ...(repeat ? ['--repeat'] : [])], api.conversationId)) });
    const timerShow = defineTool({ name: 'timer_show', description: 'Show wake-up timers for this Requirement.',
      parameters: Type.Object({}), execute: async (_args, api) => output(await invokeCli(['timer', 'show'], api.conversationId)) });
    const timerCancel = defineTool({ name: 'timer_cancel', description: 'Cancel an active wake-up timer.',
      parameters: Type.Object({ id: Type.String() }), execute: async ({ id }, api) => output(await invokeCli(['timer', 'cancel', '--id', id], api.conversationId)) });
    registry.install(defineExtension({
      name: 'code-factory',
      tools: [prRegister, ghPr, propose, action, related, message, timerRegister, timerShow, timerCancel],
      sections: [section('code-factory', () => 'You are this Requirement’s long-lived RD Agent. Use the Code Factory tools to register PRs, propose TODO follow-ups, message related agents, and manage timers. Humans confirm completion.'),
        section('workspace', (input) => input.env?.cwd)],
    }));
    this.#harness = await Harness.open(await openNodeSqliteStorage(this.#databasePath), {
      models,
      registry,
      env: ({ conversationId, cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd(), shellEnv: { ...process.env, ...this.#environments.get(conversationId) } }),
    }, CONTEXT);
    return this.#harness;
  }

  async steer(requirementId: string, message: string): Promise<boolean> {
    const active = this.#active.get(requirementId);
    if (!active) return false;
    await active.submit(message);
    return true;
  }

  async run(input: NativeRunInput): Promise<RunOutcome> {
    try {
      const harness = await this.#open();
      const [provider, modelId] = input.model?.includes('/')
        ? [input.model.slice(0, input.model.indexOf('/')), input.model.slice(input.model.indexOf('/') + 1)]
        : ['openai', input.model || 'gpt-5.4'];
      if (!this.#models && provider !== 'openai' && provider !== 'anthropic' && provider !== 'openai-codex') {
        throw new TypeError('Native model must use a configured pi-ai provider');
      }
      const agent = { model: { provider, modelId }, cwd: input.cwd,
        ...(input.reasoningEffort ? { thinkingLevel: input.reasoningEffort } : {}),
        instructions: input.instructions };
      let conversation = input.nativeSessionId
        ? await harness.conversation(Number(input.nativeSessionId) as ConversationId, CONTEXT)
        : undefined;
      if (!conversation && input.forkSourceNativeSessionId) {
        const source = await harness.conversation(Number(input.forkSourceNativeSessionId) as ConversationId, CONTEXT);
        const latest = source && (await source.entries({}, 1, undefined, CONTEXT)).items[0];
        if (source && latest) conversation = await source.fork(latest.id, { ownership: { kind: 'ownerless' }, agent }, CONTEXT);
      }
      conversation ??= await harness.createConversation({ ownership: { kind: 'ownerless' }, agent }, CONTEXT);
      if (!conversation) throw new Error('Native conversation is missing');
      this.#environments.set(conversation.id, input.environment);
      if (input.nativeSessionId) await conversation.configure(agent, CONTEXT);
      else input.onNativeSession(String(conversation.id));
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      const armTimeout = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timedOut = true; void conversation.abort(CONTEXT); }, input.timeoutMs);
        timer.unref();
      };
      const stream = await watchEvents(harness, conversation.id, CONTEXT);
      stream.start(async (events) => {
        armTimeout();
        for (const event of events) {
          if (event.type === 'message_end' && AssistantEntry.is(event.entry)) {
            const assistant = event.entry.model?.[0] as AssistantMessage | undefined;
            const message = assistant?.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n') ?? '';
            if (message) input.onEvent({ kind: 'message', message,
              traces: [{ kind: 'assistant_message', status: 'completed', title: 'Agent message', detail: message }],
              raw: { type: event.type } });
          }
          if (event.type === 'tool_execution_start') input.onEvent({ kind: 'other', traces: [{ kind: 'tool_call', status: 'started', title: `Call ${event.toolName}`, toolName: event.toolName, toolCallId: event.toolCallId, detail: JSON.stringify(event.args) }], raw: { type: event.type } });
          if (event.type === 'tool_execution_end') input.onEvent({ kind: 'other', traces: [{ kind: 'tool_result', status: 'completed', title: `Result ${event.toolName}`, toolName: event.toolName, toolCallId: event.toolCallId }], raw: { type: event.type } });
        }
      });
      const onAbort = () => { void conversation.abort(CONTEXT); };
      input.signal.addEventListener('abort', onAbort, { once: true });
      if (input.signal.aborted) onAbort();
      armTimeout();
      try {
        const submission = await conversation.submit({ type: 'input', content: input.prompt }, CONTEXT);
        this.#active.set(input.requirementId, {
          submit: async (message) => { await conversation.submit({ type: 'input', content: message, whenBusy: 'steer' }, CONTEXT); },
        });
        const settled = await submission.wait(CONTEXT);
        if (timedOut) return { status: 'timed_out', exitCode: null, nativeSessionId: String(conversation.id), finalMessage: null, error: 'Native agent timed out after inactivity' };
        if (input.signal.aborted) return { status: 'cancelled', exitCode: null, nativeSessionId: String(conversation.id), finalMessage: null, error: 'Agent Run interrupted by human' };
        if (settled.status !== 'done' || settled.type !== 'input') return { status: 'failed', exitCode: null, nativeSessionId: String(conversation.id), finalMessage: null, error: 'Native submission was unanswered' };
        const answer = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), CONTEXT);
        const assistant = answer?.model?.[0] as AssistantMessage | undefined;
        const message = assistant?.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n') ?? '';
        input.onEvent({ kind: 'completed', nativeSessionId: String(conversation.id), message, raw: { type: 'native.completed' } });
        return { status: 'succeeded', exitCode: 0, nativeSessionId: String(conversation.id), finalMessage: message, error: null };
      } finally {
        input.signal.removeEventListener('abort', onAbort);
        if (timer) clearTimeout(timer);
        this.#active.delete(input.requirementId);
        await stream.stop();
      }
    } catch (error) {
      return { status: 'failed', exitCode: null, nativeSessionId: input.nativeSessionId, finalMessage: null,
        error: error instanceof Error ? error.message : String(error) };
    }
  }

  async close(): Promise<void> {
    if (this.#opening) await this.#opening;
    if (this.#harness) await this.#harness.close(CONTEXT);
    this.#harness = null;
    if (this.#credentials) await this.#credentials.close();
    this.#credentials = null;
    this.#environments.clear();
  }
}
