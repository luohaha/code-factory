import { CommandExitError, type CommandHandle } from 'e2b';

import type { E2BHandle } from './e2b-execution-env.js';
import type { AgentProcessRunner, ProcessRunRequest } from './process-runner.js';
import type { RunOutcome } from './types.js';

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

function appendCapped(current: string, chunk: string, limit: number): string {
  const combined = current + chunk;
  return Buffer.byteLength(combined) <= limit
    ? combined : Buffer.from(combined).subarray(-limit).toString('utf8');
}

/** Runs a headless Reviewer CLI inside the selected E2B checkout. */
export class E2BProcessRunner implements AgentProcessRunner {
  constructor(readonly sandbox: E2BHandle, readonly envs: Readonly<Record<string, string>> = {}) {}

  async run(request: ProcessRunRequest): Promise<RunOutcome> {
    const command = [request.invocation.command, ...request.invocation.args].map(quote).join(' ');
    let stdoutBuffer = '';
    let stderr = '';
    let protocolError: string | null = null;
    let nativeSessionId: string | null = null;
    let finalMessage: string | null = null;
    let timedOut = false;
    let cancelled = false;
    const consume = (line: string) => {
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
    const onStdout = (chunk: string) => {
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf('\n');
      while (newline !== -1) {
        consume(stdoutBuffer.slice(0, newline));
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        newline = stdoutBuffer.indexOf('\n');
      }
      if (Buffer.byteLength(stdoutBuffer) > request.maxOutputBytes) {
        stdoutBuffer = Buffer.from(stdoutBuffer).subarray(-request.maxOutputBytes).toString('utf8');
      }
    };
    const onStderr = (chunk: string) => { stderr = appendCapped(stderr, chunk, request.maxOutputBytes); };
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    let handle: CommandHandle | undefined;
    try {
      handle = await this.sandbox.commands.run(command, {
        cwd: request.workspaceRoot, envs: { ...this.envs, ...request.environment },
        background: true, stdin: true, timeoutMs: 0, onStdout, onStderr,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      const running = handle;
      timer = setTimeout(() => { timedOut = true; void running.kill(); }, request.timeoutMs);
      timer.unref();
      if (request.signal) {
        onAbort = () => { cancelled = true; void running.kill(); };
        request.signal.addEventListener('abort', onAbort, { once: true });
        if (request.signal.aborted) onAbort();
      }
      if (!cancelled) {
        await handle.sendStdin(request.invocation.input);
        await handle.closeStdin();
      }
      let exitCode: number | null = null;
      try { exitCode = (await handle.wait()).exitCode; }
      catch (error) {
        if (error instanceof CommandExitError) {
          exitCode = error.exitCode;
          stderr = appendCapped(stderr, error.stderr ?? '', request.maxOutputBytes);
        } else if (!timedOut && !cancelled) throw error;
      }
      if (stdoutBuffer.trim()) consume(stdoutBuffer);
      if (cancelled) return { status: 'cancelled', exitCode, nativeSessionId, finalMessage, error: 'Reviewer Run interrupted' };
      if (timedOut) return { status: 'timed_out', exitCode, nativeSessionId, finalMessage,
        error: `Reviewer timed out after ${request.timeoutMs}ms` };
      if (exitCode === 0 && !protocolError) {
        return { status: 'succeeded', exitCode: 0, nativeSessionId, finalMessage, error: null };
      }
      return { status: 'failed', exitCode, nativeSessionId, finalMessage,
        error: protocolError || stderr.trim() || `Reviewer exited with code ${exitCode}` };
    } catch (error) {
      if (handle && !timedOut && !cancelled) await handle.kill().catch(() => false);
      return { status: cancelled || request.signal?.aborted ? 'cancelled' : timedOut ? 'timed_out' : 'failed', exitCode: null,
        nativeSessionId, finalMessage,
        error: cancelled || request.signal?.aborted ? 'Reviewer Run interrupted' : timedOut ? `Reviewer timed out after ${request.timeoutMs}ms`
          : error instanceof Error ? error.message : 'E2B Reviewer failed' };
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort && request.signal) request.signal.removeEventListener('abort', onAbort);
    }
  }
}
