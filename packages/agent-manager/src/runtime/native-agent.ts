import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type { Context } from '@earendil-works/chord';
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { MutableModels } from '@earendil-works/pi-ai/models';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { AssistantEntry, createRegistry, defineExtension, defineTool, Harness, section, watchEvents, type ConversationId } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { CodingTools, createBashTool, createReadTool } from '@earendil-works/pi-durable/tools';

import { runCodeFactoryCli } from '../cli/code-factory-cli.js';
import { configureNativeProfile, createNativeModels, NativeCredentialStore, NativeProfileStore,
  nativeAuthDatabasePath, profileIdFromModel } from './native-auth.js';
import { DeferredExecutionEnv } from './deferred-execution-env.js';
import { E2BExecutionEnv, E2BSandboxService, type E2BCredentials, type E2BHandle } from './e2b-execution-env.js';
import { downloadE2BFile, uploadE2BFile, validateTransferPaths } from './e2b-file-transfer.js';
import type { NormalizedAgentEvent } from './adapters/types.js';
import type { AgentReasoningEffort, RunOutcome, Sandbox } from '../core/types.js';

const execFileAsync = promisify(execFile);
const CONTEXT = BACKGROUND_CONTEXT;
const CodeFactoryExtension = defineExtension({ name: 'code-factory' });
const E2BSandboxExtension = defineExtension({ name: 'e2b-sandbox' });

export type NativeSandboxAction = 'status' | 'pause' | 'resume';
export type NativeSandboxState = Pick<Sandbox, 'id' | 'name' | 'kind' | 'providerSandboxId' | 'status' | 'checkedAt'>;

export interface NativeRunInput {
  role?: 'rd' | 'reviewer';
  requirementId: string;
  sessionId: string;
  nativeSessionId: string | null;
  prompt: string;
  model: string | null;
  reasoningEffort: AgentReasoningEffort | null;
  cwd: string;
  sandbox?: { kind: 'e2b'; providerSandboxId: string; credentials: E2BCredentials;
    cwd?: string | null; forwardGitHubToken: boolean;
    control?: (action: NativeSandboxAction, signal?: AbortSignal) => Promise<NativeSandboxState> };
  environment: Readonly<Record<string, string>>;
  instructions: string;
  signal: AbortSignal;
  timeoutMs: number;
  timeoutMode?: 'inactivity' | 'elapsed';
  onEvent: (event: NormalizedAgentEvent) => void;
  onNativeSession: (id: string) => void;
}

/** One durable Pi storage shared by all native RD conversations in a workspace. */
export class NativeAgentService {
  readonly #databasePath: string;
  #harness: Harness | null = null;
  #opening: Promise<Harness> | null = null;
  readonly #models: MutableModels | null;
  #runtimeModels: MutableModels | null = null;
  #credentials: NativeCredentialStore | null = null;
  #profiles: NativeProfileStore | null = null;
  readonly #e2b: E2BSandboxService;
  readonly #environments = new Map<ConversationId, Readonly<Record<string, string>>>();
  readonly #signals = new Map<ConversationId, AbortSignal>();
  readonly #sandboxes = new Map<ConversationId, NonNullable<NativeRunInput['sandbox']> & { signal: AbortSignal }>();
  readonly #sandboxEnvs = new Map<ConversationId, DeferredExecutionEnv>();
  readonly #sandboxHandles = new Map<ConversationId, Promise<E2BHandle>>();
  readonly #active = new Map<string, { submit: (message: string) => Promise<boolean> }>();

  constructor(databasePath: string, models?: MutableModels, e2b?: E2BSandboxService) {
    this.#databasePath = databasePath;
    this.#models = models ?? null;
    this.#e2b = e2b ?? new E2BSandboxService();
  }

  async #sandboxHandle(conversationId: ConversationId, context: Context): Promise<E2BHandle> {
    const sandbox = this.#sandboxes.get(conversationId);
    if (!sandbox) throw new Error('This tool requires a selected E2B workspace');
    context.abortSignal?.throwIfAborted();
    let pending = this.#sandboxHandles.get(conversationId);
    if (!pending) {
      pending = this.#e2b.connect(sandbox.providerSandboxId, sandbox.credentials, context.abortSignal);
      this.#sandboxHandles.set(conversationId, pending);
    }
    try {
      const handle = await awaitWithContext(pending, context);
      context.abortSignal?.throwIfAborted();
      return handle;
    } catch (error) {
      if (this.#sandboxHandles.get(conversationId) === pending) this.#sandboxHandles.delete(conversationId);
      throw error;
    }
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
    this.#runtimeModels = models;
    this.#profiles = new NativeProfileStore(nativeAuthDatabasePath(this.#databasePath));
    const registry = createRegistry();
    registry.install(CodingTools);
    const invokeCli = async (args: string[], conversationId: ConversationId, signal?: AbortSignal): Promise<string> => {
      let stdout = '';
      let stderr = '';
      const status = await runCodeFactoryCli(args, {
        environment: { ...process.env, ...this.#environments.get(conversationId) },
        ...(signal ? { requestAbortSignal: signal } : {}),
        writeOut: (value) => { stdout += value; },
        writeError: (value) => { stderr += value; },
        runGitHub: async (ghArgs) => (await execFileAsync('gh', ghArgs, { timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout,
      });
      if (status !== 0) throw new Error(stderr.trim() || `Code Factory command failed (${status})`);
      return stdout;
    };
    const output = (text: string) => ({ content: [{ type: 'text' as const, text }] });
    const artifactPublish = defineTool({ name: 'artifact_publish',
      description: 'Explicitly publish a non-empty regular host file (at most 20 MB) as an RD conversation attachment for remote browser download. localPath is an absolute Agent Manager host path. For E2B output, sandbox_download first. Transfers bytes outside model context and returns only metadata and a relative download path. Never publish credentials or secrets.',
      parameters: Type.Object({ localPath: Type.String(), fileName: Type.Optional(Type.String()), mediaType: Type.Optional(Type.String()) }),
      execute: async ({ localPath, fileName, mediaType }, api, context) => {
        const signal = this.#signals.get(api.conversationId);
        const operation = signal ? withAbortSignal(signal, context) : context;
        return output(await invokeCli(['artifact', 'publish', '--path', localPath,
          ...(fileName === undefined ? [] : ['--name', fileName]),
          ...(mediaType === undefined ? [] : ['--media-type', mediaType])], api.conversationId, operation.abortSignal));
      },
    });
    const prRegister = defineTool({ name: 'pr_register',
      description: 'Register a GitHub pull request immediately after creation, or refresh its metadata after your own push or edit. The reconciler owns lifecycle state.',
      parameters: Type.Object({ url: Type.String() }),
      execute: async ({ url }, api) => output(await invokeCli(['pr', 'register', '--from-github', url], api.conversationId)),
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
    const message = defineTool({ name: 'requirement_message', description: 'Send a necessary message to any other Requirement RD Agent by ID. Jev may reject an unnecessary message before delivery; unavailable checks allow normal delivery without an extra notice. Do not resend an unnecessary message without new information or action.',
      parameters: Type.Object({ requirementId: Type.String(), message: Type.String() }),
      execute: async ({ requirementId, message }, api) => output(await invokeCli(['requirement', 'message', '--requirement-id', requirementId, '--message', message], api.conversationId)) });
    const timerRegister = defineTool({ name: 'timer_register', description: 'Schedule one wake-up or recurring independent work.',
      parameters: Type.Object({ afterSeconds: Type.Integer({ minimum: 60 }), description: Type.String(), repeat: Type.Optional(Type.Boolean()) }),
      execute: async ({ afterSeconds, description, repeat }, api) => output(await invokeCli(['timer', 'register', '--after-seconds', String(afterSeconds), '--description', description, ...(repeat ? ['--repeat'] : [])], api.conversationId)) });
    const timerShow = defineTool({ name: 'timer_show', description: 'Show wake-up timers for this Requirement.',
      parameters: Type.Object({}), execute: async (_args, api) => output(await invokeCli(['timer', 'show'], api.conversationId)) });
    const timerCancel = defineTool({ name: 'timer_cancel', description: 'Cancel an active wake-up timer.',
      parameters: Type.Object({ id: Type.String() }), execute: async ({ id }, api) => output(await invokeCli(['timer', 'cancel', '--id', id], api.conversationId)) });
    const sandboxControl = async (action: NativeSandboxAction, conversationId: ConversationId, context: Context) => {
      const sandbox = this.#sandboxes.get(conversationId);
      if (!sandbox?.control) throw new Error('Sandbox lifecycle tools require a selected E2B RD workspace');
      const operation = withAbortSignal(sandbox.signal, context);
      operation.abortSignal?.throwIfAborted();
      const state = await awaitWithContext(sandbox.control(action, operation.abortSignal), operation);
      operation.abortSignal?.throwIfAborted();
      if (action === 'resume') {
        this.#sandboxHandles.delete(conversationId);
        this.#sandboxEnvs.get(conversationId)?.reset();
      }
      return output(JSON.stringify(state));
    };
    const sandboxStatus = defineTool({ name: 'sandbox_status',
      description: 'Check the selected E2B sandbox status without resuming it. Returns observed status and check time.',
      parameters: Type.Object({}), execute: async (_args, api, context) => sandboxControl('status', api.conversationId, context) });
    const sandboxPause = defineTool({ name: 'sandbox_pause',
      description: 'Pause the selected E2B sandbox when remote work is finished or waiting. Preserves files and memory; the agent and host tools keep running. Rejected while another RD or Reviewer Run uses it. Finish remote operations before pausing; later file or command tools may auto-resume it.',
      parameters: Type.Object({}), execute: async (_args, api, context) => sandboxControl('pause', api.conversationId, context) });
    const sandboxResume = defineTool({ name: 'sandbox_resume',
      description: 'Resume the selected E2B sandbox before using its files or commands again.',
      parameters: Type.Object({}), execute: async (_args, api, context) => sandboxControl('resume', api.conversationId, context) });
    const transfer = async (direction: 'upload' | 'download', localPath: string, remotePath: string,
      overwrite: boolean, conversationId: ConversationId, env: ExecutionEnv | undefined,
      context: Context) => {
      const sandbox = this.#sandboxes.get(conversationId);
      if (!sandbox || !env) throw new Error('File transfer requires a selected E2B workspace');
      const operation = withAbortSignal(sandbox.signal, context);
      const signal = operation.abortSignal;
      validateTransferPaths(localPath, remotePath);
      try {
        signal?.throwIfAborted();
        const resolved = await env.absolutePath(remotePath, operation);
        if (!resolved.ok) throw resolved.error;
        const handle = await this.#sandboxHandle(conversationId, operation);
        const byteSize = direction === 'upload'
          ? await uploadE2BFile(handle, localPath, resolved.value, signal)
          : await downloadE2BFile(handle, resolved.value, localPath, overwrite, signal);
        return output(JSON.stringify({ localPath, remotePath: resolved.value, byteSize }));
      } catch (error) {
        if (signal?.aborted) throw new Error('E2B file transfer aborted');
        const exists = error instanceof Error && 'code' in error && error.code === 'EEXIST';
        throw new Error(exists ? 'Host destination already exists; choose another path or set overwrite to true'
          : `E2B file ${direction} failed; check the source file, destination path, and sandbox connection`);
      }
    };
    const sandboxUpload = defineTool({ name: 'sandbox_upload',
      description: 'Stream a host file (including a conversation attachment) to the selected E2B sandbox. localPath is an absolute host path; remotePath is absolute or relative to the sandbox working directory. Creates remote parent directories and overwrites an existing remote file. Returns paths and byte count, never file contents.',
      parameters: Type.Object({ localPath: Type.String(), remotePath: Type.String() }),
      execute: async ({ localPath, remotePath }, api, context) => transfer('upload', localPath, remotePath, false, api.conversationId, api.env, context) });
    const sandboxDownload = defineTool({ name: 'sandbox_download',
      description: 'Stream a file from the selected E2B sandbox to an absolute host localPath. remotePath is absolute or relative to the sandbox working directory. Creates host parent directories. Existing host files are preserved unless overwrite is true. Returns paths and byte count for use in the reply, never file contents.',
      parameters: Type.Object({ remotePath: Type.String(), localPath: Type.String(), overwrite: Type.Optional(Type.Boolean()) }),
      execute: async ({ localPath, remotePath, overwrite }, api, context) => transfer('download', localPath, remotePath, overwrite ?? false, api.conversationId, api.env, context) });
    registry.install(defineExtension({
      ...CodeFactoryExtension,
      tools: [artifactPublish, prRegister, propose, action, related, message, timerRegister, timerShow, timerCancel],
      sections: [section('code-factory', () => 'You are this Requirement’s long-lived RD Agent. Use bash to run GitHub CLI commands. Use the Code Factory tools to publish artifacts for browser download, register PRs, propose TODO follow-ups, message other Requirement agents by ID, and manage timers. Humans confirm completion.'),
        section('workspace', (input) => input.env?.cwd)],
    }));
    registry.install(defineExtension({
      ...E2BSandboxExtension,
      tools: [sandboxStatus, sandboxPause, sandboxResume, sandboxUpload, sandboxDownload],
      sections: [section('e2b-sandbox', (input) => `Selected E2B workspace: ${input.env?.cwd || 'SDK default user directory'}. Use sandbox_upload for host attachment paths; read/write/bash operate remotely.`)],
    }));
    this.#harness = await Harness.open(await openNodeSqliteStorage(this.#databasePath), {
      models,
      registry,
      settings: { extensions: [CodingTools, CodeFactoryExtension] },
      env: async ({ conversationId, cwd }) => {
        const sandbox = this.#sandboxes.get(conversationId);
        if (sandbox) {
          let env = this.#sandboxEnvs.get(conversationId);
          if (!env) {
            const directory = sandbox.cwd === undefined ? cwd ?? process.cwd() : sandbox.cwd;
            env = new DeferredExecutionEnv(`e2b:${sandbox.credentials.domain}:${sandbox.providerSandboxId}`, directory ?? '', async (context) => {
              const operation = withAbortSignal(sandbox.signal, context);
              const handle = await this.#sandboxHandle(conversationId, operation);
              const commandEnv = Object.fromEntries((sandbox.forwardGitHubToken ? ['GH_TOKEN', 'GITHUB_TOKEN'] : [])
                .flatMap((name) => process.env[name] ? [[name, process.env[name]!]] : []));
              return E2BExecutionEnv.create(handle, directory, commandEnv, sandbox.credentials.domain, operation.abortSignal);
            });
            this.#sandboxEnvs.set(conversationId, env);
          }
          return env;
        }
        return new NodeExecutionEnv({ cwd: cwd ?? process.cwd(), shellEnv: { ...process.env, ...this.#environments.get(conversationId) } });
      },
    }, CONTEXT);
    return this.#harness;
  }

  async steer(requirementId: string, message: string): Promise<boolean> {
    const active = this.#active.get(requirementId);
    if (!active) return false;
    return active.submit(message);
  }

  async run(input: NativeRunInput): Promise<RunOutcome> {
    const reviewer = input.role === 'reviewer';
    type SteerSubmit = (message: string) => Promise<void>;
    let resolveReady!: (submit: SteerSubmit | null) => void;
    const ready = new Promise<SteerSubmit | null>((resolve) => { resolveReady = resolve; });
    let acceptingSteers = true;
    let steering = Promise.resolve();
    if (!reviewer) this.#active.set(input.requirementId, {
      submit: (message) => {
        const admitted = steering.then(async () => {
          const submit = await ready;
          if (!acceptingSteers || input.signal.aborted || !submit) return false;
          await submit(message);
          return true;
        });
        steering = admitted.then(() => undefined, () => undefined);
        return admitted;
      },
    });
    let activeConversationId: ConversationId | undefined;
    try {
      const harness = await this.#open();
      const profileId = profileIdFromModel(input.model);
      const [legacyProvider, legacyModelId] = input.model?.includes('/')
        ? [input.model.slice(0, input.model.indexOf('/')), input.model.slice(input.model.indexOf('/') + 1)]
        : ['openai', input.model || 'gpt-5.4'];
      const savedProfile = profileId ? this.#profiles!.get(profileId) : null;
      if (profileId && !savedProfile) throw new Error('Selected Native API profile no longer exists');
      const profile = savedProfile;
      const modelId = profile?.modelName ?? legacyModelId;
      if (profile) configureNativeProfile(this.#runtimeModels!, { ...profile, modelName: modelId });
      const provider = profile ? `profile:${profile.id}` : legacyProvider;
      if (!this.#models && provider !== 'openai' && provider !== 'anthropic' && !profile) {
        throw new TypeError('Native model must use a configured pi-ai provider');
      }
      const agent = { model: { provider, modelId }, cwd: input.cwd,
        ...(input.reasoningEffort ? { thinkingLevel: input.reasoningEffort } : {}),
        extensions: reviewer ? [CodingTools]
          : [CodingTools, CodeFactoryExtension, ...(input.sandbox ? [E2BSandboxExtension] : [])],
        tools: reviewer ? [createReadTool(), createBashTool()] : null,
        instructions: input.instructions };
      let conversation = input.nativeSessionId
        ? await harness.conversation(Number(input.nativeSessionId) as ConversationId, CONTEXT)
        : undefined;
      conversation ??= await harness.createConversation({ ownership: { kind: 'ownerless' }, agent }, CONTEXT);
      if (!conversation) throw new Error('Native conversation is missing');
      activeConversationId = conversation.id;
      this.#environments.set(conversation.id, input.environment);
      this.#signals.set(conversation.id, input.signal);
      if (input.sandbox) this.#sandboxes.set(conversation.id, { ...input.sandbox, signal: input.signal });
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
        if (input.timeoutMode !== 'elapsed') armTimeout();
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
      let submissionStarted = false;
      const onAbort = () => { if (submissionStarted) void conversation.abort(CONTEXT); };
      input.signal.addEventListener('abort', onAbort, { once: true });
      armTimeout();
      try {
        if (input.signal.aborted) return { status: 'cancelled', exitCode: null, nativeSessionId: String(conversation.id), finalMessage: null, error: 'Agent Run interrupted by human' };
        if (timedOut) return { status: 'timed_out', exitCode: null, nativeSessionId: String(conversation.id), finalMessage: null,
          error: input.timeoutMode === 'elapsed' ? 'Native agent timed out after elapsed time' : 'Native agent timed out after inactivity' };
        submissionStarted = true;
        const submission = await conversation.submit({ type: 'input', content: input.prompt }, CONTEXT);
        const steeredSubmissions: Array<typeof submission> = [];
        if (input.signal.aborted || timedOut) {
          await conversation.abort(CONTEXT);
          resolveReady(null);
        } else {
          resolveReady(async (message) => {
            const steered = await conversation.submit({ type: 'input', content: message, whenBusy: 'steer' }, CONTEXT);
            steeredSubmissions.push(steered);
            if (input.signal.aborted || timedOut) await conversation.abort(CONTEXT);
          });
        }
        await steering;
        let settled = await submission.wait(CONTEXT);
        acceptingSteers = false;
        await steering;
        for (const steered of steeredSubmissions) settled = await steered.wait(CONTEXT);
        if (timedOut) return { status: 'timed_out', exitCode: null, nativeSessionId: String(conversation.id), finalMessage: null,
          error: input.timeoutMode === 'elapsed' ? 'Native agent timed out after elapsed time' : 'Native agent timed out after inactivity' };
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
        await stream.stop();
      }
    } catch (error) {
      return { status: input.signal.aborted ? 'cancelled' : 'failed', exitCode: null, nativeSessionId: input.nativeSessionId, finalMessage: null,
        error: error instanceof Error ? error.message : String(error) };
    } finally {
      acceptingSteers = false;
      resolveReady(null);
      if (!reviewer) this.#active.delete(input.requirementId);
      if (activeConversationId !== undefined) {
        this.#environments.delete(activeConversationId);
        this.#signals.delete(activeConversationId);
        this.#sandboxes.delete(activeConversationId);
        this.#sandboxEnvs.delete(activeConversationId);
        this.#sandboxHandles.delete(activeConversationId);
      }
    }
  }

  async close(): Promise<void> {
    if (this.#opening) await this.#opening;
    if (this.#harness) await this.#harness.close(CONTEXT);
    this.#harness = null;
    this.#profiles?.close();
    this.#profiles = null;
    if (this.#credentials) await this.#credentials.close();
    this.#credentials = null;
    this.#environments.clear();
    this.#signals.clear();
    this.#sandboxes.clear();
    this.#sandboxEnvs.clear();
    this.#sandboxHandles.clear();
  }
}
