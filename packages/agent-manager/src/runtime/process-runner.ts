import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

import type { AgentAdapter, AgentInvocation, NormalizedAgentEvent, SendSteering, StreamingAgentInvocation } from './adapters/types.js';
import type { RunOutcome } from '../core/types.js';

export interface ProcessRunRequest {
  invocation: AgentInvocation;
  streamingInvocation?: StreamingAgentInvocation;
  adapter: AgentAdapter;
  workspaceRoot: string;
  environment?: Readonly<Record<string, string>>;
  timeoutMs: number;
  timeoutMode?: 'elapsed' | 'inactivity';
  maxOutputBytes: number;
  signal?: AbortSignal;
  onNativeSession?: (nativeSessionId: string) => void;
  onOutput?: (line: string) => void;
  onEvent?: (event: NormalizedAgentEvent) => void;
  onSteeringReady?: (send: SendSteering) => void;
}

export interface AgentProcessRunner {
  run(request: ProcessRunRequest): Promise<RunOutcome>;
}

function appendCapped(current: string, chunk: string, limit: number): string {
  const combined = current + chunk;
  return Buffer.byteLength(combined) <= limit
    ? combined
    : Buffer.from(combined).subarray(-limit).toString('utf8');
}

function formatDuration(milliseconds: number): string {
  if (milliseconds % 60_000 === 0) {
    const minutes = milliseconds / 60_000;
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  if (milliseconds % 1_000 === 0) {
    const seconds = milliseconds / 1_000;
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  return `${milliseconds}ms`;
}

interface ProcessSnapshot {
  pid: number;
  parentPid: number;
  groupId: number;
}

function processTable(): ProcessSnapshot[] {
  const result = spawnSync('ps', ['-Ao', 'pid=,ppid=,pgid='], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout.split('\n').flatMap((line) => {
    const fields = line.trim().split(/\s+/).map(Number);
    const [pid, parentPid, groupId] = fields;
    return pid && parentPid !== undefined && groupId ? [{ pid, parentPid, groupId }] : [];
  });
}

function descendantsOf(rootPid: number): ProcessSnapshot[] {
  const byParent = new Map<number, ProcessSnapshot[]>();
  for (const entry of processTable()) {
    const siblings = byParent.get(entry.parentPid) ?? [];
    siblings.push(entry);
    byParent.set(entry.parentPid, siblings);
  }
  const descendants: ProcessSnapshot[] = [];
  const pending = [rootPid];
  while (pending.length > 0) {
    for (const entry of byParent.get(pending.pop()!) ?? []) {
      descendants.push(entry);
      pending.push(entry.pid);
    }
  }
  return descendants;
}

function liveDescendants(captured: readonly ProcessSnapshot[], snapshot = processTable()): ProcessSnapshot[] {
  const current = new Map(snapshot.map((entry) => [entry.pid, entry]));
  return captured.filter((entry) => current.get(entry.pid)?.groupId === entry.groupId);
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals, descendants: readonly ProcessSnapshot[]): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (result.error || result.status !== 0) child.kill(signal);
    return;
  }
  const snapshot = processTable();
  const live = liveDescendants(descendants, snapshot);
  const root = snapshot.find((entry) => entry.pid === child.pid);
  if (root?.groupId !== child.pid && !live.some((entry) => entry.groupId === child.pid)) {
    child.kill(signal);
  } else {
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  }
  for (const entry of live.reverse()) {
    try { process.kill(entry.pid, signal); } catch { /* The process already exited. */ }
  }
}

function isProcessTreeAlive(child: ChildProcess, descendants: readonly ProcessSnapshot[]): boolean {
  if (child.pid === undefined || process.platform === 'win32') return false;
  if (liveDescendants(descendants).length > 0) return true;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class HeadlessProcessRunner implements AgentProcessRunner {
  async run(request: ProcessRunRequest): Promise<RunOutcome> {
    if (request.streamingInvocation && !request.signal?.aborted) {
      const outcome = await this.runProcess(request, request.streamingInvocation);
      if (outcome) return outcome;
    }
    if (request.signal?.aborted) {
      return { status: 'cancelled', exitCode: null, nativeSessionId: null, finalMessage: null, error: 'Agent Run interrupted by human' };
    }
    request.onSteeringReady?.(() => 'unsupported');
    return (await this.runProcess(request))!;
  }

  private runProcess(request: ProcessRunRequest, streaming?: StreamingAgentInvocation): Promise<RunOutcome | null> {
    return new Promise((resolve) => {
      const invocation = streaming ?? request.invocation;
      const child = spawn(invocation.command, invocation.args, {
        cwd: request.workspaceRoot,
        detached: process.platform !== 'win32',
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...request.environment },
      });

      let stdoutBuffer = '';
      let stderr = '';
      let nativeSessionId: string | null = null;
      let finalMessage: string | null = null;
      let protocolError: string | null = null;
      let termination: 'cancelled' | 'timed_out' | 'failed' | 'unsupported' | null = null;
      let forceKill: NodeJS.Timeout | null = null;
      let timeout: NodeJS.Timeout | null = null;
      let rootClose: { code: number | null; signal: NodeJS.Signals | null } | null = null;
      let rootExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
      let descendants: ProcessSnapshot[] = [];
      let forceSent = false;
      let settled = false;
      let protocolCompleted = false;
      let discardingOversizedLine = false;
      const timeoutMode = request.timeoutMode ?? 'elapsed';
      const timeoutError = timeoutMode === 'inactivity'
        ? `Agent produced no output for ${formatDuration(request.timeoutMs)}`
        : `Agent timed out after ${formatDuration(request.timeoutMs)}`;

      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        if (forceKill) clearTimeout(forceKill);
        request.signal?.removeEventListener('abort', onAbort);
      };

      const emitEvent = (event: NormalizedAgentEvent) => {
        request.onEvent?.(event);
        if (event.kind === 'error') {
          const message = event.message ?? 'Agent reported an error';
          if (message !== 'turn.failed' || !protocolError) protocolError = message;
        }
        if (event.nativeSessionId) {
          nativeSessionId = event.nativeSessionId;
          request.onNativeSession?.(event.nativeSessionId);
        }
        if (event.message) finalMessage = event.message;
      };

      const consumeLine = (line: string) => {
        if (!line.trim()) return;
        request.onOutput?.(line);
        if (protocol) protocol.receive(line);
        else {
          const event = request.adapter.parseLine(line);
          if (event) emitEvent(event);
        }
      };

      const finishClose = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (termination === 'cancelled' || (termination === 'unsupported' && request.signal?.aborted)) {
          resolve({ status: 'cancelled', exitCode: code, nativeSessionId, finalMessage, error: 'Agent Run interrupted by human' });
          return;
        }
        if (termination === 'timed_out') {
          resolve({ status: 'timed_out', exitCode: code, nativeSessionId, finalMessage, error: timeoutError });
          return;
        }
        if (termination === 'unsupported' || (streaming && !nativeSessionId && !protocolCompleted && !protocolError
          && code !== 0 && streaming.isUnsupported(stderr))) {
          resolve(null);
          return;
        }
        if (code === 0 && !protocolError && (!streaming || protocolCompleted)) {
          resolve({ status: 'succeeded', exitCode: 0, nativeSessionId, finalMessage, error: null });
          return;
        }
        const detail = protocolError || stderr.trim()
          || (code === 0 && streaming ? 'Agent stream closed before a final result' : `terminated by ${signal ?? 'unknown signal'}`);
        resolve({ status: 'failed', exitCode: code, nativeSessionId, finalMessage, error: detail });
      };

      const terminate = (reason: NonNullable<typeof termination>) => {
        if (termination || settled) return;
        termination = reason;
        descendants = child.pid === undefined || process.platform === 'win32' ? [] : descendantsOf(child.pid);
        signalProcessTree(child, 'SIGTERM', descendants);
        forceKill = setTimeout(() => {
          forceSent = true;
          signalProcessTree(child, 'SIGKILL', descendants);
          forceKill = null;
          if (rootClose || rootExit) {
            const result = rootClose ?? rootExit!;
            child.stdout.destroy();
            child.stderr.destroy();
            finishClose(result.code, result.signal);
          }
        }, 2_000);
      };
      const onAbort = () => terminate('cancelled');
      const armTimeout = () => {
        if (termination || settled) return;
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => terminate('timed_out'), request.timeoutMs);
        timeout.unref();
      };
      const recordActivity = () => {
        if (timeoutMode === 'inactivity') armTimeout();
      };

      const protocol = streaming?.connect({
        write: (message) => {
          if (termination || rootExit || settled || !child.stdin.writable) return false;
          child.stdin.write(`${JSON.stringify(message)}\n`);
          return true;
        },
        emit: emitEvent,
        endInput: () => { if (child.stdin.writable) child.stdin.end(); },
        complete: () => { protocolCompleted = true; },
        fail: (message) => {
          protocolError = message;
          terminate('failed');
        },
        unsupported: () => terminate('unsupported'),
      });

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        recordActivity();
        const lines = chunk.split('\n');
        const tail = lines.pop() ?? '';
        for (const line of lines) {
          if (!discardingOversizedLine && Buffer.byteLength(stdoutBuffer) + Buffer.byteLength(line) <= request.maxOutputBytes) {
            consumeLine((stdoutBuffer + line).replace(/\r$/, ''));
          }
          stdoutBuffer = '';
          discardingOversizedLine = false;
        }
        if (!discardingOversizedLine) {
          discardingOversizedLine = Buffer.byteLength(stdoutBuffer) + Buffer.byteLength(tail) > request.maxOutputBytes;
          stdoutBuffer = discardingOversizedLine ? '' : stdoutBuffer + tail;
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        recordActivity();
        stderr = appendCapped(stderr, chunk, request.maxOutputBytes);
      });
      child.stdin.on('error', () => {
        // The process-level error/close handlers produce the canonical outcome.
      });

      armTimeout();
      request.signal?.addEventListener('abort', onAbort, { once: true });
      if (request.signal?.aborted) onAbort();

      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (termination === 'cancelled') {
          resolve({ status: 'cancelled', exitCode: null, nativeSessionId, finalMessage, error: 'Agent Run interrupted by human' });
          return;
        }
        if (termination === 'timed_out') {
          resolve({ status: 'timed_out', exitCode: null, nativeSessionId, finalMessage, error: timeoutError });
          return;
        }
        resolve({ status: 'failed', exitCode: null, nativeSessionId, finalMessage, error: error.message });
      });
      child.once('exit', (code, signal) => { rootExit = { code, signal }; });
      child.once('close', (code, signal) => {
        if (settled) return;
        if (stdoutBuffer) {
          consumeLine(stdoutBuffer);
          stdoutBuffer = '';
        }
        if (termination && !forceSent && isProcessTreeAlive(child, descendants)) {
          rootClose = { code, signal };
          return;
        }
        finishClose(code, signal);
      });

      if (!termination) {
        if (protocol) {
          protocol.start();
          request.onSteeringReady?.((input, onDelivered) => {
            if (termination === 'unsupported') return 'unsupported';
            if (termination || rootExit || settled) return 'defer';
            return protocol.steer(input, onDelivered);
          });
        } else {
          child.stdin.end(invocation.input);
        }
      }
    });
  }
}
