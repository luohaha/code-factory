import { parseArgs } from 'node:util';

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
CODE_FACTORY_REQUIREMENT_ID, and CODE_FACTORY_SESSION_ID.`;

const PR_REGISTER_HELP = `Usage: code-factory-cli pr register [options]

Register a pull request after creating it. Run this command again only when your
own push or edit changes its metadata. Code Factory owns lifecycle synchronization.

Required options:
  --repository OWNER/REPO
  --number NUMBER
  --url URL
  --title TITLE
  --base-branch BRANCH
  --head-branch BRANCH
  --head-sha SHA
  --status draft|open|closed|merged

Context: CODE_FACTORY_API_URL and CODE_FACTORY_REQUIREMENT_ID.`;

const REQUIREMENT_PROPOSE_HELP = `Usage: code-factory-cli requirement propose [options]

Propose separate follow-up work as a linked TODO requirement.

Required options:
  --title TITLE
  --description DESCRIPTION

Optional options:
  --provider codex|claude-code
  --model MODEL
  --reasoning-effort low|medium|high|xhigh|max

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

function parsePullRequestPayload(args: readonly string[], environment: Environment): Record<string, unknown> {
  const values = parseOptions(args, PR_REGISTER_HELP, {
    repository: { type: 'string' },
    number: { type: 'string' },
    url: { type: 'string' },
    title: { type: 'string' },
    'base-branch': { type: 'string' },
    'head-branch': { type: 'string' },
    'head-sha': { type: 'string' },
    status: { type: 'string' },
  });
  const numberValue = Number(required(values.number as string | undefined, '--number', PR_REGISTER_HELP));
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
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

function parseRequirementPayload(args: readonly string[], environment: Environment): Record<string, unknown> {
  const values = parseOptions(args, REQUIREMENT_PROPOSE_HELP, {
    title: { type: 'string' },
    description: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    'reasoning-effort': { type: 'string' },
  });
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
    description: required(values.description as string | undefined, '--description', REQUIREMENT_PROPOSE_HELP),
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
  const response = await runtime.fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = { result: text };
    }
  }
  if (!response.ok) {
    throw new CliRequestError(`Code Factory API returned ${response.status}: ${errorMessage(payload, response.statusText)}`);
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
      body = parsePullRequestPayload(args.slice(2), runtime.environment);
    } else if (command === 'requirement propose') {
      help = REQUIREMENT_PROPOSE_HELP;
      if (writesHelp(args.slice(2))) {
        runtime.writeOut(`${help}\n`);
        return 0;
      }
      endpoint = '/agent/requirements';
      body = parseRequirementPayload(args.slice(2), runtime.environment);
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
