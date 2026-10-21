import { chmodSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { defaultWorkspaceDataDirectory } from './configuration.js';

export interface WorkspaceLock {
  path: string;
  release(): void;
}

export class WorkspaceAlreadyRunningError extends Error {
  readonly workspaceRoot: string;
  readonly lockPath: string;

  constructor(workspaceRoot: string, lockPath: string) {
    super(`An Agent Manager is already running for workspace ${workspaceRoot}`);
    this.name = 'WorkspaceAlreadyRunningError';
    this.workspaceRoot = workspaceRoot;
    this.lockPath = lockPath;
  }
}

export function defaultWorkspaceLockPath(workspaceRoot: string): string {
  return join(defaultWorkspaceDataDirectory(realpathSync(workspaceRoot)), 'agent-manager.lock');
}

export function acquireWorkspaceLock(
  workspaceRoot: string,
  options: { lockPath?: string } = {},
): WorkspaceLock {
  const canonicalWorkspace = realpathSync(workspaceRoot);
  const lockPath = options.lockPath ?? defaultWorkspaceLockPath(canonicalWorkspace);
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

  const database = new DatabaseSync(lockPath);
  try {
    chmodSync(lockPath, 0o600);
    database.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;');
  } catch (error) {
    database.close();
    if (isSqliteBusy(error)) throw new WorkspaceAlreadyRunningError(canonicalWorkspace, lockPath);
    throw error;
  }

  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      try {
        database.exec('ROLLBACK;');
      } finally {
        database.close();
      }
    },
  };
}

function isSqliteBusy(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const sqliteError = error as { errcode?: unknown; errstr?: unknown };
  return sqliteError.errcode === 5 || sqliteError.errstr === 'database is locked';
}
