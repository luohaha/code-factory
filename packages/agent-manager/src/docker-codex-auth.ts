import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Bridge macOS Codex keychain auth without replacing the user's auth.json. */
export async function dockerCodexAuth(environment: NodeJS.ProcessEnv): Promise<{
  mount: string | null;
  close(): Promise<void>;
}> {
  const home = environment.CODEX_HOME ?? join(homedir(), '.codex');
  const target = join(home, 'auth.json');
  const noBridge = { mount: null, close: async () => undefined };
  if (process.platform !== 'darwin' || !existsSync(home)) return noBridge;
  if (/[\r\n,]/.test(target)) throw new TypeError('Docker mount paths cannot contain commas or newlines');
  const account = `cli|${createHash('sha256').update(realpathSync(home)).digest('hex').slice(0, 16)}`;
  let original: string;
  try {
    original = (await exec('security', ['find-generic-password', '-s', 'Codex Auth', '-a', account, '-w'],
      { timeout: 5000, maxBuffer: 1024 * 1024 })).stdout.trim();
    const parsed: unknown = JSON.parse(original);
    if (!parsed || typeof parsed !== 'object') return noBridge;
  } catch { return noBridge; }
  const directory = await mkdtemp(join(tmpdir(), 'code-factory-codex-auth-'));
  const source = join(directory, 'auth.json');
  let placeholder: number | undefined;
  try {
    await writeFile(source, original, { mode: 0o600 });
    // A nested file mount needs a mountpoint in the shared home. Remove only our
    // untouched placeholder afterward; existing files are never overwritten.
    try { const handle = openSync(target, 'wx', 0o600); closeSync(handle); placeholder = statSync(target).ino; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  return {
    mount: `type=bind,source=${source},target=${target}`,
    close: async () => {
      try {
        const updated = await readFile(source, 'utf8');
        if (updated !== original) {
          // Preserve refreshes in the same host keychain entry for subsequent Runs.
          try { await exec('security', ['add-generic-password', '-U', '-s', 'Codex Auth', '-a', account, '-w', updated],
            { timeout: 5000, maxBuffer: 1024 * 1024 }); }
          catch { throw new Error('Could not save refreshed Docker Codex credentials to the macOS keychain'); }
        }
      } finally {
        if (placeholder !== undefined) {
          try { const current = statSync(target); if (current.ino === placeholder && current.size === 0) unlinkSync(target); } catch { /* Already removed. */ }
        }
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
