import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentManager } from '../src/agent-manager.ts';
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

test('Agent Manager queues conversation messages during a Run and resumes without replaying RD output', async () => {
  const store = new SqliteAgentManagerStore(':memory:');
  const runner = new DeferredRunner();
  const manager = new AgentManager({ workspaceRoot: process.cwd(), store, runner });
  try {
    const first = manager.createRequirement({ title: 'First', description: 'First task', provider: 'codex' });
    const second = manager.createRequirement({ title: 'Second', description: 'Second task', provider: 'claude-code' });

    const firstExecution = manager.runRequirement(first.id);
    assert.equal(runner.requests[0]?.workspaceRoot, manager.workspaceRoot);
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

test('a human-requested PR review writes to the requirement conversation and wakes the RD session', async () => {
  const store = new SqliteAgentManagerStore(':memory:');
  const runner = new DeferredRunner();
  const manager = new AgentManager({ workspaceRoot: process.cwd(), store, runner });
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
    assert.match(runner.requests[0]?.invocation.input ?? '', /^\/review/);
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
