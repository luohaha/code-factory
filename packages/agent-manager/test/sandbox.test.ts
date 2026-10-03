import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentManager } from '../src/agent-manager.js';
import { createLogger } from '../src/logger.js';
import { createAgentManagerServer } from '../src/server.js';
import { SqliteAgentManagerStore } from '../src/sqlite-store.js';

test('sandbox API creates a reusable Git worktree for native requirements', async () => {
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
    assert.equal(createdResponse.status, 201);
    const sandbox = await createdResponse.json() as { id: string; cwd: string; kind: string };
    assert.equal(sandbox.kind, 'local-sandbox');
    assert.equal(existsSync(join(sandbox.cwd, 'README.md')), true);
    const list = await (await fetch(`${baseUrl}/sandboxes`)).json() as { items: Array<{ id: string }> };
    assert(list.items.some((item) => item.id === sandbox.id));
    for (const number of [1, 2]) {
      const response = await fetch(`${baseUrl}/requirements`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          title: `Native ${number}`, description: 'Shared worktree', provider: 'native-agent', sandboxId: sandbox.id,
        }) });
      assert.equal(response.status, 201);
      assert.equal((await response.json() as { sandboxId: string }).sandboxId, sandbox.id);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
