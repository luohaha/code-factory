import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentManager } from '../src/agent-manager.ts';
import {
  DEFAULT_AGENT_MANAGER_CONFIGURATION,
  MAX_PULL_REQUEST_RECONCILE_INTERVAL_SECONDS,
} from '../src/configuration.ts';
import { createLogger } from '../src/logger.ts';
import type { AgentModelCatalogService } from '../src/model-catalog.ts';
import type { AgentProcessRunner, ProcessRunRequest } from '../src/process-runner.ts';
import { createAgentManagerServer } from '../src/server.ts';
import { SqliteAgentManagerStore } from '../src/sqlite-store.ts';
import type { RunOutcome } from '../src/types.ts';
import { CODE_FACTORY_VERSION } from '../src/version.ts';

class WaitingRunner implements AgentProcessRunner {
  request: ProcessRunRequest | null = null;

  run(request: ProcessRunRequest): Promise<RunOutcome> {
    this.request = request;
    return new Promise(() => undefined);
  }
}

class InterruptibleWaitingRunner implements AgentProcessRunner {
  requests: ProcessRunRequest[] = [];

  run(request: ProcessRunRequest): Promise<RunOutcome> {
    this.requests.push(request);
    return new Promise((resolve) => {
      request.signal?.addEventListener('abort', () => resolve({
        status: 'cancelled',
        exitCode: null,
        nativeSessionId: null,
        finalMessage: null,
        error: 'Agent Run interrupted by human',
      }), { once: true });
    });
  }
}

test('HTTP API exposes the cached provider model catalog', async () => {
  let stopped = false;
  const modelCatalog: AgentModelCatalogService = {
    start() {},
    stop() { stopped = true; },
    async refresh() {},
    async getModels() {
      return {
        refreshIntervalSeconds: 86_400,
        providers: [{
          provider: 'codex',
          models: [{ id: 'gpt-test', displayName: 'GPT Test', description: 'Test model' }],
          refreshedAt: '2026-09-12T00:00:00.000Z',
          stale: false,
        }],
      };
    },
  };
  const manager = new AgentManager({
    workspaceRoot: process.cwd(),
    store: new SqliteAgentManagerStore(':memory:'),
    logger: createLogger({ level: 'silent' }),
    modelCatalog,
  });
  const server = createAgentManagerServer(manager);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/agent-models`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      refreshIntervalSeconds: 86_400,
      providers: [{
        provider: 'codex',
        models: [{ id: 'gpt-test', displayName: 'GPT Test', description: 'Test model' }],
        refreshedAt: '2026-09-12T00:00:00.000Z',
        stale: false,
      }],
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
  }
  assert.equal(stopped, true);
});

test('HTTP API reports its version and reads, validates, persists, and applies configuration', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-config-api-'));
  const configurationFilePath = join(directory, 'config.json');
  const fileConfiguration = { ...DEFAULT_AGENT_MANAGER_CONFIGURATION, pullRequestReconcileIntervalSeconds: 0 };
  const manager = new AgentManager({
    workspaceRoot: process.cwd(),
    store: new SqliteAgentManagerStore(':memory:'),
    logger: createLogger({ level: 'debug', stdout: { write: () => undefined }, stderr: { write: () => undefined } }),
    configuration: fileConfiguration,
    effectiveConfiguration: {
      ...fileConfiguration,
      host: '0.0.0.0',
      port: 9_999,
      openDashboard: true,
      databasePath: '/launch-only/factory.sqlite',
      logLevel: 'debug',
    },
    configurationFilePath,
  });
  const server = createAgentManagerServer(manager);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const healthResponse = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), {
      ok: true,
      version: CODE_FACTORY_VERSION,
      workspaceRoot: process.cwd(),
    });

    const initialResponse = await fetch(`${baseUrl}/api/configuration`);
    assert.equal(initialResponse.status, 200);
    const initial = await initialResponse.json() as {
      path: string;
      values: { host: string; port: number; openDashboard: boolean; databasePath: string | null };
      restartRequired: boolean;
    };
    assert.equal(initial.path, configurationFilePath);
    assert.equal(initial.values.host, '127.0.0.1');
    assert.equal(initial.values.port, 4310);
    assert.equal(initial.values.openDashboard, false);
    assert.equal(initial.values.databasePath, null);
    assert.equal(initial.restartRequired, false);

    const updateResponse = await fetch(`${baseUrl}/api/configuration`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ logLevel: 'warn' }),
    });
    assert.equal(updateResponse.status, 200);
    const updated = await updateResponse.json() as {
      values: { host: string; port: number; openDashboard: boolean; databasePath: string | null; logLevel: string };
      restartRequired: boolean;
      restartRequiredFields: string[];
    };
    assert.equal(updated.values.host, '127.0.0.1');
    assert.equal(updated.values.port, 4310);
    assert.equal(updated.values.openDashboard, false);
    assert.equal(updated.values.databasePath, null);
    assert.equal(updated.values.logLevel, 'warn');
    assert.equal(updated.restartRequired, false);
    assert.deepEqual(updated.restartRequiredFields, []);
    assert.equal(manager.logger.level, 'warn');
    assert.deepEqual(JSON.parse(readFileSync(configurationFilePath, 'utf8')), updated.values);

    const restartResponse = await fetch(`${baseUrl}/api/configuration`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 8080 }),
    });
    const restart = await restartResponse.json() as { restartRequired: boolean; restartRequiredFields: string[] };
    assert.equal(restart.restartRequired, true);
    assert.deepEqual(restart.restartRequiredFields, ['port']);

    const invalidResponse = await fetch(`${baseUrl}/api/configuration`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pullRequestReconcileIntervalSeconds: MAX_PULL_REQUEST_RECONCILE_INTERVAL_SECONDS + 1,
      }),
    });
    assert.equal(invalidResponse.status, 400);
    assert.equal(manager.getConfiguration().values.pullRequestReconcileIntervalSeconds, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('HTTP API rejects unsupported reasoning effort values', async () => {
  const manager = new AgentManager({
    workspaceRoot: process.cwd(),
    store: new SqliteAgentManagerStore(':memory:'),
    logger: createLogger({ level: 'silent' }),
  });
  const server = createAgentManagerServer(manager);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/requirements`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Invalid configuration',
        description: 'Reject an unsupported effort',
        provider: 'codex',
        reasoningEffort: 'ultra',
      }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json() as { error: string }).error, /reasoningEffort/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    manager.close();
  }
});

test('HTTP API creates, lists, validates, and cancels Scheduled Agent Triggers', async () => {
  const manager = new AgentManager({
    workspaceRoot: process.cwd(),
    store: new SqliteAgentManagerStore(':memory:'),
    logger: createLogger({ level: 'silent' }),
  });
  const requirement = manager.createRequirement({
    title: 'Long build',
    description: 'Wake the RD Agent after the compiler finishes',
    provider: 'codex',
  });
  const otherRequirement = manager.createRequirement({
    title: 'Other work',
    description: 'Keep trigger ownership scoped',
    provider: 'codex',
  });
  const server = createAgentManagerServer(manager);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const collectionUrl = `${baseUrl}/api/requirements/${requirement.id}/scheduled-agent-triggers`;

  try {
    const invalid = await fetch(collectionUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schedule: 'recurring', intervalSeconds: 30 }),
    });
    assert.equal(invalid.status, 400);

    const createdResponse = await fetch(collectionUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schedule: 'recurring', intervalSeconds: 3_600 }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as {
      id: string;
      requirementId: string;
      schedule: string;
      status: string;
      nextFireAt: string | null;
    };
    assert.equal(created.requirementId, requirement.id);
    assert.equal(created.schedule, 'recurring');
    assert.equal(created.status, 'active');
    assert.ok(created.nextFireAt);

    const otherCreatedResponse = await fetch(
      `${baseUrl}/api/requirements/${otherRequirement.id}/scheduled-agent-triggers`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schedule: 'once', intervalSeconds: 7_200 }),
      },
    );
    assert.equal(otherCreatedResponse.status, 201);
    const otherCreated = await otherCreatedResponse.json() as { id: string };

    const listResponse = await fetch(collectionUrl);
    assert.equal(listResponse.status, 200);
    assert.deepEqual((await listResponse.json() as { items: Array<{ id: string }> }).items.map((item) => item.id), [created.id]);

    const globalListResponse = await fetch(`${baseUrl}/api/scheduled-agent-triggers`);
    assert.equal(globalListResponse.status, 200);
    assert.deepEqual(
      (await globalListResponse.json() as { items: Array<{ id: string }> }).items.map((item) => item.id).sort(),
      [created.id, otherCreated.id].sort(),
    );

    const wrongRequirement = await fetch(
      `${baseUrl}/api/requirements/${otherRequirement.id}/scheduled-agent-triggers/${created.id}`,
      { method: 'DELETE' },
    );
    assert.equal(wrongRequirement.status, 404);

    const cancelledResponse = await fetch(`${collectionUrl}/${created.id}`, { method: 'DELETE' });
    assert.equal(cancelledResponse.status, 200);
    assert.equal((await cancelledResponse.json() as { status: string }).status, 'cancelled');
    const repeatedCancel = await fetch(`${collectionUrl}/${created.id}`, { method: 'DELETE' });
    assert.equal(repeatedCancel.status, 409);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
  }
});

test('HTTP API deletes only TODO requirements', async () => {
  const store = new SqliteAgentManagerStore(':memory:');
  const manager = new AgentManager({
    workspaceRoot: process.cwd(),
    store,
    logger: createLogger({ level: 'silent' }),
  });
  const server = createAgentManagerServer(manager);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const createdResponse = await fetch(`${baseUrl}/api/requirements`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Discard draft',
        description: 'This work is no longer needed',
        provider: 'codex',
      }),
    });
    const created = await createdResponse.json() as { id: string };

    const deletedResponse = await fetch(`${baseUrl}/api/requirements/${created.id}`, { method: 'DELETE' });
    assert.equal(deletedResponse.status, 204);
    const listResponse = await fetch(`${baseUrl}/api/requirements`);
    assert.deepEqual(await listResponse.json(), { items: [] });

    const repeatedResponse = await fetch(`${baseUrl}/api/requirements/${created.id}`, { method: 'DELETE' });
    assert.equal(repeatedResponse.status, 409);
    const missingResponse = await fetch(`${baseUrl}/api/requirements/req_missing`, { method: 'DELETE' });
    assert.equal(missingResponse.status, 404);

    const started = manager.createRequirement({
      title: 'Keep active work',
      description: 'Execution already started',
      provider: 'codex',
    });
    store.transitionRequirement(started.id, ['todo'], 'doing', new Date().toISOString());
    const conflictResponse = await fetch(`${baseUrl}/api/requirements/${started.id}`, { method: 'DELETE' });
    assert.equal(conflictResponse.status, 409);
    assert.equal(manager.getRequirement(started.id)?.status, 'doing');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
  }
});

test('HTTP reply queues by default and the interrupt action resumes the RD Agent with that message', async () => {
  const runner = new InterruptibleWaitingRunner();
  const manager = new AgentManager({
    workspaceRoot: process.cwd(),
    store: new SqliteAgentManagerStore(':memory:'),
    runner,
    logger: createLogger({ level: 'silent' }),
  });
  const server = createAgentManagerServer(manager);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const created = await fetch(`${baseUrl}/api/requirements`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Correct course', description: 'Initial task', provider: 'codex' }),
    }).then((response) => response.json()) as { id: string };
    await fetch(`${baseUrl}/api/requirements/${created.id}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    const response = await fetch(`${baseUrl}/api/requirements/${created.id}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Use this corrected direction.' }),
    });
    assert.equal(response.status, 202);
    const body = await response.json() as { queued: boolean };
    assert.equal(body.queued, true);
    assert.equal(runner.requests[0]?.signal?.aborted, false);

    const interruptResponse = await fetch(`${baseUrl}/api/requirements/${created.id}/interrupt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(interruptResponse.status, 202);
    assert.equal(runner.requests[0]?.signal?.aborted, true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(runner.requests.length, 2);
    assert.match(runner.requests[1]?.invocation.input ?? '', /Use this corrected direction\./);

    const secondInterrupt = await fetch(`${baseUrl}/api/requirements/${created.id}/interrupt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(secondInterrupt.status, 202);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const repeatedInterrupt = await fetch(`${baseUrl}/api/requirements/${created.id}/interrupt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(repeatedInterrupt.status, 409);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    manager.close();
  }
});

test('HTTP reply reactivates a completed requirement', async () => {
  const store = new SqliteAgentManagerStore(':memory:');
  const runner = new WaitingRunner();
  const manager = new AgentManager({
    workspaceRoot: process.cwd(),
    store,
    runner,
    logger: createLogger({ level: 'silent' }),
  });
  const server = createAgentManagerServer(manager);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const requirement = manager.createRequirement({
      title: 'Reactivate completed work',
      description: 'A follow-up reply should resume the RD session',
      provider: 'codex',
    });
    store.beginRun({
      runId: 'run-completed',
      requirementId: requirement.id,
      role: 'rd',
      provider: 'codex',
      taskSummary: 'Complete the initial work',
      now: '2026-09-15T00:00:00.000Z',
    });
    store.finishRdRun('run-completed', {
      status: 'succeeded',
      exitCode: 0,
      nativeSessionId: 'native-thread-1',
      finalMessage: 'ready',
      error: null,
    }, '2026-09-15T00:01:00.000Z');
    manager.confirmRequirement(requirement.id);

    const response = await fetch(`${baseUrl}/api/requirements/${requirement.id}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Reopen this and cover the edge case.' }),
    });
    assert.equal(response.status, 202);
    const body = await response.json() as { queued: boolean; message: { body: string } };
    assert.equal(body.queued, false);
    assert.equal(body.message.body, 'Reopen this and cover the edge case.');

    const reactivated = manager.getRequirement(requirement.id);
    assert.equal(reactivated?.status, 'doing');
    assert.equal(reactivated?.session.state, 'running');
    assert.equal(reactivated?.completedAt, null);
    assert.match(runner.request?.invocation.input ?? '', /Reopen this and cover the edge case\./);
    assert.ok(runner.request?.invocation.args.includes('native-thread-1'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
  }
});

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
      body: JSON.stringify({
        title: 'Interactive task',
        description: 'Show the transcript',
        provider: 'codex',
        model: 'gpt-5.6',
        reasoningEffort: 'xhigh',
      }),
    });
    assert.equal(createdResponse.status, 201);
    assert.equal(createdResponse.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    const created = await createdResponse.json() as {
      id: string;
      model: string | null;
      reasoningEffort: string | null;
      session: { id: string };
    };
    assert.equal(created.model, 'gpt-5.6');
    assert.equal(created.reasoningEffort, 'xhigh');

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
    assert.ok(runner.request?.invocation.args.includes('gpt-5.6'));
    assert.ok(runner.request?.invocation.args.includes('model_reasoning_effort="xhigh"'));
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
      body: JSON.stringify({ provider: 'codex', model: 'gpt-5.5', reasoningEffort: 'max' }),
    });
    assert.equal(reviewResponse.status, 202);
    assert.ok(runner.request?.invocation.args.includes('gpt-5.5'));
    assert.ok(runner.request?.invocation.args.includes('model_reasoning_effort="max"'));
    const persistedReview = manager.listReviewRequests(pullRequest.id)[0];
    assert.equal(persistedReview?.model, 'gpt-5.5');
    assert.equal(persistedReview?.reasoningEffort, 'max');

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
