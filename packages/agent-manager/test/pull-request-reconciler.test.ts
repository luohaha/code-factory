import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentTriggerContext } from '../src/agent-trigger.ts';
import type { GitHubClient, GitHubPullRequestSnapshot } from '../src/github-client.ts';
import { createLogger, type LogWriter } from '../src/logger.ts';
import { PullRequestReconciler } from '../src/pull-request-reconciler.ts';
import type { PullRequestSnapshotTrigger, PullRequestTriggerRegistration } from '../src/pull-request-triggers.ts';
import { SqliteAgentManagerStore } from '../src/sqlite-store.ts';
import type { PullRequest, TrackPullRequestInput } from '../src/types.ts';

class MemoryWriter implements LogWriter {
  readonly lines: string[] = [];

  write(value: string): void {
    this.lines.push(value);
  }
}

const context: AgentTriggerContext = { deliver: () => null };

function createStore(): SqliteAgentManagerStore {
  const store = new SqliteAgentManagerStore(':memory:');
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

function trackPullRequest(store: SqliteAgentManagerStore, number: number): PullRequest {
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
    status: 'open',
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
