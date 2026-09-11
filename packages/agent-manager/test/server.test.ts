import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentManager } from '../src/agent-manager.ts';
import { createLogger } from '../src/logger.ts';
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
  const logLines: string[] = [];
  const logWriter = { write: (value: string) => logLines.push(value) };
  const logger = createLogger({ stdout: logWriter, stderr: logWriter });
  const attachmentDirectory = mkdtempSync(join(tmpdir(), 'code-factory-test-'));
  const manager = new AgentManager({
    workspaceRoot: process.cwd(),
    databasePath: ':memory:',
    attachmentDirectory,
    store: new SqliteAgentManagerStore(':memory:'),
    runner,
    logger,
  });
  const server = createAgentManagerServer(manager, { allowedOrigin: 'http://localhost:3000', logger });
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

    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64');
    const uploadResponse = await fetch(`${baseUrl}/api/requirements/${created.id}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', 'x-file-name': encodeURIComponent('failure screenshot.png') },
      body: image,
    });
    assert.equal(uploadResponse.status, 201);
    const uploaded = await uploadResponse.json() as { id: string; fileName: string; kind: string; mediaType: string; localPath: string };
    assert.equal(uploaded.fileName, 'failure screenshot.png');
    assert.equal(uploaded.kind, 'image');
    assert.equal(uploaded.mediaType, 'image/png');

    const imageResponse = await fetch(`${baseUrl}/api/attachments/${uploaded.id}`);
    assert.equal(imageResponse.status, 200);
    assert.equal(imageResponse.headers.get('content-type'), 'image/png');
    assert.match(imageResponse.headers.get('content-disposition') ?? '', /^inline;/);
    assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), image);

    const notes = Buffer.from('stack trace and reproduction steps\n');
    const fileUploadResponse = await fetch(`${baseUrl}/api/requirements/${created.id}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('debug notes.txt') },
      body: notes,
    });
    assert.equal(fileUploadResponse.status, 201);
    const uploadedFile = await fileUploadResponse.json() as { id: string; kind: string; mediaType: string; localPath: string };
    assert.equal(uploadedFile.kind, 'file');
    assert.equal(uploadedFile.mediaType, 'text/plain');
    const fileResponse = await fetch(`${baseUrl}/api/attachments/${uploadedFile.id}`);
    assert.match(fileResponse.headers.get('content-disposition') ?? '', /^attachment;/);
    assert.deepEqual(Buffer.from(await fileResponse.arrayBuffer()), notes);

    const startResponse = await fetch(`${baseUrl}/api/requirements/${created.id}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Please start with a regression test.', attachmentIds: [uploaded.id, uploadedFile.id] }),
    });
    assert.equal(startResponse.status, 202);
    assert.ok(runner.request?.invocation.args.includes(uploaded.localPath));
    assert.ok(!runner.request?.invocation.args.includes(uploadedFile.localPath));
    assert.match(runner.request?.invocation.input ?? '', /failure screenshot\.png/);
    assert.match(runner.request?.invocation.input ?? '', /debug notes\.txt/);
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
    const body = await messagesResponse.json() as { items: Array<{ author: string; body: string; attachments: Array<{ id: string }> }> };
    assert.deepEqual(body.items.map((message) => message.author), ['human', 'rd_agent', 'human']);
    assert.equal(body.items[1]?.body, 'I added the regression test.');
    assert.equal(body.items[0]?.attachments[0]?.id, uploaded.id);
    assert.equal(body.items[0]?.attachments[1]?.id, uploadedFile.id);

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
    const pullRequest = await prResponse.json() as { id: string; status: string };
    assert.equal(pullRequest.status, 'open');
    const attemptedStatusResponse = await fetch(`${baseUrl}/api/agent/pull-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requirementId: created.id,
        repository: 'acme/repo',
        number: 12,
        url: 'https://github.com/acme/repo/pull/12',
        title: 'Interactive task with another commit',
        baseBranch: 'main',
        headBranch: 'feature',
        headSha: 'def456',
        status: 'merged',
      }),
    });
    assert.equal(attemptedStatusResponse.status, 200);
    const attemptedStatus = await attemptedStatusResponse.json() as { status: string; title: string; headSha: string };
    assert.equal(attemptedStatus.status, 'open');
    assert.equal(attemptedStatus.title, 'Interactive task with another commit');
    assert.equal(attemptedStatus.headSha, 'def456');
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

    const requestLogs = logLines.map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.message === 'HTTP request completed');
    assert.ok(requestLogs.some((entry) => entry.component === 'http'
      && entry.path === '/api/requirements'
      && entry.statusCode === 201
      && typeof entry.durationMs === 'number'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    manager.close();
    rmSync(attachmentDirectory, { recursive: true, force: true });
  }
});
