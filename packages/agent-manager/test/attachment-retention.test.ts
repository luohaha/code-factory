import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { AgentManager } from '../src/core/agent-manager.ts';
import type { PublishedArtifact } from '../src/core/types.ts';
import { runCodeFactoryCli } from '../src/cli/code-factory-cli.ts';
import { DEFAULT_AGENT_MANAGER_CONFIGURATION } from '../src/infrastructure/configuration.ts';
import { createAgentManagerServer } from '../src/http/server.ts';
import { silentLogger } from '../src/infrastructure/logger.ts';
import { SqliteAgentManagerStore } from '../src/storage/sqlite-store.ts';

const now = '2026-10-31T12:00:00.000Z';
const cutoff = '2026-10-24T12:00:00.000Z';
const success = { status: 'succeeded' as const, exitCode: 0, nativeSessionId: null, finalMessage: null, error: null };

function createRequirement(store: SqliteAgentManagerStore, id = 'req-1') {
  return store.createRequirement({ requirementId: id, sessionId: `ses-${id}`, title: 'Attachment retention',
    description: 'Keep the conversation while expiring files', provider: 'codex', now });
}

function createAttachment(store: SqliteAgentManagerStore, id: string, createdAt: string, localPath = `/tmp/${id}`, requirementId = 'req-1') {
  return store.createMessageAttachment({ id, requirementId, fileName: `${id}.txt`, kind: 'file',
    mediaType: 'text/plain', byteSize: 4, localPath, now: createdAt });
}

test('attachment expiry includes the boundary and unclaimed uploads, preserving requirements, messages and newer files', () => {
  const store = new SqliteAgentManagerStore(':memory:');
  try {
    createRequirement(store);
    createAttachment(store, 'old', '2026-09-30T12:00:00.000Z');
    createAttachment(store, 'boundary', cutoff);
    createAttachment(store, 'new', '2026-10-24T12:00:00.001Z');
    const message = store.appendMessage({ id: 'msg-1', requirementId: 'req-1', sessionId: 'ses-req-1',
      author: 'human', body: 'Keep this text', attachmentIds: ['old', 'new'], deliverToRd: true, now });
    assert.deepEqual(store.purgeExpiredAttachments({ createdBefore: cutoff, now }), {
      attachmentCount: 2, requirementIds: ['req-1'],
    });
    assert.equal(store.getMessageAttachment('old'), null);
    assert.equal(store.getMessageAttachment('boundary'), null);
    assert.notEqual(store.getMessageAttachment('new'), null);
    assert.notEqual(store.getRequirement('req-1'), null);
    assert.equal(store.listMessages('req-1')[0]?.id, message.id);
    assert.equal(store.listMessages('req-1')[0]?.body, 'Keep this text');
    assert.deepEqual(store.listMessages('req-1')[0]?.attachments.map((item) => item.id), ['new']);
    assert.deepEqual(store.listPendingAttachmentDeletions().sort(), ['/tmp/boundary', '/tmp/old']);
    assert.deepEqual(store.purgeExpiredAttachments({ createdBefore: cutoff, now }), { attachmentCount: 0, requirementIds: [] });
  } finally { store.close(); }
});

for (const role of ['rd', 'reviewer'] as const) {
  test(`attachment expiry defers files used by a running ${role} and retries after it finishes`, () => {
    const store = new SqliteAgentManagerStore(':memory:');
    try {
      createRequirement(store);
      createRequirement(store, 'req-idle');
      createAttachment(store, 'busy', cutoff);
      createAttachment(store, 'idle', cutoff, '/tmp/idle', 'req-idle');
      store.beginRun({ runId: 'run-1', requirementId: 'req-1', role, provider: 'codex', taskSummary: 'Read file', now });
      assert.deepEqual(store.purgeExpiredAttachments({ createdBefore: cutoff, now }), {
        attachmentCount: 1, requirementIds: ['req-idle'],
      });
      assert.notEqual(store.getMessageAttachment('busy'), null);
      if (role === 'rd') store.finishRdRun('run-1', success, now);
      else store.finishReviewRun('run-1', success, now);
      assert.deepEqual(store.purgeExpiredAttachments({ createdBefore: cutoff, now }), {
        attachmentCount: 1, requirementIds: ['req-1'],
      });
    } finally { store.close(); }
  });
}

test('attachment metadata and deletion tombstones roll back together if expiry fails', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-attachment-atomic-'));
  const databasePath = join(directory, 'factory.sqlite');
  const store = new SqliteAgentManagerStore(databasePath);
  const database = new DatabaseSync(databasePath);
  try {
    createRequirement(store);
    createAttachment(store, 'old', cutoff);
    database.exec(`CREATE TRIGGER reject_attachment_delete BEFORE DELETE ON message_attachments
      BEGIN SELECT RAISE(ABORT, 'test deletion failure'); END`);
    assert.throws(() => store.purgeExpiredAttachments({ createdBefore: cutoff, now }), /test deletion failure/);
    assert.notEqual(store.getMessageAttachment('old'), null);
    assert.deepEqual(store.listPendingAttachmentDeletions(), []);
    database.exec('DROP TRIGGER reject_attachment_delete');
    assert.equal(store.purgeExpiredAttachments({ createdBefore: cutoff, now }).attachmentCount, 1);
  } finally {
    database.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('startup and daily scans use the default 7 days; dynamic changes apply immediately and stop on close', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.parse(now) });
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-attachment-sweep-'));
  const store = new SqliteAgentManagerStore(':memory:');
  createRequirement(store);
  const paths = ['expired', 'tomorrow', 'recent'].map((id) => join(directory, id));
  for (const path of paths) writeFileSync(path, 'data');
  createAttachment(store, 'expired', cutoff, paths[0]!);
  createAttachment(store, 'tomorrow', '2026-10-25T12:00:00.000Z', paths[1]!);
  createAttachment(store, 'recent', '2026-10-29T12:00:00.000Z', paths[2]!);
  const manager = new AgentManager({ workspaceRoot: process.cwd(), store, logger: silentLogger,
    configuration: { ...DEFAULT_AGENT_MANAGER_CONFIGURATION, pullRequestReconcileIntervalSeconds: 0 },
    modelCatalog: { start: () => undefined, stop: () => undefined,
      getModels: () => Promise.resolve({ refreshIntervalSeconds: 86_400, providers: [] }) } });
  try {
    manager.startConfiguredServices();
    assert.equal(manager.getConfiguration().values.attachmentRetentionDays, 7);
    assert.equal(manager.getMessageAttachment('expired'), null);
    assert.equal(existsSync(paths[0]!), false);
    assert.equal(existsSync(paths[1]!), true);
    t.mock.timers.tick(86_400_000);
    assert.equal(manager.getMessageAttachment('tomorrow'), null);
    assert.equal(existsSync(paths[1]!), false);
    assert.equal(existsSync(paths[2]!), true);
    manager.updateConfiguration({ attachmentRetentionDays: 60 });
    assert.notEqual(manager.getMessageAttachment('recent'), null);
    const snapshot = manager.updateConfiguration({ attachmentRetentionDays: 1 });
    assert.equal(snapshot.restartRequired, false);
    assert.equal(manager.getMessageAttachment('recent'), null);
    assert.equal(existsSync(paths[2]!), false);
    assert.notEqual(manager.getRequirement('req-1'), null);
    assert.deepEqual(store.listPendingAttachmentDeletions(), []);
    const event = manager.listEvents().filter((item) => item.type === 'attachments.purged').at(-1);
    assert.deepEqual(event?.payload, { attachmentCount: 1, requirementIds: ['req-1'], createdBefore: now });
    await manager.close();
    t.mock.timers.tick(86_400_000);
  } finally {
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('failed and interrupted file cleanup remains durable across restarts and retries missing files', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-attachment-retry-'));
  const databasePath = join(directory, 'factory.sqlite');
  const blockedPath = join(directory, 'blocked');
  const interruptedPath = join(directory, 'interrupted');
  mkdirSync(blockedPath);
  writeFileSync(interruptedPath, 'data');
  const store = new SqliteAgentManagerStore(databasePath);
  createRequirement(store);
  createAttachment(store, 'blocked', cutoff, blockedPath);
  createAttachment(store, 'interrupted', cutoff, interruptedPath);
  store.purgeExpiredAttachments({ createdBefore: cutoff, now });
  store.close(); // Simulate shutdown after metadata commits, before any files are removed.
  const reopened = new SqliteAgentManagerStore(databasePath);
  const manager = new AgentManager({ workspaceRoot: process.cwd(), store: reopened, logger: silentLogger });
  try {
    manager.updateConfiguration({ attachmentRetentionDays: 7 });
    assert.equal(existsSync(interruptedPath), false);
    assert.deepEqual(reopened.listPendingAttachmentDeletions(), [blockedPath]);
    rmSync(blockedPath, { recursive: true });
    manager.updateConfiguration({ attachmentRetentionDays: 7 });
    assert.deepEqual(reopened.listPendingAttachmentDeletions(), []);
  } finally {
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the default seven-day policy reclaims Human uploads and CLI-published artifacts while preserving the conversation', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-attachment-http-'));
  const store = new SqliteAgentManagerStore(':memory:');
  const requirement = createRequirement(store);
  const manager = new AgentManager({ workspaceRoot: process.cwd(), store, logger: silentLogger,
    attachmentDirectory: directory });
  const server = createAgentManagerServer(manager);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const upload = await fetch(`${url}/api/requirements/${requirement.id}/attachments`, {
      method: 'POST', headers: { 'X-File-Name': 'upload.txt' }, body: 'data',
    });
    assert.equal(upload.status, 201);
    const uploaded = await upload.json() as { id: string; localPath: string };
    store.appendMessage({ id: 'msg-upload', requirementId: requirement.id, sessionId: requirement.session.id,
      author: 'human', body: 'Keep this conversation', attachmentIds: [uploaded.id], deliverToRd: true, now });
    const sourcePath = join(directory, 'report-source.txt');
    writeFileSync(sourcePath, 'data');
    const output: string[] = [];
    const errors: string[] = [];
    const status = await runCodeFactoryCli(['artifact', 'publish', '--path', sourcePath, '--name', 'report.txt'], {
      environment: { CODE_FACTORY_API_URL: `${url}/api`, CODE_FACTORY_REQUIREMENT_ID: requirement.id,
        CODE_FACTORY_SESSION_ID: requirement.session.id },
      writeOut: (value) => output.push(value), writeError: (value) => errors.push(value),
    });
    assert.equal(status, 0, errors.join(''));
    const published = JSON.parse(output.join('')) as PublishedArtifact;
    const publishedPath = manager.getMessageAttachment(published.attachment.id)!.localPath;
    assert.equal((await fetch(`${url}/api/attachments/${uploaded.id}`)).status, 200);
    assert.equal((await fetch(`${url}${published.downloadPath}`)).status, 200);
    assert.equal(manager.getConfiguration().values.attachmentRetentionDays, 7);
    t.mock.timers.tick(8 * 86_400_000);
    const response = await fetch(`${url}/api/configuration`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ attachmentRetentionDays: 7 }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { restartRequired: boolean }).restartRequired, false);
    assert.equal((await fetch(`${url}/api/attachments/${uploaded.id}`)).status, 404);
    assert.equal((await fetch(`${url}${published.downloadPath}`)).status, 404);
    assert.equal(existsSync(uploaded.localPath), false);
    assert.equal(existsSync(publishedPath), false);
    assert.equal(existsSync(sourcePath), true, 'reclamation preserves the original CLI publication source');
    assert.equal(manager.listMessages(requirement.id)[0]?.body, 'Keep this conversation');
    assert.equal(manager.listMessages(requirement.id).length, 2);
    assert.ok(manager.listMessages(requirement.id).every((message) => message.attachments.length === 0));
    assert.notEqual(manager.getRequirement(requirement.id), null);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
