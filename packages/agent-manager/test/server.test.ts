import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { AgentManager } from '../src/agent-manager.ts';
import type { AgentProcessRunner, ProcessRunRequest } from '../src/process-runner.ts';
import { createAgentManagerServer } from '../src/server.ts';
import { SqliteAgentManagerStore } from '../src/sqlite-store.ts';
import type { RunOutcome } from '../src/types.ts';

class WaitingRunner implements AgentProcessRunner {
  request: ProcessRunRequest | null = null;

  run(request: ProcessRunRequest): Promise<RunOutcome> {
    this.request = request;
    return new Promise(() => undefined);
  }
}

test('HTTP API exposes the persisted human and RD Agent conversation', async () => {
  const runner = new WaitingRunner();
  const manager = new AgentManager({
    workspaceRoot: process.cwd(),
    store: new SqliteAgentManagerStore(':memory:'),
    runner,
  });
  const server = createAgentManagerServer(manager, { allowedOrigin: 'http://localhost:3000' });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const createdResponse = await fetch(`${baseUrl}/api/requirements`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: JSON.stringify({ title: 'Interactive task', description: 'Show the transcript', provider: 'codex' }),
    });
    assert.equal(createdResponse.status, 201);
    assert.equal(createdResponse.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    const created = await createdResponse.json() as { id: string; session: { id: string } };

    const startResponse = await fetch(`${baseUrl}/api/requirements/${created.id}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Please start with a regression test.' }),
    });
    assert.equal(startResponse.status, 202);
    runner.request?.onEvent?.({ kind: 'message', message: 'I added the regression test.', raw: {} });

    const queuedResponse = await fetch(`${baseUrl}/api/requirements/${created.id}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Also cover the timeout path.' }),
    });
    assert.equal(queuedResponse.status, 202);
    assert.equal((await queuedResponse.json() as { queued: boolean }).queued, true);

    const messagesResponse = await fetch(`${baseUrl}/api/requirements/${created.id}/messages`);
    assert.equal(messagesResponse.status, 200);
    const body = await messagesResponse.json() as { items: Array<{ author: string; body: string }> };
    assert.deepEqual(body.items.map((message) => message.author), ['human', 'rd_agent', 'human']);
    assert.equal(body.items[1]?.body, 'I added the regression test.');

    const prResponse = await fetch(`${baseUrl}/api/agent/pull-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requirementId: created.id,
        repository: 'acme/repo',
        number: 12,
        url: 'https://github.com/acme/repo/pull/12',
        title: 'Interactive task',
        baseBranch: 'main',
        headBranch: 'feature',
        headSha: 'abc123',
        status: 'open',
      }),
    });
    assert.equal(prResponse.status, 200);
    const pullRequest = await prResponse.json() as { id: string };
    const reviewResponse = await fetch(`${baseUrl}/api/pull-requests/${pullRequest.id}/review-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'codex' }),
    });
    assert.equal(reviewResponse.status, 202);

    const proposedResponse = await fetch(`${baseUrl}/api/agent/requirements`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceSessionId: created.session.id,
        parentRequirementId: created.id,
        title: 'Follow-up',
        description: 'A separately tracked improvement',
      }),
    });
    assert.equal(proposedResponse.status, 201);
    const proposed = await proposedResponse.json() as { status: string; createdBy: string };
    assert.equal(proposed.status, 'todo');
    assert.equal(proposed.createdBy, 'rd_agent');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    manager.close();
  }
});
