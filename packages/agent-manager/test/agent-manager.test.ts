import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentTrigger, AgentTriggerContext, AgentTriggerMessage } from '../src/agent-trigger.ts';
import { AgentManager } from '../src/agent-manager.ts';
import {
  CODE_FACTORY_API_URL,
  CODE_FACTORY_REQUIREMENT_ID,
  CODE_FACTORY_SESSION_ID,
} from '../src/code-factory-cli.ts';
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

class InterruptibleRunner implements AgentProcessRunner {
  requests: ProcessRunRequest[] = [];
  resolvers: Array<(outcome: RunOutcome) => void> = [];

  run(request: ProcessRunRequest): Promise<RunOutcome> {
    this.requests.push(request);
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
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

class TestAgentTrigger implements AgentTrigger {
  readonly id = 'slack.thread';
  readonly source = 'slack';
  context: AgentTriggerContext | null = null;
  stopCount = 0;

  start(context: AgentTriggerContext): void {
    this.context = context;
  }

  stop(): void {
    this.stopCount += 1;
  }

  deliver(message: AgentTriggerMessage) {
    if (!this.context) throw new Error('Trigger has not started');
    return this.context.deliver(message);
  }
}

test('Agent Manager queues conversation messages during a Run and resumes without replaying RD output', async () => {
  const store = new SqliteAgentManagerStore(':memory:');
  const runner = new DeferredRunner();
  const manager = new AgentManager({ workspaceRoot: process.cwd(), store, runner, logger: silentLogger });
  try {
    const first = manager.createRequirement({
      title: 'First',
      description: 'First task',
      provider: 'codex',
      model: 'gpt-5.6',
      reasoningEffort: 'max',
    });
    const second = manager.createRequirement({ title: 'Second', description: 'Second task', provider: 'claude-code' });

    const firstExecution = manager.runRequirement(first.id);
    assert.equal(runner.requests[0]?.workspaceRoot, manager.workspaceRoot);
    assert.ok(runner.requests[0]?.invocation.args.some((value) =>
      value.includes('Agent Manager owns draft/open/closed/merged lifecycle synchronization')));
    assert.ok(runner.requests[0]?.invocation.args.some((value) =>
      value.includes('Reuse a worktree dedicated to this requirement')));
    assert.ok(runner.requests[0]?.invocation.args.some((value) =>
      value.includes('Do not move, discard, or overwrite pre-existing changes')));
    assert.ok(runner.requests[0]?.invocation.args.some((value) =>
      value.includes('code-factory-cli pr register')));
    assert.ok(runner.requests[0]?.invocation.args.some((value) =>
      value.includes('code-factory-cli requirement propose')));
    assert.ok(runner.requests[0]?.invocation.args.every((value) =>
      !value.includes('/agent/pull-requests') && !value.includes('/agent/requirements')));
    assert.ok(runner.requests[0]?.invocation.args.every((value) =>
      !value.includes('Agent-created requirements are proposals and do not start automatically.')));
    assert.equal(runner.requests[0]?.environment?.[CODE_FACTORY_API_URL], 'http://127.0.0.1:4310/api');
    assert.equal(runner.requests[0]?.environment?.[CODE_FACTORY_REQUIREMENT_ID], first.id);
    assert.equal(runner.requests[0]?.environment?.[CODE_FACTORY_SESSION_ID], first.session.id);
    assert.ok(runner.requests[0]?.invocation.args.includes('gpt-5.6'));
    assert.ok(runner.requests[0]?.invocation.args.includes('model_reasoning_effort="max"'));
    assert.equal(manager.listRuns(first.id)[0]?.model, 'gpt-5.6');
    assert.equal(manager.listRuns(first.id)[0]?.reasoningEffort, 'max');
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
    assert.ok(runner.requests[2]?.invocation.args.includes('gpt-5.6'));
    assert.ok(runner.requests[2]?.invocation.args.includes('model_reasoning_effort="max"'));
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

test('a pluggable Agent Trigger delivers, deduplicates, and wakes the target RD session', async () => {
  const runner = new DeferredRunner();
  const manager = new AgentManager({
    workspaceRoot: process.cwd(),
    store: new SqliteAgentManagerStore(':memory:'),
    runner,
    logger: silentLogger,
  });
  const trigger = new TestAgentTrigger();
  try {
    const requirement = manager.createRequirement({
      title: 'Slack follow-up',
      description: 'Process thread replies',
      provider: 'codex',
    });
    manager.startAgentTrigger(trigger);
    const message = {
      requirementId: requirement.id,
      idempotencyKey: 'thread-1:message-1',
      author: 'human' as const,
      body: 'Please also cover the retry path.',
      metadata: { threadId: 'thread-1' },
    };
    assert.ok(trigger.deliver(message));
    assert.equal(trigger.deliver(message), null);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(runner.requests.length, 1);
    assert.match(runner.requests[0]?.invocation.input ?? '', /Please also cover the retry path/);
    const event = manager.listEvents().find((item) => item.type === 'message.created');
    assert.equal(event?.payload.source, 'slack');
    assert.equal(event?.payload.triggerId, 'slack.thread');
    assert.equal(event?.payload.threadId, 'thread-1');

    manager.stopAgentTrigger(trigger.id);
    assert.equal(trigger.stopCount, 1);
    assert.equal(trigger.deliver({ ...message, idempotencyKey: 'thread-1:message-2' }), null);
    assert.equal(manager.listMessages(requirement.id).length, 1);

    runner.resolvers[0]?.({
      status: 'succeeded', exitCode: 0, nativeSessionId: 'rd-session', finalMessage: 'updated', error: null,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    manager.close();
  }
});

test('a queued correction does not interrupt until a human explicitly interrupts the running RD Agent', async () => {
  const store = new SqliteAgentManagerStore(':memory:');
  const runner = new InterruptibleRunner();
  const manager = new AgentManager({ workspaceRoot: process.cwd(), store, runner, logger: silentLogger });
  try {
    const requirement = manager.createRequirement({ title: 'Correct course', description: 'Initial task', provider: 'codex' });
    const firstExecution = manager.runRequirement(requirement.id);
    const firstRunId = manager.listRuns(requirement.id)[0]?.id;
    runner.requests[0]?.onNativeSession?.('native-thread-1');

    const reply = manager.postHumanMessage(requirement.id, 'Stop and use the new approach.');
    assert.equal(reply.queued, true);
    assert.equal(runner.requests[0]?.signal?.aborted, false);

    manager.interruptRdRun(requirement.id);
    assert.equal(runner.requests[0]?.signal?.aborted, true);

    const interrupted = await firstExecution;
    assert.equal(interrupted.status, 'doing');
    assert.equal(interrupted.session.state, 'waiting_human');
    assert.equal(manager.listRuns(requirement.id).find((run) => run.id === firstRunId)?.status, 'cancelled');
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(runner.requests.length, 2);
    assert.ok(runner.requests[1]?.invocation.args.includes('resume'));
    assert.match(runner.requests[1]?.invocation.input ?? '', /Stop and use the new approach\./);
    runner.resolvers[1]?.({
      status: 'succeeded',
      exitCode: 0,
      nativeSessionId: 'native-thread-1',
      finalMessage: 'corrected',
      error: null,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    manager.close();
  }
});

test('interrupting an RD Run without a newer message stops instead of immediately restarting it', async () => {
  const store = new SqliteAgentManagerStore(':memory:');
  const runner = new InterruptibleRunner();
  const manager = new AgentManager({ workspaceRoot: process.cwd(), store, runner, logger: silentLogger });
  try {
    const requirement = manager.createRequirement({ title: 'Pause', description: 'Initial task', provider: 'codex' });
    const execution = manager.runRequirement(requirement.id, 'Start here.');
    const activeRun = manager.interruptRdRun(requirement.id);
    assert.equal(activeRun.runId, manager.listRuns(requirement.id)[0]?.id);

    const interrupted = await execution;
    assert.equal(interrupted.session.state, 'waiting_human');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(runner.requests.length, 1);
    assert.throws(() => manager.interruptRdRun(requirement.id), /does not have a running RD Run/);
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
    const reviewExecution = manager.requestReview(pullRequest.id, {
      provider: 'claude-code',
      model: 'claude-opus-4-6',
      reasoningEffort: 'high',
    });
    assert.equal(runner.requests[0]?.invocation.input, 'Review GitHub PR https://github.com/acme/repo/pull/7');
    assert.doesNotMatch(runner.requests[0]?.invocation.input ?? '', /abc123def456/);
    assert.ok(runner.requests[0]?.invocation.args.some((value) => value.includes('GitHub pull request reviewer')));
    assert.ok(runner.requests[0]?.invocation.args.includes('claude-opus-4-6'));
    const modelArgument = runner.requests[0]?.invocation.args.indexOf('--model') ?? -1;
    assert.deepEqual(runner.requests[0]?.invocation.args.slice(modelArgument, modelArgument + 4), ['--model', 'claude-opus-4-6', '--effort', 'high']);
    const reviewRequest = manager.listReviewRequests(pullRequest.id)[0];
    assert.equal(reviewRequest?.targetHeadSha, 'abc123def456');
    assert.equal(reviewRequest?.model, 'claude-opus-4-6');
    assert.equal(reviewRequest?.reasoningEffort, 'high');
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
    assert.match(runner.requests[1]?.invocation.input ?? '', /Do not run code-factory-cli pr register/);
    assert.doesNotMatch(runner.requests[1]?.invocation.input ?? '', /\/api\/agent\/pull-requests/);

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
