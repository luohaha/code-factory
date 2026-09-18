import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parseArgs, promisify } from 'node:util';

import { CODE_FACTORY_VERSION } from './version.js';

export const CODE_FACTORY_API_URL = 'CODE_FACTORY_API_URL';
export const CODE_FACTORY_REQUIREMENT_ID = 'CODE_FACTORY_REQUIREMENT_ID';
export const CODE_FACTORY_SESSION_ID = 'CODE_FACTORY_SESSION_ID';

const HELP = `Usage: code-factory-cli <command>

Code Factory control-plane commands for RD Agents.

Commands:
  pr register             Register or refresh a pull request
  requirement propose     Propose a separately tracked TODO requirement
  requirement related     Show this Requirement's direct parent and children
  requirement message     Send a message to a related Requirement's RD Agent
  timer register          Register a one-time or recurring wake-up timer
  timer show              Show timers registered for this Requirement
  timer cancel            Cancel a registered wake-up timer

Options:
  -v, --version           Print the installed Code Factory version

Run code-factory-cli <command> --help for command options.

RD Agents receive connection context through CODE_FACTORY_API_URL,
CODE_FACTORY_REQUIREMENT_ID, and CODE_FACTORY_SESSION_ID.

Success prints JSON to stdout. Errors go to stderr: exit 2 for usage/context
errors, exit 1 for execution failures. Requests time out after 30 seconds and
writes are never automatically retried.`;

const PR_REGISTER_HELP = `Usage: code-factory-cli pr register [options]

Register a pull request after creating it. Run this command again only when your
own push or edit changes its metadata. Code Factory owns lifecycle synchronization.

Recommended (requires authenticated gh):
  --from-github URL        Read current metadata from an explicit PR URL

Or supply all metadata manually (cannot combine with --from-github):
  --repository OWNER/REPO or HOST/OWNER/REPO
  --number NUMBER
  --url URL
  --title TITLE
  --base-branch BRANCH
  --head-branch BRANCH
  --head-sha SHA
  --status draft|open|closed|merged

For existing PRs, --status does not change the stored lifecycle state.

Example:
  code-factory-cli pr register --from-github https://github.com/OWNER/REPO/pull/123

Context: CODE_FACTORY_API_URL and CODE_FACTORY_REQUIREMENT_ID.`;

const REQUIREMENT_PROPOSE_HELP = `Usage: code-factory-cli requirement propose [options]

Propose separate follow-up work as a linked TODO requirement.

Required options:
  --title TITLE
  --description DESCRIPTION or --description-file PATH (UTF-8)

Optional options:
  --provider codex|claude-code
  --model MODEL
  --reasoning-effort low|medium|high|xhigh|max

Proposals remain TODO until a human starts them.

Context: CODE_FACTORY_API_URL, CODE_FACTORY_REQUIREMENT_ID, and
CODE_FACTORY_SESSION_ID.`;

const REQUIREMENT_RELATED_HELP = `Usage: code-factory-cli requirement related

Show this Requirement's direct parent and child Requirements, including their
current status and RD Session state.

Context: CODE_FACTORY_API_URL, CODE_FACTORY_REQUIREMENT_ID, and
CODE_FACTORY_SESSION_ID.`;

const REQUIREMENT_MESSAGE_HELP = `Usage: code-factory-cli requirement message [options]

Send a message to a direct parent or child Requirement's RD Agent. The message
is persisted in the target Requirement conversation and starts or queues its RD
Agent. A completed target is reactivated; a cancelled target is rejected.

Required options:
  --requirement-id ID     Direct parent or child Requirement ID
  --message TEXT          Message for the related Requirement's RD Agent

Context: CODE_FACTORY_API_URL, CODE_FACTORY_REQUIREMENT_ID, and
CODE_FACTORY_SESSION_ID.`;

const TIMER_REGISTER_HELP = `Usage: code-factory-cli timer register [options]

Register a timer that sends its ID and follow-up description to this Requirement after a delay.

Required options:
  --after-seconds SECONDS  Delay before the first wake-up (60-31536000)
  --description TEXT       Follow-up the Agent should perform when the timer fires

Optional options:
  --repeat                 Repeat at the same interval until cancelled

Context: CODE_FACTORY_API_URL and CODE_FACTORY_REQUIREMENT_ID.`;

const TIMER_SHOW_HELP = `Usage: code-factory-cli timer show

Show every timer registered for this Requirement, including its ID, description,
status, schedule, interval, and next or previous wake-up time.

Context: CODE_FACTORY_API_URL and CODE_FACTORY_REQUIREMENT_ID.`;

const TIMER_CANCEL_HELP = `Usage: code-factory-cli timer cancel [options]

Cancel an active scheduled wake-up.

Required options:
  --id TIMER_ID

Context: CODE_FACTORY_API_URL and CODE_FACTORY_REQUIREMENT_ID.`;

type Environment = Readonly<Record<string, string | undefined>>;

export interface CodeFactoryCliRuntime {
  environment: Environment;
  fetch: typeof globalThis.fetch;
  runGitHub: (args: string[]) => Promise<string>;
  readTextFile: (path: string) => Promise<string>;
  requestTimeoutMs: number;
  writeOut: (value: string) => void;
  writeError: (value: string) => void;
}

class CliUsageError extends Error {
  constructor(message: string, readonly help: string) {
    super(message);
  }
}

class CliRequestError extends Error {}

function defaultRuntime(): CodeFactoryCliRuntime {
  return {
    environment: process.env,
    fetch: globalThis.fetch,
    runGitHub: async (args) => {
      const { stdout } = await promisify(execFile)('gh', args, {
        encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
      });
      return stdout;
    },
    readTextFile: (path) => readFile(path, 'utf8'),
    requestTimeoutMs: 30_000,
    writeOut: (value) => process.stdout.write(value),
    writeError: (value) => process.stderr.write(value),
  };
}

function required(value: string | undefined, name: string, help: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new CliUsageError(`${name} is required`, help);
  return normalized;
}

function apiBaseUrl(environment: Environment): string {
  const value = required(environment[CODE_FACTORY_API_URL], CODE_FACTORY_API_URL, HELP).replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CliUsageError(`${CODE_FACTORY_API_URL} must be an absolute URL`, HELP);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CliUsageError(`${CODE_FACTORY_API_URL} must use http or https`, HELP);
  }
  if (parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new CliUsageError(`${CODE_FACTORY_API_URL} must not contain credentials, a query, or a fragment`, HELP);
  }
  return value;
}

function parseOptions(
  args: readonly string[],
  help: string,
  options: NonNullable<Parameters<typeof parseArgs>[0]>['options'],
): ReturnType<typeof parseArgs>['values'] {
  try {
    return parseArgs({ args: [...args], options, allowPositionals: false, strict: true }).values;
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error), help);
  }
}

function pullRequestTarget(value: string): { repository: string; number: number } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliUsageError('--from-github must be an absolute HTTPS PR URL', PR_REGISTER_HELP);
  }
  const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.port || !match || !Number.isSafeInteger(Number(match[3]))) {
    throw new CliUsageError('--from-github must be https://HOST/OWNER/REPO/pull/NUMBER', PR_REGISTER_HELP);
  }
  const repository = `${match[1]}/${match[2]}`;
  return { repository: url.hostname === 'github.com' ? repository : `${url.hostname}/${repository}`, number: Number(match[3]) };
}

async function parsePullRequestPayload(args: readonly string[], runtime: CodeFactoryCliRuntime): Promise<Record<string, unknown>> {
  const { environment } = runtime;
  const values = parseOptions(args, PR_REGISTER_HELP, {
    'from-github': { type: 'string' },
    repository: { type: 'string' },
    number: { type: 'string' },
    url: { type: 'string' },
    title: { type: 'string' },
    'base-branch': { type: 'string' },
    'head-branch': { type: 'string' },
    'head-sha': { type: 'string' },
    status: { type: 'string' },
  });
  if (values['from-github'] !== undefined) {
    if (Object.keys(values).some((key) => key !== 'from-github')) {
      throw new CliUsageError('--from-github cannot be combined with manual metadata options', PR_REGISTER_HELP);
    }
    const requirementId = required(environment[CODE_FACTORY_REQUIREMENT_ID], CODE_FACTORY_REQUIREMENT_ID, PR_REGISTER_HELP);
    const url = required(values['from-github'] as string | undefined, '--from-github', PR_REGISTER_HELP);
    const target = pullRequestTarget(url);
    const raw: unknown = JSON.parse(await runtime.runGitHub([
      'pr', 'view', String(target.number), '--repo', target.repository, '--json',
      'number,url,title,baseRefName,headRefName,headRefOid,state,isDraft',
    ]));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new CliRequestError('gh returned invalid PR metadata');
    }
    const details = raw as Record<string, unknown>;
    const field = (name: string): string => {
      const value = details[name];
      if (typeof value !== 'string' || !value.trim()) throw new CliRequestError(`gh returned invalid ${name}`);
      return value;
    };
    const returned = pullRequestTarget(field('url'));
    if (details.number !== target.number || returned.number !== target.number ||
        returned.repository.toLowerCase() !== target.repository.toLowerCase()) {
      throw new CliRequestError('gh returned metadata for a different pull request');
    }
    const state = field('state');
    if (!['OPEN', 'CLOSED', 'MERGED'].includes(state) || typeof details.isDraft !== 'boolean') {
      throw new CliRequestError('gh returned invalid PR state');
    }
    return {
      requirementId, repository: target.repository, number: target.number, url: field('url'),
      title: field('title'), baseBranch: field('baseRefName'), headBranch: field('headRefName'),
      headSha: field('headRefOid'),
      status: state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : details.isDraft ? 'draft' : 'open',
    };
  }
  const numberValue = Number(required(values.number as string | undefined, '--number', PR_REGISTER_HELP));
  if (!Number.isSafeInteger(numberValue) || numberValue <= 0) {
    throw new CliUsageError('--number must be a positive integer', PR_REGISTER_HELP);
  }
  const status = required(values.status as string | undefined, '--status', PR_REGISTER_HELP);
  if (!['draft', 'open', 'closed', 'merged'].includes(status)) {
    throw new CliUsageError('--status must be draft, open, closed, or merged', PR_REGISTER_HELP);
  }
  return {
    requirementId: required(environment[CODE_FACTORY_REQUIREMENT_ID], CODE_FACTORY_REQUIREMENT_ID, PR_REGISTER_HELP),
    repository: required(values.repository as string | undefined, '--repository', PR_REGISTER_HELP),
    number: numberValue,
    url: required(values.url as string | undefined, '--url', PR_REGISTER_HELP),
    title: required(values.title as string | undefined, '--title', PR_REGISTER_HELP),
    baseBranch: required(values['base-branch'] as string | undefined, '--base-branch', PR_REGISTER_HELP),
    headBranch: required(values['head-branch'] as string | undefined, '--head-branch', PR_REGISTER_HELP),
    headSha: required(values['head-sha'] as string | undefined, '--head-sha', PR_REGISTER_HELP),
    status,
  };
}

async function parseRequirementPayload(args: readonly string[], runtime: CodeFactoryCliRuntime): Promise<Record<string, unknown>> {
  const { environment } = runtime;
  const values = parseOptions(args, REQUIREMENT_PROPOSE_HELP, {
    title: { type: 'string' },
    description: { type: 'string' },
    'description-file': { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    'reasoning-effort': { type: 'string' },
  });
  if (values.description !== undefined && values['description-file'] !== undefined) {
    throw new CliUsageError('Use either --description or --description-file', REQUIREMENT_PROPOSE_HELP);
  }
  const provider = values.provider as string | undefined;
  if (provider !== undefined && provider !== 'codex' && provider !== 'claude-code') {
    throw new CliUsageError('--provider must be codex or claude-code', REQUIREMENT_PROPOSE_HELP);
  }
  const reasoningEffort = values['reasoning-effort'] as string | undefined;
  if (reasoningEffort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(reasoningEffort)) {
    throw new CliUsageError(
      '--reasoning-effort must be low, medium, high, xhigh, or max',
      REQUIREMENT_PROPOSE_HELP,
    );
  }
  return {
    sourceSessionId: required(environment[CODE_FACTORY_SESSION_ID], CODE_FACTORY_SESSION_ID, REQUIREMENT_PROPOSE_HELP),
    parentRequirementId: required(
      environment[CODE_FACTORY_REQUIREMENT_ID],
      CODE_FACTORY_REQUIREMENT_ID,
      REQUIREMENT_PROPOSE_HELP,
    ),
    title: required(values.title as string | undefined, '--title', REQUIREMENT_PROPOSE_HELP),
    description: required(values['description-file'] === undefined
      ? values.description as string | undefined
      : await runtime.readTextFile(required(values['description-file'] as string | undefined, '--description-file', REQUIREMENT_PROPOSE_HELP)),
    '--description or --description-file', REQUIREMENT_PROPOSE_HELP),
    ...(provider === undefined ? {} : { provider }),
    ...(values.model === undefined ? {} : {
      model: required(values.model as string | undefined, '--model', REQUIREMENT_PROPOSE_HELP),
    }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };
}

function parseTimerRegistrationPayload(args: readonly string[]): Record<string, unknown> {
  const values = parseOptions(args, TIMER_REGISTER_HELP, {
    'after-seconds': { type: 'string' },
    description: { type: 'string' },
    repeat: { type: 'boolean' },
  });
  const intervalSeconds = Number(required(
    values['after-seconds'] as string | undefined,
    '--after-seconds',
    TIMER_REGISTER_HELP,
  ));
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 60 || intervalSeconds > 31_536_000) {
    throw new CliUsageError('--after-seconds must be an integer from 60 to 31536000', TIMER_REGISTER_HELP);
  }
  const description = required(values.description as string | undefined, '--description', TIMER_REGISTER_HELP);
  if (description.length > 500) {
    throw new CliUsageError('--description must be 500 characters or fewer', TIMER_REGISTER_HELP);
  }
  return {
    description,
    schedule: values.repeat ? 'recurring' : 'once',
    intervalSeconds,
  };
}

function errorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const value = (payload as { error?: unknown }).error;
    if (typeof value === 'string' && value.trim()) return value;
  }
  return fallback;
}

async function requestJson(
  runtime: CodeFactoryCliRuntime,
  url: string,
  method: 'GET' | 'POST' | 'DELETE',
  body?: Record<string, unknown>,
): Promise<unknown> {
  const retryGuidance = method === 'GET'
    ? ''
    : '; the write may have succeeded. Check the Requirement before retrying.';
  let response: Response;
  let text: string;
  try {
    response = await runtime.fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(runtime.requestTimeoutMs),
    });
    text = await response.text();
  } catch (error) {
    const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    const detail = timeout ? 'timed out' : `failed: ${error instanceof Error ? error.message : String(error)}`;
    throw new CliRequestError(`Code Factory API request ${detail}${retryGuidance}`);
  }
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      if (response.ok) throw new CliRequestError(`Code Factory API returned invalid JSON${retryGuidance}`);
    }
  }
  if (!response.ok) {
    throw new CliRequestError(`Code Factory API returned ${response.status}: ${errorMessage(payload, response.statusText)}`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new CliRequestError(`Code Factory API returned an invalid response object${retryGuidance}`);
  }
  return payload;
}

function writesHelp(args: readonly string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

export async function runCodeFactoryCli(
  args: readonly string[],
  overrides: Partial<CodeFactoryCliRuntime> = {},
): Promise<number> {
  const runtime = { ...defaultRuntime(), ...overrides };
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    runtime.writeOut(`${CODE_FACTORY_VERSION}\n`);
    return 0;
  }
  if (args.length === 0 || writesHelp(args) && args.length === 1) {
    runtime.writeOut(`${HELP}\n`);
    return 0;
  }

  const command = `${args[0] ?? ''} ${args[1] ?? ''}`.trim();
  let help: string;
  let endpoint: string;
  let method: 'GET' | 'POST' | 'DELETE' = 'POST';
  let body: Record<string, unknown> | undefined;
  try {
    if (command === 'pr register') {
      help = PR_REGISTER_HELP;
      if (writesHelp(args.slice(2))) {
        runtime.writeOut(`${help}\n`);
        return 0;
      }
      endpoint = '/agent/pull-requests';
      apiBaseUrl(runtime.environment);
      body = await parsePullRequestPayload(args.slice(2), runtime);
    } else if (command === 'requirement propose') {
      help = REQUIREMENT_PROPOSE_HELP;
      if (writesHelp(args.slice(2))) {
        runtime.writeOut(`${help}\n`);
        return 0;
      }
      endpoint = '/agent/requirements';
      apiBaseUrl(runtime.environment);
      body = await parseRequirementPayload(args.slice(2), runtime);
    } else if (command === 'requirement related') {
      help = REQUIREMENT_RELATED_HELP;
      if (writesHelp(args.slice(2))) {
        runtime.writeOut(`${help}\n`);
        return 0;
      }
      parseOptions(args.slice(2), help, {});
      const requirementId = required(
        runtime.environment[CODE_FACTORY_REQUIREMENT_ID],
        CODE_FACTORY_REQUIREMENT_ID,
        help,
      );
      const sessionId = required(
        runtime.environment[CODE_FACTORY_SESSION_ID],
        CODE_FACTORY_SESSION_ID,
        help,
      );
      endpoint = `/agent/requirements/${encodeURIComponent(requirementId)}/related?sourceSessionId=${encodeURIComponent(sessionId)}`;
      method = 'GET';
    } else if (command === 'requirement message') {
      help = REQUIREMENT_MESSAGE_HELP;
      if (writesHelp(args.slice(2))) {
        runtime.writeOut(`${help}\n`);
        return 0;
      }
      const values = parseOptions(args.slice(2), help, {
        'requirement-id': { type: 'string' },
        message: { type: 'string' },
      });
      const sourceRequirementId = required(
        runtime.environment[CODE_FACTORY_REQUIREMENT_ID],
        CODE_FACTORY_REQUIREMENT_ID,
        help,
      );
      const sourceSessionId = required(
        runtime.environment[CODE_FACTORY_SESSION_ID],
        CODE_FACTORY_SESSION_ID,
        help,
      );
      const targetRequirementId = required(
        values['requirement-id'] as string | undefined,
        '--requirement-id',
        help,
      );
      endpoint = `/agent/requirements/${encodeURIComponent(sourceRequirementId)}/related/${encodeURIComponent(targetRequirementId)}/messages`;
      body = {
        sourceSessionId,
        message: required(values.message as string | undefined, '--message', help),
      };
    } else if (command === 'timer register') {
      help = TIMER_REGISTER_HELP;
      if (writesHelp(args.slice(2))) {
        runtime.writeOut(`${help}\n`);
        return 0;
      }
      const requirementId = required(
        runtime.environment[CODE_FACTORY_REQUIREMENT_ID],
        CODE_FACTORY_REQUIREMENT_ID,
        help,
      );
      endpoint = `/requirements/${encodeURIComponent(requirementId)}/timers`;
      body = parseTimerRegistrationPayload(args.slice(2));
    } else if (command === 'timer show') {
      help = TIMER_SHOW_HELP;
      if (writesHelp(args.slice(2))) {
        runtime.writeOut(`${help}\n`);
        return 0;
      }
      parseOptions(args.slice(2), help, {});
      const requirementId = required(
        runtime.environment[CODE_FACTORY_REQUIREMENT_ID],
        CODE_FACTORY_REQUIREMENT_ID,
        help,
      );
      endpoint = `/requirements/${encodeURIComponent(requirementId)}/timers`;
      method = 'GET';
    } else if (command === 'timer cancel') {
      help = TIMER_CANCEL_HELP;
      if (writesHelp(args.slice(2))) {
        runtime.writeOut(`${help}\n`);
        return 0;
      }
      const requirementId = required(
        runtime.environment[CODE_FACTORY_REQUIREMENT_ID],
        CODE_FACTORY_REQUIREMENT_ID,
        help,
      );
      const values = parseOptions(args.slice(2), help, { id: { type: 'string' } });
      const timerId = required(values.id as string | undefined, '--id', help);
      endpoint = `/requirements/${encodeURIComponent(requirementId)}/timers/${encodeURIComponent(timerId)}`;
      method = 'DELETE';
    } else {
      throw new CliUsageError(`Unknown command: ${args.join(' ')}`, HELP);
    }
    const result = await requestJson(runtime, `${apiBaseUrl(runtime.environment)}${endpoint}`, method, body);
    runtime.writeOut(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof CliUsageError) {
      runtime.writeError(`Error: ${error.message}\n\n${error.help}\n`);
      return 2;
    }
    runtime.writeError(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
