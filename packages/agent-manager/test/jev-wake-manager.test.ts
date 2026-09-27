import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentManager } from '../src/agent-manager.ts';
import type { JevWakeDecision } from '../src/jev-wake-decision.ts';
import { silentLogger } from '../src/logger.ts';
import type { AgentProcessRunner, ProcessRunRequest } from '../src/process-runner.ts';
import { SqliteAgentManagerStore } from '../src/sqlite-store.ts';

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

test('Jev key updates dynamically, remains redacted, and immediate choice resumes with continue.', async () => {
  const runner = new ReplyRunner();
  const calls: string[][] = [];
  const manager = new AgentManager({
    workspaceRoot: process.cwd(), store: new SqliteAgentManagerStore(':memory:'),
    runner, logger: silentLogger,
    jevWakeDecision: async (key, context): Promise<JevWakeDecision> => {
      assert.equal(key, 'secret');
      assert.equal(context.requirement.title, 'Continue');
      assert.equal(context.requirement.description, 'Work');
      calls.push(context.recentReplies);
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
    assert.deepEqual(calls, [['Still working.'], ['Still working.', 'Still working.']]);
    assert.equal(runner.requests.length, 3);
    assert.deepEqual(manager.listMessages(requirement.id).map((message) => message.body), [
      'Still working.', 'continue.', 'Still working.',
    ]);
    assert.match(runner.requests[2]?.invocation.input ?? '', /continue\./);

    const cleared = manager.updateConfiguration({ jevApiKey: null });
    assert.equal(cleared.jevApiKeyConfigured, false);
    const disabled = manager.createRequirement({ title: 'Disabled', description: 'Work', provider: 'codex' });
    await manager.runRequirement(disabled.id);
    assert.equal(calls.length, 2);
  } finally {
    await manager.close();
  }
});

test('Jev receives only the latest three replies from this Requirement RD Agent', async () => {
  const store = new SqliteAgentManagerStore(':memory:');
  const runner = new ReplyRunner(['First reply', 'Second reply', 'Third reply', 'Fourth reply']);
  const seen: string[][] = [];
  const manager = new AgentManager({
    workspaceRoot: process.cwd(), store, runner, logger: silentLogger,
    jevWakeDecision: async (_key, context) => {
      seen.push(context.recentReplies);
      return { kind: 'wait' };
    },
  });
  try {
    const requirement = manager.createRequirement({ title: 'Long task', description: 'Work', provider: 'codex' });
    for (let index = 0; index < 3; index += 1) await manager.runRequirement(requirement.id);
    const source = manager.createRequirement({ title: 'Related task', description: 'Work', provider: 'codex' });
    store.appendMessage({
      id: 'msg-related-agent', requirementId: requirement.id, sessionId: requirement.session.id,
      sourceRequirementId: source.id, author: 'rd_agent', body: 'Another agent reply',
      deliverToRd: false, now: new Date().toISOString(),
    });
    manager.updateConfiguration({ jevApiKey: 'secret' });
    await manager.runRequirement(requirement.id);
    assert.deepEqual(seen, [['Second reply', 'Third reply', 'Fourth reply']]);
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
  const seen: string[][] = [];
  const manager = new AgentManager({
    workspaceRoot: process.cwd(), store: new SqliteAgentManagerStore(':memory:'),
    runner, logger: silentLogger,
    jevWakeDecision: async (_key, context) => {
      seen.push(context.recentReplies);
      return { kind: 'wait' };
    },
  });
  try {
    const requirement = manager.createRequirement({ title: 'No event', description: 'Work', provider: 'codex' });
    await manager.runRequirement(requirement.id);
    manager.updateConfiguration({ jevApiKey: 'secret' });
    await manager.runRequirement(requirement.id);
    assert.deepEqual(seen, [['Earlier reply', 'Final reply without event']]);
  } finally {
    await manager.close();
  }
});

test('Jev delay creates a one-time timer; existing timers and errors preserve waiting', async () => {
  const runner = new ReplyRunner();
  let decision: JevWakeDecision | Error = { kind: 'delayed', minutes: 10 };
  let calls = 0;
  const manager = new AgentManager({
    workspaceRoot: process.cwd(), store: new SqliteAgentManagerStore(':memory:'),
    runner, logger: silentLogger,
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
  } finally {
    await manager.close();
  }
});

test('Jev ignores a stale decision after a human reply starts a newer Run', async () => {
  const runner = new ReplyRunner();
  let finishDecision: ((choice: JevWakeDecision) => void) | undefined;
  let calls = 0;
  const manager = new AgentManager({
    workspaceRoot: process.cwd(), store: new SqliteAgentManagerStore(':memory:'),
    runner, logger: silentLogger,
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
    manager.postHumanMessage(requirement.id, 'Please change the approach.');
    await new Promise<void>((resolve) => setImmediate(resolve));
    finishDecision?.({ kind: 'immediate' });
    await first;
    assert.equal(runner.requests.length, 2);
    assert.equal(manager.listMessages(requirement.id).some((message) => message.body === 'continue.'), false);
  } finally {
    await manager.close();
  }
});
