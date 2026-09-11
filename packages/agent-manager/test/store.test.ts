import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { SqliteAgentManagerStore } from '../src/sqlite-store.ts';
import { StoreConflictError } from '../src/store.ts';

const now = '2026-09-10T12:00:00.000Z';

test('a requirement is created atomically with exactly one RD session', () => {
  const store = new SqliteAgentManagerStore(':memory:');
  try {
    const item = store.createRequirement({
      requirementId: 'req-1',
      sessionId: 'ses-1',
      title: 'Improve compaction',
      description: 'Add timing details',
      provider: 'codex',
      createdBy: 'human',
      now,
    });
    assert.equal(item.status, 'todo');
    assert.equal(item.session.requirementId, item.id);
    assert.equal(item.session.state, 'idle');
    assert.equal(store.listSessions().length, 1);
  } finally {
    store.close();
  }
});

test('different requirement sessions may run concurrently without scheduling', () => {
  const store = new SqliteAgentManagerStore(':memory:');
  try {
    for (const id of ['1', '2']) {
      store.createRequirement({
        requirementId: `req-${id}`,
        sessionId: `ses-${id}`,
        title: `Requirement ${id}`,
        description: 'Description',
        provider: 'codex',
        createdBy: 'human',
        now,
      });
    }
    store.beginRun({ runId: 'run-1', requirementId: 'req-1', role: 'rd', provider: 'codex', taskSummary: 'start', now });
    store.beginRun({ runId: 'run-2', requirementId: 'req-2', role: 'rd', provider: 'codex', taskSummary: 'start', now });
    assert.equal(store.getRequirement('req-1')?.session.state, 'running');
    assert.equal(store.getRequirement('req-2')?.session.state, 'running');
    assert.equal(store.listRuns().filter((run) => run.status === 'running').length, 2);
  } finally {
    store.close();
  }
});

test('the same RD session cannot start a second active run', () => {
  const store = new SqliteAgentManagerStore(':memory:');
  try {
    store.createRequirement({
      requirementId: 'req-1',
      sessionId: 'ses-1',
      title: 'Requirement',
      description: 'Description',
      provider: 'codex',
      createdBy: 'human',
      now,
    });
    store.beginRun({ runId: 'run-1', requirementId: 'req-1', role: 'rd', provider: 'codex', taskSummary: 'start', now });
    assert.throws(
      () => store.beginRun({ runId: 'run-2', requirementId: 'req-1', role: 'rd', provider: 'codex', taskSummary: 'start again', now }),
      StoreConflictError,
    );
  } finally {
    store.close();
  }
});

test('successful RD run waits for confirmation and human confirmation completes the session', () => {
  const store = new SqliteAgentManagerStore(':memory:');
  try {
    store.createRequirement({
      requirementId: 'req-1',
      sessionId: 'ses-1',
      title: 'Requirement',
      description: 'Description',
      provider: 'claude-code',
      createdBy: 'human',
      now,
    });
    store.beginRun({ runId: 'run-1', requirementId: 'req-1', role: 'rd', provider: 'claude-code', taskSummary: 'start', now });
    const awaiting = store.finishRdRun('run-1', {
      status: 'succeeded',
      exitCode: 0,
      nativeSessionId: 'native-1',
      finalMessage: 'done',
      error: null,
    }, '2026-09-10T12:01:00.000Z');
    assert.equal(awaiting.status, 'waiting_confirmation');
    assert.equal(awaiting.session.state, 'waiting_human');
    assert.equal(awaiting.session.nativeSessionId, 'native-1');

    const done = store.transitionRequirement('req-1', ['waiting_confirmation'], 'done', '2026-09-10T12:02:00.000Z');
    assert.equal(done.status, 'done');
    assert.equal(done.session.state, 'completed');
  } finally {
    store.close();
  }
});

test('an open PR starts one ephemeral reviewer without changing its RD session', () => {
  const store = new SqliteAgentManagerStore(':memory:');
  try {
    store.createRequirement({
      requirementId: 'req-1',
      sessionId: 'ses-1',
      title: 'Requirement',
      description: 'Description',
      provider: 'codex',
      createdBy: 'human',
      now,
    });
    const pullRequest = store.upsertPullRequest({
      id: 'pr-1',
      requirementId: 'req-1',
      repository: 'acme/repo',
      number: 42,
      url: 'https://github.com/acme/repo/pull/42',
      title: 'Improve behavior',
      baseBranch: 'main',
      headBranch: 'feature',
      headSha: 'abc123',
      status: 'open',
      now,
    });
    const started = store.beginReviewRequest({
      id: 'review-request-1',
      runId: 'review-1',
      pullRequestId: pullRequest.id,
      requirementId: 'req-1',
      provider: 'codex',
      targetHeadSha: pullRequest.headSha,
      taskSummary: 'review main',
      now,
    });
    assert.equal(started.run.sessionId, null);
    assert.equal(store.getRequirement('req-1')?.session.state, 'idle');
    assert.throws(() => store.beginReviewRequest({
      id: 'review-request-2',
      runId: 'review-2',
      pullRequestId: pullRequest.id,
      requirementId: 'req-1',
      provider: 'claude-code',
      targetHeadSha: pullRequest.headSha,
      taskSummary: 'duplicate review',
      now,
    }), StoreConflictError);
    const finished = store.finishReviewRequest('review-request-1', {
      status: 'succeeded', exitCode: 0, nativeSessionId: null, finalMessage: 'reviewed', error: null,
    }, '2026-09-10T12:01:00.000Z');
    assert.equal(finished.status, 'succeeded');
  } finally {
    store.close();
  }
});

test('human and Agent messages are stored as an ordered requirement conversation', () => {
  const store = new SqliteAgentManagerStore(':memory:');
  try {
    store.createRequirement({
      requirementId: 'req-1',
      sessionId: 'ses-1',
      title: 'Requirement',
      description: 'Description',
      provider: 'codex',
      createdBy: 'human',
      now,
    });
    store.appendMessage({
      id: 'msg-1',
      requirementId: 'req-1',
      sessionId: 'ses-1',
      author: 'human',
      body: 'Please add a regression test.',
      deliverToRd: true,
      now,
    });
    store.appendMessage({
      id: 'msg-2',
      requirementId: 'req-1',
      sessionId: 'ses-1',
      author: 'rd_agent',
      body: 'The regression test is now passing.',
      deliverToRd: false,
      now: '2026-09-10T12:00:01.000Z',
    });
    const messages = store.listMessages('req-1');
    assert.deepEqual(messages.map((message) => message.sequence), [1, 2]);
    assert.deepEqual(store.listPendingRdMessages('req-1').map((message) => message.author), ['human']);
    store.beginRun({
      runId: 'run-1', requirementId: 'req-1', role: 'rd', provider: 'codex', taskSummary: 'start',
      inputFromSequence: 1, inputToSequence: 1, now,
    });
    store.finishRdRun('run-1', {
      status: 'succeeded', exitCode: 0, nativeSessionId: 'native-1', finalMessage: 'done', error: null,
    }, '2026-09-10T12:00:02.000Z');
    assert.equal(store.listPendingRdMessages('req-1').length, 0);
  } finally {
    store.close();
  }
});

test('image attachments are claimed by one requirement message', () => {
  const store = new SqliteAgentManagerStore(':memory:');
  try {
    store.createRequirement({
      requirementId: 'req-1',
      sessionId: 'ses-1',
      title: 'Inspect screenshot',
      description: 'Use the supplied image',
      provider: 'codex',
      createdBy: 'human',
      now,
    });
    store.createMessageAttachment({
      id: 'att-1',
      requirementId: 'req-1',
      fileName: 'bug.png',
      kind: 'image',
      mediaType: 'image/png',
      byteSize: 128,
      localPath: '/tmp/bug.png',
      now,
    });
    const message = store.appendMessage({
      id: 'msg-1',
      requirementId: 'req-1',
      sessionId: 'ses-1',
      author: 'human',
      body: '',
      attachmentIds: ['att-1'],
      deliverToRd: true,
      now,
    });

    assert.equal(message.body, '');
    assert.equal(message.attachments[0]?.fileName, 'bug.png');
    assert.equal(store.getMessageAttachment('att-1')?.messageId, 'msg-1');
    assert.throws(() => store.appendMessage({
      id: 'msg-2',
      requirementId: 'req-1',
      sessionId: 'ses-1',
      author: 'human',
      body: 'reuse it',
      attachmentIds: ['att-1'],
      deliverToRd: true,
      now,
    }), StoreConflictError);
  } finally {
    store.close();
  }
});

test('legacy image-only attachment storage migrates to general files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-store-test-'));
  const databasePath = join(directory, 'factory.sqlite');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`CREATE TABLE message_attachments (
    id TEXT PRIMARY KEY,
    requirement_id TEXT NOT NULL,
    message_id TEXT,
    file_name TEXT NOT NULL,
    media_type TEXT NOT NULL CHECK (media_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
    byte_size INTEGER NOT NULL CHECK (byte_size > 0),
    local_path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  ) STRICT`);
  legacy.close();

  const store = new SqliteAgentManagerStore(databasePath);
  try {
    store.createRequirement({
      requirementId: 'req-1',
      sessionId: 'ses-1',
      title: 'Inspect logs',
      description: 'Use a text attachment',
      provider: 'claude-code',
      createdBy: 'human',
      now,
    });
    const attachment = store.createMessageAttachment({
      id: 'att-1',
      requirementId: 'req-1',
      fileName: 'debug.log',
      kind: 'file',
      mediaType: 'text/plain',
      byteSize: 42,
      localPath: '/tmp/debug.log',
      now,
    });
    assert.equal(attachment.kind, 'file');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('external GitHub event messages are persisted idempotently', () => {
  const store = new SqliteAgentManagerStore(':memory:');
  try {
    store.createRequirement({
      requirementId: 'req-1',
      sessionId: 'ses-1',
      title: 'Requirement',
      description: 'Description',
      provider: 'codex',
      createdBy: 'human',
      now,
    });
    store.upsertPullRequest({
      id: 'pr-1',
      requirementId: 'req-1',
      repository: 'acme/repo',
      number: 42,
      url: 'https://github.com/acme/repo/pull/42',
      title: 'Feature',
      baseBranch: 'main',
      headBranch: 'feature',
      headSha: 'abc123',
      status: 'open',
      now,
    });
    const input = {
      pullRequestId: 'pr-1',
      sourceKey: 'github:pr-1:comment:1',
      requirementId: 'req-1',
      sessionId: 'ses-1',
      author: 'reviewer' as const,
      body: 'Please add a test.',
      deliverToRd: true,
      now,
    };
    assert.ok(store.appendExternalMessage({ id: 'msg-1', ...input }));
    assert.equal(store.appendExternalMessage({ id: 'msg-2', ...input }), null);
    assert.equal(store.listMessages('req-1').length, 1);
  } finally {
    store.close();
  }
});

test('manager restart marks orphaned runs and sessions as failed', () => {
  const store = new SqliteAgentManagerStore(':memory:');
  try {
    store.createRequirement({
      requirementId: 'req-1',
      sessionId: 'ses-1',
      title: 'Requirement',
      description: 'Description',
      provider: 'codex',
      createdBy: 'human',
      now,
    });
    store.beginRun({ runId: 'run-1', requirementId: 'req-1', role: 'rd', provider: 'codex', taskSummary: 'start', now });
    const result = store.reconcileInterruptedRuns('2026-09-10T12:01:00.000Z');
    assert.deepEqual(result.runIds, ['run-1']);
    assert.equal(store.listRuns('req-1')[0]?.status, 'failed');
    assert.equal(store.getRequirement('req-1')?.session.state, 'failed');
  } finally {
    store.close();
  }
});
