import { closeSync, chmodSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
  }

  save(reference: string, apiKey: string): void {
    this.#db.prepare('INSERT INTO e2b_credentials (reference, api_key) VALUES (?, ?)').run(reference, apiKey);
  }

  read(reference: string): string | null {
    const row = this.#db.prepare('SELECT api_key FROM e2b_credentials WHERE reference = ?').get(reference) as
      { api_key: string } | undefined;
    return row?.api_key ?? null;
  }

  delete(reference: string): void {
    this.#db.prepare('DELETE FROM e2b_credentials WHERE reference = ?').run(reference);
  }

  close(): void { this.#db.close(); }
}
