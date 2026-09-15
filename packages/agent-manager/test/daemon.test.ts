import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  daemonRestartDelayMs,
  defaultDaemonPaths,
  isProcessAlive,
  readDaemonState,
  type DaemonState,
} from '../src/daemon.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'src', 'cli.ts');
const tsxImport = import.meta.resolve('tsx');

test('daemon state parsing rejects malformed or incomplete state', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-daemon-state-'));
  const stateFile = join(directory, 'daemon.json');
  try {
    writeFileSync(stateFile, '{"version":1,"supervisorPid":"wrong"}');
    assert.equal(readDaemonState(stateFile), null);

    const state: DaemonState = {
      version: 1,
      workspaceRoot: '/workspace/repo',
      supervisorPid: 123,
      managerPid: 456,
      status: 'running',
      managerArgs: ['--port', '4310'],
      startedAt: '2026-09-12T00:00:00.000Z',
      updatedAt: '2026-09-12T00:00:01.000Z',
      restartCount: 2,
      nextRestartAt: null,
      dashboardUrl: 'http://127.0.0.1:4310/',
      apiUrl: 'http://127.0.0.1:4310/api',
      lastExitCode: 1,
      lastExitSignal: null,
    };
    writeFileSync(stateFile, JSON.stringify(state));
    assert.deepEqual(readDaemonState(stateFile), state);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('daemon restart delay uses capped exponential backoff', () => {
  assert.equal(daemonRestartDelayMs(1), 1_000);
  assert.equal(daemonRestartDelayMs(2), 2_000);
  assert.equal(daemonRestartDelayMs(3), 4_000);
  assert.equal(daemonRestartDelayMs(6), 30_000);
  assert.equal(daemonRestartDelayMs(100), 30_000);
});

test('concurrent daemon starts converge on one supervisor', { timeout: 35_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-daemon-concurrent-start-'));
  const workspace = join(directory, 'workspace');
  const fakeHome = join(directory, 'home');
  const port = await reservePort();
  const env = {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
  };
  mkdirSync(workspace, { recursive: true });
  const paths = defaultDaemonPaths(workspace, fakeHome);
  let supervisorPid: number | null = null;
  let managerPid: number | null = null;

  try {
    const args = ['start', '--daemon', '--port', String(port), '--pr-reconcile-interval', '0', '--log-level', 'silent'];
    const results = await Promise.all([
      runCliAsync(args, workspace, env),
      runCliAsync(args, workspace, env),
    ]);

    for (const result of results) {
      const daemonLog = existsSync(paths.logFile) ? readFileSync(paths.logFile, 'utf8') : '(daemon log missing)';
      const daemonLock = existsSync(paths.lockFile) ? readFileSync(paths.lockFile, 'utf8') : '(daemon lock missing)';
      assert.equal(result.status, 0, `${result.stderr}\ndaemon lock: ${daemonLock}\n${daemonLog}`);
    }
    assert.equal(results.filter((result) => /daemon started/.test(result.stdout)).length, 1);
    assert.equal(results.filter((result) => /already running/.test(result.stdout)).length, 1);

    const state = readDaemonState(paths.stateFile);
    assert.equal(state?.status, 'running');
    assert.ok(state.managerPid);
    supervisorPid = state.supervisorPid;
    managerPid = state.managerPid;
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
  } finally {
    if (existsSync(paths.stateFile)) runCli(['stop'], workspace, env, 20_000);
    const remainingState = readDaemonState(paths.stateFile);
    const remainingManagerPid = remainingState?.managerPid ?? managerPid;
    const remainingSupervisorPid = remainingState?.supervisorPid ?? supervisorPid;
    if (remainingManagerPid !== null && isProcessAlive(remainingManagerPid)) process.kill(remainingManagerPid, 'SIGKILL');
    if (remainingSupervisorPid !== null && isProcessAlive(remainingSupervisorPid)) process.kill(remainingSupervisorPid, 'SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  }
});

test('daemon starts in the background, restarts a crashed manager, and stops cleanly', { timeout: 35_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-daemon-integration-'));
  const workspace = join(directory, 'workspace');
  const fakeHome = join(directory, 'home');
  const port = await reservePort();
  const env = {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
  };
  mkdirSync(workspace, { recursive: true });
  const paths = defaultDaemonPaths(workspace, fakeHome);
  mkdirSync(dirname(paths.logFile), { recursive: true });
  writeFileSync(paths.logFile, 'previous daemon diagnostics\n');
  let supervisorPid: number | null = null;
  let managerPid: number | null = null;

  try {
    const started = runCli(
      ['start', '--daemon', '--port', String(port), '--pr-reconcile-interval', '0', '--log-level', 'silent'],
      workspace,
      env,
    );
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, /daemon started/);

    const initial = readDaemonState(paths.stateFile);
    assert.ok(initial);
    assert.equal(initial.status, 'running');
    assert.ok(initial.managerPid);
    supervisorPid = initial.supervisorPid;
    managerPid = initial.managerPid;
    assert.equal(statSync(paths.stateFile).mode & 0o777, 0o600);
    assert.equal(statSync(paths.logFile).mode & 0o777, 0o600);
    assert.match(readFileSync(paths.logFile, 'utf8'), /^previous daemon diagnostics\n/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);

    let duplicatePort = await reservePort();
    while (duplicatePort === port) duplicatePort = await reservePort();
    const duplicate = runCli(
      ['start', '--daemon', '--port', String(duplicatePort), '--pr-reconcile-interval', '0', '--log-level', 'silent'],
      workspace,
      env,
    );
    assert.equal(duplicate.status, 0, duplicate.stderr);
    assert.match(duplicate.stdout, /already running/);
    assert.equal(readDaemonState(paths.stateFile)?.supervisorPid, supervisorPid);

    const foregroundDuplicate = runCli(
      ['start', '--port', String(await reservePort()), '--pr-reconcile-interval', '0', '--log-level', 'silent'],
      workspace,
      env,
    );
    assert.equal(foregroundDuplicate.status, 1);
    assert.match(foregroundDuplicate.stderr, /already running for workspace/);

    const status = runCli(['status'], workspace, env);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, new RegExp(`Manager PID:\\s+${managerPid}`));

    const crashedManagerPid = managerPid;
    process.kill(crashedManagerPid, 'SIGKILL');
    const restarted = await waitForState(paths.stateFile, (state) => (
      state.status === 'running'
      && state.managerPid !== null
      && state.managerPid !== crashedManagerPid
      && state.restartCount >= 1
    ));
    assert.notEqual(restarted.managerPid, crashedManagerPid);
    managerPid = restarted.managerPid;
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);

    const restartedByCommand = runCli(['restart'], workspace, env);
    assert.equal(restartedByCommand.status, 0, restartedByCommand.stderr);
    assert.match(restartedByCommand.stdout, /daemon restarted/);
    const commandRestartState = readDaemonState(paths.stateFile);
    assert.ok(commandRestartState?.managerPid);
    assert.notEqual(commandRestartState.managerPid, managerPid);
    managerPid = commandRestartState.managerPid;
    supervisorPid = commandRestartState.supervisorPid;
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);

    const stopped = runCli(['stop'], workspace, env, 20_000);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /daemon stopped/);
    assert.equal(existsSync(paths.stateFile), false);
    assert.equal(isProcessAlive(supervisorPid), false);

    const inactive = runCli(['status'], workspace, env);
    assert.equal(inactive.status, 3);
    assert.match(inactive.stdout, /not running/);

    const daemonLog = readFileSync(paths.logFile, 'utf8');
    assert.match(daemonLog, /Agent Manager process exited/);
    assert.match(daemonLog, /Agent Manager restart scheduled/);
  } finally {
    if (existsSync(paths.stateFile)) runCli(['stop'], workspace, env, 20_000);
    const remainingState = readDaemonState(paths.stateFile);
    const remainingManagerPid = remainingState?.managerPid ?? managerPid;
    const remainingSupervisorPid = remainingState?.supervisorPid ?? supervisorPid;
    if (remainingManagerPid !== null && isProcessAlive(remainingManagerPid)) process.kill(remainingManagerPid, 'SIGKILL');
    if (remainingSupervisorPid !== null && isProcessAlive(remainingSupervisorPid)) process.kill(remainingSupervisorPid, 'SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  }
});

function runCliAsync(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout = 20_000,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['--import', tsxImport, cliPath, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timed out waiting for CLI: ${stderr}`));
    }, timeout);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (status) => {
      clearTimeout(timer);
      resolveRun({ status, stdout, stderr });
    });
  });
}

function runCli(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout = 20_000,
): ReturnType<typeof spawnSync> & { stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--import', tsxImport, cliPath, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
  });
  return result as ReturnType<typeof spawnSync> & { stdout: string; stderr: string };
}

async function reservePort(): Promise<number> {
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

async function waitForState(
  stateFile: string,
  predicate: (state: DaemonState) => boolean,
  timeoutMs = 10_000,
): Promise<DaemonState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readDaemonState(stateFile);
    if (state && predicate(state)) return state;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Daemon state did not reach the expected value: ${stateFile}`);
}
