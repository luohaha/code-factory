import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('HeadlessProcessRunner preserves the workspace and parent environment while applying Run context', async () => {
  const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), 'code-factory-runner-')));
  const parentContextName = 'CODE_FACTORY_PARENT_CONTEXT_TEST';
  const previousParentContext = process.env[parentContextName];
  process.env[parentContextName] = 'inherited-context';
  try {
    let output = '';
    const outcome = await new HeadlessProcessRunner().run({
      invocation: {
        command: process.execPath,
        args: ['-e', [
          'process.stdout.write(JSON.stringify({',
          '  cwd: process.cwd(),',
          `  parentContext: process.env.${parentContextName},`,
          '  requirementId: process.env.CODE_FACTORY_REQUIREMENT_ID,',
          '}) + "\\n")',
        ].join('\n')],
        input: '',
      },
      adapter: noOutputAdapter,
      workspaceRoot,
      environment: { CODE_FACTORY_REQUIREMENT_ID: 'req_environment' },
      timeoutMs: 30_000,
      maxOutputBytes: 1024,
      onOutput: (line) => { output = line; },
    });

    assert.equal(outcome.status, 'succeeded');
    assert.deepEqual(JSON.parse(output), {
      cwd: workspaceRoot,
      parentContext: 'inherited-context',
      requirementId: 'req_environment',
    });
  } finally {
    if (previousParentContext === undefined) delete process.env[parentContextName];
    else process.env[parentContextName] = previousParentContext;
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
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

test('HeadlessProcessRunner lets an active RD process outlive its inactivity timeout', async () => {
  const outcome = await new HeadlessProcessRunner().run({
    invocation: {
      command: process.execPath,
      args: ['-e', [
        "const interval = setInterval(() => process.stdout.write('active\\n'), 50);",
        'setTimeout(() => { clearInterval(interval); process.exit(0); }, 1_100);',
      ].join('\n')],
      input: '',
    },
    adapter: noOutputAdapter,
    workspaceRoot: process.cwd(),
    timeoutMs: 300,
    timeoutMode: 'inactivity',
    maxOutputBytes: 1024,
  });

  assert.equal(outcome.status, 'succeeded');
});

test('HeadlessProcessRunner reports a readable inactivity timeout', async () => {
  const outcome = await new HeadlessProcessRunner().run({
    invocation: {
      command: process.execPath,
      args: ['-e', 'setInterval(() => undefined, 1000)'],
      input: '',
    },
    adapter: noOutputAdapter,
    workspaceRoot: process.cwd(),
    timeoutMs: 300,
    timeoutMode: 'inactivity',
    maxOutputBytes: 1024,
  });

  assert.equal(outcome.status, 'timed_out');
  assert.equal(outcome.error, 'Agent produced no output for 300ms');
});

test('HeadlessProcessRunner keeps elapsed-time limits for Reviewers', async () => {
  const outcome = await new HeadlessProcessRunner().run({
    invocation: {
      command: process.execPath,
      args: ['-e', "setInterval(() => process.stdout.write('active\\n'), 50)"],
      input: '',
    },
    adapter: noOutputAdapter,
    workspaceRoot: process.cwd(),
    timeoutMs: 300,
    timeoutMode: 'elapsed',
    maxOutputBytes: 1024,
  });

  assert.equal(outcome.status, 'timed_out');
  assert.equal(outcome.error, 'Agent timed out after 300ms');
});
