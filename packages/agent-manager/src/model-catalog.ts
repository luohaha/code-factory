import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { Logger } from './logger.js';
import type {
  AgentModel,
  AgentModelCatalogSnapshot,
  AgentModelProviderCatalog,
  AgentProvider,
} from './types.js';

export const AGENT_MODEL_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const DISCOVERY_TIMEOUT_MS = 15_000;

export interface AgentModelDiscoverer {
  readonly provider: AgentProvider;
  readonly fallbackModels?: readonly AgentModel[];
  discover(signal?: AbortSignal): Promise<readonly AgentModel[]>;
}

export interface AgentModelCatalogService {
  start(): void;
  stop(): void;
  getModels(): Promise<AgentModelCatalogSnapshot>;
  refresh(): Promise<void>;
}

export interface ModelCatalogOptions {
  discoverers: readonly AgentModelDiscoverer[];
  logger: Logger;
  now?: () => Date;
  onUpdated?: (snapshot: AgentModelCatalogSnapshot) => void;
}

interface CatalogEntry {
  models: AgentModel[];
  refreshedAt: string | null;
  stale: boolean;
}

export class ModelCatalog implements AgentModelCatalogService {
  readonly #discoverers: readonly AgentModelDiscoverer[];
  readonly #logger: Logger;
  readonly #now: () => Date;
  readonly #onUpdated: ((snapshot: AgentModelCatalogSnapshot) => void) | undefined;
  readonly #entries = new Map<AgentProvider, CatalogEntry>();
  #lastAttemptAt: number | null = null;
  #timer: NodeJS.Timeout | null = null;
  #inFlight: Promise<void> | null = null;
  #refreshController: AbortController | null = null;
  #stopped = false;

  constructor(options: ModelCatalogOptions) {
    this.#discoverers = options.discoverers;
    this.#logger = options.logger.child({ component: 'model-catalog' });
    this.#now = options.now ?? (() => new Date());
    this.#onUpdated = options.onUpdated;
    for (const discoverer of this.#discoverers) {
      this.#entries.set(discoverer.provider, {
        models: normalizeModels(discoverer.fallbackModels ?? []),
        refreshedAt: null,
        stale: true,
      });
    }
  }

  start(): void {
    if (this.#timer || this.#stopped) return;
    void this.getModels();
    this.#timer = setInterval(() => void this.refresh(), AGENT_MODEL_REFRESH_INTERVAL_MS);
    this.#timer.unref();
    this.#logger.info('Agent model catalog refresh started', {
      intervalMs: AGENT_MODEL_REFRESH_INTERVAL_MS,
    });
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#refreshController?.abort();
    this.#refreshController = null;
  }

  async getModels(): Promise<AgentModelCatalogSnapshot> {
    const now = this.#now().getTime();
    if (!this.#stopped && (this.#lastAttemptAt === null
      || now - this.#lastAttemptAt >= AGENT_MODEL_REFRESH_INTERVAL_MS)) {
      await this.refresh();
    } else if (this.#inFlight) {
      await this.#inFlight;
    }
    return this.snapshot();
  }

  async refresh(): Promise<void> {
    if (this.#stopped) return;
    if (this.#inFlight) return await this.#inFlight;
    const controller = new AbortController();
    this.#refreshController = controller;
    const run = this.refreshInternal(controller.signal);
    this.#inFlight = run;
    try {
      await run;
    } finally {
      if (this.#inFlight === run) this.#inFlight = null;
      if (this.#refreshController === controller) this.#refreshController = null;
    }
  }

  private async refreshInternal(signal: AbortSignal): Promise<void> {
    const refreshedAt = this.#now().toISOString();
    this.#lastAttemptAt = Date.parse(refreshedAt);
    let changed = false;
    await Promise.all(this.#discoverers.map(async (discoverer) => {
      const current = this.#entries.get(discoverer.provider)!;
      try {
        const models = normalizeModels(await discoverer.discover(signal));
        if (models.length === 0) throw new Error('Provider returned no models');
        changed ||= current.refreshedAt !== refreshedAt || !sameModels(current.models, models) || current.stale;
        this.#entries.set(discoverer.provider, { models, refreshedAt, stale: false });
        this.#logger.info('Agent model catalog refreshed', {
          provider: discoverer.provider,
          modelCount: models.length,
        });
      } catch (error) {
        if (!signal.aborted) {
          changed ||= !current.stale;
          current.stale = true;
          this.#logger.warn('Agent model catalog refresh failed', {
            provider: discoverer.provider,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }));
    if (changed && !signal.aborted) this.#onUpdated?.(this.snapshot());
  }

  private snapshot(): AgentModelCatalogSnapshot {
    const providers: AgentModelProviderCatalog[] = this.#discoverers.map((discoverer) => {
      const entry = this.#entries.get(discoverer.provider)!;
      return {
        provider: discoverer.provider,
        models: entry.models.map((model) => ({ ...model })),
        refreshedAt: entry.refreshedAt,
        stale: entry.stale,
      };
    });
    return {
      refreshIntervalSeconds: AGENT_MODEL_REFRESH_INTERVAL_MS / 1_000,
      providers,
    };
  }
}

export interface CodexModelDiscovererOptions {
  workspaceRoot: string;
  command?: string;
  args?: readonly string[];
  timeoutMs?: number;
}

export class CodexModelDiscoverer implements AgentModelDiscoverer {
  readonly provider = 'codex' as const;
  readonly #workspaceRoot: string;
  readonly #command: string;
  readonly #args: readonly string[];
  readonly #timeoutMs: number;

  constructor(options: CodexModelDiscovererOptions) {
    this.#workspaceRoot = options.workspaceRoot;
    this.#command = options.command ?? 'codex';
    this.#args = options.args ?? ['app-server', '--stdio'];
    this.#timeoutMs = options.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  }

  discover(signal?: AbortSignal): Promise<readonly AgentModel[]> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#command, [...this.#args], {
        cwd: this.#workspaceRoot,
        env: process.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const lines = createInterface({ input: child.stdout });
      const models: AgentModel[] = [];
      let requestId = 1;
      let pendingModelRequestId: number | null = null;
      let settled = false;

      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        lines.close();
        child.stdin.end();
        if (child.exitCode === null && child.signalCode === null) child.kill();
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(models);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const abort = () => fail(new Error('Codex model discovery was cancelled'));
      const write = (message: Record<string, unknown>) => {
        if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
      };
      const requestPage = (cursor?: string) => {
        pendingModelRequestId = ++requestId;
        write({
          method: 'model/list',
          id: pendingModelRequestId,
          params: {
            includeHidden: false,
            limit: 100,
            ...(cursor ? { cursor } : {}),
          },
        });
      };
      const timeout = setTimeout(
        () => fail(new Error(`Codex model discovery timed out after ${this.#timeoutMs}ms`)),
        this.#timeoutMs,
      );
      timeout.unref();
      signal?.addEventListener('abort', abort, { once: true });

      child.once('error', (error) => fail(new Error(`Could not start Codex model discovery: ${error.message}`)));
      child.stdin.once('error', () => fail(new Error('Codex model discovery input closed unexpectedly')));
      child.once('close', (exitCode) => {
        if (!settled) fail(new Error(`Codex model discovery exited before responding (exit ${exitCode ?? 'unknown'})`));
      });
      lines.on('line', (line) => {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (!isRecord(message) || typeof message.id !== 'number') return;
        if (message.id === 1) {
          if (message.error !== undefined) {
            fail(new Error('Codex model discovery initialization failed'));
            return;
          }
          write({ method: 'initialized', params: {} });
          requestPage();
          return;
        }
        if (message.id !== pendingModelRequestId) return;
        if (message.error !== undefined || !isRecord(message.result) || !Array.isArray(message.result.data)) {
          fail(new Error('Codex model discovery returned an invalid response'));
          return;
        }
        for (const value of message.result.data) {
          const model = codexModel(value);
          if (model) models.push(model);
        }
        const nextCursor = message.result.nextCursor;
        if (typeof nextCursor === 'string' && nextCursor) requestPage(nextCursor);
        else succeed();
      });

      write({
        method: 'initialize',
        id: 1,
        params: { clientInfo: { name: 'code-factory', version: '0.1.0' } },
      });
      if (signal?.aborted) abort();
    });
  }
}

export interface ClaudeCodeModelDiscovererOptions {
  environment?: Readonly<NodeJS.ProcessEnv>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const CLAUDE_CODE_ALIASES: readonly AgentModel[] = [
  { id: 'best', displayName: 'Best', description: 'Most capable available Claude model' },
  { id: 'sonnet', displayName: 'Sonnet', description: 'Latest Sonnet model' },
  { id: 'opus', displayName: 'Opus', description: 'Latest Opus model' },
  { id: 'haiku', displayName: 'Haiku', description: 'Fast Claude model' },
  { id: 'sonnet[1m]', displayName: 'Sonnet (1M context)', description: 'Latest Sonnet model with a 1M context window' },
  { id: 'opus[1m]', displayName: 'Opus (1M context)', description: 'Latest Opus model with a 1M context window' },
  { id: 'opusplan', displayName: 'Opus Plan', description: 'Opus for planning and Sonnet for execution' },
];

export class ClaudeCodeModelDiscoverer implements AgentModelDiscoverer {
  readonly provider = 'claude-code' as const;
  readonly fallbackModels: readonly AgentModel[];
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: ClaudeCodeModelDiscovererOptions = {}) {
    this.#environment = options.environment ?? process.env;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
    this.fallbackModels = normalizeModels([
      ...CLAUDE_CODE_ALIASES,
      ...configuredClaudeModels(this.#environment),
    ]);
  }

  async discover(signal?: AbortSignal): Promise<readonly AgentModel[]> {
    const apiKey = this.#environment.ANTHROPIC_API_KEY;
    const oauthToken = this.#environment.CLAUDE_CODE_OAUTH_TOKEN;
    const discoverGateway = this.#environment.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === '1';
    if (!apiKey && !oauthToken && !discoverGateway) return this.fallbackModels;

    const baseUrl = (this.#environment.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '');
    const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' };
    if (apiKey) headers['x-api-key'] = apiKey;
    else if (oauthToken) headers.authorization = `Bearer ${oauthToken}`;
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const response = await this.#fetch(`${baseUrl}/v1/models?limit=1000`, {
      headers,
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    });
    if (!response.ok) throw new Error(`Claude model discovery returned HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body.data)) {
      throw new Error('Claude model discovery returned an invalid response');
    }
    return normalizeModels([
      ...this.fallbackModels,
      ...body.data.flatMap((value) => {
        if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()) return [];
        const displayName = typeof value.display_name === 'string' && value.display_name.trim()
          ? value.display_name.trim()
          : value.id.trim();
        return [{ id: value.id.trim(), displayName, description: null }];
      }),
    ]);
  }
}

function configuredClaudeModels(environment: Readonly<NodeJS.ProcessEnv>): AgentModel[] {
  const variables = [
    ['ANTHROPIC_MODEL', 'Configured model'],
    ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'Configured Opus model'],
    ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'Configured Sonnet model'],
    ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'Configured Haiku model'],
    ['ANTHROPIC_CUSTOM_MODEL_OPTION', environment.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME ?? 'Custom model'],
  ] as const;
  return variables.flatMap(([name, displayName]) => {
    const value = environment[name]?.trim();
    return value ? [{ id: value, displayName, description: null }] : [];
  });
}

function codexModel(value: unknown): AgentModel | null {
  if (!isRecord(value)) return null;
  const id = typeof value.model === 'string' && value.model.trim()
    ? value.model.trim()
    : typeof value.id === 'string' ? value.id.trim() : '';
  if (!id) return null;
  return {
    id,
    displayName: typeof value.displayName === 'string' && value.displayName.trim()
      ? value.displayName.trim()
      : id,
    description: typeof value.description === 'string' && value.description.trim()
      ? value.description.trim()
      : null,
  };
}

function normalizeModels(models: readonly AgentModel[]): AgentModel[] {
  const seen = new Set<string>();
  const normalized: AgentModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push({
      id,
      displayName: model.displayName.trim() || id,
      description: model.description?.trim() || null,
    });
  }
  return normalized;
}

function sameModels(left: readonly AgentModel[], right: readonly AgentModel[]): boolean {
  return left.length === right.length && left.every((model, index) => {
    const other = right[index];
    return other !== undefined
      && model.id === other.id
      && model.displayName === other.displayName
      && model.description === other.description;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
