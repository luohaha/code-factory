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
import { NativeAgentService, type NativeRunInput } from '../src/native-agent.js';
import { createAgentManagerServer } from '../src/server.js';
import { sandboxesTableSql, schemaStatements } from '../src/schema.js';
import { SqliteAgentManagerStore } from '../src/sqlite-store.js';
import type { RunOutcome, Sandbox } from '../src/types.js';

function fakeE2B(settings: { acceptRotated?: boolean; home?: string; beforeGetInfo?: () => Promise<void> } = {}) {
  let state: 'running' | 'paused' = 'running';
  let killed = false;
  const calls: string[] = [];
  const remoteCommands: Array<{ command: string; cwd: string | undefined; envs: Record<string, string> | undefined }> = [];
  const remoteFiles = new Map<string, string>();
  const remoteWrites: Array<{ path: string; content: string }> = [];
  const home = settings.home ?? '/home/user';
  const check = (credentials: { apiKey?: string; domain?: string }) => {
    if (settings.acceptRotated && credentials.apiKey === 'new-key' &&
      credentials.domain === 'new.e2b.example') return;
    assert.equal(credentials.apiKey, 'test-key');
    assert.equal(credentials.domain, 'e2b.example');
  };
  const handle = (id: string) => ({ sandboxId: id,
    files: {
      exists: async (path: string) => path === home || remoteFiles.has(path),
      write: async (path: string, content: string) => {
        remoteFiles.set(path, content);
        remoteWrites.push({ path, content });
      },
      remove: async (path: string) => { remoteFiles.delete(path); },
    },
    commands: { run: async (command: string, runOptions?: { envs?: Record<string, string>; cwd?: string;
      background?: boolean; onStdout?: (chunk: string) => void }) => { calls.push(`command:${command}`);
      remoteCommands.push({ command, cwd: runOptions?.cwd, envs: runOptions?.envs });
      if (command === 'pwd') return { exitCode: 0, stdout: `${home}\n` };
      if (runOptions?.background) {
        const path = command.match(/ > '([^']+)' 2>&1$/)?.[1];
        assert(path);
        remoteFiles.set(path, 'Remote command completed\n');
        return { wait: async () => ({ exitCode: 0 }), kill: async () => true };
      }
      if (command.startsWith('if test -f ')) {
        const path = command.match(/test -f '([^']+)'/)?.[1];
        assert(path);
        const offset = Number(command.match(/tail -c \+(\d+)/)?.[1]) - 1;
        return { exitCode: 0, stdout: Buffer.from(remoteFiles.get(path) ?? '').subarray(offset, offset + 65_536).toString('base64') };
      }
      return { exitCode: 0, stdout: '' };
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
      await settings.beforeGetInfo?.();
      return { sandboxId: id, templateId: 'base', state } as SandboxInfo;
    },
    async pause(id, options) { check(options); calls.push(`pause:${id}`); state = 'paused'; return true; },
    async kill(id, options) { check(options); calls.push(`kill:${id}`); killed = true; return true; },
  };
  return { service: new E2BSandboxService(client), calls, remoteCommands,
    remoteFiles, remoteWrites,
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
    for (const fields of [{ cwd: '/repo' }, { cwd: null }, { repositoryUrl: 'https://github.com/example/repo.git' }]) {
      const rejected = await request('/sandboxes', 'POST', { kind: 'e2b', name: 'Removed options',
        ...credentials, ...fields });
      assert.equal(rejected.status, 400);
    }
    assert.deepEqual(sdk.calls, []);
    const created = await request('/sandboxes', 'POST', { kind: 'e2b', name: 'Reusable',
      ...credentials });
    assert.equal(created.status, 201);
    const sandbox = await created.json() as { id: string; providerSandboxId: string; status: string;
      credentialEnvVar: string | null; credentialRef: string; domain: string; repositoryUrl: string | null; cwd: string | null };
    assert.equal(sandbox.providerSandboxId, 'created-e2b-id');
    assert.equal(sandbox.credentialEnvVar, null);
    assert.equal(sandbox.domain, 'e2b.example');
    assert.match(sandbox.credentialRef, /^e2b_/);
    assert.equal(sandbox.repositoryUrl, null);
    assert.equal(sandbox.cwd, null);
    assert.equal(JSON.stringify(sandbox).includes('test-key'), false);
    assert.equal(sandbox.status, 'running');
    assert.equal('sharing' in sandbox, false);
    assert.deepEqual(sdk.remoteCommands, []);
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
    assert.deepEqual(sdk.remoteCommands, []);
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

test('E2B creation ignores the managed workspace Git origin without preparing remote contents', async () => {
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
    const sandbox = await response.json() as { id: string; repositoryUrl: string | null; cwd: string | null };
    assert.equal(sandbox.repositoryUrl, null);
    assert.equal(sandbox.cwd, null);
    assert.equal('sharing' in sandbox, false);
    assert.equal(sdk.remoteCommands.length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('E2B workspace settings reject repository and directory configuration', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-options-'));
  const sdk = fakeE2B();
  const manager = new AgentManager({ workspaceRoot: directory, databasePath: ':memory:',
    store: new SqliteAgentManagerStore(':memory:'), e2bService: sdk.service,
    logger: createLogger({ level: 'silent' }) });
  const server = createAgentManagerServer(manager);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const workspace = await manager.createE2BSandbox({ name: 'No checkout', domain: 'e2b.example', apiKey: 'test-key' });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sandboxes/${workspace.id}`;
    for (const body of [{ cwd: '/repo' }, { cwd: null }, { repositoryUrl: 'https://github.com/example/repo.git' }]) {
      const response = await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 400);
    }
    assert.equal(manager.listSandboxes().find((item) => item.id === workspace.id)?.cwd, null);
    assert.deepEqual(sdk.remoteCommands, []);
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
      body: JSON.stringify({ kind: 'e2b', name: 'Original', domain: 'e2b.example', apiKey: 'test-key' }) });
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
      apiKey: 'test-key', environmentVariables: { GH_TOKEN: 'review-runtime-token', REVIEW_MODE: 'configured' } });
    const requirement = manager.createRequirement({ title: 'Remote work', description: 'Review PR',
      provider: 'native-agent', model: 'faux/faux-1', sandboxId: workspace.id });
    const pullRequest = manager.trackPullRequest({ requirementId: requirement.id, repository: 'example/repo',
      number: 7, url: 'https://github.com/example/repo/pull/7', title: 'Remote PR',
      baseBranch: 'main', headBranch: 'feature', headSha: 'abc123def456', status: 'open' });
    assert.throws(() => manager.requestReview(pullRequest.id, { provider: 'codex' }), /Native Agent Reviewer/);
    const outcome = await manager.requestReview(pullRequest.id, { provider: 'native-agent' });
    assert.equal(outcome.status, 'succeeded');
    assert(sdk.remoteCommands.some((entry) => entry.command.includes('gh pr view') && entry.cwd === undefined
      && entry.envs?.GH_TOKEN === 'review-runtime-token' && entry.envs?.REVIEW_MODE === 'configured'));
    assert.equal(manager.listMessages(requirement.id).find((message) => message.author === 'reviewer')?.body, 'Remote review completed');
  } finally {
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('large Native Agent input is available in E2B during the Run and removed afterward', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-handoff-'));
  const databasePath = join(directory, 'factory.sqlite');
  const sdk = fakeE2B();
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let handoff = '';
  faux.setResponses([fauxAssistantMessage('Remote input handled'), (context) => {
    handoff = JSON.stringify(context.messages);
    return fauxAssistantMessage('Remote context restored');
  }]);
  const store = new SqliteAgentManagerStore(databasePath);
  const manager = new AgentManager({ workspaceRoot: directory, databasePath,
    store, e2bService: sdk.service,
    nativeService: new NativeAgentService(join(directory, 'native.sqlite'), models, sdk.service),
    logger: createLogger({ level: 'silent' }) });
  const description = `${'Long description. '.repeat(300)}Final acceptance criterion.`;
  const pendingBody = `${'Long pending instruction. '.repeat(6_000)}Final pending clause.`;
  try {
    const workspace = await manager.createE2BSandbox({ name: 'Large remote input', domain: 'e2b.example',
      apiKey: 'test-key' });
    const requirement = manager.createRequirement({ title: 'Remote input', description,
      provider: 'native-agent', model: 'faux/faux-1', sandboxId: workspace.id });
    const completed = await manager.runRequirement(requirement.id, pendingBody);
    assert.equal(completed.status, 'waiting_confirmation');
    assert.equal(completed.session.pendingMessageCount, 0);
    assert.deepEqual(sdk.remoteWrites.map((write) => write.content), [description, pendingBody]);
    assert.ok(sdk.remoteWrites.every((write) => write.path.startsWith('/tmp/code-factory-')));
    assert.equal(sdk.remoteFiles.size, 0);
    store.setNativeSessionId(requirement.session.id, null, new Date().toISOString());
    const restored = await manager.runRequirement(requirement.id, 'Continue in the remote workspace');
    assert.equal(restored.status, 'waiting_confirmation');
    assert.match(handoff, /Selected E2B workspace: SDK default user home directory/);
    assert.equal(handoff.includes(directory), false);
  } finally {
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Native Agents clone repositories on demand and new sandboxes use remote GitHub authentication', async () => {
  const savedToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'test-manager-github-token';
  try {
    for (const legacy of [false, true]) {
      const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-demand-'));
      const sdk = fakeE2B();
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall('bash', { command: 'git clone https://github.com/example/repo.git' }), { stopReason: 'toolUse' }),
        (context) => {
          assert.equal(JSON.stringify(context.messages).includes('"isError":true'), false);
          return fauxAssistantMessage('Repository prepared');
        },
      ]);
      const store = new SqliteAgentManagerStore(':memory:');
      const manager = new AgentManager({ workspaceRoot: directory, databasePath: ':memory:', store, e2bService: sdk.service,
        nativeService: new NativeAgentService(join(directory, 'native.sqlite'), models, sdk.service),
        logger: createLogger({ level: 'silent' }) });
      try {
        const workspace = await manager.createE2BSandbox({ name: 'On demand', domain: 'e2b.example', apiKey: 'test-key' });
        assert.deepEqual(sdk.remoteCommands, []);
        if (legacy) store.updateSandbox({ ...workspace, cwd: '/legacy/checkout', repositoryUrl: 'https://github.com/example/repo.git' });
        const requirement = manager.createRequirement({ title: 'Clone a repository', description: 'Clone example/repo as needed',
          provider: 'native-agent', model: 'faux/faux-1', sandboxId: workspace.id });
        const outcome = await manager.runRequirement(requirement.id);
        assert.equal(outcome.status, 'waiting_confirmation');
        const cloned = sdk.remoteCommands.find((entry) => entry.command.includes('git clone https://github.com/example/repo.git'));
        assert(cloned);
        assert.equal(cloned.cwd, legacy ? '/legacy/checkout' : undefined);
        assert.equal(cloned.envs?.GH_TOKEN !== undefined, legacy);
      } finally {
        await manager.close();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  } finally {
    if (savedToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = savedToken;
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

test('sandbox cwd accepts null in new and migrated schemas', () => {
  for (const definition of ['TEXT', 'TEXT NOT NULL', "TEXT CHECK (cwd IS NOT NULL OR kind = 'e2b')"]) {
    const directory = mkdtempSync(join(tmpdir(), 'code-factory-nullable-cwd-'));
    const databasePath = join(directory, 'factory.sqlite');
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(sandboxesTableSql.replace('cwd TEXT,', `cwd ${definition},`));
    legacy.prepare('INSERT INTO sandboxes (id, name, kind, cwd, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('existing', 'Existing workspace', 'local', '/existing', '2026-01-01T00:00:00Z');
    legacy.close();
    try {
      const store = new SqliteAgentManagerStore(databasePath);
      try {
        const workspace = store.getSandbox('existing');
        assert(workspace);
        assert.equal(workspace.cwd, '/existing');
        store.updateSandbox({ ...workspace, cwd: null });
        assert.equal(store.getSandbox('existing')?.cwd, null);
      } finally { store.close(); }
      const reopened = new SqliteAgentManagerStore(databasePath);
      try { assert.equal(reopened.getSandbox('existing')?.cwd, null); }
      finally { reopened.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
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
  for (const statement of schemaStatements) legacy.exec(statement);
  legacy.prepare(`INSERT INTO requirements (id, title, description, status, provider, sandbox_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('bound', 'Existing requirement', 'Keep workspace', 'todo', 'native-agent',
    'old-e2b', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  legacy.close();
  try {
    const store = new SqliteAgentManagerStore(databasePath);
    try {
      const sandbox = store.getSandbox('old-e2b');
      assert.equal(sandbox?.providerSandboxId, 'provider-id');
      assert.equal(sandbox?.cwd, '/home/user/repo');
      assert.equal(sandbox?.credentialEnvVar, 'E2B_API_KEY');
      assert.equal(sandbox?.domain, null);
      assert.equal(sandbox?.credentialRef, null);
      assert.equal(sandbox?.repositoryUrl, null);
      assert.equal('sharing' in sandbox!, false);
    } finally { store.close(); }
    const inspected = new DatabaseSync(databasePath);
    try {
      assert.equal(inspected.prepare('SELECT sandbox_id FROM requirements WHERE id = ?').get('bound')?.sandbox_id, 'old-e2b');
      assert.deepEqual(inspected.prepare('PRAGMA foreign_key_check').all(), []);
      const reopened = new SqliteAgentManagerStore(databasePath);
      try { assert.equal(reopened.getSandbox('old-e2b')?.cwd, '/home/user/repo'); }
      finally { reopened.close(); }
    } finally { inspected.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Native RD instructions let the Agent select and clone its own repository in an empty E2B sandbox', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-agent-setup-'));
  const databasePath = join(directory, 'factory.sqlite');
  const sdk = fakeE2B();
  const requests: NativeRunInput[] = [];
  class RecordingNativeService extends NativeAgentService {
    override async run(input: NativeRunInput): Promise<RunOutcome> {
      requests.push(input);
      return { status: 'succeeded', exitCode: 0, nativeSessionId: null, finalMessage: null, error: null };
    }
  }
  const manager = new AgentManager({ workspaceRoot: directory, databasePath,
    store: new SqliteAgentManagerStore(databasePath), e2bService: sdk.service,
    nativeService: new RecordingNativeService(join(directory, 'native.sqlite')),
    logger: createLogger({ level: 'silent' }) });
  try {
    const sandbox = await manager.createE2BSandbox({ name: 'Empty sandbox', domain: 'e2b.example', apiKey: 'test-key',
      environmentVariables: { GH_TOKEN: 'runtime-only-token', CUSTOM: 'runtime-only-custom' } });
    const requirement = manager.createRequirement({ title: 'Clone task repository', description: 'Choose code later',
      provider: 'native-agent', sandboxId: sandbox.id });
    await manager.runRequirement(requirement.id);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.sandbox?.cwd, null);
    assert.equal(requests[0]!.sandbox?.forwardGitHubToken, false);
    assert.deepEqual(requests[0]!.sandbox?.environmentVariables, { GH_TOKEN: 'runtime-only-token', CUSTOM: 'runtime-only-custom' });
    assert.match(requests[0]!.instructions, /Configured environment variable names: CUSTOM, GH_TOKEN/);
    assert.equal(JSON.stringify({ prompt: requests[0]!.prompt, instructions: requests[0]!.instructions }).includes('runtime-only'), false);
    assert.match(requests[0]!.instructions, /This sandbox may be empty/);
    assert.match(requests[0]!.instructions, /Select and clone the repository required by the task/);
    assert.match(requests[0]!.instructions, /if the repository is unspecified, ask the human/);
    assert.doesNotMatch(requests[0]!.instructions, /must already contain a Git checkout|must remain authenticated/);
    await manager.updateSandbox(sandbox.id, { environmentVariables: { GH_TOKEN: 'rotated-token', CUSTOM: null } });
    await manager.runRequirement(requirement.id, 'Use the updated environment');
    assert.deepEqual(requests[1]!.sandbox?.environmentVariables, { GH_TOKEN: 'rotated-token' });
    assert.deepEqual(requests[0]!.sandbox?.environmentVariables, { GH_TOKEN: 'runtime-only-token', CUSTOM: 'runtime-only-custom' });
  } finally {
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('E2B environment API validates, hides values, preserves omitted keys, rotates, removes, and survives restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-environment-'));
  const databasePath = join(directory, 'factory.sqlite');
  const sdk = fakeE2B();
  const manager = new AgentManager({ workspaceRoot: directory, databasePath,
    store: new SqliteAgentManagerStore(databasePath), e2bService: sdk.service,
    logger: createLogger({ level: 'silent' }) });
  const server = createAgentManagerServer(manager);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sandboxes`;
  const send = (path: string, method: string, body: unknown) => fetch(path, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  let savedId = '';
  try {
    const common = { kind: 'e2b', name: 'Configured', domain: 'e2b.example', apiKey: 'test-key' };
    for (const environmentVariables of [[], 'not-an-object', { 'BAD=secret': 'secret' }, { GH_TOKEN: 42 }]) {
      const rejected = await send(base, 'POST', { ...common, environmentVariables });
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.text()).includes('secret'), false);
    }
    assert.equal(sdk.calls.length, 0);
    const local = await send(base, 'POST', { kind: 'local', name: 'Local', cwd: directory,
      environmentVariables: { GH_TOKEN: 'not-for-local' } });
    assert.equal(local.status, 400);
    assert.match(await local.text(), /only supported for E2B/);
    const created = await send(base, 'POST', { ...common,
      environmentVariables: { GH_TOKEN: 'original-github-secret', CUSTOM: '  exact value\n' } });
    assert.equal(created.status, 201);
    const sandbox = await created.json() as { id: string; credentialRef: string; environmentVariableNames: string[] };
    savedId = sandbox.id;
    assert.deepEqual(sandbox.environmentVariableNames, ['CUSTOM', 'GH_TOKEN']);
    assert.equal(JSON.stringify(sandbox).includes('original-github-secret'), false);
    assert.equal((await (await fetch(base)).text()).includes('original-github-secret'), false);
    const secrets = new E2BCredentialStore(e2bCredentialsPath(databasePath));
    try {
      assert.deepEqual(secrets.readEnvironment(sandbox.credentialRef), { GH_TOKEN: 'original-github-secret', CUSTOM: '  exact value\n' });
      const renamed = await send(`${base}/${sandbox.id}`, 'PATCH', { name: 'Renamed', apiKey: 'test-key' });
      assert.equal(renamed.status, 200);
      const rotated = await renamed.json() as { credentialRef: string };
      assert.deepEqual(secrets.readEnvironment(rotated.credentialRef), { GH_TOKEN: 'original-github-secret', CUSTOM: '  exact value\n' });
      assert.equal(secrets.read(sandbox.credentialRef), null);
      const updated = await send(`${base}/${sandbox.id}`, 'PATCH', {
        environmentVariables: { GH_TOKEN: 'replacement-github-secret', CUSTOM: null, EMPTY: '' },
      });
      assert.equal(updated.status, 200);
      const result = await updated.json() as { credentialRef: string; environmentVariableNames: string[] };
      assert.deepEqual(result.environmentVariableNames, ['EMPTY', 'GH_TOKEN']);
      assert.deepEqual(secrets.readEnvironment(result.credentialRef), { GH_TOKEN: 'replacement-github-secret', EMPTY: '' });
      assert.equal(secrets.read(rotated.credentialRef), null);
      assert.equal((await (await fetch(`${base}/${sandbox.id}/health`)).text()).includes('replacement-github-secret'), false);
    } finally { secrets.close(); }
    assert.equal(readFileSync(databasePath).includes('original-github-secret'), false);
    assert.equal(readFileSync(databasePath).includes('replacement-github-secret'), false);
    assert.equal(sdk.remoteCommands.length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
  }
  const restarted = new AgentManager({ workspaceRoot: directory, databasePath,
    store: new SqliteAgentManagerStore(databasePath), e2bService: sdk.service,
    logger: createLogger({ level: 'silent' }) });
  try {
    assert.deepEqual(restarted.listSandboxes().find((sandbox) => sandbox.id === savedId)?.environmentVariableNames, ['EMPTY', 'GH_TOKEN']);
    const cleared = await restarted.updateSandbox(savedId, { environmentVariables: { GH_TOKEN: null, EMPTY: null } });
    assert.deepEqual(cleared.environmentVariableNames, []);
    await restarted.deleteSandbox(savedId);
  } finally {
    await restarted.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const lookupFails of [false, true]) {
  test(`an in-flight ${lookupFails ? 'failed' : 'successful'} health check preserves an environment edit`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-health-edit-'));
    const databasePath = join(directory, 'factory.sqlite');
    let holdLookup = false;
    let finishLookup!: () => void;
    let lookupStarted!: () => void;
    const pendingLookup = new Promise<void>((resolve) => { finishLookup = resolve; });
    const started = new Promise<void>((resolve) => { lookupStarted = resolve; });
    const sdk = fakeE2B({ beforeGetInfo: async () => {
      if (!holdLookup) return;
      holdLookup = false;
      lookupStarted();
      await pendingLookup;
      if (lookupFails) throw new Error('Provider lookup failed');
    } });
    const requests: NativeRunInput[] = [];
    class RecordingNativeService extends NativeAgentService {
      override async run(input: NativeRunInput): Promise<RunOutcome> {
        requests.push(input);
        return { status: 'succeeded', exitCode: 0, nativeSessionId: null, finalMessage: null, error: null };
      }
    }
    const store = new SqliteAgentManagerStore(databasePath);
    const manager = new AgentManager({ workspaceRoot: directory, databasePath, store, e2bService: sdk.service,
      nativeService: new RecordingNativeService(join(directory, 'native.sqlite')),
      logger: createLogger({ level: 'silent' }) });
    const secrets = new E2BCredentialStore(e2bCredentialsPath(databasePath));
    let health: ReturnType<AgentManager['checkSandboxHealth']> | undefined;
    try {
      const sandbox = await manager.createE2BSandbox({ name: 'Original', domain: 'e2b.example', apiKey: 'test-key',
        environmentVariables: { GH_TOKEN: 'original-token' } });
      holdLookup = true;
      health = manager.checkSandboxHealth(sandbox.id);
      await started;
      const updated = await manager.updateSandbox(sandbox.id, { name: 'Edited during lookup',
        environmentVariables: { GH_TOKEN: 'replacement-token', CUSTOM: 'configured' } });
      assert.notEqual(updated.credentialRef, sandbox.credentialRef);
      assert.equal(secrets.read(sandbox.credentialRef!), null);
      finishLookup();
      const checked = await health;
      assert.equal(checked.credentialRef, updated.credentialRef);
      assert.equal(checked.name, updated.name);
      assert.deepEqual(checked.environmentVariableNames, ['CUSTOM', 'GH_TOKEN']);
      assert.equal(checked.status, lookupFails ? 'unreachable' : 'running');
      assert(checked.checkedAt);
      assert.equal(store.getSandbox(sandbox.id)?.credentialRef, updated.credentialRef);
      assert.deepEqual(manager.listSandboxes().find((item) => item.id === sandbox.id), checked);
      assert.deepEqual(secrets.readEnvironment(checked.credentialRef!), { GH_TOKEN: 'replacement-token', CUSTOM: 'configured' });
      const requirement = manager.createRequirement({ title: 'Use edited environment', description: 'Continue after health check',
        provider: 'native-agent', sandboxId: sandbox.id });
      const outcome = await manager.runRequirement(requirement.id);
      assert.equal(outcome.status, 'waiting_confirmation');
      assert.equal(requests[0]?.sandbox?.credentials.apiKey, 'test-key');
      assert.deepEqual(requests[0]?.sandbox?.environmentVariables, { GH_TOKEN: 'replacement-token', CUSTOM: 'configured' });
    } finally {
      finishLookup();
      await health?.catch(() => undefined);
      secrets.close();
      await manager.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('failed sandbox persistence preserves the old environment and removes the uncommitted secret record', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-env-rollback-'));
  const databasePath = join(directory, 'factory.sqlite');
  class FailingStore extends SqliteAgentManagerStore {
    override updateSandbox(_sandbox: Sandbox): Sandbox { throw new Error('Save failed'); }
  }
  const manager = new AgentManager({ workspaceRoot: directory, databasePath,
    store: new FailingStore(databasePath), e2bService: fakeE2B().service,
    logger: createLogger({ level: 'silent' }) });
  try {
    const sandbox = await manager.createE2BSandbox({ name: 'Original', domain: 'e2b.example', apiKey: 'test-key',
      environmentVariables: { GH_TOKEN: 'original-token' } });
    await assert.rejects(manager.updateSandbox(sandbox.id, { environmentVariables: { GH_TOKEN: 'replacement-token' } }), /Save failed/);
    assert.deepEqual(manager.listSandboxes().find((item) => item.id === sandbox.id), sandbox);
    const secrets = new E2BCredentialStore(e2bCredentialsPath(databasePath));
    try { assert.deepEqual(secrets.readEnvironment(sandbox.credentialRef!), { GH_TOKEN: 'original-token' }); }
    finally { secrets.close(); }
    const database = new DatabaseSync(e2bCredentialsPath(databasePath));
    try { assert.equal(database.prepare('SELECT COUNT(*) AS count FROM e2b_credentials').get()?.count, 1); }
    finally { database.close(); }
  } finally {
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('environment updates wait until a sandbox has no active RD Run', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-env-active-'));
  const databasePath = join(directory, 'factory.sqlite');
  let finish!: (outcome: RunOutcome) => void;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  class PendingNativeService extends NativeAgentService {
    override run(input: NativeRunInput): Promise<RunOutcome> {
      return new Promise((resolve) => {
        finish = resolve;
        input.signal.addEventListener('abort', () => resolve({ status: 'cancelled', exitCode: null,
          nativeSessionId: null, finalMessage: null, error: 'Stopped' }), { once: true });
        ready();
      });
    }
  }
  const manager = new AgentManager({ workspaceRoot: directory, databasePath,
    store: new SqliteAgentManagerStore(databasePath), e2bService: fakeE2B().service,
    nativeService: new PendingNativeService(join(directory, 'native.sqlite')),
    logger: createLogger({ level: 'silent' }) });
  try {
    const sandbox = await manager.createE2BSandbox({ name: 'Busy', domain: 'e2b.example', apiKey: 'test-key',
      environmentVariables: { GH_TOKEN: 'original' } });
    const requirement = manager.createRequirement({ title: 'Running', description: 'Use environment',
      provider: 'native-agent', sandboxId: sandbox.id });
    const run = manager.runRequirement(requirement.id);
    await started;
    await assert.rejects(manager.updateSandbox(sandbox.id, { environmentVariables: { GH_TOKEN: 'new' } }), /active RD Run/);
    finish({ status: 'succeeded', exitCode: 0, nativeSessionId: null, finalMessage: null, error: null });
    await run;
    assert.deepEqual((await manager.updateSandbox(sandbox.id, { environmentVariables: { GH_TOKEN: null } })).environmentVariableNames, []);
  } finally {
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
