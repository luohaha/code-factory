import { parseArgs } from 'node:util';

export const CODE_FACTORY_API_URL = 'CODE_FACTORY_API_URL';
export const CODE_FACTORY_REQUIREMENT_ID = 'CODE_FACTORY_REQUIREMENT_ID';
export const CODE_FACTORY_SESSION_ID = 'CODE_FACTORY_SESSION_ID';

const HELP = `Usage: code-factory-cli <command>

Code Factory control-plane commands for RD Agents.

Commands:
  pr register             Register or refresh a pull request
  requirement propose     Propose a separately tracked TODO requirement

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

function errorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const value = (payload as { error?: unknown }).error;
    if (typeof value === 'string' && value.trim()) return value;
  }
  return fallback;
}

async function postJson(
  runtime: CodeFactoryCliRuntime,
  url: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await runtime.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
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
  if (args.length === 0 || writesHelp(args) && args.length === 1) {
    runtime.writeOut(`${HELP}\n`);
    return 0;
  }

  const command = `${args[0] ?? ''} ${args[1] ?? ''}`.trim();
  let help: string;
  let endpoint: string;
  let body: Record<string, unknown>;
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
    } else {
      throw new CliUsageError(`Unknown command: ${args.join(' ')}`, HELP);
    }
    const result = await postJson(runtime, `${apiBaseUrl(runtime.environment)}${endpoint}`, body);
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
