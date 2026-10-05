import { closeSync, chmodSync, mkdirSync, openSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import type { Credential, CredentialInfo, CredentialStore, AuthOperationOptions } from '@earendil-works/pi-ai';
import type { MutableModels } from '@earendil-works/pi-ai/models';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';

export type NativeApiFormat = 'openai' | 'anthropic';
export interface NativeApiProfile {
  id: string;
  format: NativeApiFormat;
  baseUrl: string;
  modelName: string;
}
export interface NativeApiProfileSecret extends NativeApiProfile { apiKey: string }

export function profileModel(profileId: string): string { return `profile:${profileId}`; }
export function profileIdFromModel(model: string | null): string | null {
  return model?.startsWith('profile:') ? model.slice('profile:'.length) : null;
}

/** Profile metadata and secrets share one owner-only database and are never returned together to the browser. */
export class NativeProfileStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const handle = openSync(path, 'a', 0o600);
    closeSync(handle);
    chmodSync(path, 0o600);
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA busy_timeout = 5000');
    this.#db.exec(`CREATE TABLE IF NOT EXISTS native_profiles (
      id TEXT PRIMARY KEY, format TEXT NOT NULL CHECK(format IN ('openai', 'anthropic')),
      base_url TEXT NOT NULL, api_key TEXT NOT NULL, model_name TEXT NOT NULL,
      created_at TEXT NOT NULL) STRICT`);
    const legacyTable = this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'native_credentials'").get();
    if (legacyTable) {
      const rows = this.#db.prepare("SELECT provider_id, credential_json FROM native_credentials WHERE provider_id IN ('openai', 'anthropic')").all();
      for (const row of rows) {
        let credential: Credential;
        try { credential = JSON.parse(String(row.credential_json)) as Credential; } catch { continue; }
        if (credential.type !== 'api_key' || !credential.key) continue;
        const format = String(row.provider_id) as NativeApiFormat;
        this.#db.prepare('INSERT OR IGNORE INTO native_profiles (id, format, base_url, api_key, model_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(`legacy-${format}`, format, format === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com',
            credential.key, format === 'openai' ? 'gpt-5.4' : 'claude-sonnet-4-6', '1970-01-01T00:00:00.000Z');
      }
    }
  }

  list(): NativeApiProfile[] {
    const rows = this.#db.prepare('SELECT id, format, base_url, model_name FROM native_profiles ORDER BY created_at, id').all();
    return rows.map((row) => ({ id: String(row.id), format: String(row.format) as NativeApiFormat,
      baseUrl: String(row.base_url), modelName: String(row.model_name) }));
  }

  get(id: string): NativeApiProfileSecret | null {
    const row = this.#db.prepare('SELECT * FROM native_profiles WHERE id = ?').get(id);
    return row ? { id: String(row.id), format: String(row.format) as NativeApiFormat,
      baseUrl: String(row.base_url), modelName: String(row.model_name), apiKey: String(row.api_key) } : null;
  }

  save(input: { id?: string; format: NativeApiFormat; baseUrl: string; apiKey: string; modelName: string }): NativeApiProfile {
    if (input.format !== 'openai' && input.format !== 'anthropic') throw new TypeError('format must be openai or anthropic');
    const baseUrl = input.baseUrl.trim();
    const apiKey = input.apiKey.trim();
    const modelName = input.modelName.trim();
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw new TypeError('baseUrl must be an absolute HTTP URL'); }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash) {
      throw new TypeError('baseUrl must be an HTTP URL without credentials, query, or fragment');
    }
    if (!apiKey || !modelName) throw new TypeError('apiKey and modelName are required');
    const id = input.id ?? randomUUID();
    if ((id === 'legacy-openai' || id === 'legacy-anthropic') && input.format !== id.slice('legacy-'.length)) {
      throw new TypeError('The format of an imported API key cannot be changed');
    }
    if (input.id) {
      const result = this.#db.prepare('UPDATE native_profiles SET format = ?, base_url = ?, api_key = ?, model_name = ? WHERE id = ?')
        .run(input.format, baseUrl, apiKey, modelName, id);
      if (!result.changes) throw new Error('Native API profile not found');
      if (id === 'legacy-openai' || id === 'legacy-anthropic') {
        this.#db.prepare('UPDATE native_credentials SET credential_json = ? WHERE provider_id = ?')
          .run(JSON.stringify({ type: 'api_key', key: apiKey }), input.format);
      }
    } else {
      this.#db.prepare('INSERT INTO native_profiles (id, format, base_url, api_key, model_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, input.format, baseUrl, apiKey, modelName, new Date().toISOString());
    }
    return { id, format: input.format, baseUrl, modelName };
  }

  delete(id: string): boolean {
    const deleted = this.#db.prepare('DELETE FROM native_profiles WHERE id = ?').run(id).changes > 0;
    if (deleted && (id === 'legacy-openai' || id === 'legacy-anthropic')) {
      this.#db.prepare('DELETE FROM native_credentials WHERE provider_id = ?').run(id.slice('legacy-'.length));
    }
    return deleted;
  }
  close(): void { this.#db.close(); }
}

export function configureNativeProfile(models: MutableModels, profile: NativeApiProfileSecret): void {
  const providerId = profileModel(profile.id);
  const api = profile.format === 'openai' ? 'openai-completions' : 'anthropic-messages';
  const model = { id: profile.modelName, name: profile.modelName, provider: providerId, api,
    baseUrl: profile.baseUrl, input: ['text', 'image'] as Array<'text' | 'image'>,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false,
    contextWindow: 200_000, maxTokens: 8192 };
  models.setProvider(createProvider({ id: providerId, name: profile.modelName, baseUrl: profile.baseUrl,
    auth: { apiKey: { name: 'API key', resolve: async ({ signal }) => {
      signal.throwIfAborted();
      return { auth: { apiKey: profile.apiKey }, source: 'saved profile' };
    } } },
    models: [model], api: profile.format === 'openai' ? openAICompletionsApi() : anthropicMessagesApi() }));
}

export function nativeAuthDatabasePath(nativeConversationDatabasePath: string): string {
  return join(dirname(nativeConversationDatabasePath), 'native-agent-auth.sqlite');
}

/** Persist pi-ai OAuth refresh tokens and entered API keys outside Requirement data. */
export class NativeCredentialStore implements CredentialStore {
  readonly #db: DatabaseSync;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const handle = openSync(path, 'a', 0o600);
    closeSync(handle);
    chmodSync(path, 0o600);
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA busy_timeout = 0');
    this.#db.exec('CREATE TABLE IF NOT EXISTS native_credentials (provider_id TEXT PRIMARY KEY, credential_json TEXT NOT NULL)');
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const row = this.#db.prepare('SELECT credential_json FROM native_credentials WHERE provider_id = ?').get(providerId) as { credential_json: string } | undefined;
    return row ? JSON.parse(row.credential_json) as Credential : undefined;
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    const rows = this.#db.prepare('SELECT provider_id, credential_json FROM native_credentials ORDER BY provider_id').all() as Array<{ provider_id: string; credential_json: string }>;
    return rows.map((row) => ({ providerId: row.provider_id, type: (JSON.parse(row.credential_json) as Credential).type }));
  }

  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.#serialize(async () => {
      options?.signal?.throwIfAborted();
      await this.#beginWrite(options);
      try {
        const current = await this.read(providerId, options);
        const next = await fn(current);
        options?.signal?.throwIfAborted();
        if (next) this.#db.prepare('INSERT INTO native_credentials (provider_id, credential_json) VALUES (?, ?) ON CONFLICT(provider_id) DO UPDATE SET credential_json = excluded.credential_json')
          .run(providerId, JSON.stringify(next));
        this.#db.exec('COMMIT');
        return next ?? current;
      } catch (error) {
        this.#db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.#serialize(async () => {
      options?.signal?.throwIfAborted();
      await this.#beginWrite(options);
      try {
        this.#db.prepare('DELETE FROM native_credentials WHERE provider_id = ?').run(providerId);
        this.#db.exec('COMMIT');
      } catch (error) {
        this.#db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    await this.#writeTail;
    this.#db.close();
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#writeTail.then(operation, operation);
    this.#writeTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async #beginWrite(options?: AuthOperationOptions): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (true) {
      options?.signal?.throwIfAborted();
      try {
        this.#db.exec('BEGIN IMMEDIATE');
        return;
      } catch (error) {
        if ((error as { errcode?: unknown }).errcode !== 5 || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }
}

export function createNativeModels(credentials?: CredentialStore): MutableModels {
  const apiKeyOnly: CredentialStore | undefined = credentials && {
    read: async (providerId, options) => {
      const credential = await credentials.read(providerId, options);
      return credential?.type === 'api_key' ? credential : undefined;
    },
    list: async (options) => (await credentials.list(options)).filter((credential) => credential.type === 'api_key'),
    modify: (providerId, fn, options) => credentials.modify(providerId, fn, options),
    delete: (providerId, options) => credentials.delete(providerId, options),
  };
  const models = createModels(apiKeyOnly ? { credentials: apiKeyOnly } : {});
  models.setProvider(openaiProvider());
  models.setProvider(anthropicProvider());
  return models;
}
