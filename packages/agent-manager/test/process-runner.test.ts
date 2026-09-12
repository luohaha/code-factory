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

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

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

test('HeadlessProcessRunner merges per-Run environment into the child environment', async () => {
  let output = '';
  const outcome = await new HeadlessProcessRunner().run({
    invocation: {
      command: process.execPath,
      args: ['-e', 'process.stdout.write(`${process.env.CODE_FACTORY_REQUIREMENT_ID}\\n`)'],
      input: '',
    },
    adapter: noOutputAdapter,
    workspaceRoot: process.cwd(),
    environment: { CODE_FACTORY_REQUIREMENT_ID: 'req_environment' },
    timeoutMs: 30_000,
    maxOutputBytes: 1024,
    onOutput: (line) => { output = line; },
  });

  assert.equal(outcome.status, 'succeeded');
  assert.equal(output, 'req_environment');
});

test('HeadlessProcessRunner kills descendant tool processes before completing a cancelled Run', async () => {
  const grandchildScript = [
    "process.on('SIGTERM', () => undefined);",
    "process.send?.('ready');",
    'setInterval(() => undefined, 1000);',
  ].join('\n');
  const rootScript = [
    "const { spawn } = require('node:child_process');",
    `const tool = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });`,
    "tool.once('message', () => process.stdout.write(`grandchild:${tool.pid}\\n`));",
    'setInterval(() => undefined, 1000);',
  ].join('\n');
  const controller = new AbortController();
  let ready: (pid: number) => void = () => undefined;
  const grandchildReady = new Promise<number>((resolve) => { ready = resolve; });
  let grandchildPid: number | null = null;

  const outcomePromise = new HeadlessProcessRunner().run({
    invocation: { command: process.execPath, args: ['-e', rootScript], input: '' },
    adapter: noOutputAdapter,
    workspaceRoot: process.cwd(),
    timeoutMs: 30_000,
    maxOutputBytes: 1024,
    signal: controller.signal,
    onOutput: (line) => {
      const match = line.match(/^grandchild:(\d+)$/);
      if (match?.[1]) ready(Number(match[1]));
    },
  });

  try {
    grandchildPid = await Promise.race([
      grandchildReady,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Grandchild did not start')), 2_000)),
    ]);
    controller.abort();
    const outcome = await outcomePromise;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    assert.equal(outcome.status, 'cancelled');
    assert.equal(processExists(grandchildPid), false);
  } finally {
    if (grandchildPid !== null && processExists(grandchildPid)) process.kill(grandchildPid, 'SIGKILL');
  }
});
