import { closeSync, chmodSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { applyEnvironmentVariablePatch, environmentVariablePatch } from './sandbox-environment.js';

export function e2bCredentialsPath(databasePath: string): string {
  return join(dirname(databasePath), 'e2b-credentials.sqlite');
}

/** The application database stores only opaque references to these owner-only secrets. */
export class E2BCredentialStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const handle = openSync(path, 'a', 0o600);
    closeSync(handle);
    chmodSync(path, 0o600);
    this.#db = new DatabaseSync(path);
    this.#db.exec('CREATE TABLE IF NOT EXISTS e2b_credentials (reference TEXT PRIMARY KEY, api_key TEXT NOT NULL) STRICT');
    const columns = this.#db.prepare('PRAGMA table_info(e2b_credentials)').all();
    if (!columns.some((column) => column.name === 'environment_json')) {
      this.#db.exec("ALTER TABLE e2b_credentials ADD COLUMN environment_json TEXT NOT NULL DEFAULT '{}'");
    }
  }

  save(reference: string, apiKey: string, environment: Readonly<Record<string, string>> = {}): void {
    this.#db.prepare('INSERT INTO e2b_credentials (reference, api_key, environment_json) VALUES (?, ?, ?)')
      .run(reference, apiKey, JSON.stringify(environment));
  }

  read(reference: string): string | null {
    const row = this.#db.prepare('SELECT api_key FROM e2b_credentials WHERE reference = ?').get(reference) as
      { api_key: string } | undefined;
    return row?.api_key ?? null;
  }

  readEnvironment(reference: string): Record<string, string> {
    const row = this.#db.prepare('SELECT environment_json FROM e2b_credentials WHERE reference = ?').get(reference);
    if (!row) return {};
    try {
      return applyEnvironmentVariablePatch({}, environmentVariablePatch(JSON.parse(String(row.environment_json))));
    } catch {
      throw new Error('Saved E2B environment variables could not be read');
    }
  }

  delete(reference: string): void {
    this.#db.prepare('DELETE FROM e2b_credentials WHERE reference = ?').run(reference);
  }

  close(): void { this.#db.close(); }
}
