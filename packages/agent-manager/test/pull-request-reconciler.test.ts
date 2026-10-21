import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { AgentTriggerContext } from '../src/triggers/agent-trigger.ts';
import type { GitHubClient, GitHubPullRequestSnapshot } from '../src/github/github-client.ts';
import { createLogger, type LogWriter } from '../src/infrastructure/logger.ts';
import { PullRequestReconciler } from '../src/github/pull-request-reconciler.ts';
import {
  PullRequestStatusTrigger, PullRequestCommentTrigger, PullRequestCiFailureTrigger, PullRequestConflictTrigger,
  PULL_REQUEST_STATUS_TRIGGER_ID, PULL_REQUEST_COMMENT_TRIGGER_ID,
  PULL_REQUEST_CI_FAILURE_TRIGGER_ID, PULL_REQUEST_CONFLICT_TRIGGER_ID,
  type PullRequestSnapshotTrigger, type PullRequestTriggerRegistration,
} from '../src/github/pull-request-triggers.ts';
import { SqliteAgentManagerStore } from '../src/storage/sqlite-store.ts';
import type { PullRequest, TrackPullRequestInput } from '../src/core/types.ts';

class MemoryWriter implements LogWriter {
  readonly lines: string[] = [];

  write(value: string): void {
    this.lines.push(value);
  }
}

const context: AgentTriggerContext = { deliver: () => null };

function createStore(databasePath = ':memory:'): SqliteAgentManagerStore {
  const store = new SqliteAgentManagerStore(databasePath);
  store.createRequirement({
    requirementId: 'req-reconciliation',
    sessionId: 'ses-reconciliation',
    title: 'Reconcile pull requests',
    description: 'Exercise failure recovery',
    provider: 'codex',
    createdBy: 'human',
    now: '2026-09-21T00:00:00.000Z',
  });
  return store;
}

function trackPullRequest(store: SqliteAgentManagerStore, number: number, status: PullRequest['status'] = 'open'): PullRequest {
  return store.upsertPullRequest({
    id: `pr-${number}`,
    requirementId: 'req-reconciliation',
    repository: 'acme/widgets',
    number,
    url: `https://github.com/acme/widgets/pull/${number}`,
    title: `PR ${number}`,
    baseBranch: 'main',
    headBranch: `feature-${number}`,
    headSha: `head-${number}`,
    status,
    // The store returns most recently updated PRs first. Keep #1 first so the
    // isolation tests prove that reconciliation continues after its failure.
    now: number === 1 ? '2026-09-21T00:00:02.000Z' : '2026-09-21T00:00:01.000Z',
  });
}

function snapshot(pullRequest: PullRequest, status: GitHubPullRequestSnapshot['status']): GitHubPullRequestSnapshot {
  return {
    status,
    title: pullRequest.title,
    url: pullRequest.url,
    baseBranch: pullRequest.baseBranch,
    headBranch: pullRequest.headBranch,
    headSha: pullRequest.headSha,
    mergeable: 'MERGEABLE',
    updatedAt: '2026-09-21T01:00:00.000Z',
    reviewActivity: [{
      kind: 'comment',
      id: 'private-review',
      author: 'reviewer',
      body: 'PRIVATE REVIEW BODY MUST NOT BE LOGGED',
      url: `${pullRequest.url}#issuecomment-1`,
      createdAt: '2026-09-21T00:30:00.000Z',
      state: null,
      path: null,
      line: null,
    }],
    checks: [],
  };
}

function createReconciler(
  store: SqliteAgentManagerStore,
  githubClient: GitHubClient,
  stderr: MemoryWriter,
): PullRequestReconciler {
  return new PullRequestReconciler({
    store,
    githubClient,
    logger: createLogger({ level: 'error', stdout: new MemoryWriter(), stderr }),
    synchronizePullRequest: (input: TrackPullRequestInput) => {
      const current = store.listPullRequests().find((item) => (
        item.repository === input.repository && item.number === input.number
      ));
      assert.ok(current);
      store.upsertPullRequest({ ...input, id: current.id, now: '2026-09-21T01:00:00.000Z' });
    },
    isClosed: () => false,
  });
}

function registration(trigger: PullRequestSnapshotTrigger): PullRequestTriggerRegistration[] {
  return [{ trigger, context }];
}

const noOpTrigger: PullRequestSnapshotTrigger = {
  id: 'test.pull-request',
  source: 'test',
  start: () => undefined,
  stop: () => undefined,
  reconcileSnapshot: () => undefined,
};

test('draft PRs only deliver lifecycle changes and resume activity with a fresh durable baseline when open', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-21T01:00:00.000Z') });
  const store = createStore();
  try {
    const pullRequest = trackPullRequest(store, 1, 'draft');
    store.ensurePullRequestObservation(pullRequest.id, '2026-09-21T00:00:00.000Z');
    let current: GitHubPullRequestSnapshot = {
      ...snapshot(pullRequest, 'draft'),
      mergeable: 'CONFLICTING',
      reviewActivity: (['comment', 'review', 'review_comment'] as const).map((kind) => ({
        ...snapshot(pullRequest, 'draft').reviewActivity[0]!,
        kind,
        id: `draft-${kind}`,
        createdAt: '2026-09-21T00:59:00.000Z',
      })),
      checks: [{
        key: 'test', name: 'test', workflow: 'CI', status: 'COMPLETED', conclusion: 'FAILURE',
        completedAt: '2026-09-21T00:59:00.000Z', url: null,
      }],
    };
    const githubClient: GitHubClient = { inspectPullRequest: async () => current };
    let reconciler = createReconciler(store, githubClient, new MemoryWriter());
    const delivered: string[] = [];
    const receipts = new Set<string>();
    const registrations = () => [
      new PullRequestStatusTrigger(reconciler), new PullRequestCommentTrigger(reconciler),
      new PullRequestCiFailureTrigger(reconciler), new PullRequestConflictTrigger(reconciler),
    ].map((trigger) => ({
      trigger,
      context: { deliver: (message) => {
        const key = `${trigger.id}:${message.idempotencyKey}`;
        if (!receipts.has(key)) delivered.push(trigger.id);
        receipts.add(key);
        return null;
      } } satisfies AgentTriggerContext,
    }));

    await reconciler.reconcile(registrations());
    assert.deepEqual(delivered, [], 'draft comments, reviews, failures and conflicts do not deliver');
    assert.deepEqual(store.ensurePullRequestObservation(pullRequest.id, '').observation.checkStates, {});

    t.mock.timers.tick(60_000);
    current = { ...current, status: 'open', updatedAt: new Date().toISOString() };
    await reconciler.reconcile(registrations());
    assert.equal(store.getPullRequest(pullRequest.id)?.status, 'open');
    assert.deepEqual(delivered, [PULL_REQUEST_STATUS_TRIGGER_ID, PULL_REQUEST_CONFLICT_TRIGGER_ID]);
    const baseline = store.ensurePullRequestObservation(pullRequest.id, '').observation;
    assert.equal(baseline.initializedAt, new Date().toISOString());
    assert.ok(baseline.checkStates.test, 'existing draft CI failures become the new baseline');

    // A fresh reconciler still uses the persisted baseline, including old draft activity.
    reconciler = createReconciler(store, githubClient, new MemoryWriter());
    await reconciler.reconcile(registrations());
    assert.equal(delivered.length, 2);

    t.mock.timers.tick(60_000);
    current = {
      ...current,
      reviewActivity: [...current.reviewActivity, {
        ...current.reviewActivity[0]!, id: 'open-comment', createdAt: '2026-09-21T01:01:30.000Z',
      }],
      checks: [{ ...current.checks[0]!, completedAt: '2026-09-21T01:01:40.000Z' }],
    };
    await reconciler.reconcile(registrations());
    assert.deepEqual(delivered.slice(2), [PULL_REQUEST_COMMENT_TRIGGER_ID, PULL_REQUEST_CI_FAILURE_TRIGGER_ID]);

    t.mock.timers.tick(60_000);
    current = {
      ...current, status: 'draft', headSha: 'another-conflicting-head', updatedAt: new Date().toISOString(),
      reviewActivity: [...current.reviewActivity, {
        ...current.reviewActivity[0]!, id: 'second-draft-comment', createdAt: new Date().toISOString(),
      }],
      checks: [{ ...current.checks[0]!, completedAt: new Date().toISOString() }],
    };
    await reconciler.reconcile(registrations());
    assert.deepEqual(delivered.slice(4), [PULL_REQUEST_STATUS_TRIGGER_ID], 'open to draft disables all activity');
    await reconciler.reconcile(registrations());
    assert.equal(delivered.length, 5);

    t.mock.timers.tick(60_000);
    current = { ...current, status: 'open', updatedAt: new Date().toISOString() };
    await reconciler.reconcile(registrations());
    assert.deepEqual(delivered.slice(5), [PULL_REQUEST_STATUS_TRIGGER_ID, PULL_REQUEST_CONFLICT_TRIGGER_ID]);
    assert.equal(store.ensurePullRequestObservation(pullRequest.id, '').observation.initializedAt, new Date().toISOString());
  } finally {
    store.close();
  }
});

for (const status of ['closed', 'merged'] as const) {
  test(`draft to ${status} delivers only lifecycle and stops polling`, async () => {
    const store = createStore();
    try {
      const pullRequest = trackPullRequest(store, 1, 'draft');
      let inspections = 0;
      const reconciler = createReconciler(store, {
        inspectPullRequest: async () => { inspections += 1; return snapshot(pullRequest, status); },
      }, new MemoryWriter());
      const delivered: string[] = [];
      const statusTrigger = new PullRequestStatusTrigger(reconciler);
      const registrations: PullRequestTriggerRegistration[] = [
        { trigger: statusTrigger, context: { deliver: (message) => { delivered.push(message.body); return null; } } },
        { trigger: { ...noOpTrigger, reconcileSnapshot: () => assert.fail('terminal activity must be ignored') }, context },
      ];
      await reconciler.reconcile(registrations);
      assert.equal(store.getPullRequest(pullRequest.id)?.status, status);
      assert.equal(delivered.length, 1);
      assert.match(delivered[0]!, new RegExp(`draft -> ${status}`));
      await reconciler.reconcile(registrations);
      assert.equal(inspections, 1);
    } finally {
      store.close();
    }
  });
}

for (const failureStage of ['synchronization', 'trigger'] as const) {
  test(`opening baseline survives a ${failureStage} failure and a fresh reconciler without discarding new open activity`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-21T01:00:00.000Z') });
    const directory = mkdtempSync(join(tmpdir(), 'code-factory-opening-retry-'));
    const databasePath = join(directory, 'factory.sqlite');
    let store = createStore(databasePath);
    try {
      const pullRequest = trackPullRequest(store, 1, 'draft');
      store.ensurePullRequestObservation(pullRequest.id, '2026-09-21T00:00:00.000Z');
      let current = snapshot(pullRequest, 'open');
      const githubClient: GitHubClient = { inspectPullRequest: async () => current };
      const delivered: string[] = [];
      const receipts = new Set<string>();
      const registrations = (reconciler: PullRequestReconciler): PullRequestTriggerRegistration[] => [
        new PullRequestStatusTrigger(reconciler), new PullRequestCommentTrigger(reconciler),
        new PullRequestCiFailureTrigger(reconciler),
      ].map((trigger) => ({
        trigger,
        context: { deliver: (message) => {
          const key = `${trigger.id}:${message.idempotencyKey}`;
          if (!receipts.has(key)) delivered.push(trigger.id);
          receipts.add(key);
          return null;
        } } satisfies AgentTriggerContext,
      }));
      if (failureStage === 'synchronization') {
        t.mock.method(store, 'upsertPullRequest', () => { throw new Error('PR write failed'); }, { times: 1 });
      }
      let reconciler = createReconciler(store, githubClient, new MemoryWriter());
      const initialRegistrations = registrations(reconciler);
      if (failureStage === 'trigger') {
        initialRegistrations.push({
          trigger: { ...noOpTrigger, reconcileSnapshot: () => { throw new Error('Trigger failed'); } }, context,
        });
      }
      await assert.rejects(reconciler.reconcile(initialRegistrations), AggregateError);
      assert.equal(store.getPullRequest(pullRequest.id)?.status, 'draft');
      const firstBaseline = store.ensurePullRequestObservation(pullRequest.id, '').observation.initializedAt;
      assert.equal(store.ensurePullRequestObservation(pullRequest.id, '').observation.observedStatus, 'open');

      t.mock.timers.tick(30_000);
      current = {
        ...current,
        reviewActivity: [...current.reviewActivity, {
          ...current.reviewActivity[0]!, id: 'open-comment', createdAt: '2026-09-21T01:00:15.000Z',
        }],
        checks: [{ key: 'new-check', name: 'new-check', workflow: 'CI', status: 'COMPLETED',
          conclusion: 'FAILURE', completedAt: '2026-09-21T01:00:15.000Z', url: null }],
      };
      store.close();
      store = new SqliteAgentManagerStore(databasePath);
      reconciler = createReconciler(store, githubClient, new MemoryWriter());
      await reconciler.reconcile(registrations(reconciler));
      assert.equal(store.getPullRequest(pullRequest.id)?.status, 'open');
      assert.equal(store.ensurePullRequestObservation(pullRequest.id, '').observation.initializedAt, firstBaseline);
      assert.deepEqual(delivered, [PULL_REQUEST_STATUS_TRIGGER_ID, PULL_REQUEST_COMMENT_TRIGGER_ID, PULL_REQUEST_CI_FAILURE_TRIGGER_ID]);
      await reconciler.reconcile(registrations(reconciler));
      assert.equal(delivered.length, 3);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('PR reconciliation isolates transient inspection failures and retries terminal synchronization', async () => {
  const store = createStore();
  const stderr = new MemoryWriter();
  const attempts = new Map<number, number>();
  const inspectionOrder: number[] = [];
  const githubClient: GitHubClient = {
    inspectPullRequest: async (pullRequest) => {
      inspectionOrder.push(pullRequest.number);
      const attempt = (attempts.get(pullRequest.number) ?? 0) + 1;
      attempts.set(pullRequest.number, attempt);
      if (pullRequest.number === 1 && attempt === 1) {
        throw new AggregateError([
          new Error('gh pr view failed: API unavailable'),
          new AggregateError([
            new SyntaxError('gh api returned invalid JSON'),
          ], 'inline review query failed'),
        ], 'GitHub inspection failed');
      }
      return snapshot(pullRequest, 'merged');
    },
  };

  try {
    trackPullRequest(store, 1);
    trackPullRequest(store, 2);
    const reconciler = createReconciler(store, githubClient, stderr);

    await assert.rejects(reconciler.reconcile(registration(noOpTrigger)), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 1);
      assert.match(String(error.errors[0]), /inspection failed for acme\/widgets#1 \(pr-1\)/);
      assert.ok((error.errors[0] as Error).cause instanceof AggregateError);
      return true;
    });

    assert.equal(store.getPullRequest('pr-1')?.status, 'open');
    assert.equal(store.getPullRequest('pr-2')?.status, 'merged', 'another eligible PR still synchronizes');
    assert.deepEqual(Object.fromEntries(attempts), { 1: 1, 2: 1 });
    assert.deepEqual(inspectionOrder, [1, 2], 'the successful PR is inspected after the failed PR');

    const entry = JSON.parse(stderr.lines[0]!) as {
      reconciliationStage: string;
      pullRequestId: string;
      repository: string;
      number: number;
      error: { name: string; errors: Array<{ message: string; errors?: Array<{ message: string }> }> };
    };
    assert.equal(entry.reconciliationStage, 'inspection');
    assert.equal(entry.pullRequestId, 'pr-1');
    assert.equal(entry.repository, 'acme/widgets');
    assert.equal(entry.number, 1);
    assert.equal(entry.error.name, 'AggregateError');
    assert.equal(entry.error.errors[0]?.message, 'gh pr view failed: API unavailable');
    assert.equal(entry.error.errors[1]?.errors?.[0]?.message, 'gh api returned invalid JSON');
    assert.doesNotMatch(stderr.lines[0]!, /PRIVATE REVIEW BODY/);

    await reconciler.reconcile(registration(noOpTrigger));
    assert.equal(store.getPullRequest('pr-1')?.status, 'merged');
    assert.deepEqual(Object.fromEntries(attempts), { 1: 2, 2: 1 });

    await reconciler.reconcile(registration(noOpTrigger));
    assert.deepEqual(Object.fromEntries(attempts), { 1: 2, 2: 1 }, 'terminal PRs are no longer inspected');
  } finally {
    store.close();
  }
});

test('snapshot reconciliation failures include PR context and do not stop later PRs', async () => {
  const store = createStore();
  const stderr = new MemoryWriter();
  const reconciledNumbers: number[] = [];
  const githubClient: GitHubClient = {
    inspectPullRequest: async (pullRequest) => snapshot(pullRequest, 'open'),
  };
  const trigger: PullRequestSnapshotTrigger = {
    id: 'test.failing-snapshot',
    source: 'test',
    start: () => undefined,
    stop: () => undefined,
    reconcileSnapshot: (_context, pullRequest) => {
      reconciledNumbers.push(pullRequest.number);
      if (pullRequest.number === 1) {
        throw new AggregateError([new Error('receipt write failed')], 'trigger fanout failed');
      }
    },
  };

  try {
    trackPullRequest(store, 1);
    trackPullRequest(store, 2);
    const reconciler = createReconciler(store, githubClient, stderr);

    await assert.rejects(reconciler.reconcile(registration(trigger)), AggregateError);

    assert.deepEqual(reconciledNumbers, [1, 2], 'the later PR reconciles after the earlier snapshot failure');
    const entry = JSON.parse(stderr.lines[0]!) as Record<string, unknown>;
    assert.equal(entry.reconciliationStage, 'snapshot');
    assert.equal(entry.pullRequestId, 'pr-1');
    assert.equal(entry.repository, 'acme/widgets');
    assert.equal(entry.number, 1);
    assert.doesNotMatch(stderr.lines[0]!, /PRIVATE REVIEW BODY/);
  } finally {
    store.close();
  }
});

test('scheduled reconciliation clears a rejected run and retries on the next interval', async () => {
  const store = createStore();
  const stderr = new MemoryWriter();
  let attempts = 0;
  const githubClient: GitHubClient = {
    inspectPullRequest: async (pullRequest) => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary GitHub outage');
      return snapshot(pullRequest, 'merged');
    },
  };
  const reconciler = createReconciler(store, githubClient, stderr);

  try {
    trackPullRequest(store, 1);
    reconciler.register(noOpTrigger, context);
    reconciler.setInterval(1_000);
    const startedAt = Date.now();
    reconciler.start();

    await waitFor(() => store.getPullRequest('pr-1')?.status === 'merged', 4_000);

    assert.equal(attempts, 2);
    assert.ok(Date.now() - startedAt >= 900, 'the retry should wait for the configured interval');
    const errors = stderr.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(errors.length, 1, 'the expected failure is logged once with its PR context');
    assert.equal(errors[0]?.reconciliationStage, 'inspection');
  } finally {
    reconciler.stop();
    store.close();
  }
});

test('overlapping scheduled ticks do not repeat an in-flight reconciliation failure', async () => {
  const store = createStore();
  const stderr = new MemoryWriter();
  let attempts = 0;
  let failFirst: ((error: Error) => void) | undefined;
  const githubClient: GitHubClient = {
    inspectPullRequest: (pullRequest) => {
      attempts += 1;
      if (attempts === 1) {
        return new Promise((_, reject) => { failFirst = reject; });
      }
      return Promise.resolve(snapshot(pullRequest, 'merged'));
    },
  };
  const reconciler = createReconciler(store, githubClient, stderr);

  try {
    trackPullRequest(store, 1);
    reconciler.register(noOpTrigger, context);
    reconciler.setInterval(1_000);
    reconciler.start();
    await waitFor(() => failFirst !== undefined, 1_000);

    await new Promise<void>((resolve) => setTimeout(resolve, 2_200));
    assert.equal(attempts, 1, 'ticks share the unfinished inspection');
    failFirst?.(new Error('temporary GitHub outage'));
    await waitFor(() => store.getPullRequest('pr-1')?.status === 'merged', 4_000);

    const errors = stderr.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.reconciliationStage, 'inspection');
    assert.equal(errors[0]?.number, 1);
  } finally {
    reconciler.stop();
    store.close();
  }
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Condition was not met within ${timeoutMs}ms`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
