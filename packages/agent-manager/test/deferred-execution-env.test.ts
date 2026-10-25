import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';

import { DeferredExecutionEnv } from '../src/runtime/deferred-execution-env.js';

test('an already-cancelled file operation never opens its deferred environment', async () => {
  let opened = false;
  const env = new DeferredExecutionEnv('test', tmpdir(), async () => {
    opened = true;
    return new NodeExecutionEnv({ cwd: tmpdir() });
  });
  const context = withAbortSignal(AbortSignal.abort(), BACKGROUND_CONTEXT);
  await assert.rejects(env.absolutePath('file.txt', context), { name: 'AbortError' });
  assert.equal(opened, false);
});

test('a cancelled opener cannot hold up retries or replace a newer cached environment', async () => {
  const originalDirectory = join(tmpdir(), 'cancelled-environment');
  const retryDirectory = join(tmpdir(), 'retry-environment');
  let release!: (env: ExecutionEnv) => void;
  const pending = new Promise<ExecutionEnv>((resolve) => { release = resolve; });
  const controller = new AbortController();
  const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
  let attempts = 0;
  const env = new DeferredExecutionEnv('test', tmpdir(), async (received) => {
    attempts++;
    if (attempts === 1) {
      assert.equal(received, context);
      return pending;
    }
    return new NodeExecutionEnv({ cwd: retryDirectory });
  });
  const cancelled = env.absolutePath('file.txt', context);
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.deepEqual(await env.absolutePath('file.txt', BACKGROUND_CONTEXT), {
    ok: true, value: join(retryDirectory, 'file.txt'),
  });
  release(new NodeExecutionEnv({ cwd: originalDirectory }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(env.cwd, retryDirectory);
  assert.equal(attempts, 2);
  assert.deepEqual(await env.absolutePath('other.txt', BACKGROUND_CONTEXT), {
    ok: true, value: join(retryDirectory, 'other.txt'),
  });
  assert.equal(attempts, 2);
});
