import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { acquireWorkspaceLock } from './workspace-lock.js';

export type DaemonStatus = 'starting' | 'running' | 'restarting' | 'stopping';

export interface DaemonState {
  version: 1;
  workspaceRoot: string;
  supervisorPid: number;
  managerPid: number | null;
  status: DaemonStatus;
  managerArgs: string[];
  startedAt: string;
  updatedAt: string;
  restartCount: number;
  nextRestartAt: string | null;
  dashboardUrl: string | null;
  apiUrl: string | null;
  lastExitCode: number | null;
  lastExitSignal: string | null;
}

export interface DaemonPaths {
  directory: string;
  stateFile: string;
  lockFile: string;
  lockGuardFile: string;
  logFile: string;
}

export interface DaemonInspection {
  running: boolean;
  state: DaemonState | null;
  paths: DaemonPaths;
}

export interface StartDaemonResult {
  state: DaemonState;
  paths: DaemonPaths;
  alreadyRunning: boolean;
}

export interface StopDaemonResult {
  stopped: boolean;
  paths: DaemonPaths;
}

interface DaemonReadyMessage {
  type: 'code-factory-agent-manager-ready';
  dashboardUrl: string;
  apiUrl: string;
}

interface DaemonStartupFailureMessage {
  type: 'code-factory-agent-manager-startup-failed';
  message: string;
}

interface DaemonLock {
  release(): void;
}

const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 12_000;
const FORCE_KILL_DELAY_MS = 10_000;
const STABLE_RUNTIME_MS = 30_000;

export function defaultDaemonPaths(workspaceRoot: string, homeDirectory = homedir()): DaemonPaths {
  const canonicalWorkspace = realpathSync(workspaceRoot);
  const key = createHash('sha256').update(canonicalWorkspace).digest('hex').slice(0, 16);
  const directory = join(homeDirectory, '.code-factory', 'workspaces', key);
  return {
    directory,
    stateFile: join(directory, 'daemon.json'),
    lockFile: join(directory, 'daemon.lock'),
    lockGuardFile: join(directory, 'daemon.guard.sqlite'),
    logFile: join(directory, 'logs', 'daemon.log'),
  };
}

export function readDaemonState(stateFile: string): DaemonState | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (!isRecord(parsed)) return null;
    if (parsed.version !== 1
      || typeof parsed.workspaceRoot !== 'string'
      || !isPositiveInteger(parsed.supervisorPid)
      || !(parsed.managerPid === null || isPositiveInteger(parsed.managerPid))
      || !isDaemonStatus(parsed.status)
      || !Array.isArray(parsed.managerArgs)
      || !parsed.managerArgs.every((value) => typeof value === 'string')
      || typeof parsed.startedAt !== 'string'
      || typeof parsed.updatedAt !== 'string'
      || !Number.isInteger(parsed.restartCount)
      || Number(parsed.restartCount) < 0
      || !(parsed.nextRestartAt === null || typeof parsed.nextRestartAt === 'string')
      || !(parsed.dashboardUrl === null || typeof parsed.dashboardUrl === 'string')
      || !(parsed.apiUrl === null || typeof parsed.apiUrl === 'string')
      || !(parsed.lastExitCode === null
        || (typeof parsed.lastExitCode === 'number' && Number.isInteger(parsed.lastExitCode)))
      || !(parsed.lastExitSignal === null || typeof parsed.lastExitSignal === 'string')) {
      return null;
    }
    return {
      version: 1,
      workspaceRoot: parsed.workspaceRoot,
      supervisorPid: parsed.supervisorPid,
      managerPid: parsed.managerPid,
      status: parsed.status,
      managerArgs: [...parsed.managerArgs],
      startedAt: parsed.startedAt,
      updatedAt: parsed.updatedAt,
      restartCount: Number(parsed.restartCount),
      nextRestartAt: parsed.nextRestartAt,
      dashboardUrl: parsed.dashboardUrl,
      apiUrl: parsed.apiUrl,
      lastExitCode: parsed.lastExitCode,
      lastExitSignal: parsed.lastExitSignal,
    };
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function inspectDaemon(workspaceRoot = process.cwd()): DaemonInspection {
  const canonicalWorkspace = realpathSync(workspaceRoot);
  const paths = defaultDaemonPaths(canonicalWorkspace);
  const state = readDaemonState(paths.stateFile);
  const stateMatchesWorkspace = state?.workspaceRoot === canonicalWorkspace;
  return {
    running: Boolean(stateMatchesWorkspace && state && isProcessAlive(state.supervisorPid)),
    state: stateMatchesWorkspace ? state : null,
    paths,
  };
}

export async function startDaemon(
  managerArgs: readonly string[],
  options: { workspaceRoot?: string; timeoutMs?: number } = {},
): Promise<StartDaemonResult> {
  const workspaceRoot = realpathSync(options.workspaceRoot ?? process.cwd());
  const initial = inspectDaemon(workspaceRoot);
  if (initial.running && initial.state?.status === 'running') {
    return { state: initial.state, paths: initial.paths, alreadyRunning: true };
  }

  let expectedSupervisorPid = initial.running ? initial.state?.supervisorPid ?? null : null;
  let alreadyRunning = initial.running;
  if (!initial.running) {
    const cliPath = process.argv[1];
    if (!cliPath) throw new Error('Unable to resolve the Agent Manager CLI path');
    const canonicalCliPath = realpathSync(cliPath);
    const supervisor = spawn(
      process.execPath,
      [...process.execArgv, canonicalCliPath, '__daemon', ...managerArgs],
      {
        cwd: workspaceRoot,
        detached: true,
        env: process.env,
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    if (supervisor.pid === undefined) throw new Error('Unable to start the daemon supervisor');
    expectedSupervisorPid = supervisor.pid;
    supervisor.unref();
  }

  const deadline = Date.now() + (options.timeoutMs ?? START_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const inspection = inspectDaemon(workspaceRoot);
    const observedSupervisorPid = inspection.running ? inspection.state?.supervisorPid ?? null : null;
    if (observedSupervisorPid !== null && observedSupervisorPid !== expectedSupervisorPid) {
      expectedSupervisorPid = observedSupervisorPid;
      alreadyRunning = true;
    }
    if (inspection.running && inspection.state?.status === 'running') {
      return {
        state: inspection.state,
        paths: inspection.paths,
        alreadyRunning,
      };
    }
    if (expectedSupervisorPid !== null && !isProcessAlive(expectedSupervisorPid)) {
      assertWorkspaceAvailable(workspaceRoot);
      throw new Error(`Daemon supervisor exited before Agent Manager became ready; inspect ${inspection.paths.logFile}`);
    }
    await delay(50);
  }

  throw new Error(`Agent Manager did not become ready within ${options.timeoutMs ?? START_TIMEOUT_MS}ms; inspect ${initial.paths.logFile}`);
}

export async function stopDaemon(
  workspaceRoot = process.cwd(),
  timeoutMs = STOP_TIMEOUT_MS,
): Promise<StopDaemonResult> {
  const inspection = inspectDaemon(workspaceRoot);
  if (!inspection.running || !inspection.state) {
    return { stopped: false, paths: inspection.paths };
  }

  const { supervisorPid, managerPid } = inspection.state;
  signalPid(supervisorPid, 'SIGTERM');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isProcessAlive(supervisorPid)) await delay(50);

  if (isProcessAlive(supervisorPid)) {
    if (managerPid !== null) signalPid(managerPid, 'SIGKILL');
    signalPid(supervisorPid, 'SIGKILL');
    const forceDeadline = Date.now() + 2_000;
    while (Date.now() < forceDeadline && isProcessAlive(supervisorPid)) await delay(50);
  }
  if (isProcessAlive(supervisorPid)) throw new Error(`Unable to stop daemon supervisor process ${supervisorPid}`);

  return { stopped: true, paths: inspection.paths };
}

export async function runDaemonSupervisor(managerArgs: readonly string[]): Promise<void> {
  const workspaceRoot = realpathSync(process.cwd());
  const paths = defaultDaemonPaths(workspaceRoot);
  mkdirSync(dirname(paths.logFile), { recursive: true, mode: 0o700 });
  const logFd = openSync(paths.logFile, 'a', 0o600);
  chmodSync(paths.logFile, 0o600);

  let lock: DaemonLock | null = null;
  let child: ChildProcess | null = null;
  let stopping = false;
  let stopResolver: (() => void) | null = null;
  const stopRequested = new Promise<void>((resolveStop) => { stopResolver = resolveStop; });
  let forceKillTimer: NodeJS.Timeout | null = null;
  const startedAt = new Date().toISOString();
  let restartCount = 0;
  let consecutiveFailures = 0;
  let state: DaemonState = {
    version: 1,
    workspaceRoot,
    supervisorPid: process.pid,
    managerPid: null,
    status: 'starting',
    managerArgs: [...managerArgs],
    startedAt,
    updatedAt: startedAt,
    restartCount,
    nextRestartAt: null,
    dashboardUrl: null,
    apiUrl: null,
    lastExitCode: null,
    lastExitSignal: null,
  };

  const updateState = (changes: Partial<DaemonState>) => {
    state = { ...state, ...changes, updatedAt: new Date().toISOString() };
    writeDaemonState(paths.stateFile, state);
  };
  const requestStop = () => {
    if (stopping) return;
    stopping = true;
    updateState({ status: 'stopping', nextRestartAt: null });
    stopResolver?.();
    if (child?.pid !== undefined) {
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => child?.kill('SIGKILL'), FORCE_KILL_DELAY_MS);
      forceKillTimer.unref();
    }
  };

  try {
    lock = await acquireDaemonLockOrJoin(paths, workspaceRoot);
    if (lock === null) {
      appendDaemonEvent(logFd, 'Daemon start joined existing supervisor', { supervisorPid: process.pid, workspaceRoot });
      return;
    }
    writeDaemonState(paths.stateFile, state);
    process.once('SIGINT', requestStop);
    process.once('SIGTERM', requestStop);
    appendDaemonEvent(logFd, 'Daemon supervisor started', { supervisorPid: process.pid, workspaceRoot });

    while (!stopping) {
      const launchStartedAt = Date.now();
      let startupFailure: string | null = null;
      child = spawn(
        process.execPath,
        [...process.execArgv, resolve(process.argv[1]!), 'start', ...managerArgs],
        {
          cwd: workspaceRoot,
          env: { ...process.env, CODE_FACTORY_DAEMON_CHILD: '1' },
          shell: false,
          stdio: ['ignore', logFd, logFd, 'ipc'],
          windowsHide: true,
        },
      );
      const launchedChild = child;
      updateState({
        managerPid: launchedChild.pid ?? null,
        status: restartCount === 0 ? 'starting' : 'restarting',
        nextRestartAt: null,
      });
      appendDaemonEvent(logFd, 'Agent Manager process started', {
        managerPid: launchedChild.pid ?? null,
        restartCount,
      });

      launchedChild.on('message', (message: unknown) => {
        if (stopping || child !== launchedChild) return;
        if (isReadyMessage(message)) {
          updateState({
            status: 'running',
            dashboardUrl: message.dashboardUrl,
            apiUrl: message.apiUrl,
            nextRestartAt: null,
          });
          appendDaemonEvent(logFd, 'Agent Manager is ready', {
            managerPid: launchedChild.pid ?? null,
            dashboardUrl: message.dashboardUrl,
          });
        } else if (isStartupFailureMessage(message)) {
          startupFailure = message.message;
        }
      });

      const outcome = await childOutcome(launchedChild);
      child = null;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      forceKillTimer = null;
      appendDaemonEvent(logFd, 'Agent Manager process exited', outcome);
      if (stopping) break;
      if (startupFailure !== null) throw new Error(startupFailure);

      const runtimeMs = Date.now() - launchStartedAt;
      consecutiveFailures = runtimeMs >= STABLE_RUNTIME_MS ? 1 : consecutiveFailures + 1;
      restartCount += 1;
      const restartDelayMs = daemonRestartDelayMs(consecutiveFailures);
      updateState({
        managerPid: null,
        status: 'restarting',
        restartCount,
        nextRestartAt: new Date(Date.now() + restartDelayMs).toISOString(),
        dashboardUrl: null,
        apiUrl: null,
        lastExitCode: outcome.exitCode,
        lastExitSignal: outcome.signal,
      });
      appendDaemonEvent(logFd, 'Agent Manager restart scheduled', { restartCount, restartDelayMs });
      await waitForDelayOrStop(restartDelayMs, stopRequested);
    }
  } catch (error) {
    appendDaemonEvent(logFd, 'Daemon supervisor failed', { error: errorMessage(error) });
    throw error;
  } finally {
    if (forceKillTimer) clearTimeout(forceKillTimer);
    process.removeListener('SIGINT', requestStop);
    process.removeListener('SIGTERM', requestStop);
    if (lock !== null) {
      try {
        removeFile(paths.stateFile);
        removeFile(paths.lockFile);
      } finally {
        lock.release();
      }
    }
    appendDaemonEvent(logFd, 'Daemon supervisor stopped', { supervisorPid: process.pid });
    closeSync(logFd);
  }
}

export function daemonRestartDelayMs(consecutiveFailures: number): number {
  const exponent = Math.max(0, Math.min(5, consecutiveFailures - 1));
  return Math.min(30_000, 1_000 * (2 ** exponent));
}

function writeDaemonState(stateFile: string, state: DaemonState): void {
  mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
  const temporaryFile = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryFile, stateFile);
  chmodSync(stateFile, 0o600);
}

async function acquireDaemonLockOrJoin(paths: DaemonPaths, workspaceRoot: string): Promise<DaemonLock | null> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const lock = tryAcquireDaemonLock(paths);
    if (lock !== null) return lock;

    const state = readDaemonState(paths.stateFile);
    if (state?.workspaceRoot === workspaceRoot
      && state.supervisorPid !== process.pid
      && isProcessAlive(state.supervisorPid)) {
      return null;
    }
    await delay(50);
  }
  throw new Error('An Agent Manager daemon supervisor is already running but has not published its state');
}

function tryAcquireDaemonLock(paths: DaemonPaths): DaemonLock | null {
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(paths.lockGuardFile);
  try {
    chmodSync(paths.lockGuardFile, 0o600);
    database.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;');
  } catch (error) {
    database.close();
    if (isSqliteBusy(error)) return null;
    throw error;
  }

  try {
    const temporaryFile = `${paths.lockFile}.${process.pid}.tmp`;
    let published = false;
    writeFileSync(temporaryFile, `${process.pid}\n`, { mode: 0o600 });
    try {
      renameSync(temporaryFile, paths.lockFile);
      published = true;
      chmodSync(paths.lockFile, 0o600);
    } catch (error) {
      removeFile(temporaryFile);
      if (published) removeFile(paths.lockFile);
      throw error;
    }
  } catch (error) {
    releaseSqliteLock(database);
    throw error;
  }

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      releaseSqliteLock(database);
    },
  };
}

function releaseSqliteLock(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK;');
  } finally {
    database.close();
  }
}

function isSqliteBusy(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const sqliteError = error as { errcode?: unknown; errstr?: unknown };
  return sqliteError.errcode === 5 || sqliteError.errstr === 'database is locked';
}

function childOutcome(childProcess: ChildProcess): Promise<{ exitCode: number | null; signal: string | null }> {
  return new Promise((resolveOutcome) => {
    let settled = false;
    const settle = (exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      resolveOutcome({ exitCode, signal });
    };
    childProcess.once('error', () => settle(null, null));
    childProcess.once('close', (exitCode, signal) => settle(exitCode, signal));
  });
}

function isReadyMessage(value: unknown): value is DaemonReadyMessage {
  return isRecord(value)
    && value.type === 'code-factory-agent-manager-ready'
    && typeof value.dashboardUrl === 'string'
    && typeof value.apiUrl === 'string';
}

function isStartupFailureMessage(value: unknown): value is DaemonStartupFailureMessage {
  return isRecord(value)
    && value.type === 'code-factory-agent-manager-startup-failed'
    && typeof value.message === 'string';
}

function assertWorkspaceAvailable(workspaceRoot: string): void {
  const lock = acquireWorkspaceLock(workspaceRoot);
  lock.release();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isDaemonStatus(value: unknown): value is DaemonStatus {
  return value === 'starting' || value === 'running' || value === 'restarting' || value === 'stopping';
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitForDelayOrStop(milliseconds: number, stopRequested: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  const elapsed = new Promise<void>((resolveElapsed) => { timer = setTimeout(resolveElapsed, milliseconds); });
  await Promise.race([elapsed, stopRequested]);
  if (timer) clearTimeout(timer);
}

function appendDaemonEvent(fd: number, message: string, context: Record<string, unknown>): void {
  try {
    writeSync(fd, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: message.includes('failed') ? 'error' : 'info',
      component: 'daemon-supervisor',
      message,
      ...context,
    })}\n`);
  } catch {
    // Diagnostics must not interrupt supervision.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
