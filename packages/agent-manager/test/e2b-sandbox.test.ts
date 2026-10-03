import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import type { SandboxInfo } from 'e2b';

import { AgentManager } from '../src/agent-manager.js';
import { E2BSandboxService, type E2BClient, type E2BHandle } from '../src/e2b-execution-env.js';
import { createLogger } from '../src/logger.js';
import { createAgentManagerServer } from '../src/server.js';
import { SqliteAgentManagerStore } from '../src/sqlite-store.js';

function fakeE2B() {
  let state: 'running' | 'paused' = 'running';
  let killed = false;
  const calls: string[] = [];
  const handle = (id: string) => ({ sandboxId: id,
    files: { exists: async (path: string) => path === '/home/user', makeDir: async () => true },
  }) as unknown as E2BHandle;
  const client: E2BClient = {
    async create(options) {
      calls.push(`create:${options.template}`);
      assert.equal(options.apiKey, 'test-key');
      return handle('created-e2b-id');
    },
    async connect(id, options) {
      calls.push(`connect:${id}`);
      assert.equal(options.apiKey, 'test-key');
      state = 'running';
      return handle(id);
    },
    async getInfo(id) {
      calls.push(`info:${id}`);
      return { sandboxId: id, templateId: 'base', state } as SandboxInfo;
    },
    async pause(id) { calls.push(`pause:${id}`); state = 'paused'; return true; },
    async kill(id) { calls.push(`kill:${id}`); killed = true; return true; },
  };
  return { service: new E2BSandboxService(client, () => 'test-key'), calls, get killed() { return killed; } };
}

test('E2B sandbox API provisions, binds exclusively, checks health and controls lifecycle', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-api-'));
  const databasePath = join(directory, 'factory.sqlite');
  const sdk = fakeE2B();
  const manager = new AgentManager({ workspaceRoot: directory, databasePath,
    store: new SqliteAgentManagerStore(databasePath), e2bService: sdk.service,
    logger: createLogger({ level: 'silent' }) });
  const server = createAgentManagerServer(manager);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  let attachedId: string | null = null;
  const request = (path: string, method: string, body?: unknown) => fetch(`${base}${path}`, {
    method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  try {
    const created = await request('/sandboxes', 'POST', { kind: 'e2b', name: 'Dedicated', sharing: 'dedicated' });
    assert.equal(created.status, 201);
    const sandbox = await created.json() as { id: string; providerSandboxId: string; status: string; credentialEnvVar: string };
    assert.equal(sandbox.providerSandboxId, 'created-e2b-id');
    assert.equal(sandbox.credentialEnvVar, 'E2B_API_KEY');
    assert.equal(sandbox.status, 'running');
    assert.equal((await request('/sandboxes', 'POST', { kind: 'e2b', name: 'Duplicate', sharing: 'shared',
      providerSandboxId: 'created-e2b-id' })).status, 409);

    const first = await request('/requirements', 'POST', { title: 'First', description: 'Uses E2B',
      provider: 'native-agent', sandboxId: sandbox.id });
    assert.equal(first.status, 201);
    const requirement = await first.json() as { id: string };
    assert.equal((await request('/requirements', 'POST', { title: 'Second', description: 'Conflicts',
      provider: 'native-agent', sandboxId: sandbox.id })).status, 409);

    const health = await request(`/sandboxes/${sandbox.id}/health`, 'GET');
    assert.equal((await health.json() as { status: string }).status, 'running');
    const paused = await request(`/sandboxes/${sandbox.id}/pause`, 'POST');
    assert.equal((await paused.json() as { status: string }).status, 'paused');
    const resumed = await request(`/sandboxes/${sandbox.id}/resume`, 'POST');
    assert.equal((await resumed.json() as { status: string }).status, 'running');
    assert.equal((await request(`/sandboxes/${sandbox.id}`, 'DELETE')).status, 409);
    assert.equal((await request(`/requirements/${requirement.id}`, 'PATCH', { sandboxId: null })).status, 200);
    assert.equal((await request(`/sandboxes/${sandbox.id}`, 'DELETE')).status, 204);
    assert.equal(sdk.killed, true);
    const attached = await request('/sandboxes', 'POST', { kind: 'e2b', name: 'Attached', sharing: 'shared',
      providerSandboxId: 'external-e2b-id' });
    assert.equal(attached.status, 201);
    attachedId = (await attached.json() as { id: string }).id;
    for (const number of [1, 2]) {
      assert.equal((await request('/requirements', 'POST', { title: `Shared ${number}`, description: 'Same E2B',
        provider: 'native-agent', sandboxId: attachedId })).status, 201);
    }
    assert(sdk.calls.includes('connect:external-e2b-id'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
    if (attachedId) {
      const reopened = new SqliteAgentManagerStore(databasePath);
      try {
        assert.equal(reopened.getSandbox(attachedId)?.providerSandboxId, 'external-e2b-id');
        assert.equal(reopened.getSandbox(attachedId)?.sharing, 'shared');
      } finally { reopened.close(); }
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy sandbox records survive E2B schema migration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-migrate-'));
  const databasePath = join(directory, 'factory.sqlite');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`CREATE TABLE sandboxes (id TEXT PRIMARY KEY, name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('local', 'local-sandbox')), cwd TEXT NOT NULL, created_at TEXT NOT NULL) STRICT`);
  legacy.prepare('INSERT INTO sandboxes VALUES (?, ?, ?, ?, ?)').run('old', 'Existing', 'local-sandbox',
    '/tmp/existing', '2026-01-01T00:00:00Z');
  legacy.close();
  try {
    const store = new SqliteAgentManagerStore(databasePath);
    try {
      assert.deepEqual(store.getSandbox('old'), { id: 'old', name: 'Existing', kind: 'local-sandbox',
        cwd: '/tmp/existing', providerSandboxId: null, credentialEnvVar: null, template: null,
        sharing: null, status: 'unknown', checkedAt: null, createdAt: '2026-01-01T00:00:00Z' });
    } finally { store.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
