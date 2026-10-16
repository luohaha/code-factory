import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentManager, type AgentManagerOptions } from '../src/agent-manager.ts';
import { DEFAULT_AGENT_MANAGER_CONFIGURATION } from '../src/configuration.ts';
import { JevMessageDeliveryError, type JevMessageContext, type JevMessageDecision } from '../src/jev-message-decision.ts';
import { createLogger, silentLogger } from '../src/logger.ts';
import type { ProcessRunRequest } from '../src/process-runner.ts';
import { SqliteAgentManagerStore } from '../src/sqlite-store.ts';

function fixture(decide: NonNullable<AgentManagerOptions['jevMessageDecision']>, options: Partial<AgentManagerOptions> = {}) {
  const requests: ProcessRunRequest[] = [];
  const manager = new AgentManager({
    workspaceRoot: process.cwd(), store: new SqliteAgentManagerStore(':memory:'),
    logger: silentLogger,
    configuration: { ...DEFAULT_AGENT_MANAGER_CONFIGURATION, jevApiKey: 'private-key' },
    jevWakeDecision: async () => ({ kind: 'wait' }), jevMessageDecision: decide,
    runner: { run: (request) => {
      requests.push(request);
      return new Promise((resolve) => {
        request.signal?.addEventListener('abort', () => resolve({
          status: 'cancelled', exitCode: null, nativeSessionId: null, finalMessage: null, error: 'Stopped',
        }), { once: true });
      });
    } },
    ...options,
  });
  const source = manager.createRequirement({ title: 'Source', description: 'Implement the contract', provider: 'codex' });
  const target = manager.createRequirement({ title: 'Target', description: 'Consume the contract', provider: 'claude-code' });
  const send = (body: string) => manager.postRequirementAgentMessage(source.id, source.session.id, target.id, body);
  return { manager, source, target, requests, send };
}

test('each direct message is checked; rejected messages never persist or wake either agent', async () => {
  const seen: JevMessageContext[] = [];
  const decisions: JevMessageDecision[] = ['reject', 'deliver', 'deliver'];
  const { manager, source, target, requests, send } = fixture(async (key, context) => {
    assert.equal(key, 'private-key');
    seen.push(context);
    return decisions.shift()!;
  });
  try {
    await assert.rejects(send('Thanks!'), (error: unknown) => {
      assert.ok(error instanceof JevMessageDeliveryError);
      assert.equal(error.code, 'jev_message_unnecessary');
      assert.match(error.message, /Jev rejected.*unnecessary.*not delivered/);
      return true;
    });
    assert.deepEqual(manager.listMessages(target.id), []);
    assert.deepEqual(manager.listMessages(source.id), []);
    assert.equal(manager.getRequirement(target.id)?.session.pendingMessageCount, 0);
    assert.equal(requests.length, 0);
    assert.equal(manager.listEvents().filter((event) => event.type === 'message.created').length, 0);

    const first = await send('Use contract version 2.');
    assert.equal(first.queued, false);
    assert.equal(first.message.sourceRequirementId, source.id);
    const second = await send('Version 2 also requires an id field.');
    assert.equal(second.queued, true);
    assert.equal(requests.length, 1);
    assert.equal(seen.length, 3);
    assert.equal(seen[0]?.sourceRequirement.description, source.description);
    assert.equal(seen[0]?.targetRequirement.description, target.description);
    assert.equal(seen[0]?.message, 'Thanks!');
    assert.deepEqual(seen[2]?.recentMessages, [{
      author: 'rd_agent', body: 'Use contract version 2.',
    }]);
    assert.deepEqual(manager.listMessages(target.id).map(({ body }) => body), [
      'Use contract version 2.', 'Version 2 also requires an id field.',
    ]);
  } finally {
    await manager.close();
  }
});

test('missing keys and failed checks silently allow normal delivery without leaking decision input in logs', async () => {
  let calls = 0;
  let failure: Error = new Error('private-message private-key');
  const lines: string[] = [];
  const writer = { write: (value: string) => { lines.push(value); } };
  const { manager, source, target, requests, send } = fixture(async () => {
    calls += 1;
    throw failure;
  }, {
    configuration: { ...DEFAULT_AGENT_MANAGER_CONFIGURATION, jevApiKey: null },
    logger: createLogger({ level: 'info', stdout: writer, stderr: writer }),
  });
  try {
    const unchecked = await send('private-message without a key');
    assert.equal(unchecked.queued, false);
    assert.deepEqual(Object.keys(unchecked).sort(), ['message', 'queued', 'requirement']);
    assert.equal(calls, 0);
    manager.updateConfiguration({ jevApiKey: 'private-key' });
    for (const error of [failure, new SyntaxError('private-message'), new DOMException('private-key', 'TimeoutError')]) {
      failure = error;
      const delivered = await send('private-message after a failed check');
      assert.equal(delivered.queued, true);
      assert.deepEqual(Object.keys(delivered).sort(), ['message', 'queued', 'requirement']);
    }
    assert.equal(calls, 3);
    assert.equal(manager.listMessages(target.id).length, 4);
    assert.deepEqual(manager.listMessages(source.id), []);
    assert.equal(requests.length, 1);
    assert.doesNotMatch(lines.join(''), /private-message|private-key/);
    manager.updateConfiguration({ jevApiKey: null });
    manager.postHumanMessage(target.id, 'Human input still works without a message check.');
    assert.equal(calls, 3);
    assert.equal(requests.length, 1);
  } finally {
    await manager.close();
  }
});

test('validation happens before Jev and target cancellation is rechecked before delivery', async () => {
  let finish!: (decision: JevMessageDecision) => void;
  let calls = 0;
  const { manager, source, target, requests, send } = fixture(async () => {
    calls += 1;
    return new Promise((resolve) => { finish = resolve; });
  });
  try {
    await assert.rejects(send('  '), /non-empty/);
    await assert.rejects(manager.postRequirementAgentMessage(source.id, target.session.id, target.id, 'Invalid sender'), /sourceSessionId/);
    await assert.rejects(manager.postRequirementAgentMessage(source.id, source.session.id, source.id, 'Self message'), /own Requirement/);
    assert.equal(calls, 0);
    const pending = send('Use version 2.');
    assert.equal(calls, 1);
    manager.deleteRequirement(target.id);
    finish('deliver');
    await assert.rejects(pending, /cancelled/);
    assert.deepEqual(manager.listMessages(target.id), []);
    assert.equal(requests.length, 0);
  } finally {
    await manager.close();
  }
});

test('delivery uses the current running state after the Jev check', async () => {
  let finish!: (decision: JevMessageDecision) => void;
  const { manager, target, requests, send } = fixture(async () => new Promise((resolve) => { finish = resolve; }));
  try {
    const pending = send('Use version 2.');
    manager.postHumanMessage(target.id, 'Start the consumer.');
    finish('deliver');
    const result = await pending;
    assert.equal(result.queued, true);
    assert.equal(requests.length, 1);
  } finally {
    await manager.close();
  }
});

test('configuration changes discard stale rejections and shutdown still cancels delivery', async () => {
  let finish!: (decision: JevMessageDecision) => void;
  let signal: AbortSignal | undefined;
  const { manager, target, requests, send } = fixture(async (_key, _context, currentSignal) => {
    signal = currentSignal;
    return new Promise((resolve) => { finish = resolve; });
  });
  try {
    const first = send('Use version 2.');
    manager.updateConfiguration({ jevApiKey: 'replacement-key' });
    finish('reject');
    assert.equal((await first).message.body, 'Use version 2.');
    assert.equal(manager.listMessages(target.id).length, 1);
    const second = send('Use version 3.');
    await manager.close();
    assert.equal(signal?.aborted, true);
    finish('deliver');
    await assert.rejects(second, /not delivered/);
    assert.equal(requests.length, 1);
  } finally {
    await manager.close();
  }
});
