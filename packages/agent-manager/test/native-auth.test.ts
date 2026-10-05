import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createModels } from '@earendil-works/pi-ai/models';

import { configureNativeProfile, createNativeModels, NativeCredentialStore, NativeProfileStore, profileModel } from '../src/native-auth.js';

test('Native API profiles persist multiple endpoints and configure isolated pi-ai providers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-factory-profiles-'));
  const path = join(directory, 'native-agent-auth.sqlite');
  const store = new NativeProfileStore(path);
  try {
    const first = store.save({ format: 'openai', baseUrl: 'https://gateway.example/v1', apiKey: 'secret-one', modelName: 'team/model-1' });
    const second = store.save({ format: 'anthropic', baseUrl: 'https://claude.example', apiKey: 'secret-two', modelName: 'claude-custom' });
    assert.equal(store.list().length, 2);
    assert.equal(JSON.stringify(store.list()).includes('secret-'), false);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const models = createModels();
    configureNativeProfile(models, store.get(first.id)!);
    configureNativeProfile(models, store.get(second.id)!);
    assert.equal(models.getModel(profileModel(first.id), first.modelName)?.baseUrl, first.baseUrl);
    assert.equal(models.getModel(profileModel(first.id), first.modelName)?.api, 'openai-completions');
    assert.equal(models.getModel(profileModel(second.id), second.modelName)?.api, 'anthropic-messages');
    assert.deepEqual((await models.getAuth(profileModel(first.id)))?.auth, { apiKey: 'secret-one' });
    assert.deepEqual((await models.getAuth(profileModel(second.id)))?.auth, { apiKey: 'secret-two' });
    assert.equal(store.delete(first.id), true);
    assert.equal(store.get(first.id), null);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Native API profiles reject invalid format, URL, and missing credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-factory-profiles-'));
  const store = new NativeProfileStore(join(directory, 'auth.sqlite'));
  try {
    const input = { format: 'openai' as const, baseUrl: 'https://example.com/v1', apiKey: 'secret', modelName: 'model' };
    assert.throws(() => store.save({ ...input, format: 'other' as 'openai' }), TypeError);
    assert.throws(() => store.save({ ...input, baseUrl: 'file:///tmp/model' }), TypeError);
    assert.throws(() => store.save({ ...input, baseUrl: 'https://user:pass@example.com' }), TypeError);
    assert.throws(() => store.save({ ...input, apiKey: ' ' }), TypeError);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('existing OpenAI and Anthropic API keys become selectable profiles; OAuth is ignored', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-factory-profiles-'));
  const path = join(directory, 'auth.sqlite');
  const credentials = new NativeCredentialStore(path);
  await credentials.modify('openai', async () => ({ type: 'api_key', key: 'old-key' }));
  await credentials.modify('openai-codex', async () => ({ type: 'oauth', access: 'token', refresh: 'refresh', expires: Date.now() }));
  const models = createNativeModels(credentials);
  assert.deepEqual((await models.getAuth('openai'))?.auth, { apiKey: 'old-key' });
  assert.equal(models.getProvider('openai-codex'), undefined);
  await credentials.close();
  const profiles = new NativeProfileStore(path);
  try {
    assert.deepEqual(profiles.list().map((item) => item.id), ['legacy-openai']);
    assert.equal(profiles.get('legacy-openai')?.apiKey, 'old-key');
    assert.equal(profiles.delete('legacy-openai'), true);
  } finally { profiles.close(); }
  const reopened = new NativeProfileStore(path);
  try { assert.deepEqual(reopened.list(), []); }
  finally { reopened.close(); await rm(directory, { recursive: true, force: true }); }
});
