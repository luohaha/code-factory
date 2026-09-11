import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentManager } from '../src/agent-manager.ts';
import type { GitHubClient, GitHubPullRequestSnapshot } from '../src/github-client.ts';
import { silentLogger } from '../src/logger.ts';
import type { AgentProcessRunner, ProcessRunRequest } from '../src/process-runner.ts';
import { SqliteAgentManagerStore } from '../src/sqlite-store.ts';
import type { RunOutcome } from '../src/types.ts';

class DeferredRunner implements AgentProcessRunner {
  requests: ProcessRunRequest[] = [];
  resolvers: Array<(outcome: RunOutcome) => void> = [];

  run(request: ProcessRunRequest): Promise<RunOutcome> {
    this.requests.push(request);
    return new Promise((resolve) => this.resolvers.push(resolve));
  }
}

class SequenceGitHubClient implements GitHubClient {
  readonly #snapshots: GitHubPullRequestSnapshot[];
  #index = 0;

  constructor(snapshots: GitHubPullRequestSnapshot[]) {
    this.#snapshots = snapshots;
  }

  inspectPullRequest(): Promise<GitHubPullRequestSnapshot> {
    const snapshot = this.#snapshots[Math.min(this.#index, this.#snapshots.length - 1)];
    this.#index += 1;
    if (!snapshot) throw new Error('No GitHub snapshot configured');
    return Promise.resolve(snapshot);
  }
}

test('Agent Manager queues conversation messages during a Run and resumes without replaying RD output', async () => {
  const store = new SqliteAgentManagerStore(':memory:');
  const runner = new DeferredRunner();
  const manager = new AgentManager({ workspaceRoot: process.cwd(), store, runner, logger: silentLogger });
  try {
    const first = manager.createRequirement({ title: 'First', description: 'First task', provider: 'codex' });
    const second = manager.createRequirement({ title: 'Second', description: 'Second task', provider: 'claude-code' });

    const firstExecution = manager.runRequirement(first.id);
    assert.equal(runner.requests[0]?.workspaceRoot, manager.workspaceRoot);
    assert.ok(runner.requests[0]?.invocation.args.some((value) =>
      value.includes('Agent Manager owns draft/open/closed/merged lifecycle synchronization')));
    const secondExecution = manager.runRequirement(second.id);
    assert.equal(runner.requests[1]?.workspaceRoot, manager.workspaceRoot);
    const queued = manager.postHumanMessage(first.id, 'add another test');
    assert.equal(queued.queued, true);
    assert.equal(runner.requests.length, 2);

    runner.requests[0]?.onNativeSession?.('native-thread-1');
    runner.requests[0]?.onEvent?.({ kind: 'message', message: 'Implementation is ready.', raw: {} });
    runner.resolvers[0]?.({
      status: 'succeeded',
      exitCode: 0,
      nativeSessionId: 'native-thread-1',
      finalMessage: 'ready',
      error: null,
    });
    const awaiting = await firstExecution;
    assert.equal(awaiting.session.nativeSessionId, 'native-thread-1');
    assert.equal(awaiting.status, 'waiting_confirmation');
    assert.deepEqual(manager.listMessages(first.id).map((message) => message.body), ['add another test', 'Implementation is ready.']);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(runner.requests[2]?.invocation.args.includes('resume'));
    assert.ok(runner.requests[2]?.invocation.args.includes('native-thread-1'));
    assert.match(runner.requests[2]?.invocation.input ?? '', /add another test/);
    assert.doesNotMatch(runner.requests[2]?.invocation.input ?? '', /Implementation is ready/);
    runner.resolvers[2]?.({
      status: 'succeeded',
      exitCode: 0,
      nativeSessionId: 'native-thread-1',
      finalMessage: 'updated',
      error: null,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    runner.resolvers[1]?.({
      status: 'succeeded',
      exitCode: 0,
      nativeSessionId: 'native-session-2',
      finalMessage: 'ready',
      error: null,
    });
    await secondExecution;
  } finally {
    manager.close();
  }
});

test('RD Agent registration cannot advance an existing PR lifecycle state', () => {
  const manager = new AgentManager({
    workspaceRoot: process.cwd(),
    store: new SqliteAgentManagerStore(':memory:'),
    logger: silentLogger,
  });
  try {
    const requirement = manager.createRequirement({ title: 'PR ownership', description: 'Open a PR', provider: 'codex' });
    const initial = manager.registerAgentPullRequest({
      requirementId: requirement.id,
      repository: 'acme/repo',
      number: 8,
      url: 'https://github.com/acme/repo/pull/8',
      title: 'Feature',
      baseBranch: 'main',
      headBranch: 'feature',
      headSha: 'abc123',
      status: 'open',
    });
    const attempted = manager.registerAgentPullRequest({
      ...initial,
      title: 'Feature updated by RD',
      headSha: 'def456',
      status: 'merged',
    });
    assert.equal(attempted.title, 'Feature updated by RD');
    assert.equal(attempted.headSha, 'def456');
    assert.equal(attempted.status, 'open');

    const reconciled = manager.trackPullRequest({ ...attempted, status: 'merged' });
    assert.equal(reconciled.status, 'merged');
  } finally {
    manager.close();
  }
});

test('a human-requested PR review writes to the requirement conversation and wakes the RD session', async () => {
  const store = new SqliteAgentManagerStore(':memory:');
  const runner = new DeferredRunner();
  const manager = new AgentManager({ workspaceRoot: process.cwd(), store, runner, logger: silentLogger });
  try {
    const requirement = manager.createRequirement({ title: 'Review me', description: 'Open a PR', provider: 'codex' });
    const pullRequest = manager.trackPullRequest({
      requirementId: requirement.id,
      repository: 'acme/repo',
      number: 7,
      url: 'https://github.com/acme/repo/pull/7',
      title: 'Feature',
      baseBranch: 'main',
      headBranch: 'feature',
      headSha: 'abc123def456',
      status: 'open',
    });
    const reviewExecution = manager.requestReview(pullRequest.id, { provider: 'claude-code' });
    assert.equal(runner.requests[0]?.invocation.input, 'Review GitHub PR https://github.com/acme/repo/pull/7');
    assert.doesNotMatch(runner.requests[0]?.invocation.input ?? '', /abc123def456/);
    assert.ok(runner.requests[0]?.invocation.args.some((value) => value.includes('GitHub pull request reviewer')));
    assert.equal(manager.listReviewRequests(pullRequest.id)[0]?.targetHeadSha, 'abc123def456');
    runner.requests[0]?.onEvent?.({ kind: 'message', message: 'Found one issue: comment URL', raw: {} });
    runner.resolvers[0]?.({
      status: 'succeeded', exitCode: 0, nativeSessionId: null, finalMessage: 'reviewed', error: null,
    });
    await reviewExecution;
    await new Promise<void>((resolve) => setImmediate(resolve));

    const reviewerMessage = manager.listMessages(requirement.id).at(-1);
    assert.equal(reviewerMessage?.author, 'reviewer');
    assert.equal(reviewerMessage?.deliverToRd, true);
    assert.equal(runner.requests.length, 2);
    assert.match(runner.requests[1]?.invocation.input ?? '', /Found one issue/);

    runner.resolvers[1]?.({
      status: 'succeeded', exitCode: 0, nativeSessionId: 'rd-session', finalMessage: 'fixed', error: null,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    manager.close();
  }
});

test('PR reconciliation delivers new review activity, CI failures, and status changes to the RD session once', async () => {
  const pendingCheck = {
    key: 'CheckRun:CI:test:https://github.com/acme/repo/actions/runs/1',
    name: 'test',
    workflow: 'CI',
    status: 'IN_PROGRESS',
    conclusion: null,
    url: 'https://github.com/acme/repo/actions/runs/1',
    completedAt: null,
  };
  const failedCheck = {
    ...pendingCheck,
    status: 'COMPLETED',
    conclusion: 'FAILURE',
    completedAt: '2099-01-01T00:02:00.000Z',
  };
  const openSnapshot: GitHubPullRequestSnapshot = {
    status: 'open',
    title: 'Feature',
    url: 'https://github.com/acme/repo/pull/7',
    baseBranch: 'main',
    headBranch: 'feature',
    headSha: 'abc123def456',
    updatedAt: '2099-01-01T00:00:00.000Z',
    reviewActivity: [{
      kind: 'review_comment',
      id: 'old-comment',
      author: 'reviewer',
      body: 'Historical feedback',
      url: 'https://github.com/acme/repo/pull/7#discussion-old',
      createdAt: '2020-01-01T00:00:00.000Z',
      state: null,
      path: 'src/old.ts',
      line: 1,
    }],
    checks: [pendingCheck],
  };
  const activitySnapshot: GitHubPullRequestSnapshot = {
    ...openSnapshot,
    updatedAt: '2099-01-01T00:02:00.000Z',
    reviewActivity: [...openSnapshot.reviewActivity, {
      kind: 'review_comment',
      id: 'new-comment',
      author: 'reviewer',
      body: 'Please cover the retry path.',
      url: 'https://github.com/acme/repo/pull/7#discussion-new',
      createdAt: '2099-01-01T00:01:00.000Z',
      state: null,
      path: 'src/retry.ts',
      line: 42,
    }],
    checks: [failedCheck],
  };
  const mergedSnapshot: GitHubPullRequestSnapshot = {
    ...activitySnapshot,
    status: 'merged',
    updatedAt: '2099-01-01T00:03:00.000Z',
  };
  const runner = new DeferredRunner();
  const manager = new AgentManager({
    workspaceRoot: process.cwd(),
    store: new SqliteAgentManagerStore(':memory:'),
    runner,
    githubClient: new SequenceGitHubClient([openSnapshot, activitySnapshot, activitySnapshot, mergedSnapshot]),
    logger: silentLogger,
  });
  try {
    const requirement = manager.createRequirement({ title: 'Feature', description: 'Open a PR', provider: 'codex' });
    const pullRequest = manager.trackPullRequest({
      requirementId: requirement.id,
      repository: 'acme/repo',
      number: 7,
      url: openSnapshot.url,
      title: openSnapshot.title,
      baseBranch: openSnapshot.baseBranch,
      headBranch: openSnapshot.headBranch,
      headSha: openSnapshot.headSha,
      status: 'open',
    });

    await manager.reconcilePullRequests();
    assert.equal(manager.listMessages(requirement.id).length, 0);

    await manager.reconcilePullRequests();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(runner.requests.length, 1);
    assert.match(runner.requests[0]?.invocation.input ?? '', /Please cover the retry path/);
    assert.match(runner.requests[0]?.invocation.input ?? '', /GitHub CI failed/);

    await manager.reconcilePullRequests();
    assert.equal(manager.listMessages(requirement.id).length, 2);

    await manager.reconcilePullRequests();
    assert.equal(manager.listPullRequests().find((item) => item.id === pullRequest.id)?.status, 'merged');
    assert.equal(manager.listMessages(requirement.id).length, 3);
    assert.equal(runner.requests.length, 1);

    runner.resolvers[0]?.({
      status: 'succeeded', exitCode: 0, nativeSessionId: 'rd-session', finalMessage: 'fixed', error: null,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(runner.requests.length, 2);
    assert.match(runner.requests[1]?.invocation.input ?? '', /open -> merged/);
    assert.match(runner.requests[1]?.invocation.input ?? '', /already persisted this lifecycle state/);
    assert.match(runner.requests[1]?.invocation.input ?? '', /Do not call \/api\/agent\/pull-requests/);

    runner.resolvers[1]?.({
      status: 'succeeded', exitCode: 0, nativeSessionId: 'rd-session', finalMessage: 'merged', error: null,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(manager.listMessages(requirement.id).slice(0, 3).map((message) => message.author), [
      'reviewer',
      'system',
      'system',
    ]);
    assert.ok(manager.listMessages(requirement.id).slice(0, 3).every((message) => message.deliverToRd));
  } finally {
    manager.close();
  }
});
