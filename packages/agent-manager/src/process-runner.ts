import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

import type { AgentAdapter, AgentInvocation, NormalizedAgentEvent } from './adapters/types.js';
import type { RunOutcome } from './types.js';

export interface ProcessRunRequest {
  invocation: AgentInvocation;
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

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (result.error || result.status !== 0) child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function isProcessTreeAlive(child: ChildProcess): boolean {
  if (child.pid === undefined || process.platform === 'win32') return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class HeadlessProcessRunner implements AgentProcessRunner {
  async run(request: ProcessRunRequest): Promise<RunOutcome> {
    return await new Promise<RunOutcome>((resolve) => {
      const child = spawn(request.invocation.command, request.invocation.args, {
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
      let termination: 'cancelled' | 'timed_out' | null = null;
      let forceKill: NodeJS.Timeout | null = null;
      let timeout: NodeJS.Timeout | null = null;
      let rootClose: { code: number | null; signal: NodeJS.Signals | null } | null = null;
      let forceSent = false;
      let settled = false;
      const timeoutMode = request.timeoutMode ?? 'elapsed';
      const timeoutError = timeoutMode === 'inactivity'
        ? `Agent produced no output for ${formatDuration(request.timeoutMs)}`
        : `Agent timed out after ${formatDuration(request.timeoutMs)}`;

      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        if (forceKill) clearTimeout(forceKill);
        request.signal?.removeEventListener('abort', onAbort);
      };

      const consumeLine = (line: string) => {
        if (!line.trim()) return;
        request.onOutput?.(line);
        const event = request.adapter.parseLine(line);
        if (!event) return;
        request.onEvent?.(event);
        if (event.kind === 'error') protocolError = event.message ?? 'Agent reported an error';
        if (event.nativeSessionId) {
          nativeSessionId = event.nativeSessionId;
          request.onNativeSession?.(event.nativeSessionId);
        }
        if (event.message) finalMessage = event.message;
      };

      const finishClose = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (termination === 'cancelled') {
          resolve({ status: 'cancelled', exitCode: code, nativeSessionId, finalMessage, error: 'Agent Run interrupted by human' });
          return;
        }
        if (termination === 'timed_out') {
          resolve({ status: 'timed_out', exitCode: code, nativeSessionId, finalMessage, error: timeoutError });
          return;
        }
        if (code === 0 && !protocolError) {
          resolve({ status: 'succeeded', exitCode: 0, nativeSessionId, finalMessage, error: null });
          return;
        }
        const detail = protocolError || stderr.trim() || `terminated by ${signal ?? 'unknown signal'}`;
        const providerLimit = request.adapter.classifyFailure?.(detail, new Date());
        resolve({
          status: 'failed',
          exitCode: code,
          nativeSessionId,
          finalMessage,
          error: detail,
          ...(providerLimit ? { providerLimit } : {}),
        });
      };

      const terminate = (reason: 'cancelled' | 'timed_out') => {
        if (termination || settled) return;
        termination = reason;
        signalProcessTree(child, 'SIGTERM');
        forceKill = setTimeout(() => {
          forceSent = true;
          signalProcessTree(child, 'SIGKILL');
          forceKill = null;
          if (rootClose) finishClose(rootClose.code, rootClose.signal);
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

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        recordActivity();
        stdoutBuffer = appendCapped(stdoutBuffer, chunk, request.maxOutputBytes);
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) consumeLine(line);
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
      child.once('close', (code, signal) => {
        if (settled) return;
        if (stdoutBuffer) {
          consumeLine(stdoutBuffer);
          stdoutBuffer = '';
        }
        if (termination && !forceSent && isProcessTreeAlive(child)) {
          rootClose = { code, signal };
          return;
        }
        finishClose(code, signal);
      });

      child.stdin.end(request.invocation.input);
    });
  }
}
