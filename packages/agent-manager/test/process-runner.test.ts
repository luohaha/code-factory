import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentAdapter } from '../src/adapters/types.ts';
import { HeadlessProcessRunner } from '../src/process-runner.ts';

const noOutputAdapter: AgentAdapter = {
  provider: 'codex',
  buildRdInvocation: () => ({ command: process.execPath, args: [], input: '' }),
  buildReviewInvocation: () => ({ command: process.execPath, args: [], input: '' }),
  parseLine: () => null,
};

test('HeadlessProcessRunner terminates an aborted child as a cancelled Run', async () => {
  const controller = new AbortController();
  const outcomePromise = new HeadlessProcessRunner().run({
    invocation: {
      command: process.execPath,
      args: ['-e', 'setInterval(() => undefined, 1000)'],
      input: '',
    },
    adapter: noOutputAdapter,
    workspaceRoot: process.cwd(),
    timeoutMs: 30_000,
    maxOutputBytes: 1024,
    signal: controller.signal,
  });

  controller.abort();
  const outcome = await outcomePromise;
  assert.equal(outcome.status, 'cancelled');
  assert.match(outcome.error ?? '', /interrupted by human/);
});
