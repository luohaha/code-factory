import { closeSync, chmodSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createModels } from '@earendil-works/pi-ai/models';
import type { Credential, CredentialInfo, CredentialStore, AuthOperationOptions } from '@earendil-works/pi-ai';
import type { MutableModels } from '@earendil-works/pi-ai/models';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';

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

export function createNativeModels(credentials: CredentialStore): MutableModels {
  const models = createModels({ credentials });
  models.setProvider(openaiProvider());
  models.setProvider(anthropicProvider());
  models.setProvider(openaiCodexProvider());
  return models;
}
