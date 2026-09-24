import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import type { AgentTrigger, AgentTriggerContext, AgentTriggerMessage } from '../src/agent-trigger.ts';
import { AgentManager } from '../src/agent-manager.ts';
import { DEFAULT_AGENT_MANAGER_CONFIGURATION } from '../src/configuration.ts';
import {
  CODE_FACTORY_API_URL,
  CODE_FACTORY_REQUIREMENT_ID,
  CODE_FACTORY_SESSION_ID,
} from '../src/code-factory-cli.ts';
import type { GitHubClient, GitHubPullRequestSnapshot } from '../src/github-client.ts';
import { silentLogger } from '../src/logger.ts';
import type { AgentProcessRunner, ProcessRunRequest } from '../src/process-runner.ts';
import {
  PULL_REQUEST_CI_FAILURE_TRIGGER_ID,
  PULL_REQUEST_COMMENT_TRIGGER_ID,
  PULL_REQUEST_CONFLICT_TRIGGER_ID,
  PULL_REQUEST_STATUS_TRIGGER_ID,
} from '../src/pull-request-triggers.ts';
import { SqliteAgentManagerStore } from '../src/sqlite-store.ts';
import { TIMER_AGENT_TRIGGER_ID } from '../src/timer-agent-trigger.ts';
import type { PullRequest, RunOutcome } from '../src/types.ts';

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
  readonly inspections: PullRequest[] = [];
  #index = 0;

  get inspectionCount(): number {
    return this.#index;
  }

  constructor(snapshots: GitHubPullRequestSnapshot[]) {
    this.#snapshots = snapshots;
  }

  inspectPullRequest(pullRequest: PullRequest): Promise<GitHubPullRequestSnapshot> {
    this.inspections.push(pullRequest);
    const snapshot = this.#snapshots[Math.min(this.#index, this.#snapshots.length - 1)];
    this.#index += 1;
    if (!snapshot) throw new Error('No GitHub snapshot configured');
    return Promise.resolve(snapshot);
  }
}

test('commit co-author guidance is enabled by default and updates without restarting', async () => {
  const runner = new DeferredRunner();
  const manager = new AgentManager({
    workspaceRoot: process.cwd(),
    store: new SqliteAgentManagerStore(':memory:'),
    runner,
    logger: silentLogger,
  });
  try {
    const enabledRequirement = manager.createRequirement({
      title: 'Attributed commit',
      description: 'Use the default co-author guidance',
      provider: 'codex',
    });
    const enabledRun = manager.runRequirement(enabledRequirement.id);
    assert.ok(runner.requests[0]?.invocation.args.some((value) =>
      value.includes('Co-authored-by: code-factory <333128126+code-factory-bot@users.noreply.github.com>')));

    const configuration = manager.updateConfiguration({ commitCoAuthorEnabled: false });
    assert.equal(configuration.values.commitCoAuthorEnabled, false);
    assert.equal(configuration.restartRequired, false);

    const disabledRequirement = manager.createRequirement({
      title: 'Unattributed commit',
      description: 'Disable the co-author guidance',
      provider: 'claude-code',
    });
    const disabledRun = manager.runRequirement(disabledRequirement.id);
    assert.ok(runner.requests[1]?.invocation.args.every((value) =>
      !value.includes('Co-authored-by: code-factory')));

    for (const resolve of runner.resolvers) {
      resolve({
        status: 'succeeded',
        exitCode: 0,
        nativeSessionId: null,
        finalMessage: null,
        error: null,
      });
    }
    await Promise.all([enabledRun, disabledRun]);
  } finally {
    await manager.close();
  }
});

test('runtime configuration starts and stops PR reconciliation without restarting the manager', async () => {
  const snapshot: GitHubPullRequestSnapshot = {
    status: 'open',
    title: 'Dynamic configuration',
    url: 'https://github.com/acme/repo/pull/4',
    baseBranch: 'main',
    headBranch: 'configuration',
    headSha: 'abc123',
    mergeable: 'MERGEABLE',
    updatedAt: '2099-01-01T00:00:00.000Z',
    reviewActivity: [],
    checks: [],
  };
  const githubClient = new SequenceGitHubClient([snapshot]);
  const manager = new AgentManager({
    workspaceRoot: process.cwd(),
    store: new SqliteAgentManagerStore(':memory:'),
    githubClient,
    logger: silentLogger,
    configuration: {
      ...DEFAULT_AGENT_MANAGER_CONFIGURATION,
      pullRequestReconcileIntervalSeconds: 0,
      logLevel: 'silent',
    },
  });
  try {
    const requirement = manager.createRequirement({ title: 'Configuration', description: 'Enable polling', provider: 'codex' });
    manager.trackPullRequest({
      requirementId: requirement.id,
      repository: 'acme/repo',
      number: 4,
      url: snapshot.url,
      title: snapshot.title,
      baseBranch: snapshot.baseBranch,
      headBranch: snapshot.headBranch,
      headSha: snapshot.headSha,
      status: snapshot.status,
    });
    manager.startConfiguredServices();
    assert.equal(githubClient.inspectionCount, 0);

    const enabled = manager.updateConfiguration({ pullRequestReconcileIntervalSeconds: 1 });
    assert.equal(enabled.restartRequired, false);
    const configurationEvent = manager.listEvents().find((event) =>
      event.type === 'manager.configuration.updated');
    assert.equal(
      (configurationEvent?.payload.configuration as { values?: { pullRequestReconcileIntervalSeconds?: number } })
        ?.values?.pullRequestReconcileIntervalSeconds,
      1,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(githubClient.inspectionCount, 1);

    manager.updateConfiguration({ pullRequestReconcileIntervalSeconds: 0 });
    assert.equal(manager.getConfiguration().values.pullRequestReconcileIntervalSeconds, 0);
    for (const triggerId of [
      PULL_REQUEST_STATUS_TRIGGER_ID,
      PULL_REQUEST_COMMENT_TRIGGER_ID,
      PULL_REQUEST_CI_FAILURE_TRIGGER_ID,
      PULL_REQUEST_CONFLICT_TRIGGER_ID,
    ]) {
      const probe: AgentTrigger = {
        id: triggerId,
        source: 'test',
        start: () => undefined,
        stop: () => undefined,
      };
      manager.startAgentTrigger(probe);
      manager.stopAgentTrigger(triggerId);
    }
  } finally {
    await manager.close();
  }
});

test('runtime retention configuration immediately purges expired requirements and attachment files', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-manager-retention-'));
  const attachmentPath = join(directory, 'expired.txt');
  const retryAttachmentPath = join(directory, 'retry-expired');
  writeFileSync(attachmentPath, 'expired');
  mkdirSync(retryAttachmentPath);
  const store = new SqliteAgentManagerStore(':memory:');
  store.createRequirement({
    requirementId: 'req-cancelled-expired',
    sessionId: 'ses-cancelled-expired',
    title: 'Old cancellation',
    description: 'Purge after the retention setting changes',
    provider: 'codex',
    createdBy: 'human',
    now: '2020-01-01T00:00:00.000Z',
  });
  store.createMessageAttachment({
    id: 'att-cancelled-expired',
    requirementId: 'req-cancelled-expired',
    fileName: 'expired.txt',
    kind: 'file',
    mediaType: 'text/plain',
    byteSize: 7,
    localPath: attachmentPath,
    now: '2020-01-01T00:00:00.000Z',
  });
  store.createMessageAttachment({
    id: 'att-cancelled-retry',
    requirementId: 'req-cancelled-expired',
    fileName: 'retry-expired',
    kind: 'file',
    mediaType: 'application/octet-stream',
    byteSize: 1,
    localPath: retryAttachmentPath,
    now: '2020-01-01T00:00:00.000Z',
  });
  store.transitionRequirement(
    'req-cancelled-expired',
    ['todo'],
    'cancelled',
    '2020-01-01T00:01:00.000Z',
  );
  store.createRequirement({
    requirementId: 'req-done-expired',
    sessionId: 'ses-done-expired',
    title: 'Old completion',
    description: 'Purge after the retention setting changes',
    provider: 'codex',
    createdBy: 'human',
    now: '2020-01-01T00:00:00.000Z',
  });
  store.transitionRequirement(
    'req-done-expired',
    ['todo'],
    'done',
    '2020-01-01T00:01:00.000Z',
  );
  store.createRequirement({
    requirementId: 'req-cancelled-ancient',
    sessionId: 'ses-cancelled-ancient',
    title: 'Ancient cancellation',
    description: 'Purge during the startup sweep',
    provider: 'codex',
    createdBy: 'human',
    now: '1900-01-01T00:00:00.000Z',
  });
  store.transitionRequirement(
    'req-cancelled-ancient',
    ['todo'],
    'cancelled',
    '1900-01-01T00:01:00.000Z',
  );
  const manager = new AgentManager({
    workspaceRoot: process.cwd(),
    store,
    attachmentDirectory: directory,
    logger: silentLogger,
    configuration: {
      ...DEFAULT_AGENT_MANAGER_CONFIGURATION,
      pullRequestReconcileIntervalSeconds: 0,
      cancelledRequirementRetentionDays: 36_500,
      doneRequirementRetentionDays: 36_500,
    },
    modelCatalog: {
      start: () => undefined,
      stop: () => undefined,
      getModels: () => Promise.resolve({ refreshIntervalSeconds: 86_400, providers: [] }),
    },
  });
  try {
    manager.startConfiguredServices();
    assert.equal(manager.getRequirement('req-cancelled-ancient'), null);
    assert.notEqual(manager.getRequirement('req-cancelled-expired'), null);
    assert.notEqual(manager.getRequirement('req-done-expired'), null);

    const snapshot = manager.updateConfiguration({
      cancelledRequirementRetentionDays: 7,
      doneRequirementRetentionDays: 365,
    });

    assert.equal(snapshot.restartRequired, false);
    assert.deepEqual(snapshot.restartRequiredFields, []);
    assert.equal(manager.getRequirement('req-cancelled-expired'), null);
    assert.equal(manager.getRequirement('req-done-expired'), null);
    assert.equal(existsSync(attachmentPath), false);
    assert.equal(existsSync(retryAttachmentPath), true);
    assert.deepEqual(store.listPendingAttachmentDeletions(), [retryAttachmentPath]);
    const purgeEvent = manager.listEvents().filter((event) => event.type === 'requirements.purged').at(-1);
    assert.deepEqual(purgeEvent?.payload, {
      requirementIds: ['req-cancelled-expired', 'req-done-expired'],
      cancelledCount: 1,
      doneCount: 1,
    });

    rmSync(retryAttachmentPath, { recursive: true, force: true });
    manager.updateConfiguration({ cancelledRequirementRetentionDays: 7 });
    assert.deepEqual(store.listPendingAttachmentDeletions(), []);
  } finally {
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('zero-day retention purges requirements as cancellation and completion become terminal', async () => {
  const store = new SqliteAgentManagerStore(':memory:');
  const manager = new AgentManager({
    workspaceRoot: process.cwd(),
    store,
    logger: silentLogger,
    configuration: {
      ...DEFAULT_AGENT_MANAGER_CONFIGURATION,
      cancelledRequirementRetentionDays: 0,
      doneRequirementRetentionDays: 0,
    },
  });
  try {
    const cancelled = manager.createRequirement({
      title: 'Cancel immediately',
      description: 'Apply an existing zero-day policy on cancellation',
      provider: 'codex',
    });
    manager.deleteRequirement(cancelled.id);
    assert.equal(manager.getRequirement(cancelled.id), null);

    const done = manager.createRequirement({
      title: 'Complete immediately',
      description: 'Apply an existing zero-day policy on completion',
      provider: 'codex',
    });
    store.transitionRequirement(done.id, ['todo'], 'waiting_confirmation', new Date().toISOString());
    const completed = manager.confirmRequirement(done.id);
    assert.equal(completed.status, 'done');
    assert.equal(manager.getRequirement(done.id), null);

    assert.deepEqual(
      manager.listEvents().filter((event) => event.type === 'requirements.purged').map((event) => event.payload),
      [
        { requirementIds: [cancelled.id], cancelledCount: 1, doneCount: 0 },
        { requirementIds: [done.id], cancelledCount: 0, doneCount: 1 },
      ],
    );
  } finally {
    await manager.close();
  }
});

test('zero-day retention retries after an in-flight reviewer finishes', async () => {
  const runner = new DeferredRunner();
  const manager = new AgentManager({
    workspaceRoot: process.cwd(),
    store: new SqliteAgentManagerStore(':memory:'),
    runner,
    logger: silentLogger,
    configuration: {
      ...DEFAULT_AGENT_MANAGER_CONFIGURATION,
      cancelledRequirementRetentionDays: 0,
    },
  });
  try {
    const requirement = manager.createRequirement({
      title: 'Cancel while review is running',
      description: 'Defer zero-day cleanup until the reviewer result is recorded',
      provider: 'codex',
    });
    const pullRequest = manager.trackPullRequest({
      requirementId: requirement.id,
      repository: 'acme/repo',
      number: 40,
      url: 'https://github.com/acme/repo/pull/40',
      title: 'Review before cleanup',
      baseBranch: 'main',
      headBranch: 'review-before-cleanup',
      headSha: 'review-before-cleanup-sha',
      status: 'open',
    });
    const review = manager.requestReview(pullRequest.id, { provider: 'codex' });

    manager.deleteRequirement(requirement.id);
    assert.equal(manager.getRequirement(requirement.id)?.status, 'cancelled');
    runner.resolvers[0]?.({
      status: 'succeeded',
      exitCode: 0,
      nativeSessionId: null,
      finalMessage: 'reviewed',
      error: null,
    });
    await review;

    assert.equal(manager.getRequirement(requirement.id), null);
  } finally {
    await manager.close();
  }
});

test('PR reconciliation polls Draft and Open PRs and persists Draft to Open transitions', async () => {
  const openSnapshot: GitHubPullRequestSnapshot = {
    status: 'open',
    title: 'open',
    url: 'https://github.com/acme/repo/pull/2',
    baseBranch: 'main',
    headBranch: 'open',
    headSha: 'open-sha',
    mergeable: 'MERGEABLE',
    updatedAt: '2099-01-01T00:00:00.000Z',
    reviewActivity: [],
    checks: [],
  };
  const githubClient = new SequenceGitHubClient([openSnapshot]);
  const runner = new DeferredRunner();
  const manager = new AgentManager({
    workspaceRoot: process.cwd(),
    store: new SqliteAgentManagerStore(':memory:'),
    runner,
    githubClient,
    logger: silentLogger,
  });
  try {
    const requirement = manager.createRequirement({ title: 'Polling scope', description: 'Track PRs', provider: 'codex' });
    for (const [index, status] of (['draft', 'open', 'closed', 'merged'] as const).entries()) {
      const number = index + 1;
      manager.trackPullRequest({
        requirementId: requirement.id,
        repository: 'acme/repo',
        number,
        url: `https://github.com/acme/repo/pull/${number}`,
        title: status,
        baseBranch: 'main',
        headBranch: status,
        headSha: `${status}-sha`,
        status,
      });
    }

    await manager.reconcilePullRequests();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(githubClient.inspections.map((pullRequest) => ({
      number: pullRequest.number,
      status: pullRequest.status,
    })).sort((left, right) => left.number - right.number), [
      { number: 1, status: 'draft' },
      { number: 2, status: 'open' },
    ]);
    assert.equal(manager.listPullRequests().find((pullRequest) => pullRequest.number === 1)?.status, 'open');
    assert.equal(manager.listMessages(requirement.id).filter((message) => message.body.includes('draft -> open')).length, 1);

    runner.resolvers[0]?.({
      status: 'succeeded', exitCode: 0, nativeSessionId: 'rd-session', finalMessage: 'ready', error: null,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    await manager.close();
  }
});

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

test('Agent Manager removes a TODO requirement from active lists and publishes a durable event', async () => {
  const store = new SqliteAgentManagerStore(':memory:');
  const manager = new AgentManager({
    workspaceRoot: process.cwd(),
    store,
    logger: silentLogger,
  });
  try {
    const requirement = manager.createRequirement({
      title: 'Discard draft',
      description: 'This work is no longer needed',
      provider: 'codex',
    });
    manager.deleteRequirement(requirement.id);

    assert.equal(manager.getRequirement(requirement.id)?.status, 'cancelled');
    assert.equal(manager.getRequirement(requirement.id)?.session.state, 'completed');
    assert.equal(manager.listRequirements().some((item) => item.id === requirement.id), false);
    const event = manager.listEvents().at(-1);
    assert.equal(event?.type, 'requirement.deleted');
    assert.equal(event?.requirementId, requirement.id);
    assert.equal(event?.sessionId, requirement.session.id);
    assert.equal((event?.payload.requirement as { id?: string; status?: string })?.id, requirement.id);
    assert.equal((event?.payload.requirement as { status?: string })?.status, 'cancelled');
    assert.deepEqual(event?.payload.timers, []);
  } finally {
    await manager.close();
  }
});

test('Agent Manager updates TODO Agent configuration and uses it for the first Run', async () => {
  const store = new SqliteAgentManagerStore(':memory:');
  const runner = new DeferredRunner();
  const manager = new AgentManager({
    workspaceRoot: process.cwd(),
    store,
    runner,
    logger: silentLogger,
  });
  try {
    const created = manager.createRequirement({
      title: 'Tune the first Run',
      description: 'Change the model before execution',
      provider: 'codex',
      model: 'gpt-old',
      reasoningEffort: 'low',
    });
    const updated = manager.updateRequirementAgentConfiguration(created.id, {
      model: 'gpt-new',
      reasoningEffort: 'max',
    });

    assert.equal(updated.model, 'gpt-new');
    assert.equal(updated.reasoningEffort, 'max');
    const updateEvent = manager.listEvents().findLast((event) => event.type === 'requirement.updated');
    assert.equal(updateEvent?.requirementId, created.id);
    assert.equal((updateEvent?.payload.requirement as { model?: string })?.model, 'gpt-new');

    const runPromise = manager.runRequirement(created.id);
    assert.ok(runner.requests[0]?.invocation.args.includes('gpt-new'));
    assert.ok(runner.requests[0]?.invocation.args.includes('model_reasoning_effort="max"'));
    assert.throws(
      () => manager.updateRequirementAgentConfiguration(created.id, { model: null }),
      /only be changed while it is todo/,
    );
    runner.resolvers[0]?.({
      status: 'succeeded',
      exitCode: 0,
      nativeSessionId: 'native-tuned',
      finalMessage: 'done',
      error: null,
    });
    await runPromise;
  } finally {
    await manager.close();
  }
});

test('Agent Manager applies lifecycle actions only to children proposed by the source RD Session', async () => {
  const runner = new InterruptibleRunner();
  const manager = new AgentManager({
    workspaceRoot: process.cwd(),
    store: new SqliteAgentManagerStore(':memory:'),
    runner,
    logger: silentLogger,
  });
  try {
    const source = manager.createRequirement({
      title: 'Source work',
      description: 'Find follow-up tasks',
      provider: 'codex',
    });
    const child = manager.createRequirement({
      title: 'Draft follow-up',
      description: 'Delete this separate task',
      provider: 'codex',
      createdBy: 'rd_agent',
      parentRequirementId: source.id,
      sourceSessionId: source.session.id,
    });
    const humanRequirement = manager.createRequirement({
      title: 'Human work',
      description: 'Must not be managed by the Agent',
      provider: 'codex',
    });
    const startedChild = manager.createRequirement({
      title: 'Start follow-up',
      description: 'Run this separate task',
      provider: 'codex',
      createdBy: 'rd_agent',
      parentRequirementId: source.id,
      sourceSessionId: source.session.id,
    });

    assert.throws(() => manager.startProposedRequirement(
      source.id,
      source.session.id,
      humanRequirement.id,
    ), /was not proposed by/);
    assert.throws(() => manager.stopProposedRequirement(
      source.id,
      source.session.id,
      humanRequirement.id,
    ), /was not proposed by/);
    assert.throws(() => manager.deleteProposedRequirement(
      source.id,
      source.session.id,
      humanRequirement.id,
    ), /was not proposed by/);
    assert.throws(() => manager.completeProposedRequirement(
      source.id,
      source.session.id,
      humanRequirement.id,
    ), /was not proposed by/);

    const execution = manager.startProposedRequirement(
      source.id,
      source.session.id,
      startedChild.id,
    );
    assert.equal(manager.getRequirement(startedChild.id)?.status, 'doing');
    assert.equal(manager.getRequirement(startedChild.id)?.session.state, 'running');
    assert.equal(runner.requests.at(-1)?.invocation.input.includes('Start follow-up'), true);
    const activeRunId = manager.listRuns(startedChild.id)[0]?.id;
    assert.ok(activeRunId);
    const repeatedStart = await manager.startProposedRequirement(
      source.id,
      source.session.id,
      startedChild.id,
    );
    assert.equal(repeatedStart.session.state, 'running');
    assert.equal(runner.requests.length, 1);

    const stopped = manager.stopProposedRequirement(
      source.id,
      source.session.id,
      startedChild.id,
    );
    assert.equal(stopped.runId, activeRunId);
    await execution;
    assert.equal(manager.getRequirement(startedChild.id)?.status, 'doing');
    assert.equal(manager.getRequirement(startedChild.id)?.session.state, 'waiting_human');

    const retry = manager.startProposedRequirement(
      source.id,
      source.session.id,
      startedChild.id,
    );
    runner.resolvers.at(-1)?.({
      status: 'succeeded', exitCode: 0, nativeSessionId: 'native-started-child', finalMessage: 'done', error: null,
    });
    await retry;
    assert.equal(manager.getRequirement(startedChild.id)?.status, 'waiting_confirmation');
    assert.throws(() => manager.deleteProposedRequirement(
      source.id,
      source.session.id,
      startedChild.id,
    ), /cannot transition to cancelled/);

    const completed = manager.completeProposedRequirement(
      source.id,
      source.session.id,
      startedChild.id,
    );
    assert.equal(completed.status, 'done');
    assert.equal(completed.session.state, 'completed');
    assert.throws(() => manager.completeProposedRequirement(
      source.id,
      source.session.id,
      startedChild.id,
    ), /cannot transition to done/);

    const deleted = manager.deleteProposedRequirement(
      source.id,
      source.session.id,
      child.id,
    );
    assert.equal(deleted.status, 'cancelled');
    assert.throws(() => manager.startProposedRequirement(
      source.id,
      source.session.id,
      child.id,
    ), /already cancelled/);
  } finally {
    await manager.close();
  }
});

test('Agent Manager includes a human start message in the initial RD Run', async () => {
  const runner = new DeferredRunner();
  const manager = new AgentManager({
    workspaceRoot: process.cwd(),
    store: new SqliteAgentManagerStore(':memory:'),
    runner,
    logger: silentLogger,
  });
  try {
    const requirement = manager.createRequirement({ title: 'First input', description: 'Initial task', provider: 'codex' });
    const execution = manager.runRequirement(requirement.id, 'Start here.');

    assert.match(runner.requests[0]?.invocation.input ?? '', /Start here\./);
    assert.equal(manager.listRuns(requirement.id)[0]?.inputFromSequence, 1);
    assert.equal(manager.listRuns(requirement.id)[0]?.inputToSequence, 1);
    const startedEvent = manager.listEvents().find((event) => event.type === 'run.started');
    assert.equal((startedEvent?.payload.requirement as { session?: { state?: string } })?.session?.state, 'running');
    assert.equal((startedEvent?.payload.run as { status?: string })?.status, 'running');

    runner.resolvers[0]?.({
      status: 'succeeded', exitCode: 0, nativeSessionId: 'native-thread-1', finalMessage: 'ready', error: null,
    });
    await execution;
    assert.equal(manager.getRequirement(requirement.id)?.session.lastConsumedMessageSequence, 1);
    const succeededEvent = manager.listEvents().find((event) => event.type === 'run.succeeded');
    assert.equal((succeededEvent?.payload.requirement as { status?: string })?.status, 'waiting_confirmation');
    assert.equal((succeededEvent?.payload.run as { status?: string })?.status, 'succeeded');
  } finally {
    manager.close();
  }
});

test('related Requirements can inspect each other and deliver visible RD Agent messages', async () => {
  const runner = new DeferredRunner();
  const manager = new AgentManager({
    workspaceRoot: process.cwd(),
    store: new SqliteAgentManagerStore(':memory:'),
    runner,
    logger: silentLogger,
  });
  try {
    const parent = manager.createRequirement({
      title: 'Parent contract',
      description: 'Coordinate the shared contract',
      provider: 'codex',
    });
    const child = manager.createRequirement({
      title: 'Child implementation',
      description: 'Implement one part of the contract',
      provider: 'codex',
      createdBy: 'rd_agent',
      parentRequirementId: parent.id,
      sourceSessionId: parent.session.id,
    });
    const unrelated = manager.createRequirement({
      title: 'Unrelated work',
      description: 'Must not receive this message',
      provider: 'codex',
    });
    const cancelledChild = manager.createRequirement({
      title: 'Cancelled child',
      description: 'Remain visible as relationship history',
      provider: 'codex',
      createdBy: 'rd_agent',
      parentRequirementId: parent.id,
      sourceSessionId: parent.session.id,
    });
    manager.deleteRequirement(cancelledChild.id);

    const parentRelations = manager.listRelatedRequirements(parent.id, parent.session.id);
    assert.equal(parentRelations.parent, null);
    assert.deepEqual(
      new Set(parentRelations.children.map((requirement) => requirement.id)),
      new Set([child.id, cancelledChild.id]),
    );
    const childRelations = manager.listRelatedRequirements(child.id, child.session.id);
    assert.equal(childRelations.parent?.id, parent.id);
    assert.deepEqual(childRelations.children, []);
    assert.throws(
      () => manager.listRelatedRequirements(child.id, parent.session.id),
      /sourceSessionId must belong to source Requirement/,
    );
    assert.throws(
      () => manager.postRelatedRequirementMessage(
        child.id,
        child.session.id,
        unrelated.id,
        'This must be rejected.',
      ),
      /is not a parent or child/,
    );

    const delivered = manager.postRelatedRequirementMessage(
      child.id,
      child.session.id,
      parent.id,
      'The shared contract now uses field version 2.',
    );
    assert.equal(delivered.queued, false);
    assert.equal(delivered.message.author, 'rd_agent');
    assert.equal(delivered.message.sourceRequirementId, child.id);
    assert.equal(delivered.message.deliverToRd, true);
    assert.equal(delivered.requirement.session.state, 'running');
    assert.deepEqual(manager.listMessages(parent.id).map((message) => message.body), [
      'The shared contract now uses field version 2.',
    ]);
    assert.match(runner.requests[0]?.invocation.input ?? '', /Related RD Agent from Child implementation/);
    assert.match(runner.requests[0]?.invocation.input ?? '', /The shared contract now uses field version 2\./);
  } finally {
    await manager.close();
  }
});

test('a related RD Agent message reactivates done work and rejects a cancelled target', async () => {
  const store = new SqliteAgentManagerStore(':memory:');
  const runner = new DeferredRunner();
  const manager = new AgentManager({ workspaceRoot: process.cwd(), store, runner, logger: silentLogger });
  try {
    const completedParent = manager.createRequirement({
      title: 'Completed parent',
      description: 'Resume when the child needs coordination',
      provider: 'codex',
    });
    const completedChild = manager.createRequirement({
      title: 'Completed parent child',
      description: 'Send a follow-up to the parent',
      provider: 'codex',
      createdBy: 'rd_agent',
      parentRequirementId: completedParent.id,
      sourceSessionId: completedParent.session.id,
    });
    store.beginRun({
      runId: 'run-related-completed',
      requirementId: completedParent.id,
      role: 'rd',
      provider: 'codex',
      taskSummary: 'Complete the parent',
      now: '2026-09-18T00:00:00.000Z',
    });
    store.finishRdRun('run-related-completed', {
      status: 'succeeded',
      exitCode: 0,
      nativeSessionId: 'native-related-parent',
      finalMessage: 'ready',
      error: null,
    }, '2026-09-18T00:01:00.000Z');
    manager.confirmRequirement(completedParent.id);

    const reactivated = manager.postRelatedRequirementMessage(
      completedChild.id,
      completedChild.session.id,
      completedParent.id,
      'Please extend the completed contract.',
    );
    assert.equal(reactivated.queued, false);
    assert.equal(reactivated.requirement.status, 'doing');
    assert.equal(reactivated.requirement.session.state, 'running');
    assert.equal(reactivated.requirement.completedAt, null);
    assert.ok(runner.requests[0]?.invocation.args.includes('native-related-parent'));

    const cancelledParent = manager.createRequirement({
      title: 'Cancelled parent',
      description: 'Remain terminal',
      provider: 'codex',
    });
    const cancelledChild = manager.createRequirement({
      title: 'Cancelled parent child',
      description: 'Cannot revive the cancelled parent',
      provider: 'codex',
      createdBy: 'rd_agent',
      parentRequirementId: cancelledParent.id,
      sourceSessionId: cancelledParent.session.id,
    });
    manager.deleteRequirement(cancelledParent.id);
    assert.throws(
      () => manager.postRelatedRequirementMessage(
        cancelledChild.id,
        cancelledChild.session.id,
        cancelledParent.id,
        'This target must stay cancelled.',
      ),
      /already cancelled/,
    );
  } finally {
    await manager.close();
  }
});

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
      value.includes('The GitHub reconciler owns lifecycle')));
    assert.ok(runner.requests[0]?.invocation.args.some((value) =>
      value.includes('reuse or create a Requirement-specific worktree')));
    assert.ok(runner.requests[0]?.invocation.args.some((value) =>
      value.includes('Preserve pre-existing changes')));
    for (const capability of [
      'register PRs', 'propose separate TODO follow-ups',
      'manage those proposals with lifecycle actions',
      'inspect direct parent/child requirements',
      'message their RD Agents', 'manage wake-up timers', 'code-factory-cli --help',
      'Track started tasks to completion', 'provider wait/monitor tools',
      'only for work guaranteed to continue independently afterward', 'cancel unneeded recurring timers',
    ]) {
      assert.ok(runner.requests[0]?.invocation.args.some((value) => value.includes(capability)));
    }
    assert.ok(runner.requests[0]?.invocation.args.every((value) =>
      !value.includes('/agent/pull-requests') && !value.includes('/agent/requirements')));
    assert.ok(runner.requests[0]?.invocation.args.every((value) =>
      !value.includes('Agent-created requirements are proposals and do not start automatically.')));
    assert.equal(runner.requests[0]?.environment?.[CODE_FACTORY_API_URL], 'http://127.0.0.1:4310/api');
    assert.equal(runner.requests[0]?.environment?.[CODE_FACTORY_REQUIREMENT_ID], first.id);
    assert.equal(runner.requests[0]?.environment?.[CODE_FACTORY_SESSION_ID], first.session.id);
    assert.equal(runner.requests[0]?.timeoutMode, 'inactivity');
    assert.ok(runner.requests[0]?.invocation.args.includes('gpt-5.6'));
    assert.ok(runner.requests[0]?.invocation.args.includes('model_reasoning_effort="max"'));
    assert.equal(manager.listRuns(first.id)[0]?.model, 'gpt-5.6');
    assert.equal(manager.listRuns(first.id)[0]?.reasoningEffort, 'max');
    const secondExecution = manager.runRequirement(second.id);
    assert.equal(runner.requests[1]?.workspaceRoot, manager.workspaceRoot);
    const queued = manager.postHumanMessage(first.id, 'add another test');
    assert.equal(queued.queued, true);
    assert.equal(queued.requirement.session.state, 'running');
    assert.equal(queued.requirement.session.pendingMessageCount, 1);
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
    assert.match(runner.requests[2]?.invocation.input ?? '', /Title: First/);
    assert.match(runner.requests[2]?.invocation.input ?? '', /Description:\nFirst task/);
    assert.ok(runner.requests[2]?.invocation.args.some((value) => value.includes('check worktree and PR state before repeating actions')));
    assert.ok(runner.requests[1]?.invocation.args.some((value) => value.includes('humans confirm completion')));
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

test('a human reply reactivates a completed requirement in its original RD session', async () => {
  const runner = new DeferredRunner();
  const manager = new AgentManager({
    workspaceRoot: process.cwd(),
    store: new SqliteAgentManagerStore(':memory:'),
    runner,
    logger: silentLogger,
  });
  try {
    const requirement = manager.createRequirement({
      title: 'Completed work needs a follow-up',
      description: 'Resume the same context when a human replies',
      provider: 'codex',
    });
    const firstExecution = manager.runRequirement(requirement.id, 'Implement the first version.');
    runner.resolvers[0]?.({
      status: 'succeeded',
      exitCode: 0,
      nativeSessionId: 'native-thread-1',
      finalMessage: 'ready',
      error: null,
    });
    await firstExecution;

    const scheduled = manager.createAgentTimer(requirement.id, {
      description: 'Check compiler status',
      schedule: 'recurring',
      intervalSeconds: 3_600,
    });

    const completed = manager.confirmRequirement(requirement.id);
    assert.equal(completed.status, 'done');
    assert.equal(completed.session.state, 'completed');
    assert.ok(completed.completedAt);
    assert.equal(manager.listAgentTimers(requirement.id)
      .find((timer) => timer.id === scheduled.id)?.status, 'cancelled');

    const reply = manager.postHumanMessage(requirement.id, 'Please add one more regression test.');
    assert.equal(reply.queued, false);
    assert.equal(reply.message.deliverToRd, true);
    assert.equal(reply.requirement.status, 'doing');
    assert.equal(reply.requirement.session.state, 'running');
    assert.equal(reply.requirement.completedAt, null);
    assert.equal(runner.requests.length, 2);
    assert.ok(runner.requests[1]?.invocation.args.includes('resume'));
    assert.ok(runner.requests[1]?.invocation.args.includes('native-thread-1'));
    assert.match(runner.requests[1]?.invocation.input ?? '', /Please add one more regression test\./);

    const reactivated = manager.getRequirement(requirement.id);
    assert.equal(reactivated?.status, 'doing');
    assert.equal(reactivated?.session.state, 'running');
    assert.equal(reactivated?.session.id, requirement.session.id);
    assert.equal(reactivated?.completedAt, null);

    runner.resolvers[1]?.({
      status: 'succeeded',
      exitCode: 0,
      nativeSessionId: 'native-thread-1',
      finalMessage: 'updated',
      error: null,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(manager.getRequirement(requirement.id)?.status, 'waiting_confirmation');
  } finally {
    manager.close();
  }
});

test('the native Timer Agent Trigger wakes an idle RD session with timer context', async () => {
  const store = new SqliteAgentManagerStore(':memory:');
  const runner = new DeferredRunner();
  const manager = new AgentManager({ workspaceRoot: process.cwd(), store, runner, logger: silentLogger });
  try {
    const requirement = manager.createRequirement({
      title: 'Long compiler job',
      description: 'Inspect the compiler result after the timer fires',
      provider: 'codex',
    });
    const scheduledFor = new Date(Date.now() - 1_000).toISOString();
    store.createAgentTimer({
      id: 'tmr-due',
      requirementId: requirement.id,
      description: 'Check compiler status',
      schedule: 'once',
      intervalSeconds: 60,
      nextFireAt: scheduledFor,
      now: scheduledFor,
    });

    manager.startConfiguredServices();
    const deadline = Date.now() + 1_000;
    while (runner.requests.length === 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }

    assert.equal(runner.requests.length, 1);
    assert.match(runner.requests[0]?.invocation.input ?? '', /Timer ID: tmr-due/);
    assert.match(runner.requests[0]?.invocation.input ?? '', /Description: Check compiler status/);
    const message = manager.listMessages(requirement.id)[0];
    assert.equal(message?.author, 'system');
    assert.match(message?.body ?? '', /^Timer fired\./);
    const messageEvent = manager.listEvents().find((event) =>
      event.type === 'message.created' && event.payload.timerId === 'tmr-due');
    assert.equal(messageEvent?.payload.triggerId, TIMER_AGENT_TRIGGER_ID);
    assert.equal(messageEvent?.payload.source, 'timer');
    assert.equal((messageEvent?.payload.message as { requirementId?: string })?.requirementId, requirement.id);
    assert.equal((messageEvent?.payload.requirement as { id?: string })?.id, requirement.id);
    assert.equal(store.getAgentTimer('tmr-due')?.status, 'completed');
    assert.ok(manager.listEvents().some((event) => event.type === 'timer.fired'));

    runner.resolvers[0]?.({
      status: 'succeeded',
      exitCode: 0,
      nativeSessionId: 'native-scheduled-session',
      finalMessage: 'Build inspected',
      error: null,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    await manager.close();
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
    assert.equal(runner.requests[0]?.timeoutMode, 'elapsed');
    const reviewRequest = manager.listReviewRequests(pullRequest.id)[0];
    assert.equal(reviewRequest?.targetHeadSha, 'abc123def456');
    assert.equal(reviewRequest?.model, 'claude-opus-4-6');
    assert.equal(reviewRequest?.reasoningEffort, 'high');
    const reviewStartedEvent = manager.listEvents().find((event) => event.type === 'review_request.started');
    assert.equal((reviewStartedEvent?.payload.pullRequest as { id?: string })?.id, pullRequest.id);
    assert.equal((reviewStartedEvent?.payload.reviewRequest as { id?: string })?.id, reviewRequest?.id);
    assert.equal((reviewStartedEvent?.payload.run as { id?: string; status?: string })?.status, 'running');
    runner.requests[0]?.onEvent?.({ kind: 'message', message: 'Found one issue: comment URL', raw: {} });
    runner.resolvers[0]?.({
      status: 'succeeded', exitCode: 0, nativeSessionId: null, finalMessage: 'reviewed', error: null,
    });
    await reviewExecution;
    await new Promise<void>((resolve) => setImmediate(resolve));

    const reviewSucceededEvent = manager.listEvents().find((event) =>
      event.type === 'run.succeeded' && event.runId === reviewRequest?.runId);
    assert.equal((reviewSucceededEvent?.payload.reviewRequest as { status?: string })?.status, 'succeeded');
    assert.equal((reviewSucceededEvent?.payload.run as { status?: string })?.status, 'succeeded');

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

test('independent PR triggers deliver review activity, CI failures, and status changes once from one snapshot', async () => {
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
    mergeable: 'MERGEABLE',
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
  const githubClient = new SequenceGitHubClient([openSnapshot, activitySnapshot, activitySnapshot, mergedSnapshot]);
  const manager = new AgentManager({
    workspaceRoot: process.cwd(),
    store: new SqliteAgentManagerStore(':memory:'),
    runner,
    githubClient,
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
    assert.equal(githubClient.inspectionCount, 2);
    assert.equal(runner.requests.length, 1);
    assert.match(runner.requests[0]?.invocation.input ?? '', /Please cover the retry path/);
    assert.match(runner.requests[0]?.invocation.input ?? '', /GitHub CI failed/);
    const feedbackEvents = manager.listEvents().filter((item) => item.type === 'message.created');
    assert.deepEqual(feedbackEvents.map((event) => event.payload.triggerId), [
      PULL_REQUEST_COMMENT_TRIGGER_ID,
      PULL_REQUEST_CI_FAILURE_TRIGGER_ID,
    ]);

    await manager.reconcilePullRequests();
    assert.equal(manager.listMessages(requirement.id).length, 2);

    await manager.reconcilePullRequests();
    assert.equal(manager.listPullRequests().find((item) => item.id === pullRequest.id)?.status, 'merged');
    assert.equal(manager.listMessages(requirement.id).length, 3);
    assert.equal(runner.requests.length, 1);
    assert.equal(manager.listEvents().filter((item) => item.type === 'message.created').at(-1)?.payload.triggerId,
      PULL_REQUEST_STATUS_TRIGGER_ID);

    await manager.reconcilePullRequests();
    assert.equal(githubClient.inspectionCount, 4, 'a terminal PR is excluded after its final active-state poll');

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

test('PR conflict trigger delivers each conflicting head revision once', async () => {
  const conflictSnapshot: GitHubPullRequestSnapshot = {
    status: 'open',
    title: 'Feature',
    url: 'https://github.com/acme/repo/pull/9',
    baseBranch: 'main',
    headBranch: 'feature',
    headSha: 'head123',
    mergeable: 'CONFLICTING',
    updatedAt: '2099-01-01T00:00:00.000Z',
    reviewActivity: [],
    checks: [],
  };
  const runner = new DeferredRunner();
  const nextHeadSnapshot = { ...conflictSnapshot, headSha: 'head456', updatedAt: '2099-01-01T00:01:00.000Z' };
  const manager = new AgentManager({
    workspaceRoot: process.cwd(),
    store: new SqliteAgentManagerStore(':memory:'),
    runner,
    githubClient: new SequenceGitHubClient([conflictSnapshot, conflictSnapshot, nextHeadSnapshot]),
    logger: silentLogger,
  });
  try {
    const requirement = manager.createRequirement({ title: 'Conflicted feature', description: 'Open a PR', provider: 'codex' });
    manager.trackPullRequest({
      requirementId: requirement.id,
      repository: 'acme/repo',
      number: 9,
      url: conflictSnapshot.url,
      title: conflictSnapshot.title,
      baseBranch: conflictSnapshot.baseBranch,
      headBranch: conflictSnapshot.headBranch,
      headSha: conflictSnapshot.headSha,
      status: 'open',
    });

    await manager.reconcilePullRequests();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await manager.reconcilePullRequests();
    await manager.reconcilePullRequests();

    assert.equal(manager.listMessages(requirement.id).length, 2);
    assert.match(runner.requests[0]?.invocation.input ?? '', /has merge conflicts/);
    assert.match(runner.requests[0]?.invocation.input ?? '', /Base: main/);
    const events = manager.listEvents().filter((item) => item.type === 'message.created');
    assert.deepEqual(events.map((event) => event.payload.triggerId), [
      PULL_REQUEST_CONFLICT_TRIGGER_ID,
      PULL_REQUEST_CONFLICT_TRIGGER_ID,
    ]);

    runner.resolvers[0]?.({
      status: 'succeeded', exitCode: 0, nativeSessionId: 'rd-session', finalMessage: 'rebased', error: null,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.match(runner.requests[1]?.invocation.input ?? '', /Head: feature at head456/);
    runner.resolvers[1]?.({
      status: 'succeeded', exitCode: 0, nativeSessionId: 'rd-session', finalMessage: 'rebased again', error: null,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    manager.close();
  }
});

test('scheduled PR triggers can be stopped independently while sharing one poller', async () => {
  const pendingCheck = {
    key: 'CheckRun:CI:test:https://github.com/acme/repo/actions/runs/2',
    name: 'test',
    workflow: 'CI',
    status: 'IN_PROGRESS',
    conclusion: null,
    url: 'https://github.com/acme/repo/actions/runs/2',
    completedAt: null,
  };
  const baseline: GitHubPullRequestSnapshot = {
    status: 'open',
    title: 'Feature',
    url: 'https://github.com/acme/repo/pull/10',
    baseBranch: 'main',
    headBranch: 'feature',
    headSha: 'head123',
    mergeable: 'MERGEABLE',
    updatedAt: '2099-01-01T00:00:00.000Z',
    reviewActivity: [],
    checks: [pendingCheck],
  };
  const failed: GitHubPullRequestSnapshot = {
    ...baseline,
    updatedAt: '2099-01-01T00:02:00.000Z',
    reviewActivity: [{
      kind: 'comment',
      id: 'comment-after-stop',
      author: 'reviewer',
      body: 'This comment trigger is stopped.',
      url: 'https://github.com/acme/repo/pull/10#issuecomment-1',
      createdAt: '2099-01-01T00:01:00.000Z',
      state: null,
      path: null,
      line: null,
    }],
    checks: [{
      ...pendingCheck,
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      completedAt: '2099-01-01T00:02:00.000Z',
    }],
  };
  const runner = new DeferredRunner();
  const githubClient = new SequenceGitHubClient([baseline, failed]);
  const manager = new AgentManager({
    workspaceRoot: process.cwd(),
    store: new SqliteAgentManagerStore(':memory:'),
    runner,
    githubClient,
    logger: silentLogger,
  });
  try {
    const requirement = manager.createRequirement({ title: 'Independent triggers', description: 'Open a PR', provider: 'codex' });
    manager.trackPullRequest({
      requirementId: requirement.id,
      repository: 'acme/repo',
      number: 10,
      url: baseline.url,
      title: baseline.title,
      baseBranch: baseline.baseBranch,
      headBranch: baseline.headBranch,
      headSha: baseline.headSha,
      status: baseline.status,
    });

    manager.startPullRequestReconciler(60_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(githubClient.inspectionCount, 1);
    manager.stopAgentTrigger(PULL_REQUEST_COMMENT_TRIGGER_ID);
    await manager.reconcilePullRequests();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(githubClient.inspectionCount, 2);
    assert.equal(manager.listMessages(requirement.id).length, 1);
    assert.equal(manager.listEvents().find((item) => item.type === 'message.created')?.payload.triggerId,
      PULL_REQUEST_CI_FAILURE_TRIGGER_ID);

    runner.resolvers[0]?.({
      status: 'succeeded', exitCode: 0, nativeSessionId: 'rd-session', finalMessage: 'fixed', error: null,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    manager.close();
  }
});

test('mixed-case PR registration preserves identity, lifecycle, and Requirement ownership', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-pr-owner-'));
  const databasePath = join(directory, 'store.sqlite');
  const manager = new AgentManager({
    workspaceRoot: process.cwd(), store: new SqliteAgentManagerStore(databasePath), logger: silentLogger,
  });
  try {
    const owner = manager.createRequirement({ title: 'Owner', description: 'Task', provider: 'codex' });
    const other = manager.createRequirement({ title: 'Other', description: 'Task', provider: 'codex' });
    const initial = manager.registerAgentPullRequest({
      requirementId: owner.id, repository: 'Acme/Widgets', number: 184,
      url: 'https://github.com/Acme/Widgets/pull/184', title: 'Feature',
      baseBranch: 'main', headBranch: 'feature', headSha: 'abc123', status: 'open',
    });
    assert.equal(initial.repository, 'acme/widgets');
    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.prepare('UPDATE pull_requests SET repository = ? WHERE id = ?').run('Acme/Widgets', initial.id);
    } finally {
      legacy.close();
    }
    assert.throws(() => manager.registerAgentPullRequest({
      ...initial, requirementId: other.id, repository: 'ACME/widgets',
    }), /already belongs to requirement/);
    const updated = manager.registerAgentPullRequest({
      ...initial, repository: 'ACME/widgets', headSha: 'def456', status: 'merged',
    });
    assert.equal(updated.id, initial.id);
    assert.equal(updated.status, 'open');
    assert.equal(updated.headSha, 'def456');
    assert.throws(() => manager.registerAgentPullRequest({
      ...updated, requirementId: other.id, repository: 'acme/WIDGETS',
    }), /already belongs to requirement/);
    assert.equal(manager.listPullRequests().length, 1);
    assert.equal(manager.listPullRequests()[0]?.requirementId, owner.id);
    const reconciled = manager.trackPullRequest({ ...updated, repository: 'ACME/WIDGETS', status: 'merged' });
    assert.equal(reconciled.id, initial.id);
    assert.equal(reconciled.status, 'merged');
    assert.equal(manager.listEvents().filter((event) => event.type === 'pull_request.created').length, 1);
  } finally {
    manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
