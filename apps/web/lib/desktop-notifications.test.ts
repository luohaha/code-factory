import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentRunDto, ManagerEventDto, RequirementDto } from './agent-manager-client.ts';
import {
  desktopNotificationsEnabled,
  takeFinishedRdRun,
  type FinishedRunStatus,
} from './desktop-notifications.ts';

void test('enables desktop notifications by default and preserves an explicit opt-out', () => {
  assert.equal(desktopNotificationsEnabled(null), true);
  assert.equal(desktopNotificationsEnabled('on'), true);
  assert.equal(desktopNotificationsEnabled('off'), false);
});

function finishedEvent(status: FinishedRunStatus): ManagerEventDto {
  return {
    id: 42,
    type: `run.${status}`,
    requirementId: 'req-one',
    sessionId: 'ses-one',
    runId: 'run-one',
    createdAt: '2026-09-23T09:00:00.000Z',
    payload: {
      requirement: {
        id: 'req-one',
        title: 'Ship the feature',
      } as RequirementDto,
      run: {
        id: 'run-one',
        requirementId: 'req-one',
        role: 'rd',
        status,
      } as AgentRunDto,
    },
  };
}

void test('selects each finished RD outcome once, including an SSE replay', () => {
  for (const status of ['succeeded', 'failed', 'timed_out', 'cancelled'] as const) {
    const seen = new Set<string>();
    const event = finishedEvent(status);
    assert.deepEqual(takeFinishedRdRun(event, seen), {
      runId: 'run-one',
      requirementId: 'req-one',
      requirementTitle: 'Ship the feature',
      status,
    });
    assert.equal(takeFinishedRdRun(event, seen), null);
  }
});

void test('ignores Reviewer outcomes, in-progress runs, and inconsistent event ownership', () => {
  const seen = new Set<string>();
  const event = finishedEvent('succeeded');
  assert.equal(takeFinishedRdRun({ ...event, type: 'run.started' }, seen), null);
  assert.equal(takeFinishedRdRun({ ...event, payload: {
    ...event.payload,
    run: { ...event.payload.run!, role: 'reviewer' },
  } }, seen), null);
  assert.equal(takeFinishedRdRun({ ...event, requirementId: 'req-other' }, seen), null);
  assert.equal(takeFinishedRdRun({ ...event, runId: 'run-other' }, seen), null);
  assert.equal(takeFinishedRdRun({ ...event, payload: {
    ...event.payload,
    requirement: { ...event.payload.requirement!, id: 'req-other' },
  } }, seen), null);
  assert.equal(takeFinishedRdRun({ ...event, payload: {
    ...event.payload,
    run: { ...event.payload.run!, status: 'failed' },
  } }, seen), null);
  assert.equal(seen.size, 0);
});
