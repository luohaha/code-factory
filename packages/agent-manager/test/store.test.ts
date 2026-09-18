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
      model: 'gpt-5.6',
      reasoningEffort: 'high',
      createdBy: 'human',
      now,
    });
    assert.equal(item.status, 'todo');
    assert.equal(item.model, 'gpt-5.6');
    assert.equal(item.reasoningEffort, 'high');
    assert.equal(item.session.requirementId, item.id);
    assert.equal(item.session.state, 'idle');
    assert.equal(store.listSessions().length, 1);
  } finally {
    store.close();
  }
});

test('hybrid search indexes requirements, conversations, and pull request metadata', () => {
  const store = new SqliteAgentManagerStore(':memory:');
  try {
    store.createRequirement({
      requirementId: 'req-search',
      sessionId: 'ses-search',
      title: 'Secure user access',
      description: 'Build authentication middleware for protected routes',
      provider: 'codex',
      createdBy: 'human',
      now,
    });
    store.appendMessage({
      id: 'msg-search',
      requirementId: 'req-search',
      sessionId: 'ses-search',
      author: 'human',
      body: 'The database deadlock only happens during retry.',
      deliverToRd: true,
      now,
    });
    store.upsertPullRequest({
      id: 'pr-search',
      requirementId: 'req-search',
      repository: 'acme/repo',
      number: 42,
      url: 'https://github.com/acme/repo/pull/42',
      title: 'Prevent duplicate refresh tokens',
      baseBranch: 'main',
      headBranch: 'secure-refresh',
      headSha: 'abc123',
      status: 'open',
      now,
    });

    assert.equal(store.search('protected routes')[0]?.kind, 'requirement');
    assert.equal(store.search('database deadlock')[0]?.sourceId, 'msg-search');
    const pullRequestMatch = store.search('duplicate refresh tokens')[0];
    assert.equal(pullRequestMatch?.sourceId, 'pr-search');
    assert.match(pullRequestMatch?.excerpt ?? '', /duplicate refresh tokens/i);
    assert.ok(store.search('authenticating').some((result) =>
      result.requirementId === 'req-search' && result.fullTextScore === 0 && result.vectorScore >= 0.2));
    assert.ok(store.search('ses-search').some((result) => result.requirementId === 'req-search'));

    store.upsertPullRequest({
      id: 'ignored-on-update',
      requirementId: 'req-search',
      repository: 'acme/repo',
      number: 42,
      url: 'https://github.com/acme/repo/pull/42',
      title: 'Rotate encrypted credential marker',
      baseBranch: 'main',
      headBranch: 'secure-refresh',
      headSha: 'def456',
      status: 'open',
      now: '2026-09-10T12:01:00.000Z',
    });
    assert.equal(store.search('encrypted credential marker')[0]?.sourceId, 'pr-search');
  } finally {
    store.close();
  }
});

test('search backfills existing records and hides cancelled requirements', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-search-backfill-'));
  const databasePath = join(directory, 'factory.sqlite');
  const initial = new SqliteAgentManagerStore(databasePath);
  initial.createRequirement({
    requirementId: 'req-backfill',
    sessionId: 'ses-backfill',
    title: '搜索历史记录',
    description: '保留旧数据库里的需求内容',
    provider: 'codex',
    createdBy: 'human',
    now,
  });
  initial.close();

  const database = new DatabaseSync(databasePath);
  database.prepare('DELETE FROM search_documents WHERE source_id = ?').run('req-backfill');
  database.close();

  const migrated = new SqliteAgentManagerStore(databasePath);
  try {
    assert.equal(migrated.search('旧数据库')[0]?.requirementId, 'req-backfill');
    migrated.transitionRequirement('req-backfill', ['todo'], 'cancelled', now);
    assert.deepEqual(migrated.search('旧数据库'), []);
  } finally {
    migrated.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('cancelling a TODO requirement hides it, archives its session, and preserves its records', () => {
  const store = new SqliteAgentManagerStore(':memory:');
  try {
    store.createRequirement({
      requirementId: 'req-delete',
      sessionId: 'ses-delete',
      title: 'Discard draft',
      description: 'This work is no longer needed',
      provider: 'codex',
      createdBy: 'human',
      now,
    });
    store.createMessageAttachment({
      id: 'att-delete',
      requirementId: 'req-delete',
      fileName: 'notes.txt',
      kind: 'file',
      mediaType: 'text/plain',
      byteSize: 5,
      localPath: '/tmp/att-delete-notes.txt',
      now,
    });
    store.createAgentTimer({
      id: 'tmr-delete',
      requirementId: 'req-delete',
      description: 'Check discarded work',
      schedule: 'recurring',
      intervalSeconds: 3_600,
      nextFireAt: '2026-09-10T13:00:00.000Z',
      now,
    });

    const cancelled = store.transitionRequirement('req-delete', ['todo'], 'cancelled', now);

    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.session.state, 'completed');
    assert.equal(store.listRequirements().length, 0);
    assert.equal(store.getMessageAttachment('att-delete')?.requirementId, 'req-delete');
    assert.equal(store.getAgentTimer('tmr-delete')?.status, 'cancelled');
    assert.equal(store.getAgentTimer('tmr-delete')?.nextFireAt, null);
    assert.throws(
      () => store.transitionRequirement('req-delete', ['todo'], 'cancelled', now),
      StoreConflictError,
    );

    store.createRequirement({
      requirementId: 'req-started',
      sessionId: 'ses-started',
      title: 'Keep started work',
      description: 'Execution already began',
      provider: 'codex',
      createdBy: 'human',
      now,
    });
    store.beginRun({
      runId: 'run-started',
      requirementId: 'req-started',
      role: 'rd',
      provider: 'codex',
      taskSummary: 'start',
      now,
    });

    assert.throws(
      () => store.transitionRequirement('req-started', ['todo'], 'cancelled', now),
      StoreConflictError,
    );
    assert.equal(store.getRequirement('req-started')?.status, 'doing');
  } finally {
    store.close();
  }
});

test('expired cancelled and done requirements purge their related domain records in one transaction', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-retention-'));
  const databasePath = join(directory, 'factory.sqlite');
  const store = new SqliteAgentManagerStore(databasePath);
  try {
    store.createRequirement({
      requirementId: 'req-cancelled-expired',
      sessionId: 'ses-cancelled-expired',
      title: 'Expired cancellation',
      description: 'Delete this requirement and its records',
      provider: 'codex',
      createdBy: 'human',
      now: '2026-08-01T00:00:00.000Z',
    });
    store.createMessageAttachment({
      id: 'att-cancelled-expired',
      requirementId: 'req-cancelled-expired',
      fileName: 'expired.txt',
      kind: 'file',
      mediaType: 'text/plain',
      byteSize: 7,
      localPath: join(directory, 'expired.txt'),
      now: '2026-08-01T00:00:00.000Z',
    });
    store.appendMessage({
      id: 'msg-cancelled-expired',
      requirementId: 'req-cancelled-expired',
      sessionId: 'ses-cancelled-expired',
      author: 'human',
      body: 'No longer needed',
      attachmentIds: ['att-cancelled-expired'],
      deliverToRd: true,
      now: '2026-08-01T00:01:00.000Z',
    });
    const cancelledPullRequest = store.upsertPullRequest({
      id: 'pr-cancelled-expired',
      requirementId: 'req-cancelled-expired',
      repository: 'acme/repo',
      number: 10,
      url: 'https://github.com/acme/repo/pull/10',
      title: 'Cancelled work',
      baseBranch: 'main',
      headBranch: 'cancelled',
      headSha: 'cancelled-sha',
      status: 'closed',
      now: '2026-08-01T00:02:00.000Z',
    });
    store.ensurePullRequestObservation(cancelledPullRequest.id, '2026-08-01T00:02:00.000Z');
    store.appendEvent({
      type: 'test.cancelled',
      requirementId: 'req-cancelled-expired',
      sessionId: 'ses-cancelled-expired',
      now: '2026-08-01T00:03:00.000Z',
    });
    store.createAgentTimer({
      id: 'tmr-cancelled-expired',
      requirementId: 'req-cancelled-expired',
      description: 'Wake expired work',
      schedule: 'once',
      intervalSeconds: 3_600,
      nextFireAt: '2026-08-01T01:03:00.000Z',
      now: '2026-08-01T00:03:00.000Z',
    });
    store.transitionRequirement(
      'req-cancelled-expired',
      ['todo'],
      'cancelled',
      '2026-08-01T00:04:00.000Z',
    );

    store.createRequirement({
      requirementId: 'req-child',
      sessionId: 'ses-child',
      title: 'Surviving follow-up',
      description: 'Keep this requirement without dangling source references',
      provider: 'codex',
      createdBy: 'rd_agent',
      parentRequirementId: 'req-cancelled-expired',
      sourceSessionId: 'ses-cancelled-expired',
      now: '2026-09-09T00:00:00.000Z',
    });

    store.createRequirement({
      requirementId: 'req-done-expired',
      sessionId: 'ses-done-expired',
      title: 'Expired completion',
      description: 'Delete completed work and review data',
      provider: 'claude-code',
      createdBy: 'human',
      now: '2024-01-01T00:00:00.000Z',
    });
    store.beginRun({
      runId: 'run-done-expired',
      requirementId: 'req-done-expired',
      role: 'rd',
      provider: 'claude-code',
      taskSummary: 'Implement old requirement',
      now: '2024-01-01T00:01:00.000Z',
    });
    store.finishRdRun('run-done-expired', {
      status: 'succeeded',
      exitCode: 0,
      nativeSessionId: 'native-done-expired',
      finalMessage: 'done',
      error: null,
    }, '2024-01-01T00:02:00.000Z');
    const donePullRequest = store.upsertPullRequest({
      id: 'pr-done-expired',
      requirementId: 'req-done-expired',
      repository: 'acme/repo',
      number: 11,
      url: 'https://github.com/acme/repo/pull/11',
      title: 'Completed work',
      baseBranch: 'main',
      headBranch: 'done',
      headSha: 'done-sha',
      status: 'open',
      now: '2024-01-01T00:03:00.000Z',
    });
    store.ensurePullRequestObservation(donePullRequest.id, '2024-01-01T00:03:00.000Z');
    store.beginReviewRequest({
      id: 'review-done-expired',
      runId: 'review-run-done-expired',
      pullRequestId: donePullRequest.id,
      requirementId: 'req-done-expired',
      provider: 'codex',
      targetHeadSha: donePullRequest.headSha,
      taskSummary: 'Review old requirement',
      now: '2024-01-01T00:04:00.000Z',
    });
    store.finishReviewRequest('review-done-expired', {
      status: 'succeeded',
      exitCode: 0,
      nativeSessionId: null,
      finalMessage: 'reviewed',
      error: null,
    }, '2024-01-01T00:05:00.000Z');
    store.appendAgentTriggerMessage({
      id: 'msg-done-expired',
      triggerId: 'test-trigger',
      idempotencyKey: 'done-expired-event',
      requirementId: 'req-done-expired',
      sessionId: 'ses-done-expired',
      author: 'system',
      body: 'Old external event',
      deliverToRd: false,
      now: '2024-01-01T00:06:00.000Z',
    });
    store.transitionRequirement(
      'req-done-expired',
      ['waiting_confirmation'],
      'done',
      '2024-01-01T00:07:00.000Z',
    );

    store.createRequirement({
      requirementId: 'req-cancelled-recent',
      sessionId: 'ses-cancelled-recent',
      title: 'Recent cancellation',
      description: 'Retain this requirement',
      provider: 'codex',
      createdBy: 'human',
      now: '2026-09-09T00:00:00.000Z',
    });
    store.transitionRequirement(
      'req-cancelled-recent',
      ['todo'],
      'cancelled',
      '2026-09-09T00:01:00.000Z',
    );
    store.createRequirement({
      requirementId: 'req-done-recent',
      sessionId: 'ses-done-recent',
      title: 'Recent completion',
      description: 'Retain this requirement',
      provider: 'codex',
      createdBy: 'human',
      now: '2026-01-01T00:00:00.000Z',
    });
    store.transitionRequirement(
      'req-done-recent',
      ['todo'],
      'done',
      '2026-01-01T00:01:00.000Z',
    );

    const purged = store.purgeExpiredRequirements({
      cancelledBefore: '2026-09-03T00:00:00.000Z',
      doneBefore: '2025-09-10T00:00:00.000Z',
      now: '2026-09-10T00:00:00.000Z',
    });

    assert.deepEqual(purged.requirements, [
      { id: 'req-done-expired', status: 'done' },
      { id: 'req-cancelled-expired', status: 'cancelled' },
    ]);
    assert.deepEqual(store.listPendingAttachmentDeletions(), [join(directory, 'expired.txt')]);
    assert.equal(store.getRequirement('req-cancelled-expired'), null);
    assert.equal(store.getRequirement('req-done-expired'), null);
    assert.equal(store.getPullRequest('pr-cancelled-expired'), null);
    assert.equal(store.getPullRequest('pr-done-expired'), null);
    assert.equal(store.getMessageAttachment('att-cancelled-expired'), null);
    assert.equal(store.getAgentTimer('tmr-cancelled-expired'), null);
    assert.deepEqual(store.listRuns('req-done-expired'), []);
    assert.deepEqual(store.listReviewRequests(), []);
    assert.equal(store.listEvents(0).some((event) => event.requirementId === 'req-cancelled-expired'), false);
    assert.equal(store.getRequirement('req-cancelled-recent')?.status, 'cancelled');
    assert.equal(store.getRequirement('req-done-recent')?.status, 'done');
    assert.equal(store.getRequirement('req-child')?.parentRequirementId, null);
    assert.equal(store.getRequirement('req-child')?.sourceSessionId, null);
    assert.equal(store.listSessions().some((session) => session.id === 'ses-cancelled-expired'), false);
    assert.equal(store.listSessions().some((session) => session.id === 'ses-done-expired'), false);
  } finally {
    store.close();
  }

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      (database.prepare('SELECT local_path FROM pending_attachment_deletions').all() as Array<{ local_path: string }>)
        .map((row) => row.local_path),
      [join(directory, 'expired.txt')],
    );
    for (const table of [
      'agent_sessions',
      'agent_runs',
      'manager_events',
      'requirement_messages',
      'message_attachments',
      'pull_requests',
      'pull_request_observations',
      'agent_trigger_receipts',
      'agent_timers',
      'review_requests',
    ]) {
      const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}
        WHERE ${table === 'pull_request_observations'
          ? "pull_request_id IN ('pr-cancelled-expired', 'pr-done-expired')"
          : table === 'review_requests'
            ? "id = 'review-done-expired'"
            : table === 'agent_trigger_receipts'
              ? "requirement_id = 'req-done-expired'"
              : table === 'manager_events'
                ? "requirement_id IN ('req-cancelled-expired', 'req-done-expired')"
                : "requirement_id IN ('req-cancelled-expired', 'req-done-expired')"}`).get() as { count: number };
      assert.equal(row.count, 0, `${table} should not retain expired requirement data`);
    }
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an expired requirement with a running reviewer is retained until the run finishes', () => {
  const store = new SqliteAgentManagerStore(':memory:');
  try {
    store.createRequirement({
      requirementId: 'req-review-running',
      sessionId: 'ses-review-running',
      title: 'Completed work under review',
      description: 'Do not delete the reviewer state while its process is active',
      provider: 'codex',
      createdBy: 'human',
      now: '2024-01-01T00:00:00.000Z',
    });
    store.transitionRequirement(
      'req-review-running',
      ['todo'],
      'done',
      '2024-01-01T00:01:00.000Z',
    );
    const pullRequest = store.upsertPullRequest({
      id: 'pr-review-running',
      requirementId: 'req-review-running',
      repository: 'acme/repo',
      number: 12,
      url: 'https://github.com/acme/repo/pull/12',
      title: 'Still reviewing',
      baseBranch: 'main',
      headBranch: 'review-running',
      headSha: 'review-running-sha',
      status: 'open',
      now: '2026-09-10T00:00:00.000Z',
    });
    store.beginReviewRequest({
      id: 'review-running',
      runId: 'review-run-running',
      pullRequestId: pullRequest.id,
      requirementId: 'req-review-running',
      provider: 'codex',
      targetHeadSha: pullRequest.headSha,
      taskSummary: 'Review before retention cleanup',
      now: '2026-09-10T00:01:00.000Z',
    });

    const deferred = store.purgeExpiredRequirements({
      cancelledBefore: '2026-09-10T00:02:00.000Z',
      doneBefore: '2026-09-10T00:02:00.000Z',
      now: '2026-09-10T00:02:00.000Z',
    });

    assert.deepEqual(deferred.requirements, []);
    assert.equal(store.getRequirement('req-review-running')?.status, 'done');
    assert.equal(store.listReviewRequests()[0]?.status, 'running');
    store.finishReviewRequest('review-running', {
      status: 'succeeded',
      exitCode: 0,
      nativeSessionId: null,
      finalMessage: 'reviewed',
      error: null,
    }, '2026-09-10T00:03:00.000Z');

    const purged = store.purgeExpiredRequirements({
      cancelledBefore: '2026-09-10T00:04:00.000Z',
      doneBefore: '2026-09-10T00:04:00.000Z',
      now: '2026-09-10T00:04:00.000Z',
    });

    assert.deepEqual(purged.requirements, [{ id: 'req-review-running', status: 'done' }]);
    assert.equal(store.getRequirement('req-review-running'), null);
    assert.deepEqual(store.listReviewRequests(), []);
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
    store.createAgentTimer({
      id: 'tmr-complete',
      requirementId: 'req-1',
      description: 'Check completed work',
      schedule: 'recurring',
      intervalSeconds: 3_600,
      nextFireAt: '2026-09-10T13:01:00.000Z',
      now: '2026-09-10T12:01:00.000Z',
    });

    const done = store.transitionRequirement('req-1', ['waiting_confirmation'], 'done', '2026-09-10T12:02:00.000Z');
    assert.equal(done.status, 'done');
    assert.equal(done.session.state, 'completed');
    assert.equal(store.getAgentTimer('tmr-complete')?.status, 'cancelled');
    assert.equal(store.getAgentTimer('tmr-complete')?.nextFireAt, null);
  } finally {
    store.close();
  }
});

test('an interrupted RD run returns to a non-error waiting state', () => {
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
    const interrupted = store.finishRdRun('run-1', {
      status: 'cancelled',
      exitCode: null,
      nativeSessionId: 'native-1',
      finalMessage: null,
      error: 'Agent Run interrupted by human',
    }, '2026-09-10T12:01:00.000Z');

    assert.equal(interrupted.status, 'doing');
    assert.equal(interrupted.session.state, 'waiting_human');
    assert.equal(interrupted.session.lastError, null);
    assert.equal(store.listRuns('req-1')[0]?.status, 'cancelled');
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
      model: 'gpt-5.5',
      reasoningEffort: 'max',
      targetHeadSha: pullRequest.headSha,
      taskSummary: 'review main',
      now,
    });
    assert.equal(started.run.sessionId, null);
    assert.equal(started.run.model, 'gpt-5.5');
    assert.equal(started.run.reasoningEffort, 'max');
    assert.equal(started.reviewRequest.model, 'gpt-5.5');
    assert.equal(started.reviewRequest.reasoningEffort, 'max');
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
      sourceRequirementId: 'req-1',
      author: 'rd_agent',
      body: 'The regression test is now passing.',
      deliverToRd: false,
      now: '2026-09-10T12:00:01.000Z',
    });
    const messages = store.listMessages('req-1');
    assert.deepEqual(messages.map((message) => message.sequence), [1, 2]);
    assert.equal(messages[1]?.sourceRequirementId, 'req-1');
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

test('legacy databases add nullable model and reasoning configuration columns', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-store-test-'));
  const databasePath = join(directory, 'factory.sqlite');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE requirements (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL,
      provider TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
    ) STRICT;
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL, session_id TEXT, role TEXT NOT NULL,
      provider TEXT NOT NULL, status TEXT NOT NULL, task_summary TEXT NOT NULL, native_session_id TEXT,
      exit_code INTEGER, error TEXT, started_at TEXT NOT NULL, finished_at TEXT
    ) STRICT;
    CREATE TABLE review_requests (
      id TEXT PRIMARY KEY, pull_request_id TEXT NOT NULL, run_id TEXT NOT NULL, provider TEXT NOT NULL,
      target_head_sha TEXT NOT NULL, status TEXT NOT NULL, requested_by TEXT NOT NULL, error TEXT,
      created_at TEXT NOT NULL, finished_at TEXT
    ) STRICT;
  `);
  legacy.close();

  const store = new SqliteAgentManagerStore(databasePath);
  store.close();
  const migrated = new DatabaseSync(databasePath);
  try {
    for (const table of ['requirements', 'agent_runs', 'review_requests']) {
      const columns = migrated.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      assert.ok(columns.some((column) => column.name === 'model'), `${table} should contain model`);
      assert.ok(columns.some((column) => column.name === 'reasoning_effort'), `${table} should contain reasoning_effort`);
    }
    const parentIndexColumns = migrated.prepare('PRAGMA index_info(requirements_parent_updated)').all() as Array<{
      name: string;
    }>;
    assert.deepEqual(
      parentIndexColumns.map((column) => column.name),
      ['parent_requirement_id', 'updated_at'],
    );
  } finally {
    migrated.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy requirement messages add related Requirement provenance', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-message-source-test-'));
  const databasePath = join(directory, 'factory.sqlite');
  const initial = new SqliteAgentManagerStore(databasePath);
  initial.close();
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    DROP TABLE requirement_messages;
    CREATE TABLE requirement_messages (
      id TEXT PRIMARY KEY,
      requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
      author TEXT NOT NULL CHECK (author IN ('human', 'rd_agent', 'reviewer', 'system')),
      body TEXT NOT NULL,
      sequence INTEGER NOT NULL DEFAULT 0,
      deliver_to_rd INTEGER NOT NULL DEFAULT 0 CHECK (deliver_to_rd IN (0, 1)),
      created_at TEXT NOT NULL
    ) STRICT;
  `);
  legacy.close();

  const migratedStore = new SqliteAgentManagerStore(databasePath);
  migratedStore.close();
  const migrated = new DatabaseSync(databasePath);
  try {
    const columns = migrated.prepare('PRAGMA table_info(requirement_messages)').all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === 'source_requirement_id'));
  } finally {
    migrated.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Agent Trigger messages are source-neutral and idempotent within each trigger', () => {
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
    const input = {
      triggerId: 'slack.thread',
      idempotencyKey: 'thread-1:message-1',
      requirementId: 'req-1',
      sessionId: 'ses-1',
      author: 'human' as const,
      body: 'Please add a retry test.',
      deliverToRd: true,
      now,
    };
    assert.ok(store.appendAgentTriggerMessage({ id: 'msg-1', ...input }));
    assert.equal(store.appendAgentTriggerMessage({ id: 'msg-2', ...input }), null);
    assert.ok(store.appendAgentTriggerMessage({ id: 'msg-3', ...input, triggerId: 'another.trigger' }));
    assert.equal(store.listMessages('req-1').length, 2);
  } finally {
    store.close();
  }
});

test('legacy GitHub event receipts migrate to split triggers without replaying delivered messages', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-trigger-receipts-'));
  const databasePath = join(directory, 'factory.sqlite');
  const initial = new SqliteAgentManagerStore(databasePath);
  initial.createRequirement({
    requirementId: 'req-1',
    sessionId: 'ses-1',
    title: 'Requirement',
    description: 'Description',
    provider: 'codex',
    createdBy: 'human',
    now,
  });
  initial.upsertPullRequest({
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
  initial.close();

  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`CREATE TABLE external_event_receipts (
    source_key TEXT PRIMARY KEY,
    pull_request_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  ) STRICT`);
  legacy.prepare(`INSERT INTO external_event_receipts
    (source_key, pull_request_id, created_at) VALUES (?, ?, ?)`)
    .run('github:pr-1:comment:1', 'pr-1', now);
  legacy.close();

  const migrated = new SqliteAgentManagerStore(databasePath);
  try {
    assert.equal(migrated.appendAgentTriggerMessage({
      id: 'msg-1',
      triggerId: 'github.pull-request.comment',
      idempotencyKey: 'github:pr-1:comment:1',
      requirementId: 'req-1',
      sessionId: 'ses-1',
      author: 'reviewer',
      body: 'Already delivered',
      deliverToRd: true,
      now,
    }), null);
  } finally {
    migrated.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Agent Timers persist descriptions, advance, complete, and cancel atomically', () => {
  const store = new SqliteAgentManagerStore(':memory:');
  try {
    store.createRequirement({
      requirementId: 'req-scheduled',
      sessionId: 'ses-scheduled',
      title: 'Wait for a build',
      description: 'Wake the Agent later',
      provider: 'codex',
      createdBy: 'human',
      now,
    });
    const recurring = store.createAgentTimer({
      id: 'tmr-recurring',
      requirementId: 'req-scheduled',
      description: 'Check compiler status',
      schedule: 'recurring',
      intervalSeconds: 3_600,
      nextFireAt: '2026-09-10T13:00:00.000Z',
      now,
    });
    assert.equal(recurring.status, 'active');
    assert.equal(recurring.description, 'Check compiler status');
    assert.equal(recurring.lastFiredAt, null);

    const advanced = store.completeAgentTimerOccurrence({
      id: recurring.id,
      expectedNextFireAt: recurring.nextFireAt!,
      nextFireAt: '2026-09-10T14:00:00.000Z',
      now: '2026-09-10T13:00:01.000Z',
    });
    assert.equal(advanced?.status, 'active');
    assert.equal(advanced?.lastFiredAt, '2026-09-10T13:00:01.000Z');
    assert.equal(store.completeAgentTimerOccurrence({
      id: recurring.id,
      expectedNextFireAt: recurring.nextFireAt!,
      now: '2026-09-10T13:00:02.000Z',
    }), null);

    const once = store.createAgentTimer({
      id: 'tmr-once',
      requirementId: 'req-scheduled',
      description: 'Check generated artifacts',
      schedule: 'once',
      intervalSeconds: 60,
      nextFireAt: '2026-09-10T12:01:00.000Z',
      now,
    });
    const completed = store.completeAgentTimerOccurrence({
      id: once.id,
      expectedNextFireAt: once.nextFireAt!,
      now: '2026-09-10T12:01:00.000Z',
    });
    assert.equal(completed?.status, 'completed');
    assert.equal(completed?.nextFireAt, null);

    const cancelled = store.cancelAgentTimer(recurring.id, '2026-09-10T13:10:00.000Z');
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.nextFireAt, null);
    assert.throws(
      () => store.cancelAgentTimer(recurring.id, '2026-09-10T13:11:00.000Z'),
      StoreConflictError,
    );
    assert.deepEqual(
      store.listAgentTimers('req-scheduled').map((timer) => timer.id).sort(),
      ['tmr-once', 'tmr-recurring'],
    );
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
