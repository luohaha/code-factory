import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentManager } from '../src/agent-manager.js';
import { createLogger } from '../src/logger.js';
import { createAgentManagerServer } from '../src/server.js';
import { SqliteAgentManagerStore } from '../src/sqlite-store.js';

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
    assert.equal(createdResponse.status, 404);
    const list = await (await fetch(`${baseUrl}/sandboxes`)).json() as { items: Array<{ id: string; cwd: string }> };
    assert.deepEqual(list.items, [{ id: 'local', name: 'Local execution', kind: 'local', cwd: realpathSync(repository),
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

test('legacy local sandbox selections migrate to local execution', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-local-migration-'));
  const databasePath = join(directory, 'factory.sqlite');
  const first = new SqliteAgentManagerStore(databasePath);
  try {
    const now = new Date().toISOString();
    first.createSandbox({ id: 'sbx_legacy', name: 'Old worktree', kind: 'local-sandbox', cwd: join(directory, 'old'), createdAt: now });
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
