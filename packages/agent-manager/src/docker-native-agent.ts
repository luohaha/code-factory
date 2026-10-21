import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { AgentAdapter, NormalizedAgentEvent } from './adapters/types.js';
import type { NativeRunInput } from './native-agent.js';
import { HeadlessProcessRunner } from './process-runner.js';
import type { RunOutcome } from './types.js';

export type NativeWorkerInput = Omit<NativeRunInput, 'signal' | 'onEvent' | 'onNativeSession' | 'docker'>;
export type NativeWorkerCommand =
  | { type: 'start'; databasePath: string; input: NativeWorkerInput }
  | { type: 'steer'; id: string; message: string };
export type NativeWorkerEvent =
  | { type: 'event'; event: NormalizedAgentEvent }
  | { type: 'session'; id: string }
  | { type: 'steer'; id: string; accepted: boolean }
  | { type: 'outcome'; outcome: RunOutcome };

export class DockerNativeAgent {
  readonly #active = new Map<string, { write: (line: string) => void; pending: Map<string, (accepted: boolean) => void> }>();
  readonly #runs = new Set<Promise<RunOutcome>>();
  readonly #controllers = new Set<AbortController>();

  async steer(requirementId: string, message: string): Promise<boolean> {
    const active = this.#active.get(requirementId);
    if (!active) return false;
    const id = randomUUID();
    return new Promise<boolean>((resolve) => {
      active.pending.set(id, resolve);
      active.write(JSON.stringify({ type: 'steer', id, message } satisfies NativeWorkerCommand));
    });
  }

  run(databasePath: string, input: NativeRunInput): Promise<RunOutcome> {
    const run = this.#run(databasePath, input);
    this.#runs.add(run);
    void run.finally(() => this.#runs.delete(run)).catch(() => undefined);
    return run;
  }

  async #run(databasePath: string, input: NativeRunInput): Promise<RunOutcome> {
    const { signal, onEvent, onNativeSession, docker, ...workerInput } = input;
    if (!docker) throw new TypeError('Docker resources are required');
    const reviewer = input.role === 'reviewer';
    // A separate durable database prevents a host Harness from claiming container work.
    const workerDatabase = join(dirname(databasePath), `native-docker-${input.requirementId}${reviewer ? `-reviewer-${randomUUID()}` : ''}.sqlite`);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    this.#controllers.add(controller);
    const pending = new Map<string, (accepted: boolean) => void>();
    let outcome: RunOutcome | undefined;
    let removed = false;
    const adapter: AgentAdapter = {
      provider: 'native-agent',
      buildRdInvocation: () => { throw new Error('Native worker has no CLI adapter'); },
      buildReviewInvocation: () => { throw new Error('Native worker has no CLI adapter'); },
      parseLine: (line) => {
        let event: NativeWorkerEvent;
        try { event = JSON.parse(line) as NativeWorkerEvent; } catch { return null; }
        if (!event || typeof event !== 'object') return null;
        if (event.type === 'event') return event.event;
        if (event.type === 'session') return { kind: 'session_started', nativeSessionId: event.id, raw: {} };
        if (event.type === 'outcome') outcome = event.outcome;
        if (event.type === 'steer') {
          pending.get(event.id)?.(event.accepted);
          pending.delete(event.id);
        }
        return null;
      },
    };
    try {
      await mkdir(dirname(workerDatabase), { recursive: true });
      const transport = await new HeadlessProcessRunner().run({
        invocation: { command: 'node', args: ['/opt/code-factory/dist/native-agent-worker.js'],
          input: `${JSON.stringify({ type: 'start', databasePath: workerDatabase,
            input: { ...workerInput, environment: {} } } satisfies NativeWorkerCommand)}\n` },
        adapter, workspaceRoot: input.cwd, docker, dockerPaths: [dirname(workerDatabase), ...(input.dockerPaths ?? [])],
        environment: input.environment, signal: controller.signal,
        timeoutMs: input.timeoutMs, timeoutMode: input.timeoutMode ?? 'inactivity', maxOutputBytes: 16 * 1024 * 1024,
        inputChannel: (write) => { if (!reviewer) this.#active.set(input.requirementId, { write, pending }); },
        onEvent, onNativeSession,
      });
      removed = true;
      return transport.status === 'succeeded' && outcome ? outcome : transport.status === 'succeeded'
        ? { ...transport, status: 'failed', error: 'Native Docker worker exited without an outcome' } : transport;
    } catch (error) {
      return { status: signal.aborted ? 'cancelled' : 'failed', exitCode: null, nativeSessionId: input.nativeSessionId,
        finalMessage: null, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (!reviewer) this.#active.delete(input.requirementId);
      for (const resolve of pending.values()) resolve(false);
      signal.removeEventListener('abort', abort);
      this.#controllers.delete(controller);
      if (reviewer && removed) await Promise.allSettled(['', '-shm', '-wal'].map((suffix) => rm(`${workerDatabase}${suffix}`, { force: true })));
    }
  }

  async close(): Promise<void> {
    for (const controller of this.#controllers) controller.abort();
    await Promise.allSettled(this.#runs);
  }
}
