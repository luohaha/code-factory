import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentManager } from '../src/agent-manager.js';
import { createLogger } from '../src/logger.js';
import { createAgentManagerServer } from '../src/server.js';
import { SqliteAgentManagerStore } from '../src/sqlite-store.js';
import type { AgentProcessRunner, ProcessRunRequest } from '../src/process-runner.js';

test('local execution uses the managed workspace without creating a sandbox worktree', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-sandbox-'));
  const repository = join(directory, 'repo');
  const data = join(directory, 'data');
  execFileSync('git', ['init', repository]);
  writeFileSync(join(repository, 'README.md'), 'Test repository\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repository });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'Initial'], { cwd: repository });
  const databasePath = join(data, 'factory.sqlite');
  const manager = new AgentManager({ workspaceRoot: repository, databasePath,
    store: new SqliteAgentManagerStore(databasePath), logger: createLogger({ level: 'silent' }) });
  const server = createAgentManagerServer(manager);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}/api`;
  try {
    const createdResponse = await fetch(`${baseUrl}/sandboxes`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Shared' }) });
    assert.equal(createdResponse.status, 400);
    const list = await (await fetch(`${baseUrl}/sandboxes`)).json() as { items: Array<{ id: string; cwd: string }> };
    assert.deepEqual(list.items, [{ id: 'local', name: 'Default workspace', kind: 'local', cwd: realpathSync(repository),
      providerSandboxId: null, credentialEnvVar: null, domain: null, credentialRef: null, repositoryUrl: null,
      template: null, sharing: null,
      status: 'running', checkedAt: null,
      createdAt: '1970-01-01T00:00:00.000Z' }]);
    for (const number of [1, 2]) {
      const response = await fetch(`${baseUrl}/requirements`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          title: `Native ${number}`, description: 'Managed workspace', provider: 'native-agent', sandboxId: 'local',
        }) });
      assert.equal(response.status, 201);
      assert.equal((await response.json() as { sandboxId: string | null }).sandboxId, null);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('named local execution paths set RD cwd for Codex and Claude while Default uses the managed workspace', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-local-path-'));
  const workspace = join(directory, 'workspace');
  const checkout = join(directory, 'checkout');
  mkdirSync(workspace);
  mkdirSync(checkout);
  const requests: ProcessRunRequest[] = [];
  const runner: AgentProcessRunner = { async run(request) {
    requests.push(request);
    return { status: 'succeeded', exitCode: 0, nativeSessionId: null, finalMessage: null, error: null };
  } };
  const manager = new AgentManager({ workspaceRoot: workspace, store: new SqliteAgentManagerStore(':memory:'),
    runner, logger: createLogger({ level: 'silent' }) });
  const server = createAgentManagerServer(manager);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const post = (path: string, body: object) => fetch(`${base}${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/sandboxes', { kind: 'local', name: 'Relative', cwd: 'checkout' })).status, 400);
    const missing = await post('/sandboxes', { kind: 'local', name: 'Missing', cwd: join(directory, 'missing') });
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), {
      error: 'local workspace path must be an existing directory on the Agent Manager host',
    });
    assert.equal(manager.listSandboxes().length, 1);
    assert.equal((await post('/sandboxes', { kind: 'local', name: 'Duplicate default', cwd: workspace })).status, 400);
    const created = await post('/sandboxes', { kind: 'local', name: 'Feature checkout', cwd: checkout });
    assert.equal(created.status, 201);
    const path = await created.json() as { id: string; name: string; kind: string; cwd: string };
    assert.equal(path.name, 'Feature checkout');
    assert.equal(path.kind, 'local');
    assert.equal(path.cwd, realpathSync(checkout));
    assert.equal(manager.listSandboxes().length, 2);
    const unused = await post('/sandboxes', { kind: 'local', name: 'Unused', cwd: directory });
    const unusedPath = await unused.json() as { id: string };
    const missingUpdate = await fetch(`${base}/sandboxes/${unusedPath.id}`, { method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Invalid update', cwd: join(directory, 'missing') }) });
    assert.equal(missingUpdate.status, 400);
    assert.deepEqual(await missingUpdate.json(), {
      error: 'local workspace path must be an existing directory on the Agent Manager host',
    });
    const unchanged = manager.listSandboxes().find((sandbox) => sandbox.id === unusedPath.id);
    assert.equal(unchanged?.name, 'Unused');
    assert.equal(unchanged?.cwd, realpathSync(directory));
    const patched = await fetch(`${base}/sandboxes/${unusedPath.id}`, { method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed checkout', cwd: checkout }) });
    assert.equal(patched.status, 200);
    assert.deepEqual(await patched.json().then((item: { name: string; cwd: string }) => [item.name, item.cwd]),
      ['Renamed checkout', realpathSync(checkout)]);
    assert.equal((await fetch(`${base}/sandboxes/local`, { method: 'PATCH',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Renamed' }) })).status, 400);
    assert.equal((await fetch(`${base}/sandboxes/${unusedPath.id}`, { method: 'DELETE' })).status, 204);
    assert.equal(statSync(directory).isDirectory(), true);
    assert.equal(manager.listSandboxes().length, 2);

    for (const provider of ['codex', 'claude-code'] as const) {
      const response = await post('/requirements', { title: provider, description: 'Use custom path',
        provider, sandboxId: path.id });
      assert.equal(response.status, 201);
      const requirement = await response.json() as { id: string; sandboxId: string };
      assert.equal(requirement.sandboxId, path.id);
      await manager.runRequirement(requirement.id);
      assert.equal(requests.at(-1)?.workspaceRoot, realpathSync(checkout));
    }
    const native = manager.createRequirement({ title: 'Native', description: 'Use custom path',
      provider: 'native-agent', sandboxId: path.id });
    assert.equal(native.sandboxId, path.id);
    const editable = manager.createRequirement({ title: 'Editable', description: 'Choose later', provider: 'claude-code' });
    assert.equal(manager.updateRequirementAgentConfiguration(editable.id, { sandboxId: path.id }).sandboxId, path.id);
    const standard = manager.createRequirement({ title: 'Default', description: 'Use workspace', provider: 'codex' });
    await manager.runRequirement(standard.id);
    assert.equal(requests.at(-1)?.workspaceRoot, realpathSync(workspace));
    assert.equal((await fetch(`${base}/sandboxes/${path.id}`, { method: 'DELETE' })).status, 409);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy local sandbox selections migrate to local execution', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-local-migration-'));
  const databasePath = join(directory, 'factory.sqlite');
  const first = new SqliteAgentManagerStore(databasePath);
  try {
    const now = new Date().toISOString();
    first.createSandbox({ id: 'sbx_legacy', name: 'Old worktree', kind: 'local-sandbox', cwd: join(directory, 'old'),
      providerSandboxId: null, credentialEnvVar: null, domain: null, credentialRef: null, repositoryUrl: null,
      template: null, sharing: null,
      status: 'unknown', checkedAt: null, createdAt: now });
    first.createRequirement({ requirementId: 'req_local', sessionId: 'ses_local', title: 'Local',
      description: 'Use workspace', provider: 'native-agent', sandboxId: 'sbx_legacy', now });
  } finally {
    first.close();
  }
  const reopened = new SqliteAgentManagerStore(databasePath);
  try {
    assert.equal(reopened.getRequirement('req_local')?.sandboxId, null);
  } finally {
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
