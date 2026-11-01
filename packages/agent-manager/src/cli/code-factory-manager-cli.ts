import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { AgentTimer, PullRequest, RequirementMessage, RequirementWithSession, ReviewRequest } from '../core/types.js';

export interface ManagerCliRuntime {
  environment: Readonly<Record<string, string | undefined>>;
  fetch: typeof globalThis.fetch;
  now: () => number;
  readTextFile: (path: string) => Promise<string>;
  requestTimeoutMs: number;
  writeOut: (value: string) => void;
  writeError: (value: string) => void;
}

type Options = ReturnType<typeof parseArgs>['values'];
type Collection<T> = { items: T[] };

const GLOBAL_OPTIONS = {
  'api-url': { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;
const stringOption = { type: 'string' } as const;
const COMMANDS = {
  'requirement list': { options: { range: stringOption, status: stringOption }, usage: '[--range 7d|30d|90d|all] [--status STATUS[,STATUS...]]' },
  'requirement show': { options: { id: stringOption }, usage: '--id ID (title, body, session, and complete conversation)' },
  'requirement reply': { options: { id: stringOption, message: stringOption, 'message-file': stringOption }, usage: '--id ID (--message TEXT | --message-file PATH)' },
  'requirement related': { options: { id: stringOption }, usage: '--id ID (direct parent and children)' },
  'requirement delete': { options: { id: stringOption }, usage: '--id ID (cancel a TODO Requirement)' },
  'requirement confirm': { options: { id: stringOption }, usage: '--id ID (confirm waiting_confirmation as done)' },
  'requirement start': { options: { id: stringOption }, usage: '--id ID (start TODO work or resume/retry active work)' },
  'pr list': { options: { 'requirement-id': stringOption }, usage: '[--requirement-id ID] (find Code Factory PR IDs)' },
  'pr review': { options: { id: stringOption, provider: stringOption, model: stringOption, 'reasoning-effort': stringOption, prompt: stringOption, 'prompt-file': stringOption }, usage: '--id PR_ID --provider codex|claude-code|native-agent [--model MODEL] [--reasoning-effort LEVEL] [--prompt TEXT | --prompt-file PATH]' },
  'pr reviews': { options: { id: stringOption }, usage: '--id PR_ID (inspect review progress and result)' },
  'timer register': { options: { 'requirement-id': stringOption, 'after-seconds': stringOption, description: stringOption, repeat: { type: 'boolean' } }, usage: '--requirement-id ID --after-seconds SECONDS --description TEXT [--repeat]' },
  'timer show': { options: { 'requirement-id': stringOption }, usage: '--requirement-id ID (includes completed/cancelled history)' },
  'timer cancel': { options: { 'requirement-id': stringOption, id: stringOption }, usage: '--requirement-id ID --id TIMER_ID' },
} as const;
const STATUSES: readonly string[] = ['todo', 'doing', 'waiting_confirmation', 'done'];
const RANGES: Readonly<Record<string, number>> = { '7d': 7, '30d': 30, '90d': 90, all: Infinity };
const HELP = `Usage: code-factory-manager-cli <command> [options]

Human operations for a running Code Factory Manager.

${Object.entries(COMMANDS).map(([name, command]) => `  ${name} ${command.usage}`).join('\n')}

Global options (after the command):
  --api-url URL   Manager root URL; overrides CODE_FACTORY_API_URL
                  Default: http://127.0.0.1:4310
  --json          Print JSON for scripts (default: readable text)
  -h, --help      Show help without connecting

List defaults: --range 7d --status all. Ranges use creation time, matching the
dashboard. Cancelled Requirements are excluded, matching the dashboard.
Statuses: ${STATUSES.join(', ')}; use all for every status.
PR_ID means Code Factory's pr_<uuid>, obtained with pr list, not a GitHub number.
Timer delay: whole seconds from 60 to 31536000; description: 1-500 characters.
Review reasoning levels: low, medium, high, xhigh, max. Native Requirements need
a native-agent Reviewer; headless Requirements accept codex or claude-code.

Replies are authored by human and can start work or reopen a done Requirement.
Mutations require the user's instruction; RD automation uses code-factory-cli.
Accepted starts/replies/reviews run in the background, not to completion.
Requests time out after 30 seconds; writes are never automatically retried.
Exit codes: 0 success, 2 usage error, 1 API/transport failure. After a failed write,
inspect current state before retrying because its outcome may be unknown.`;

class UsageError extends Error {}
class RequestError extends Error {}

function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new UsageError(`${name} is required`);
  return value.trim();
}

function baseUrl(value: unknown): string {
  let url;
  try { url = new URL(required(value, '--api-url')); }
  catch { throw new UsageError('--api-url must be an absolute HTTP(S) Manager URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new UsageError('--api-url must use HTTP(S) without credentials, query, or fragment');
  }
  // Accept the /api suffix used by RD connection context as well as Manager roots.
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/api$/, '');
  return url.href.replace(/\/+$/, '');
}

function items<T>(value: Collection<T>): T[] {
  if (!value || !Array.isArray(value.items)) throw new RequestError('Manager returned an invalid collection');
  return value.items;
}

function summary(requirement: RequirementWithSession) {
  return {
    id: requirement.id, title: requirement.title, status: requirement.status,
    createdAt: requirement.createdAt, sessionState: requirement.session?.state ?? null,
  };
}

function option(values: Options, name: string): string | undefined {
  const value = values[name];
  return typeof value === 'string' ? value : undefined;
}

async function textOption(values: Options, name: string, readTextFile: ManagerCliRuntime['readTextFile'], mandatory = false): Promise<string | undefined> {
  const path = values[`${name}-file`];
  if (values[name] !== undefined && path !== undefined) throw new UsageError(`Use either --${name} or --${name}-file`);
  let value = option(values, name);
  if (path !== undefined) {
    try { value = await readTextFile(required(path, `--${name}-file`)); }
    catch (error) {
      if (error instanceof UsageError) throw error;
      throw new RequestError(`Unable to read --${name}-file; check the path and permissions`);
    }
  }
  if (value === undefined && !mandatory) return undefined;
  required(value, `--${name} or --${name}-file`);
  return value;
}

function table<T>(rows: readonly T[], columns: readonly (keyof T)[]): string {
  const cell = (value: unknown) => String(value ?? '').replace(/[\r\n\t\x1b]/g, ' ');
  return [columns.join('\t'), ...rows.map((row) => columns.map((key) => cell(row[key])).join('\t'))].join('\n');
}

function readableShow(r: RequirementWithSession, messages: RequirementMessage[]): string {
  return `${r.id} [${r.status}] ${r.title}\nSession: ${r.session?.state ?? 'unknown'}\n\n${r.description}\n\nConversation:\n${messages.map((m) => `[${m.sequence}] ${m.author} ${m.createdAt}\n${m.body}${(m.attachments ?? []).map((a) => `\nAttachment: ${a.id} ${a.fileName}`).join('')}`).join('\n\n')}`;
}

function isCommand(value: string): value is keyof typeof COMMANDS {
  return Object.hasOwn(COMMANDS, value);
}

/** Run without RD Session credentials. Runtime injection keeps tests off live Managers. */
export async function runManagerCli(args: readonly string[], overrides: Partial<ManagerCliRuntime> = {}): Promise<number> {
  const runtime: ManagerCliRuntime = {
    environment: process.env, fetch: globalThis.fetch, now: Date.now,
    readTextFile: (path) => readFile(path, 'utf8'), requestTimeoutMs: 30_000,
    writeOut: (value) => process.stdout.write(value), writeError: (value) => process.stderr.write(value),
    ...overrides,
  };
  try {
    if (args.length === 0 || (args.length === 1 && args[0] !== undefined && ['--help', '-h'].includes(args[0]))) {
      runtime.writeOut(`${HELP}\n`);
      return 0;
    }
    const command = args.slice(0, 2).join(' ');
    if (!isCommand(command)) throw new UsageError(`Unknown command: ${command}`);
    let values: Options;
    try {
      const config: NonNullable<Parameters<typeof parseArgs>[0]> = {
        args: [...args.slice(2)], strict: true, allowPositionals: false,
        options: { ...GLOBAL_OPTIONS, ...COMMANDS[command].options },
      };
      values = parseArgs(config).values;
    } catch (error) { throw new UsageError(error instanceof Error ? error.message : String(error)); }
    if (values.help) { runtime.writeOut(`${HELP}\n`); return 0; }
    const api = baseUrl(values['api-url'] ?? runtime.environment.CODE_FACTORY_API_URL ?? 'http://127.0.0.1:4310');
    const request = async <T = unknown>(path: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', body?: Record<string, unknown>): Promise<T> => {
      try {
        const response = await runtime.fetch(`${api}/api${path}`, {
          method, redirect: 'error', signal: AbortSignal.timeout(runtime.requestTimeoutMs),
          ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        });
        if (!response.ok) {
          const data: unknown = await response.json().catch(() => null);
          const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? `: ${data.error}` : '';
          throw new RequestError(`Manager HTTP ${response.status}${message}`);
        }
        const data: unknown = response.status === 204 ? { ok: true } : await response.json();
        return data as T;
      } catch (error) {
        if (error instanceof RequestError) throw error;
        throw new RequestError('Manager request failed or timed out; check the URL and service. If this was a write, inspect state before retrying.');
      }
    };
    const requirementPath = () => `/requirements/${encodeURIComponent(required(values['requirement-id'] ?? values.id, '--requirement-id or --id'))}`;
    let result: unknown;
    let formatted: string | undefined;
    if (command === 'requirement list') {
      const range = option(values, 'range') ?? '7d';
      const days = Object.hasOwn(RANGES, range) ? RANGES[range] : undefined;
      if (days === undefined) throw new UsageError('--range must be 7d, 30d, 90d, or all');
      const statuses = (option(values, 'status') ?? 'all').split(',');
      if (statuses.some((status) => !STATUSES.includes(status)) && !(statuses.length === 1 && statuses[0] === 'all')) {
        throw new UsageError(`--status must be all or a comma-separated list of: ${STATUSES.join(', ')}`);
      }
      const cutoff = runtime.now() - days * 86_400_000;
      const rows = items(await request<Collection<RequirementWithSession>>('/requirements'))
        .filter((r) => (range === 'all' || Date.parse(r.createdAt) >= cutoff) && (statuses.includes('all') || statuses.includes(r.status)))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).map(summary);
      result = { items: rows };
      formatted = table(rows, ['id', 'title', 'status']);
    } else if (command === 'requirement show') {
      const path = requirementPath();
      const [requirement, messages] = await Promise.all([request<RequirementWithSession>(path), request<Collection<RequirementMessage>>(`${path}/messages`)]);
      result = { requirement, messages: items(messages).sort((a, b) => a.sequence - b.sequence) };
      formatted = readableShow(requirement, messages.items);
    } else if (command === 'requirement related') {
      const requirement = await request<RequirementWithSession>(requirementPath());
      const [parent, collection] = await Promise.all([
        requirement.parentRequirementId ? request<RequirementWithSession>(`/requirements/${encodeURIComponent(requirement.parentRequirementId)}`) : null,
        request<Collection<RequirementWithSession>>('/requirements'),
      ]);
      const related = { parent: parent ? summary(parent) : null,
        children: items(collection).filter((r) => r.parentRequirementId === requirement.id).map(summary) };
      result = related;
      formatted = `Parent:\n${table(related.parent ? [related.parent] : [], ['id', 'title', 'status'])}\n\nChildren:\n${table(related.children, ['id', 'title', 'status'])}`;
    } else if (command === 'requirement reply') {
      const path = requirementPath();
      result = await request(`${path}/reply`, 'POST', { message: await textOption(values, 'message', runtime.readTextFile, true) });
    } else if (['requirement delete', 'requirement confirm', 'requirement start'].includes(command)) {
      const path = requirementPath();
      result = command === 'requirement delete' ? await request(path, 'DELETE') : await request(`${path}/${args[1]}`, 'POST', {});
    } else if (command === 'pr list') {
      const id = values['requirement-id'];
      const collection = await request<Collection<PullRequest>>(`/pull-requests${id === undefined ? '' : `?${new URLSearchParams({ requirementId: required(id, '--requirement-id') })}`}`);
      formatted = table(items(collection), ['id', 'requirementId', 'title', 'status', 'url']);
      result = collection;
    } else if (command === 'pr reviews') {
      const id = required(values.id, '--id');
      const collection = await request<Collection<ReviewRequest>>(`/review-requests?${new URLSearchParams({ pullRequestId: id })}`);
      formatted = table(items(collection), ['id', 'pullRequestId', 'status', 'error']);
      result = collection;
    } else if (command === 'pr review') {
      const id = required(values.id, '--id');
      const provider = required(values.provider, '--provider');
      if (!['codex', 'claude-code', 'native-agent'].includes(provider)) throw new UsageError('--provider must be codex, claude-code, or native-agent');
      const effort = option(values, 'reasoning-effort');
      if (effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new UsageError('Invalid --reasoning-effort');
      const prompt = await textOption(values, 'prompt', runtime.readTextFile);
      result = await request(`/pull-requests/${encodeURIComponent(id)}/review-requests`, 'POST', {
        provider, ...(values.model === undefined ? {} : { model: required(values.model, '--model') }),
        ...(effort === undefined ? {} : { reasoningEffort: effort }), ...(prompt === undefined ? {} : { prompt }),
      });
    } else if (command === 'timer register') {
      const path = requirementPath();
      const seconds = Number(required(values['after-seconds'], '--after-seconds'));
      if (!Number.isInteger(seconds) || seconds < 60 || seconds > 31_536_000) throw new UsageError('--after-seconds must be a whole number from 60 to 31536000');
      const description = required(values.description, '--description');
      if (description.length > 500) throw new UsageError('--description must be 1-500 characters');
      result = await request(`${path}/timers`, 'POST', { description, intervalSeconds: seconds, schedule: values.repeat ? 'recurring' : 'once' });
    } else if (command === 'timer show') {
      required(values['requirement-id'], '--requirement-id');
      const collection = await request<Collection<AgentTimer>>(`${requirementPath()}/timers`);
      formatted = table(items(collection), ['id', 'status', 'schedule', 'intervalSeconds', 'nextFireAt', 'description']);
      result = collection;
    } else if (command === 'timer cancel') {
      required(values['requirement-id'], '--requirement-id');
      result = await request(`${requirementPath()}/timers/${encodeURIComponent(required(values.id, '--id'))}`, 'DELETE');
    }
    runtime.writeOut(`${values.json ? JSON.stringify(result) : formatted ?? JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    runtime.writeError(`${error instanceof UsageError ? `${error.message}\nRun code-factory-manager-cli --help for usage.` : error instanceof RequestError ? error.message : 'Unable to process the Manager response.'}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}

