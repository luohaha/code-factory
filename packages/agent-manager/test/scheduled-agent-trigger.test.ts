import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentTriggerMessage } from '../src/agent-trigger.ts';
import { silentLogger } from '../src/logger.ts';
import {
  SCHEDULED_CONTINUE_MESSAGE,
  ScheduledContinueTrigger,
} from '../src/scheduled-agent-trigger.ts';
import { SqliteAgentManagerStore } from '../src/sqlite-store.ts';

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

test('one-time Scheduled Agent Trigger delivers continue and completes', async () => {
  const store = new SqliteAgentManagerStore(':memory:');
  const messages: AgentTriggerMessage[] = [];
  const fired: string[] = [];
  createRequirement(store);
  const scheduledFor = new Date(Date.now() - 1_000).toISOString();
  store.createScheduledAgentTrigger({
    id: 'sat-once',
    requirementId: 'req-scheduled',
    schedule: 'once',
    intervalSeconds: 60,
    nextFireAt: scheduledFor,
    now: scheduledFor,
  });
  const trigger = new ScheduledContinueTrigger({
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

    assert.equal(messages[0]?.body, SCHEDULED_CONTINUE_MESSAGE);
    assert.equal(messages[0]?.author, 'system');
    assert.equal(messages[0]?.idempotencyKey, `sat-once:${scheduledFor}`);
    assert.deepEqual(fired, ['sat-once']);
    const persisted = store.getScheduledAgentTrigger('sat-once');
    assert.equal(persisted?.status, 'completed');
    assert.equal(persisted?.nextFireAt, null);
  } finally {
    trigger.stop();
    store.close();
  }
});

test('recurring Scheduled Agent Trigger skips missed intervals instead of replaying a backlog', async () => {
  const store = new SqliteAgentManagerStore(':memory:');
  let deliveryCount = 0;
  createRequirement(store);
  const scheduledFor = new Date(Date.now() - 5 * 60_000).toISOString();
  store.createScheduledAgentTrigger({
    id: 'sat-recurring',
    requirementId: 'req-scheduled',
    schedule: 'recurring',
    intervalSeconds: 60,
    nextFireAt: scheduledFor,
    now: scheduledFor,
  });
  const trigger = new ScheduledContinueTrigger({ store, logger: silentLogger });
  try {
    trigger.start({
      deliver: () => {
        deliveryCount += 1;
        return null;
      },
    });
    await waitFor(() => deliveryCount === 1);

    const persisted = store.getScheduledAgentTrigger('sat-recurring');
    assert.equal(persisted?.status, 'active');
    assert.ok(Date.parse(persisted?.nextFireAt ?? '') > Date.now());
    assert.ok(Date.parse(persisted?.nextFireAt ?? '') <= Date.now() + 60_000);
    assert.equal(deliveryCount, 1);
  } finally {
    trigger.stop();
    store.close();
  }
});
