import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentManager } from '../src/agent-manager.js';
import { NativeCredentialStore, nativeAuthDatabasePath } from '../src/native-auth.js';
import { NativeAuthService } from '../src/native-auth-service.js';
import { createLogger } from '../src/logger.js';
import { createAgentManagerServer } from '../src/server.js';
import { SqliteAgentManagerStore } from '../src/sqlite-store.js';

test('Native Agent credentials and subscription login work through the configuration API', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-native-auth-api-'));
  const conversationPath = join(directory, 'native-agent.sqlite');
  const auth = new NativeAuthService(conversationPath, {
    environment: {},
    login: async (provider, interaction, getDeviceId) => {
      assert.match(getDeviceId(), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      if (provider === 'openai-codex') {
        assert.equal(await interaction.prompt({ type: 'select', message: 'Method', options: [
          { id: 'browser', label: 'Browser' }, { id: 'device_code', label: 'Device code' },
        ] }), 'device_code');
        interaction.notify({ type: 'device_code', verificationUri: 'https://example.com/device', userCode: 'ABCD' });
        await new Promise<void>((_resolve, reject) => {
          interaction.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
      } else {
        interaction.notify({ type: 'auth_url', url: 'https://example.com/authorize' });
        assert.equal(await interaction.prompt({ type: 'manual_code', message: 'Paste redirect URL' }),
          'https://example.com/callback?code=done');
      }
    },
  });
  const manager = new AgentManager({ workspaceRoot: directory, store: new SqliteAgentManagerStore(':memory:'),
    nativeAuthService: auth, logger: createLogger({ level: 'silent' }) });
  const server = createAgentManagerServer(manager);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/native-auth`;
  const request = (path: string, method = 'GET', body?: unknown) => fetch(`${base}${path}`, {
    method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  try {
    const initial = await (await request('')).json() as { providers: Array<{ provider: string; source: string | null }> };
    assert.equal(initial.providers.find((item) => item.provider === 'openai')?.source, null);

    assert.equal((await request('/openai/api-key', 'PUT', { key: '' })).status, 400);
    const savedResponse = await request('/openai/api-key', 'PUT', { key: 'api-secret-123' });
    assert.equal(savedResponse.status, 200);
    const savedText = await savedResponse.text();
    assert.equal(savedText.includes('api-secret-123'), false);
    assert.equal((JSON.parse(savedText) as { providers: Array<{ provider: string; source: string }> })
      .providers.find((item) => item.provider === 'openai')?.source, 'stored_api_key');
    const credentials = new NativeCredentialStore(nativeAuthDatabasePath(conversationPath));
    try { assert.deepEqual(await credentials.read('openai'), { type: 'api_key', key: 'api-secret-123' }); }
    finally { await credentials.close(); }
    assert.equal(statSync(nativeAuthDatabasePath(conversationPath)).mode & 0o777, 0o600);
    assert.equal((await request('/openai', 'DELETE')).status, 200);

    const codex = await (await request('/openai-codex/login', 'POST')).json() as { id: string };
    assert.equal((await request('/openai/login', 'POST')).status, 409);
    const codexProgress = await (await request(`/logins/${codex.id}`)).json() as { state: string; userCode: string };
    assert.equal(codexProgress.state, 'pending');
    assert.equal(codexProgress.userCode, 'ABCD');
    assert.equal((await request(`/logins/${codex.id}`, 'DELETE')).status, 200);

    const cancelledOpenai = await (await request('/openai/login', 'POST')).json() as { id: string };
    assert.equal((await request(`/logins/${cancelledOpenai.id}`, 'DELETE')).status, 200);
    const cancelled = await (await request(`/logins/${cancelledOpenai.id}`)).json() as { state: string };
    assert.equal(cancelled.state, 'cancelled');

    const openai = await (await request('/openai/login', 'POST')).json() as { id: string };
    const prompt = await (await request(`/logins/${openai.id}`)).json() as { state: string; authorizationUrl: string };
    assert.equal(prompt.state, 'prompt');
    assert.equal(prompt.authorizationUrl, 'https://example.com/authorize');
    assert.equal((await request(`/logins/${openai.id}`, 'POST', { answer: 'https://example.com/callback?code=done' })).status, 200);
    await Promise.resolve();
    const completed = await (await request(`/logins/${openai.id}`)).json() as { state: string };
    assert.equal(completed.state, 'succeeded');
    assert.equal((await request('/anthropic/login', 'POST')).status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
