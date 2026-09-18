import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentTriggerMessage } from '../src/agent-trigger.ts';
import { silentLogger } from '../src/logger.ts';
import { SqliteAgentManagerStore } from '../src/sqlite-store.ts';
import { TimerAgentTrigger } from '../src/timer-agent-trigger.ts';

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for scheduled trigger');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function createRequirement(store: SqliteAgentManagerStore): void {
  store.createRequirement({
    requirementId: 'req-scheduled',
    sessionId: 'ses-scheduled',
    title: 'Wait for a build',
    description: 'Wake the Agent when it may be complete',
    provider: 'codex',
    createdBy: 'human',
    now: new Date().toISOString(),
  });
}

test('one-time Agent Timer delivers its identity and description, then completes', async () => {
  const store = new SqliteAgentManagerStore(':memory:');
  const messages: AgentTriggerMessage[] = [];
  const fired: string[] = [];
  createRequirement(store);
  const scheduledFor = new Date(Date.now() - 1_000).toISOString();
  store.createAgentTimer({
    id: 'tmr-once',
    requirementId: 'req-scheduled',
    description: 'Check compiler status',
    schedule: 'once',
    intervalSeconds: 60,
    nextFireAt: scheduledFor,
    now: scheduledFor,
  });
  const trigger = new TimerAgentTrigger({
    store,
    logger: silentLogger,
    onFired: (item) => fired.push(item.id),
  });
  try {
    trigger.start({
      deliver: (message) => {
        messages.push(message);
        return null;
      },
    });
    await waitFor(() => messages.length === 1);

    assert.match(messages[0]?.body ?? '', /^Timer fired\./);
    assert.match(messages[0]?.body ?? '', /Timer ID: tmr-once/);
    assert.match(messages[0]?.body ?? '', /Description: Check compiler status/);
    assert.equal(messages[0]?.author, 'system');
    assert.equal(messages[0]?.idempotencyKey, `tmr-once:${scheduledFor}`);
    assert.equal(messages[0]?.metadata.timerId, 'tmr-once');
    assert.deepEqual(fired, ['tmr-once']);
    const persisted = store.getAgentTimer('tmr-once');
    assert.equal(persisted?.status, 'completed');
    assert.equal(persisted?.nextFireAt, null);
  } finally {
    trigger.stop();
    store.close();
  }
});

test('recurring Agent Timer skips missed intervals and tells the Agent how to cancel it', async () => {
  const store = new SqliteAgentManagerStore(':memory:');
  let deliveryCount = 0;
  createRequirement(store);
  const scheduledFor = new Date(Date.now() - 5 * 60_000).toISOString();
  store.createAgentTimer({
    id: 'tmr-recurring',
    requirementId: 'req-scheduled',
    description: 'Check compiler status',
    schedule: 'recurring',
    intervalSeconds: 60,
    nextFireAt: scheduledFor,
    now: scheduledFor,
  });
  const messages: AgentTriggerMessage[] = [];
  const trigger = new TimerAgentTrigger({ store, logger: silentLogger });
  try {
    trigger.start({
      deliver: (message) => {
        messages.push(message);
        deliveryCount += 1;
        return null;
      },
    });
    await waitFor(() => deliveryCount === 1);

    const persisted = store.getAgentTimer('tmr-recurring');
    assert.equal(persisted?.status, 'active');
    assert.ok(Date.parse(persisted?.nextFireAt ?? '') > Date.now());
    assert.ok(Date.parse(persisted?.nextFireAt ?? '') <= Date.now() + 60_000);
    assert.equal(deliveryCount, 1);
    assert.match(messages[0]?.body ?? '', /code-factory-cli timer cancel --id tmr-recurring/);
  } finally {
    trigger.stop();
    store.close();
  }
});
