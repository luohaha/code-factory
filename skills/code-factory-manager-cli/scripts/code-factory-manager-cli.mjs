#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const GLOBAL_OPTIONS = {
  'api-url': { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};
const stringOption = { type: 'string' };
const COMMANDS = {
  'requirement list': { options: { range: stringOption, status: stringOption }, usage: '[--range 7d|30d|90d|all] [--status STATUS[,STATUS...]]' },
  'requirement show': { options: { id: stringOption }, usage: '--id ID (title, body, session, and complete conversation)' },
  'requirement reply': { options: { id: stringOption, message: stringOption, 'message-file': stringOption }, usage: '--id ID (--message TEXT | --message-file PATH)' },
  'requirement related': { options: { id: stringOption }, usage: '--id ID (direct parent and children, including cancelled)' },
  'requirement delete': { options: { id: stringOption }, usage: '--id ID (cancel a TODO Requirement)' },
  'requirement confirm': { options: { id: stringOption }, usage: '--id ID (confirm waiting_confirmation as done)' },
  'requirement start': { options: { id: stringOption }, usage: '--id ID (start TODO work or resume/retry active work)' },
  'pr list': { options: { 'requirement-id': stringOption }, usage: '[--requirement-id ID] (find Code Factory PR IDs)' },
  'pr review': { options: { id: stringOption, provider: stringOption, model: stringOption, 'reasoning-effort': stringOption, prompt: stringOption, 'prompt-file': stringOption }, usage: '--id PR_ID --provider codex|claude-code|native-agent [--model MODEL] [--reasoning-effort LEVEL] [--prompt TEXT | --prompt-file PATH]' },
  'pr reviews': { options: { id: stringOption }, usage: '--id PR_ID (inspect review progress and result)' },
  'timer register': { options: { 'requirement-id': stringOption, 'after-seconds': stringOption, description: stringOption, repeat: { type: 'boolean' } }, usage: '--requirement-id ID --after-seconds SECONDS --description TEXT [--repeat]' },
  'timer show': { options: { 'requirement-id': stringOption }, usage: '--requirement-id ID (includes completed/cancelled history)' },
  'timer cancel': { options: { 'requirement-id': stringOption, id: stringOption }, usage: '--requirement-id ID --id TIMER_ID' },
};
const STATUSES = ['todo', 'doing', 'waiting_confirmation', 'done', 'cancelled'];
const RANGES = { '7d': 7, '30d': 30, '90d': 90, all: Infinity };
const HELP = `Usage: code-factory-manager-cli <command> [options]

Human operations for a running Code Factory Manager.

${Object.entries(COMMANDS).map(([name, command]) => `  ${name} ${command.usage}`).join('\n')}

Global options (after the command):
  --api-url URL   Manager root URL; overrides CODE_FACTORY_API_URL
                  Default: http://127.0.0.1:4310
  --json          Print JSON for scripts (default: readable text)
  -h, --help      Show help without connecting

List defaults: --range 7d --status all. Ranges use creation time, matching the
dashboard; all statuses include cancelled records still retained by the Manager.
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

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new UsageError(`${name} is required`);
  return value.trim();
}

function baseUrl(value) {
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

function items(value) {
  if (!value || !Array.isArray(value.items)) throw new RequestError('Manager returned an invalid collection');
  return value.items;
}

function summary(requirement) {
  return {
    id: requirement.id, title: requirement.title, status: requirement.status,
    createdAt: requirement.createdAt, sessionState: requirement.session?.state ?? null,
  };
}

async function textOption(values, name, readTextFile, mandatory = false) {
  const path = values[`${name}-file`];
  if (values[name] !== undefined && path !== undefined) throw new UsageError(`Use either --${name} or --${name}-file`);
  let value = values[name];
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

function table(rows, columns) {
  const cell = (value) => String(value ?? '').replace(/[\r\n\t\x1b]/g, ' ');
  return [columns.join('\t'), ...rows.map((row) => columns.map((key) => cell(row[key])).join('\t'))].join('\n');
}

function readable(command, result) {
  if (command === 'requirement list') return table(result.items, ['id', 'title', 'status']);
  if (command === 'requirement show') {
    const r = result.requirement;
    return `${r.id} [${r.status}] ${r.title}\nSession: ${r.session?.state ?? 'unknown'}\n\n${r.description}\n\nConversation:\n${result.messages.map((m) => `[${m.sequence}] ${m.author} ${m.createdAt}\n${m.body}${(m.attachments ?? []).map((a) => `\nAttachment: ${a.id} ${a.fileName}`).join('')}`).join('\n\n')}`;
  }
  if (command === 'requirement related') {
    return `Parent:\n${table(result.parent ? [result.parent] : [], ['id', 'title', 'status'])}\n\nChildren:\n${table(result.children, ['id', 'title', 'status'])}`;
  }
  if (command === 'pr list') return table(result.items, ['id', 'requirementId', 'title', 'status', 'url']);
  if (command === 'pr reviews') return table(result.items, ['id', 'pullRequestId', 'status', 'error']);
  if (command === 'timer show') return table(result.items, ['id', 'status', 'schedule', 'intervalSeconds', 'nextFireAt', 'description']);
  return JSON.stringify(result, null, 2);
}

/** Run without RD Session credentials. Runtime injection keeps tests off live Managers. */
export async function runManagerCli(args, overrides = {}) {
  const runtime = {
    environment: process.env, fetch: globalThis.fetch, now: Date.now,
    readTextFile: (path) => readFile(path, 'utf8'), requestTimeoutMs: 30_000,
    writeOut: (value) => process.stdout.write(value), writeError: (value) => process.stderr.write(value),
    ...overrides,
  };
  try {
    if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0]))) {
      runtime.writeOut(`${HELP}\n`);
      return 0;
    }
    const command = args.slice(0, 2).join(' ');
    if (!Object.hasOwn(COMMANDS, command)) throw new UsageError(`Unknown command: ${command}`);
    let values;
    try {
      values = parseArgs({ args: args.slice(2), strict: true, allowPositionals: false,
        options: { ...GLOBAL_OPTIONS, ...COMMANDS[command].options } }).values;
    } catch (error) { throw new UsageError(error.message); }
    if (values.help) { runtime.writeOut(`${HELP}\n`); return 0; }
    const api = baseUrl(values['api-url'] ?? runtime.environment.CODE_FACTORY_API_URL ?? 'http://127.0.0.1:4310');
    const request = async (path, method = 'GET', body = undefined) => {
      try {
        const response = await runtime.fetch(`${api}/api${path}`, {
          method, redirect: 'error', signal: AbortSignal.timeout(runtime.requestTimeoutMs),
          ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => null);
          throw new RequestError(`Manager HTTP ${response.status}${typeof data?.error === 'string' ? `: ${data.error}` : ''}`);
        }
        if (response.status === 204) return { ok: true };
        return await response.json();
      } catch (error) {
        if (error instanceof RequestError) throw error;
        throw new RequestError('Manager request failed or timed out; check the URL and service. If this was a write, inspect state before retrying.');
      }
    };
    const requirementPath = () => `/requirements/${encodeURIComponent(required(values['requirement-id'] ?? values.id, '--requirement-id or --id'))}`;
    let result;
    if (command === 'requirement list') {
      const range = values.range ?? '7d';
      if (!Object.hasOwn(RANGES, range)) throw new UsageError('--range must be 7d, 30d, 90d, or all');
      const statuses = (values.status ?? 'all').split(',');
      if (statuses.some((status) => !STATUSES.includes(status)) && !(statuses.length === 1 && statuses[0] === 'all')) {
        throw new UsageError(`--status must be all or a comma-separated list of: ${STATUSES.join(', ')}`);
      }
      const includeCancelled = statuses.includes('all') || statuses.includes('cancelled');
      const cutoff = runtime.now() - RANGES[range] * 86_400_000;
      result = { items: items(await request(`/requirements${includeCancelled ? '?includeCancelled=true' : ''}`))
        .filter((r) => (range === 'all' || Date.parse(r.createdAt) >= cutoff) && (statuses.includes('all') || statuses.includes(r.status)))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).map(summary) };
    } else if (command === 'requirement show') {
      const path = requirementPath();
      const [requirement, messages] = await Promise.all([request(path), request(`${path}/messages`)]);
      result = { requirement, messages: items(messages).sort((a, b) => a.sequence - b.sequence) };
    } else if (command === 'requirement related') {
      const requirement = await request(requirementPath());
      const [parent, collection] = await Promise.all([
        requirement.parentRequirementId ? request(`/requirements/${encodeURIComponent(requirement.parentRequirementId)}`) : null,
        request('/requirements?includeCancelled=true'),
      ]);
      result = { parent: parent ? summary(parent) : null,
        children: items(collection).filter((r) => r.parentRequirementId === requirement.id).map(summary) };
    } else if (command === 'requirement reply') {
      const path = requirementPath();
      result = await request(`${path}/reply`, 'POST', { message: await textOption(values, 'message', runtime.readTextFile, true) });
    } else if (['requirement delete', 'requirement confirm', 'requirement start'].includes(command)) {
      const path = requirementPath();
      result = command === 'requirement delete' ? await request(path, 'DELETE') : await request(`${path}/${args[1]}`, 'POST', {});
    } else if (command === 'pr list') {
      const id = values['requirement-id'];
      result = await request(`/pull-requests${id === undefined ? '' : `?${new URLSearchParams({ requirementId: required(id, '--requirement-id') })}`}`);
      items(result);
    } else if (command === 'pr reviews') {
      const id = required(values.id, '--id');
      result = await request(`/review-requests?${new URLSearchParams({ pullRequestId: id })}`);
      items(result);
    } else if (command === 'pr review') {
      const id = required(values.id, '--id');
      const provider = required(values.provider, '--provider');
      if (!['codex', 'claude-code', 'native-agent'].includes(provider)) throw new UsageError('--provider must be codex, claude-code, or native-agent');
      const effort = values['reasoning-effort'];
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
      result = await request(`${requirementPath()}/timers`);
      items(result);
    } else if (command === 'timer cancel') {
      required(values['requirement-id'], '--requirement-id');
      result = await request(`${requirementPath()}/timers/${encodeURIComponent(required(values.id, '--id'))}`, 'DELETE');
    }
    runtime.writeOut(`${values.json ? JSON.stringify(result) : readable(command, result)}\n`);
    return 0;
  } catch (error) {
    runtime.writeError(`${error instanceof UsageError ? `${error.message}\nRun code-factory-manager-cli --help for usage.` : error instanceof RequestError ? error.message : 'Unable to process the Manager response.'}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await runManagerCli(process.argv.slice(2));
}
