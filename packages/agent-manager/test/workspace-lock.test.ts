import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  acquireWorkspaceLock,
  WorkspaceAlreadyRunningError,
} from '../src/workspace-lock.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'src', 'cli.ts');
const tsxImport = import.meta.resolve('tsx');

test('workspace lock allows only one Agent Manager regardless of its network configuration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-workspace-lock-'));
  const workspace = join(directory, 'workspace');
  const lockPath = join(directory, 'data', 'agent-manager.lock');
  mkdirSync(workspace);

  try {
    const first = acquireWorkspaceLock(workspace, { lockPath });
    assert.equal(first.path, lockPath);
    assert.equal(statSync(lockPath).mode & 0o777, 0o600);

    assert.throws(
      () => acquireWorkspaceLock(workspace, { lockPath }),
      (error: unknown) => error instanceof WorkspaceAlreadyRunningError
        && error.workspaceRoot === realpathSync(workspace)
        && error.lockPath === lockPath,
    );

    first.release();
    first.release();
    const replacement = acquireWorkspaceLock(workspace, { lockPath });
    replacement.release();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a second foreground CLI start fails for the same workspace on a different port', { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-workspace-cli-lock-'));
  const workspace = join(directory, 'workspace');
  const fakeHome = join(directory, 'home');
  const firstPort = await reservePort();
  let secondPort = await reservePort();
  while (secondPort === firstPort) secondPort = await reservePort();
  const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
  mkdirSync(workspace);
  let first: ChildProcess | null = null;

  try {
    first = startCli(firstPort, workspace, env);
    await waitForOutput(first, /Agent Manager .* started/);

    const duplicate = spawnSync(
      process.execPath,
      ['--import', tsxImport, cliPath, 'start', '--port', String(secondPort), '--pr-reconcile-interval', '0', '--log-level', 'silent'],
      { cwd: workspace, env, encoding: 'utf8', timeout: 10_000 },
    );
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /already running for workspace/);

    const daemonDuplicate = spawnSync(
      process.execPath,
      ['--import', tsxImport, cliPath, 'start', '--daemon', '--port', String(secondPort), '--pr-reconcile-interval', '0', '--log-level', 'silent'],
      { cwd: workspace, env, encoding: 'utf8', timeout: 10_000 },
    );
    assert.equal(daemonDuplicate.status, 1);
    assert.match(daemonDuplicate.stderr, /already running for workspace/);

    first.kill('SIGTERM');
    assert.equal(await waitForExit(first), 0);
    first = null;

    const replacement = startCli(secondPort, workspace, env);
    first = replacement;
    await waitForOutput(replacement, /Agent Manager .* started/);
  } finally {
    if (first && first.exitCode === null) {
      first.kill('SIGTERM');
      await waitForExit(first);
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

function startCli(port: number, cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(
    process.execPath,
    ['--import', tsxImport, cliPath, 'start', '--port', String(port), '--pr-reconcile-interval', '0', '--log-level', 'silent'],
    { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function waitForOutput(child: ChildProcess, pattern: RegExp, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolveOutput, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for CLI output: ${output}`)), timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (!pattern.test(output)) return;
      clearTimeout(timer);
      resolveOutput();
    });
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`CLI exited before startup with code ${code ?? '-'} and signal ${signal ?? '-'}: ${output}`));
    });
  });
}

function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for CLI to exit')), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
}

async function reservePort(): Promise<number> {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolveClose, reject) => server.close((error) => (
    error ? reject(error) : resolveClose()
  )));
  return address.port;
}
