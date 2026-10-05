import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { AgentManager } from '../src/agent-manager.js';
import { NativeProfileStore, nativeAuthDatabasePath, profileModel } from '../src/native-auth.js';
import { createLogger } from '../src/logger.js';
import { createAgentManagerServer } from '../src/server.js';
import { SqliteAgentManagerStore } from '../src/sqlite-store.js';

test('Native API profiles are saved without exposing keys and selected by requirements', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-native-auth-api-'));
  const manager = new AgentManager({ workspaceRoot: directory, store: new SqliteAgentManagerStore(':memory:'),
    logger: createLogger({ level: 'silent' }) });
  const server = createAgentManagerServer(manager);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const request = (path: string, method = 'GET', body?: unknown) => fetch(`${base}${path}`, {
    method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  try {
    const input = { format: 'openai', baseUrl: 'https://gateway.example/v1', apiKey: 'api-secret-123', modelName: 'team/model' };
    assert.equal((await request('/native-auth/openai-codex/login', 'POST')).status, 404);
    assert.equal((await request('/native-auth/profiles', 'POST', { ...input, format: 'other' })).status, 400);
    const createdResponse = await request('/native-auth/profiles', 'POST', input);
    assert.equal(createdResponse.status, 201);
    const createdText = await createdResponse.text();
    assert.equal(createdText.includes(input.apiKey), false);
    const created = JSON.parse(createdText) as { id: string; modelName: string };
    assert.equal(created.modelName, input.modelName);
    assert.equal(statSync(nativeAuthDatabasePath(join(dirname(manager.databasePath), 'native-agent.sqlite'))).mode & 0o777, 0o600);
    const listText = await (await request('/native-auth')).text();
    assert.equal(listText.includes(input.apiKey), false);
    assert.equal((JSON.parse(listText) as { items: unknown[] }).items.length, 1);
    const updatedResponse = await request(`/native-auth/profiles/${created.id}`, 'PUT', {
      format: 'openai', baseUrl: 'https://gateway.example/updated', modelName: 'new-model',
    });
    assert.equal(updatedResponse.status, 200);
    assert.equal((await updatedResponse.text()).includes(input.apiKey), false);
    assert.equal(manager.listNativeApiProfiles()[0]?.modelName, 'new-model');
    const profileStore = new NativeProfileStore(nativeAuthDatabasePath(join(dirname(manager.databasePath), 'native-agent.sqlite')));
    try { assert.equal(profileStore.get(created.id)?.apiKey, input.apiKey); }
    finally { profileStore.close(); }

    const model = profileModel(created.id);
    const requirementResponse = await request('/requirements', 'POST', { title: 'Use gateway', description: 'Build it', provider: 'native-agent', model });
    assert.equal(requirementResponse.status, 201);
    const requirement = await requirementResponse.json() as { id: string; model: string };
    assert.equal(requirement.model, model);
    assert.equal((await request('/native-auth/profiles/absent', 'DELETE')).status, 404);
    assert.equal((await request(`/native-auth/profiles/${created.id}`, 'DELETE')).status, 409);
    assert.equal((await request('/requirements', 'POST', { title: 'Bad profile', description: 'Build it', provider: 'native-agent', model: 'profile:absent' })).status, 404);
    assert.equal((await request(`/requirements/${requirement.id}`, 'DELETE')).status, 204);
    assert.equal((await request(`/native-auth/profiles/${created.id}`, 'DELETE')).status, 204);
    assert.equal((JSON.parse(await (await request('/native-auth')).text()) as { items: unknown[] }).items.length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
