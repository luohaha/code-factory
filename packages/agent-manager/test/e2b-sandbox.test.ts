import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import type { SandboxInfo } from 'e2b';

import { AgentManager } from '../src/agent-manager.js';
import { E2BCredentialStore, e2bCredentialsPath } from '../src/e2b-credentials.js';
import { E2BSandboxService, type E2BClient, type E2BHandle } from '../src/e2b-execution-env.js';
import { createLogger } from '../src/logger.js';
import { createAgentManagerServer } from '../src/server.js';
import { SqliteAgentManagerStore } from '../src/sqlite-store.js';

function fakeE2B(options: { missingGh?: boolean } = {}) {
  let state: 'running' | 'paused' = 'running';
  let killed = false;
  const calls: string[] = [];
  const cloneAuth: Array<{ url: string; hasToken: boolean }> = [];
  const authTokenForwarded: boolean[] = [];
  const check = (options: { apiKey?: string; domain?: string }) => {
    assert.equal(options.apiKey, 'test-key');
    assert.equal(options.domain, 'e2b.example');
  };
  const handle = (id: string) => ({ sandboxId: id,
    files: { exists: async (path: string) => path === '/home/user/repo' },
    commands: { run: async (command: string, runOptions?: { envs?: Record<string, string> }) => { calls.push(`command:${command}`);
      if (command === 'gh auth status') authTokenForwarded.push(runOptions?.envs?.GH_TOKEN !== undefined);
      return { exitCode: options.missingGh && command.startsWith('command -v') ? 1 : 0 }; } },
    git: { clone: async (url: string, options: { path: string; password?: string }) => {
      cloneAuth.push({ url, hasToken: options.password !== undefined });
      calls.push(`clone:${url}:${options.path}`); return { exitCode: 0 };
    } },
  }) as unknown as E2BHandle;
  const client: E2BClient = {
    async create(options) {
      calls.push(`create:${options.template}`);
      check(options);
      return handle('created-e2b-id');
    },
    async connect(id, options) {
      calls.push(`connect:${id}`);
      check(options);
      state = 'running';
      return handle(id);
    },
    async getInfo(id, options) {
      check(options);
      calls.push(`info:${id}`);
      return { sandboxId: id, templateId: 'base', state } as SandboxInfo;
    },
    async pause(id, options) { check(options); calls.push(`pause:${id}`); state = 'paused'; return true; },
    async kill(id, options) { check(options); calls.push(`kill:${id}`); killed = true; return true; },
  };
  return { service: new E2BSandboxService(client), calls, cloneAuth, authTokenForwarded,
    get killed() { return killed; } };
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
  let attachedRef: string | null = null;
  const credentials = { domain: 'e2b.example', apiKey: 'test-key' };
  const request = (path: string, method: string, body?: unknown) => fetch(`${base}${path}`, {
    method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  try {
    assert.equal((await request('/sandboxes', 'POST', { kind: 'e2b', name: 'Missing URL', sharing: 'shared',
      ...credentials })).status, 400);
    for (const repositoryUrl of ['https://user:secret@github.com/example/repo.git',
      'https://github.com/example/repo.git?token=secret']) {
      const rejected = await request('/sandboxes', 'POST', { kind: 'e2b', name: 'Unsafe URL',
        sharing: 'shared', ...credentials, repositoryUrl });
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.text()).includes('secret'), false);
    }
    const created = await request('/sandboxes', 'POST', { kind: 'e2b', name: 'Dedicated', sharing: 'dedicated',
      ...credentials, repositoryUrl: 'https://github.com/example/repo.git' });
    assert.equal(created.status, 201);
    const sandbox = await created.json() as { id: string; providerSandboxId: string; status: string;
      credentialEnvVar: string | null; credentialRef: string; domain: string; repositoryUrl: string };
    assert.equal(sandbox.providerSandboxId, 'created-e2b-id');
    assert.equal(sandbox.credentialEnvVar, null);
    assert.equal(sandbox.domain, 'e2b.example');
    assert.match(sandbox.credentialRef, /^e2b_/);
    assert.equal(sandbox.repositoryUrl, 'https://github.com/example/repo.git');
    assert.equal(JSON.stringify(sandbox).includes('test-key'), false);
    assert.equal(sandbox.status, 'running');
    assert(sdk.calls.includes('clone:https://github.com/example/repo.git:/home/user/repo'));
    assert(sdk.calls.includes('command:gh auth status'));
    assert.equal((await request('/sandboxes', 'POST', { kind: 'e2b', name: 'Duplicate', sharing: 'shared',
      ...credentials, providerSandboxId: 'created-e2b-id' })).status, 409);

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
      ...credentials, providerSandboxId: 'external-e2b-id' });
    assert.equal(attached.status, 201);
    const attachedRecord = await attached.json() as { id: string; credentialRef: string };
    attachedId = attachedRecord.id;
    attachedRef = attachedRecord.credentialRef;
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
        assert.equal(reopened.getSandbox(attachedId)?.domain, 'e2b.example');
        assert.equal(reopened.getSandbox(attachedId)?.credentialRef, attachedRef);
      } finally { reopened.close(); }
      const secrets = new E2BCredentialStore(e2bCredentialsPath(databasePath));
      try { assert.equal(secrets.read(attachedRef!), 'test-key'); }
      finally { secrets.close(); }
      assert.equal(statSync(e2bCredentialsPath(databasePath)).mode & 0o777, 0o600);
      assert.equal(readFileSync(databasePath).includes('test-key'), false);
      const restarted = new AgentManager({ workspaceRoot: directory, databasePath,
        store: new SqliteAgentManagerStore(databasePath), e2bService: sdk.service,
        logger: createLogger({ level: 'silent' }) });
      try { assert.equal((await restarted.checkSandboxHealth(attachedId)).status, 'running'); }
      finally { await restarted.close(); }
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('E2B provisioning rejects missing remote gh and removes the new sandbox', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-gh-'));
  const databasePath = join(directory, 'factory.sqlite');
  const sdk = fakeE2B({ missingGh: true });
  const manager = new AgentManager({ workspaceRoot: directory, databasePath,
    store: new SqliteAgentManagerStore(databasePath), e2bService: sdk.service,
    logger: createLogger({ level: 'silent' }) });
  const server = createAgentManagerServer(manager);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const response = await fetch(`${base}/sandboxes`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'e2b', name: 'Missing gh', sharing: 'shared', domain: 'e2b.example',
        apiKey: 'test-key', repositoryUrl: 'https://github.com/example/repo.git' }) });
    assert.equal(response.status, 400);
    const body = await response.text();
    assert.match(body, /git and gh installed/);
    assert.equal(body.includes('test-key'), false);
    assert.equal(sdk.killed, true);
    assert.equal(manager.listSandboxes().length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('GitHub token is sent to clone and remote gh only for github.com repositories', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-token-host-'));
  const databasePath = join(directory, 'factory.sqlite');
  const savedToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'test-github-token';
  const sdk = fakeE2B();
  const manager = new AgentManager({ workspaceRoot: directory, databasePath,
    store: new SqliteAgentManagerStore(databasePath), e2bService: sdk.service,
    logger: createLogger({ level: 'silent' }) });
  try {
    for (const repositoryUrl of ['https://git.example/org/repo.git', 'https://github.com/org/repo.git']) {
      const sandbox = await manager.createE2BSandbox({ name: 'Scoped token', sharing: 'shared',
        domain: 'e2b.example', apiKey: 'test-key', repositoryUrl });
      await manager.deleteSandbox(sandbox.id);
    }
    assert.deepEqual(sdk.cloneAuth, [
      { url: 'https://git.example/org/repo.git', hasToken: false },
      { url: 'https://github.com/org/repo.git', hasToken: true },
    ]);
    assert.deepEqual(sdk.authTokenForwarded, [false, true]);
  } finally {
    await manager.close();
    if (savedToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = savedToken;
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
        cwd: '/tmp/existing', providerSandboxId: null, credentialEnvVar: null, domain: null,
        credentialRef: null, repositoryUrl: null, template: null,
        sharing: null, status: 'unknown', checkedAt: null, createdAt: '2026-01-01T00:00:00Z' });
    } finally { store.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('E2B records created before per-sandbox credentials gain nullable settings', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-settings-'));
  const databasePath = join(directory, 'factory.sqlite');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`CREATE TABLE sandboxes (id TEXT PRIMARY KEY, name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('local', 'local-sandbox', 'e2b')), cwd TEXT NOT NULL,
    provider_sandbox_id TEXT, credential_env_var TEXT, template TEXT, sharing TEXT,
    status TEXT NOT NULL, checked_at TEXT, created_at TEXT NOT NULL) STRICT`);
  legacy.prepare('INSERT INTO sandboxes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'old-e2b', 'Existing E2B', 'e2b', '/home/user/repo', 'provider-id', 'E2B_API_KEY',
    'base', 'shared', 'running', null, '2026-01-01T00:00:00Z');
  legacy.close();
  try {
    const store = new SqliteAgentManagerStore(databasePath);
    try {
      const sandbox = store.getSandbox('old-e2b');
      assert.equal(sandbox?.providerSandboxId, 'provider-id');
      assert.equal(sandbox?.credentialEnvVar, 'E2B_API_KEY');
      assert.equal(sandbox?.domain, null);
      assert.equal(sandbox?.credentialRef, null);
      assert.equal(sandbox?.repositoryUrl, null);
    } finally { store.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
