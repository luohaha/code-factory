import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import type { SandboxInfo } from 'e2b';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';

import { AgentManager } from '../src/agent-manager.js';
import { E2BCredentialStore, e2bCredentialsPath } from '../src/e2b-credentials.js';
import { E2BSandboxService, type E2BClient, type E2BHandle } from '../src/e2b-execution-env.js';
import { createLogger } from '../src/logger.js';
import { NativeAgentService } from '../src/native-agent.js';
import { createAgentManagerServer } from '../src/server.js';
import { SqliteAgentManagerStore } from '../src/sqlite-store.js';

function fakeE2B(settings: { missingGh?: boolean; acceptRotated?: boolean; review?: boolean } = {}) {
  let state: 'running' | 'paused' = 'running';
  let killed = false;
  const calls: string[] = [];
  const cloneAuth: Array<{ url: string; hasToken: boolean }> = [];
  const authTokenForwarded: boolean[] = [];
  const reviews: Array<{ command: string; cwd: string | undefined; input: string }> = [];
  const remoteCommands: Array<{ command: string; cwd: string | undefined }> = [];
  const check = (credentials: { apiKey?: string; domain?: string }) => {
    if (settings.acceptRotated && credentials.apiKey === 'new-key' &&
      credentials.domain === 'new.e2b.example') return;
    assert.equal(credentials.apiKey, 'test-key');
    assert.equal(credentials.domain, 'e2b.example');
  };
  const handle = (id: string) => ({ sandboxId: id,
    files: { exists: async (path: string) => path === '/home/user/repo' },
    commands: { run: async (command: string, runOptions?: { envs?: Record<string, string>; cwd?: string;
      background?: boolean; onStdout?: (chunk: string) => void }) => { calls.push(`command:${command}`);
      remoteCommands.push({ command, cwd: runOptions?.cwd });
      if (settings.review && runOptions?.background) {
        const review = { command, cwd: runOptions.cwd, input: '' };
        reviews.push(review);
        return { sendStdin: async (input: string) => { review.input = input; },
          closeStdin: async () => undefined, kill: async () => true,
          wait: async () => { runOptions.onStdout?.('{"type":"item.completed","item":{"type":"agent_message","text":"Remote review"}}\n');
            return { exitCode: 0 }; } };
      }
      if (command === 'gh auth status') authTokenForwarded.push(runOptions?.envs?.GH_TOKEN !== undefined);
      return { exitCode: settings.missingGh && command.startsWith('command -v') ? 1 : 0 }; } },
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
  return { service: new E2BSandboxService(client), calls, cloneAuth, authTokenForwarded, reviews, remoteCommands,
    get killed() { return killed; } };
}

test('E2B sandbox API provisions, allows reuse, checks health and controls lifecycle', async () => {
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
    assert.equal((await request('/sandboxes', 'POST', { kind: 'e2b', name: 'Missing URL',
      ...credentials })).status, 400);
    for (const repositoryUrl of ['https://user:secret@github.com/example/repo.git',
      'https://github.com/example/repo.git?token=secret']) {
      const rejected = await request('/sandboxes', 'POST', { kind: 'e2b', name: 'Unsafe URL',
        ...credentials, repositoryUrl });
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.text()).includes('secret'), false);
    }
    const created = await request('/sandboxes', 'POST', { kind: 'e2b', name: 'Reusable',
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
    assert.equal('sharing' in sandbox, false);
    assert(sdk.calls.includes('clone:https://github.com/example/repo.git:/home/user/repo'));
    assert(sdk.calls.includes('command:gh auth status'));
    assert.equal((await request('/sandboxes', 'POST', { kind: 'e2b', name: 'Duplicate',
      ...credentials, providerSandboxId: 'created-e2b-id' })).status, 409);

    const first = await request('/requirements', 'POST', { title: 'First', description: 'Uses E2B',
      provider: 'native-agent', sandboxId: sandbox.id });
    assert.equal(first.status, 201);
    const requirement = await first.json() as { id: string };
    const second = await request('/requirements', 'POST', { title: 'Second', description: 'Reuses E2B',
      provider: 'native-agent', sandboxId: sandbox.id });
    assert.equal(second.status, 201);
    const secondRequirement = await second.json() as { id: string; sandboxId: string };
    assert.equal(secondRequirement.sandboxId, sandbox.id);
    assert.equal((await request('/requirements', 'POST', { title: 'Headless', description: 'Cannot use E2B',
      provider: 'codex', sandboxId: sandbox.id })).status, 400);

    const health = await request(`/sandboxes/${sandbox.id}/health`, 'GET');
    assert.equal((await health.json() as { status: string }).status, 'running');
    const paused = await request(`/sandboxes/${sandbox.id}/pause`, 'POST');
    assert.equal((await paused.json() as { status: string }).status, 'paused');
    const resumed = await request(`/sandboxes/${sandbox.id}/resume`, 'POST');
    assert.equal((await resumed.json() as { status: string }).status, 'running');
    assert.equal((await request(`/sandboxes/${sandbox.id}`, 'DELETE')).status, 409);
    const switched = await request(`/requirements/${requirement.id}`, 'PATCH', { provider: 'codex' });
    assert.equal(switched.status, 200);
    assert.equal((await switched.json() as { sandboxId: string | null }).sandboxId, null);
    assert.equal((await request(`/sandboxes/${sandbox.id}`, 'DELETE')).status, 409);
    assert.equal((await request(`/requirements/${secondRequirement.id}`, 'PATCH', { provider: 'codex' })).status, 200);
    assert.equal((await request(`/sandboxes/${sandbox.id}`, 'DELETE')).status, 204);
    assert.equal(sdk.killed, true);
    const attached = await request('/sandboxes', 'POST', { kind: 'e2b', name: 'Attached',
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
        assert.equal('sharing' in reopened.getSandbox(attachedId)!, false);
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

test('E2B creation uses the managed workspace Git origin when only name, domain, and key are supplied', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-origin-'));
  const databasePath = join(directory, 'factory.sqlite');
  execFileSync('git', ['init', directory]);
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:example/repo.git'], { cwd: directory });
  const sdk = fakeE2B();
  const manager = new AgentManager({ workspaceRoot: directory, databasePath,
    store: new SqliteAgentManagerStore(databasePath), e2bService: sdk.service,
    logger: createLogger({ level: 'silent' }) });
  const server = createAgentManagerServer(manager);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sandboxes`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'e2b', name: 'Simple', domain: 'e2b.example', apiKey: 'test-key' }),
    });
    assert.equal(response.status, 201);
    const sandbox = await response.json() as { id: string; repositoryUrl: string; cwd: string };
    assert.equal(sandbox.repositoryUrl, 'https://github.com/example/repo.git');
    assert.equal(sandbox.cwd, '/home/user/repo');
    assert.equal('sharing' in sandbox, false);
    assert.deepEqual(sdk.cloneAuth, [{ url: sandbox.repositoryUrl, hasToken: Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN) }]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('E2B workspace settings can be edited and credentials rotate without exposing keys', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-edit-'));
  const databasePath = join(directory, 'factory.sqlite');
  const sdk = fakeE2B({ acceptRotated: true });
  const manager = new AgentManager({ workspaceRoot: directory, databasePath,
    store: new SqliteAgentManagerStore(databasePath), e2bService: sdk.service,
    logger: createLogger({ level: 'silent' }) });
  const server = createAgentManagerServer(manager);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sandboxes`;
  try {
    const created = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'e2b', name: 'Original', domain: 'e2b.example', apiKey: 'test-key',
        repositoryUrl: 'https://github.com/example/repo.git' }) });
    assert.equal(created.status, 201);
    const first = await created.json() as { id: string; credentialRef: string };
    const updated = await fetch(`${base}/${first.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed', domain: 'new.e2b.example', apiKey: 'new-key' }) });
    assert.equal(updated.status, 200);
    const second = await updated.json() as { id: string; name: string; domain: string;
      credentialRef: string };
    assert.equal(second.name, 'Renamed');
    assert.equal(second.domain, 'new.e2b.example');
    assert.equal('sharing' in second, false);
    assert.notEqual(second.credentialRef, first.credentialRef);
    assert.equal(JSON.stringify(second).includes('new-key'), false);
    const secrets = new E2BCredentialStore(e2bCredentialsPath(databasePath));
    try {
      assert.equal(secrets.read(first.credentialRef), null);
      assert.equal(secrets.read(second.credentialRef), 'new-key');
    } finally { secrets.close(); }
    assert.equal((await fetch(`${base}/${first.id}/health`)).status, 200);
    assert.equal((await fetch(`${base}/${first.id}`, { method: 'DELETE' })).status, 204);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a Native Reviewer for an E2B Requirement uses the same remote execution environment without a CLI', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-review-'));
  const databasePath = join(directory, 'factory.sqlite');
  const sdk = fakeE2B();
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('bash', { command: 'gh pr view https://github.com/example/repo/pull/7' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Remote review completed'),
    fauxAssistantMessage('RD saw the review'),
  ]);
  const manager = new AgentManager({ workspaceRoot: directory, databasePath,
    store: new SqliteAgentManagerStore(databasePath), e2bService: sdk.service,
    nativeService: new NativeAgentService(join(directory, 'native.sqlite'), models, sdk.service),
    logger: createLogger({ level: 'silent' }) });
  try {
    const workspace = await manager.createE2BSandbox({ name: 'Review remote', domain: 'e2b.example',
      apiKey: 'test-key', repositoryUrl: 'https://github.com/example/repo.git' });
    const requirement = manager.createRequirement({ title: 'Remote work', description: 'Review PR',
      provider: 'native-agent', model: 'faux/faux-1', sandboxId: workspace.id });
    const pullRequest = manager.trackPullRequest({ requirementId: requirement.id, repository: 'example/repo',
      number: 7, url: 'https://github.com/example/repo/pull/7', title: 'Remote PR',
      baseBranch: 'main', headBranch: 'feature', headSha: 'abc123def456', status: 'open' });
    assert.throws(() => manager.requestReview(pullRequest.id, { provider: 'codex' }), /Native Agent Reviewer/);
    const outcome = await manager.requestReview(pullRequest.id, { provider: 'native-agent' });
    assert.equal(outcome.status, 'succeeded');
    assert.equal(sdk.reviews.length, 0);
    assert(sdk.remoteCommands.some((entry) => entry.command.includes('gh pr view') && entry.cwd === '/home/user/repo'));
    assert.equal(manager.listMessages(requirement.id).find((message) => message.author === 'reviewer')?.body, 'Remote review completed');
  } finally {
    await manager.close();
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
      body: JSON.stringify({ kind: 'e2b', name: 'Missing gh', domain: 'e2b.example',
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
      const sandbox = await manager.createE2BSandbox({ name: 'Scoped token',
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
        status: 'unknown', checkedAt: null, createdAt: '2026-01-01T00:00:00Z' });
    } finally { store.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('E2B records created before per-sandbox credentials gain nullable settings', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-settings-'));
  const databasePath = join(directory, 'factory.sqlite');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`CREATE TABLE sandboxes (id TEXT PRIMARY KEY, name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('local', 'local-sandbox', 'e2b')), cwd TEXT NOT NULL,
    provider_sandbox_id TEXT, credential_env_var TEXT, template TEXT,
    status TEXT NOT NULL, checked_at TEXT, created_at TEXT NOT NULL) STRICT`);
  legacy.prepare('INSERT INTO sandboxes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'old-e2b', 'Existing E2B', 'e2b', '/home/user/repo', 'provider-id', 'E2B_API_KEY',
    'base', 'running', null, '2026-01-01T00:00:00Z');
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
      assert.equal('sharing' in sandbox!, false);
    } finally { store.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
