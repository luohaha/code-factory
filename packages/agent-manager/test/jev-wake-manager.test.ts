import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentManager } from '../src/agent-manager.ts';
import type { JevWakeDecision } from '../src/jev-wake-decision.ts';
import { createLogger, silentLogger, type LogWriter } from '../src/logger.ts';
import type { AgentProcessRunner, ProcessRunRequest } from '../src/process-runner.ts';
import { SqliteAgentManagerStore } from '../src/sqlite-store.ts';
import type { MessageAuthor } from '../src/types.ts';

type SeenMessage = { author: MessageAuthor; body: string };

class MemoryWriter implements LogWriter {
  readonly lines: string[] = [];

  write(value: string): void {
    this.lines.push(value);
  }
}

class ReplyRunner implements AgentProcessRunner {
  readonly requests: ProcessRunRequest[] = [];
  readonly #replies: string[];

  constructor(replies: string[] = []) {
    this.#replies = replies;
  }

  async run(request: ProcessRunRequest) {
    this.requests.push(request);
    const reply = this.#replies[this.requests.length - 1] ?? 'Still working.';
    request.onEvent?.({ kind: 'message', message: reply, raw: {} });
    return {
      status: 'succeeded' as const,
      exitCode: 0,
      nativeSessionId: 'thread-1',
      finalMessage: reply,
      error: null,
    };
  }
}

test('Jev logs precondition skips and every decision kind without sensitive decision input', async () => {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const decisions: JevWakeDecision[] = [
    { kind: 'wait' },
    { kind: 'delayed', minutes: 10 },
    { kind: 'immediate' },
    { kind: 'wait' },
  ];
  const manager = new AgentManager({
    workspaceRoot: process.cwd(), store: new SqliteAgentManagerStore(':memory:'),
    runner: new ReplyRunner(), logger: createLogger({ level: 'info', stdout, stderr }),
    jevWakeDecision: async () => decisions.shift() ?? { kind: 'wait' },
  });
  try {
    const unconfigured = manager.createRequirement({
      title: 'No Jev', description: 'private unconfigured description', provider: 'codex',
    });
    await manager.runRequirement(unconfigured.id);

    manager.updateConfiguration({ jevApiKey: 'private-jev-key' });
    const waiting = manager.createRequirement({
      title: 'Wait', description: 'private waiting description', provider: 'codex',
    });
    await manager.runRequirement(waiting.id);

    const delayed = manager.createRequirement({
      title: 'Delay', description: 'private delayed description', provider: 'codex',
    });
    await manager.runRequirement(delayed.id);

    const withTimer = manager.createRequirement({
      title: 'Timer', description: 'private timer description', provider: 'codex',
    });
    manager.createAgentTimer(withTimer.id, {
      description: 'private timer contents', schedule: 'once', intervalSeconds: 60,
    });
    await manager.runRequirement(withTimer.id);

    const immediate = manager.createRequirement({
      title: 'Immediate', description: 'private immediate description', provider: 'codex',
    });
    await manager.runRequirement(immediate.id);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const entries = [...stdout.lines, ...stderr.lines]
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const jevEntries = entries.filter((entry) => String(entry.message).startsWith('Jev wake decision'));
    assert.ok(jevEntries.every((entry) => typeof entry.requirementId === 'string'
      && typeof entry.runId === 'string' && typeof entry.stage === 'string'));

    assert.ok(jevEntries.some((entry) => entry.requirementId === unconfigured.id
      && entry.stage === 'precondition' && entry.skipReason === 'api_key_missing'));
    assert.ok(jevEntries.some((entry) => entry.requirementId === withTimer.id
      && entry.stage === 'precondition' && entry.skipReason === 'active_timer'));
    assert.ok(jevEntries.some((entry) => entry.requirementId === waiting.id
      && entry.stage === 'decision' && entry.decision === 'wait'));
    assert.ok(jevEntries.some((entry) => entry.requirementId === delayed.id
      && entry.stage === 'decision' && entry.decision === 'delayed' && entry.minutes === 10));
    assert.ok(jevEntries.some((entry) => entry.requirementId === delayed.id
      && entry.stage === 'application' && entry.decision === 'delayed'));
    assert.ok(jevEntries.some((entry) => entry.requirementId === immediate.id
      && entry.stage === 'decision' && entry.decision === 'immediate'));
    assert.ok(jevEntries.some((entry) => entry.requirementId === immediate.id
      && entry.stage === 'application' && entry.decision === 'immediate'));

    const serializedEntries = JSON.stringify(entries);
    assert.doesNotMatch(serializedEntries, /private-jev-key|private .* description|private timer contents|Still working\./);
  } finally {
    await manager.close();
  }
});

test('Jev key updates dynamically, remains redacted, and immediate choice resumes with continue.', async () => {
  const runner = new ReplyRunner();
  const calls: SeenMessage[][] = [];
  const manager = new AgentManager({
    workspaceRoot: process.cwd(), store: new SqliteAgentManagerStore(':memory:'),
    runner, logger: silentLogger,
    jevWakeDecision: async (key, context): Promise<JevWakeDecision> => {
      assert.equal(key, 'secret');
      assert.equal(context.requirement.title, 'Continue');
      assert.equal(context.requirement.description, 'Work');
      calls.push(context.recentMessages);
      return calls.length === 1 ? { kind: 'immediate' } : { kind: 'wait' };
    },
  });
  try {
    const unconfigured = manager.createRequirement({ title: 'No Jev', description: 'Work', provider: 'codex' });
    await manager.runRequirement(unconfigured.id);
    assert.equal(calls.length, 0);

    const snapshot = manager.updateConfiguration({ jevApiKey: ' secret ' });
    assert.equal(snapshot.jevApiKeyConfigured, true);
    assert.equal(snapshot.values.jevApiKey, null);
    assert.equal(snapshot.restartRequired, false);
    assert.equal(JSON.stringify(manager.listEvents()).includes('secret'), false);

    const requirement = manager.createRequirement({ title: 'Continue', description: 'Work', provider: 'codex' });
    await manager.runRequirement(requirement.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls, [
      [{ author: 'rd_agent', body: 'Still working.' }],
      [
        { author: 'rd_agent', body: 'Still working.' },
        { author: 'jev', body: 'continue.' },
        { author: 'rd_agent', body: 'Still working.' },
      ],
    ]);
    assert.equal(runner.requests.length, 3);
    assert.deepEqual(manager.listMessages(requirement.id).map((message) => message.body), [
      'Still working.', 'continue.', 'Still working.',
    ]);
    assert.deepEqual(manager.listMessages(requirement.id).map((message) => message.author),
      ['rd_agent', 'jev', 'rd_agent']);
    assert.match(runner.requests[2]?.invocation.input ?? '', /\[Jev #2\]\ncontinue\./);
    assert.doesNotMatch(runner.requests[2]?.invocation.input ?? '', /\[System #2\]/);

    const cleared = manager.updateConfiguration({ jevApiKey: null });
    assert.equal(cleared.jevApiKeyConfigured, false);
    const disabled = manager.createRequirement({ title: 'Disabled', description: 'Work', provider: 'codex' });
    await manager.runRequirement(disabled.id);
    assert.equal(calls.length, 2);
  } finally {
    await manager.close();
  }
});

test('Jev receives the latest three conversation messages with authors', async () => {
  const store = new SqliteAgentManagerStore(':memory:');
  const runner = new ReplyRunner(['First reply', 'Second reply', 'Third reply', 'Fourth reply']);
  const seen: SeenMessage[][] = [];
  const manager = new AgentManager({
    workspaceRoot: process.cwd(), store, runner, logger: silentLogger,
    jevWakeDecision: async (_key, context) => {
      seen.push(context.recentMessages);
      return { kind: 'wait' };
    },
  });
  try {
    const requirement = manager.createRequirement({ title: 'Long task', description: 'Work', provider: 'codex' });
    for (let index = 0; index < 3; index += 1) await manager.runRequirement(requirement.id);
    store.appendMessage({
      id: 'msg-system', requirementId: requirement.id, sessionId: requirement.session.id,
      author: 'system', body: 'CI passed',
      deliverToRd: false, now: new Date().toISOString(),
    });
    store.appendMessage({
      id: 'msg-human', requirementId: requirement.id, sessionId: requirement.session.id,
      author: 'human', body: 'Please finish the summary',
      deliverToRd: false, now: new Date().toISOString(),
    });
    manager.updateConfiguration({ jevApiKey: 'secret' });
    await manager.runRequirement(requirement.id);
    assert.deepEqual(seen, [[
      { author: 'system', body: 'CI passed' },
      { author: 'human', body: 'Please finish the summary' },
      { author: 'rd_agent', body: 'Fourth reply' },
    ]]);
  } finally {
    await manager.close();
  }
});

test('Jev includes the current final reply when the provider emitted no message event', async () => {
  let runNumber = 0;
  const runner: AgentProcessRunner = {
    async run(request) {
      runNumber += 1;
      if (runNumber === 1) request.onEvent?.({ kind: 'message', message: 'Earlier reply', raw: {} });
      return {
        status: 'succeeded' as const, exitCode: 0, nativeSessionId: 'thread-1',
        finalMessage: runNumber === 1 ? 'Earlier reply' : 'Final reply without event', error: null,
      };
    },
  };
  const seen: SeenMessage[][] = [];
  const manager = new AgentManager({
    workspaceRoot: process.cwd(), store: new SqliteAgentManagerStore(':memory:'),
    runner, logger: silentLogger,
    jevWakeDecision: async (_key, context) => {
      seen.push(context.recentMessages);
      return { kind: 'wait' };
    },
  });
  try {
    const requirement = manager.createRequirement({ title: 'No event', description: 'Work', provider: 'codex' });
    await manager.runRequirement(requirement.id);
    manager.updateConfiguration({ jevApiKey: 'secret' });
    await manager.runRequirement(requirement.id);
    assert.deepEqual(seen, [[
      { author: 'rd_agent', body: 'Earlier reply' },
      { author: 'rd_agent', body: 'Final reply without event' },
    ]]);
  } finally {
    await manager.close();
  }
});

test('Jev delay creates a one-time timer; existing timers and errors preserve waiting', async () => {
  const runner = new ReplyRunner();
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  let decision: JevWakeDecision | Error = { kind: 'delayed', minutes: 10 };
  let calls = 0;
  const manager = new AgentManager({
    workspaceRoot: process.cwd(), store: new SqliteAgentManagerStore(':memory:'),
    runner, logger: createLogger({ level: 'info', stdout, stderr }),
    jevWakeDecision: async () => {
      calls += 1;
      if (decision instanceof Error) throw decision;
      return decision;
    },
  });
  try {
    manager.updateConfiguration({ jevApiKey: 'secret' });
    const delayed = manager.createRequirement({ title: 'Delay', description: 'Work', provider: 'codex' });
    await manager.runRequirement(delayed.id);
    const timers = manager.listAgentTimers(delayed.id);
    assert.equal(timers.length, 1);
    assert.equal(timers[0]?.schedule, 'once');
    assert.equal(timers[0]?.intervalSeconds, 600);
    assert.equal(timers[0]?.description, 'continue.');
    assert.equal(timers[0]?.messageAuthor, 'jev');
    assert.equal(delayed.session.pendingMessageCount, 0);

    const agentTimer = manager.createRequirement({ title: 'Has timer', description: 'Work', provider: 'codex' });
    manager.createAgentTimer(agentTimer.id, { description: 'Check deployment', schedule: 'once', intervalSeconds: 60 });
    await manager.runRequirement(agentTimer.id);
    assert.equal(calls, 1);
    assert.equal(manager.listAgentTimers(agentTimer.id).length, 1);

    decision = new Error('API unavailable');
    const failed = manager.createRequirement({ title: 'Jev unavailable', description: 'Work', provider: 'codex' });
    const result = await manager.runRequirement(failed.id);
    assert.equal(result.status, 'waiting_confirmation');
    assert.equal(manager.listAgentTimers(failed.id).length, 0);
    assert.equal(calls, 2);
    const requestFailure = stderr.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.requirementId === failed.id && entry.message === 'Jev wake decision skipped');
    assert.equal(requestFailure?.runId, manager.listRuns(failed.id)[0]?.id);
    assert.equal(requestFailure?.stage, 'request');
    assert.equal(requestFailure?.skipReason, 'request_failed');
    assert.equal(requestFailure?.error, 'Error');
    assert.doesNotMatch(JSON.stringify([...stdout.lines, ...stderr.lines]), /API unavailable/);
  } finally {
    await manager.close();
  }
});

test('Jev ignores a stale decision after a human reply starts a newer Run', async () => {
  const runner = new ReplyRunner();
  const stdout = new MemoryWriter();
  let finishDecision: ((choice: JevWakeDecision) => void) | undefined;
  let calls = 0;
  const manager = new AgentManager({
    workspaceRoot: process.cwd(), store: new SqliteAgentManagerStore(':memory:'),
    runner, logger: createLogger({ level: 'info', stdout, stderr: new MemoryWriter() }),
    jevWakeDecision: async () => {
      calls += 1;
      return calls === 1
        ? new Promise<JevWakeDecision>((resolve) => { finishDecision = resolve; })
        : { kind: 'wait' };
    },
  });
  try {
    manager.updateConfiguration({ jevApiKey: 'secret' });
    const requirement = manager.createRequirement({ title: 'Human reply', description: 'Work', provider: 'codex' });
    const first = manager.runRequirement(requirement.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const firstRunId = manager.listRuns(requirement.id)[0]?.id;
    manager.postHumanMessage(requirement.id, 'Please change the approach.');
    await new Promise<void>((resolve) => setImmediate(resolve));
    finishDecision?.({ kind: 'immediate' });
    await first;
    assert.equal(runner.requests.length, 2);
    assert.equal(manager.listMessages(requirement.id).some((message) => message.body === 'continue.'), false);
    const revalidationSkip = stdout.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.message === 'Jev wake decision skipped' && entry.runId === firstRunId);
    assert.equal(revalidationSkip?.requirementId, requirement.id);
    assert.equal(revalidationSkip?.stage, 'revalidation');
    assert.equal(revalidationSkip?.decision, 'immediate');
    assert.equal(revalidationSkip?.skipReason, 'latest_rd_run_changed');
  } finally {
    await manager.close();
  }
});

test('Jev does not wake RD while Reviewer feedback is still running', async () => {
  let finishDecision: ((choice: JevWakeDecision) => void) | undefined;
  let finishReview: (() => void) | undefined;
  let decisions = 0;
  const requests: ProcessRunRequest[] = [];
  const runner: AgentProcessRunner = {
    async run(request) {
      requests.push(request);
      if (request.invocation.input.startsWith('Review GitHub PR')) {
        return new Promise((resolve) => { finishReview = () => resolve({
          status: 'succeeded', exitCode: 0, nativeSessionId: null,
          finalMessage: 'Review complete', error: null,
        }); });
      }
      request.onEvent?.({ kind: 'message', message: 'RD progress', raw: {} });
      return { status: 'succeeded', exitCode: 0, nativeSessionId: 'thread-1',
        finalMessage: 'RD progress', error: null };
    },
  };
  const manager = new AgentManager({
    workspaceRoot: process.cwd(), store: new SqliteAgentManagerStore(':memory:'),
    runner, logger: silentLogger,
    jevWakeDecision: async () => {
      decisions += 1;
      return decisions === 1
        ? new Promise<JevWakeDecision>((resolve) => { finishDecision = resolve; })
        : { kind: 'wait' };
    },
  });
  try {
    manager.updateConfiguration({ jevApiKey: 'secret' });
    const requirement = manager.createRequirement({ title: 'Review race', description: 'Work', provider: 'codex' });
    const pullRequest = manager.trackPullRequest({
      requirementId: requirement.id, repository: 'acme/repo', number: 77,
      url: 'https://github.com/acme/repo/pull/77', title: 'Review race',
      baseBranch: 'main', headBranch: 'review-race', headSha: 'abc123', status: 'open',
    });
    const firstRun = manager.runRequirement(requirement.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(decisions, 1);

    const review = manager.requestReview(pullRequest.id, { provider: 'codex' });
    assert.equal(requests.length, 2);
    finishDecision?.({ kind: 'immediate' });
    await firstRun;
    assert.equal(manager.listMessages(requirement.id).some((message) => message.author === 'jev'), false);
    assert.equal(manager.listAgentTimers(requirement.id).length, 0);
    assert.equal(requests.length, 2);

    finishReview?.();
    await review;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 3);
    assert.equal(manager.listMessages(requirement.id).some((message) => message.author === 'reviewer'), true);
    assert.equal(manager.listMessages(requirement.id).some((message) => message.author === 'jev'), false);
    assert.equal(decisions, 2);
  } finally {
    finishDecision?.({ kind: 'wait' });
    finishReview?.();
    await manager.close();
  }
});

test('Jev skips its request when Reviewer is already running', async () => {
  let finishReview: (() => void) | undefined;
  let decisions = 0;
  const runner: AgentProcessRunner = {
    async run(request) {
      if (request.invocation.input.startsWith('Review GitHub PR')) {
        return new Promise((resolve) => { finishReview = () => resolve({
          status: 'succeeded', exitCode: 0, nativeSessionId: null,
          finalMessage: 'Review complete', error: null,
        }); });
      }
      request.onEvent?.({ kind: 'message', message: 'RD progress', raw: {} });
      return { status: 'succeeded', exitCode: 0, nativeSessionId: 'thread-1',
        finalMessage: 'RD progress', error: null };
    },
  };
  const manager = new AgentManager({
    workspaceRoot: process.cwd(), store: new SqliteAgentManagerStore(':memory:'),
    runner, logger: silentLogger, jevWakeDecision: async () => { decisions += 1; return { kind: 'wait' }; },
  });
  try {
    manager.updateConfiguration({ jevApiKey: 'secret' });
    const requirement = manager.createRequirement({ title: 'Active review', description: 'Work', provider: 'codex' });
    const pullRequest = manager.trackPullRequest({
      requirementId: requirement.id, repository: 'acme/repo', number: 78,
      url: 'https://github.com/acme/repo/pull/78', title: 'Active review',
      baseBranch: 'main', headBranch: 'active-review', headSha: 'abc123', status: 'open',
    });
    const review = manager.requestReview(pullRequest.id, { provider: 'codex' });
    await manager.runRequirement(requirement.id);
    assert.equal(decisions, 0);
    assert.equal(manager.listMessages(requirement.id).some((message) => message.author === 'jev'), false);
    finishReview?.();
    await review;
    manager.updateConfiguration({ jevApiKey: null });
  } finally {
    finishReview?.();
    await manager.close();
  }
});

test('closing during a pending Jev decision ignores late answers without reading the closed store', async () => {
  const answers: JevWakeDecision[] = [
    { kind: 'wait' }, { kind: 'immediate' }, { kind: 'delayed', minutes: 1 },
  ];
  for (const answer of answers) {
    const runner = new ReplyRunner();
    let finishDecision: ((choice: JevWakeDecision) => void) | undefined;
    let decisionSignal: AbortSignal | undefined;
    const manager = new AgentManager({
      workspaceRoot: process.cwd(), store: new SqliteAgentManagerStore(':memory:'),
      runner, logger: silentLogger,
      jevWakeDecision: async (_key, _context, signal) => {
        decisionSignal = signal;
        return new Promise<JevWakeDecision>((resolve) => { finishDecision = resolve; });
      },
    });
    try {
      manager.updateConfiguration({ jevApiKey: 'secret' });
      const requirement = manager.createRequirement({ title: 'Close during Jev', description: 'Work', provider: 'codex' });
      const run = manager.runRequirement(requirement.id);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(decisionSignal?.aborted, false);
      await manager.close();
      assert.equal(decisionSignal?.aborted, true);
      finishDecision?.(answer);
      assert.equal((await run).status, 'waiting_confirmation');
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(runner.requests.length, 1);
    } finally {
      finishDecision?.({ kind: 'wait' });
      await manager.close();
    }
  }
});
