import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createNativeModels, NativeCredentialStore } from '../src/native-auth.js';

test('native credentials persist OAuth login and serialize refresh across store instances', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-factory-auth-'));
  const path = join(directory, 'auth.sqlite');
  const first = new NativeCredentialStore(path);
  const second = new NativeCredentialStore(path);
  try {
    const models = createNativeModels(first);
    assert(models.getProvider('openai-codex'));
    const initial = { type: 'oauth' as const, access: 'access-1', refresh: 'refresh-1', expires: Date.now() + 60_000 };
    await first.modify('openai-codex', async () => initial);
    const updates: string[] = [];
    const firstUpdate = first.modify('openai-codex', async (current) => {
      assert.equal(current?.type, 'oauth');
      await new Promise((resolve) => setTimeout(resolve, 40));
      updates.push('first');
      return { ...initial, access: 'access-2', refresh: 'refresh-2' };
    });
    const secondUpdate = second.modify('openai-codex', async (current) => {
      assert.equal(current?.type, 'oauth');
      assert.equal(current.access, 'access-2');
      updates.push('second');
      return { ...current, access: 'access-3' };
    });
    await Promise.all([firstUpdate, secondUpdate]);
    assert.deepEqual(updates, ['first', 'second']);
    assert.equal((await second.read('openai-codex'))?.type, 'oauth');
    assert.equal((await first.read('openai-codex'))?.type, 'oauth');
    assert.deepEqual(await second.list(), [{ providerId: 'openai-codex', type: 'oauth' }]);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await second.delete('openai-codex');
    assert.equal(await first.read('openai-codex'), undefined);
  } finally {
    await first.close();
    await second.close();
    await rm(directory, { recursive: true, force: true });
  }
});
