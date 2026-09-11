import { spawn } from 'node:child_process';

import type { AgentAdapter, AgentInvocation, NormalizedAgentEvent } from './adapters/types.js';
import type { RunOutcome } from './types.js';

export interface ProcessRunRequest {
  invocation: AgentInvocation;
  adapter: AgentAdapter;
  workspaceRoot: string;
  timeoutMs: number;
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

export class HeadlessProcessRunner implements AgentProcessRunner {
  async run(request: ProcessRunRequest): Promise<RunOutcome> {
    return await new Promise<RunOutcome>((resolve) => {
      const child = spawn(request.invocation.command, request.invocation.args, {
        cwd: request.workspaceRoot,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });

      let stdoutBuffer = '';
      let stderr = '';
      let nativeSessionId: string | null = null;
      let finalMessage: string | null = null;
      let protocolError: string | null = null;
      let termination: 'cancelled' | 'timed_out' | null = null;
      let forceKill: NodeJS.Timeout | null = null;
      let settled = false;

      const terminate = (reason: 'cancelled' | 'timed_out') => {
        if (termination || settled) return;
        termination = reason;
        child.kill('SIGTERM');
        forceKill = setTimeout(() => child.kill('SIGKILL'), 2_000);
        forceKill.unref();
      };
      const onAbort = () => terminate('cancelled');
      const cleanup = () => {
        clearTimeout(timeout);
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

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer = appendCapped(stdoutBuffer, chunk, request.maxOutputBytes);
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) consumeLine(line);
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr = appendCapped(stderr, chunk, request.maxOutputBytes);
      });
      child.stdin.on('error', () => {
        // The process-level error/close handlers produce the canonical outcome.
      });

      const timeout = setTimeout(() => terminate('timed_out'), request.timeoutMs);
      timeout.unref();
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
          resolve({ status: 'timed_out', exitCode: null, nativeSessionId, finalMessage, error: `Agent timed out after ${request.timeoutMs}ms` });
          return;
        }
        resolve({ status: 'failed', exitCode: null, nativeSessionId, finalMessage, error: error.message });
      });
      child.once('close', (code, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (stdoutBuffer) consumeLine(stdoutBuffer);
        if (termination === 'cancelled') {
          resolve({ status: 'cancelled', exitCode: code, nativeSessionId, finalMessage, error: 'Agent Run interrupted by human' });
          return;
        }
        if (termination === 'timed_out') {
          resolve({ status: 'timed_out', exitCode: code, nativeSessionId, finalMessage, error: `Agent timed out after ${request.timeoutMs}ms` });
          return;
        }
        if (code === 0 && !protocolError) {
          resolve({ status: 'succeeded', exitCode: 0, nativeSessionId, finalMessage, error: null });
          return;
        }
        const detail = protocolError || stderr.trim() || `terminated by ${signal ?? 'unknown signal'}`;
        resolve({ status: 'failed', exitCode: code, nativeSessionId, finalMessage, error: detail });
      });

      child.stdin.end(request.invocation.input);
    });
  }
}
