import assert from 'node:assert/strict';
import test from 'node:test';

import type { ManagerEventDto } from './agent-manager-client.ts';
import {
  applyRequirementScopedUpdate,
  mergeRefreshTargets,
  mergeVersionedSnapshot,
  refreshTargetsForManagerEvent,
  replaceRequirementRuns,
  upsertRequirement,
  upsertRun,
} from './dashboard-state.ts';

function managerEvent(
  type: string,
  payload: Record<string, unknown> = {},
  requirementId: string | null = 'requirement-1',
): ManagerEventDto {
  return {
    id: 1,
    type,
    requirementId,
    sessionId: requirementId ? 'session-1' : null,
    runId: null,
    payload,
    createdAt: '2026-09-18T04:00:00.000Z',
  };
}

void test('updates one Requirement without dropping unrelated dashboard state', () => {
  const requirements = [
    { id: 'requirement-2', status: 'doing', updatedAt: '2026-09-18T02:00:00.000Z' },
    { id: 'requirement-1', status: 'done', updatedAt: '2026-09-18T01:00:00.000Z' },
  ];

  assert.deepEqual(
    upsertRequirement(requirements, {
      id: 'requirement-1',
      status: 'doing',
      updatedAt: '2026-09-18T03:00:00.000Z',
    }),
    [
      { id: 'requirement-1', status: 'doing', updatedAt: '2026-09-18T03:00:00.000Z' },
      { id: 'requirement-2', status: 'doing', updatedAt: '2026-09-18T02:00:00.000Z' },
    ],
  );
});

void test('replaces only the affected Requirement Runs and preserves global ordering', () => {
  const runs = [
    { id: 'run-2', requirementId: 'requirement-2', startedAt: '2026-09-18T02:00:00.000Z' },
    { id: 'run-1-old', requirementId: 'requirement-1', startedAt: '2026-09-18T01:00:00.000Z' },
  ];

  assert.deepEqual(
    replaceRequirementRuns(runs, 'requirement-1', [
      { id: 'run-1-new', requirementId: 'requirement-1', startedAt: '2026-09-18T03:00:00.000Z' },
      { id: 'run-1-old', requirementId: 'requirement-1', startedAt: '2026-09-18T01:00:00.000Z' },
    ]),
    [
      { id: 'run-1-new', requirementId: 'requirement-1', startedAt: '2026-09-18T03:00:00.000Z' },
      { id: 'run-2', requirementId: 'requirement-2', startedAt: '2026-09-18T02:00:00.000Z' },
      { id: 'run-1-old', requirementId: 'requirement-1', startedAt: '2026-09-18T01:00:00.000Z' },
    ],
  );
});

void test('does not let an older Requirement response overwrite newer session state', () => {
  const current = [{
    id: 'requirement-1',
    status: 'doing',
    updatedAt: '2026-09-18T01:00:00.000Z',
    session: { updatedAt: '2026-09-18T03:00:00.000Z', state: 'running' },
  }];
  const stale = {
    id: 'requirement-1',
    status: 'todo',
    updatedAt: '2026-09-18T02:00:00.000Z',
    session: { updatedAt: '2026-09-18T02:00:00.000Z', state: 'idle' },
  };

  assert.deepEqual(upsertRequirement(current, stale), current);
});

void test('an in-flight snapshot cannot overwrite an equal-timestamp SSE update', () => {
  const snapshot = [{
    id: 'requirement-1',
    status: 'doing',
    updatedAt: '2026-09-18T03:00:00.000Z',
    session: { updatedAt: '2026-09-18T03:00:00.000Z', pendingMessageCount: 0 },
  }];
  const live = [{
    id: 'requirement-1',
    status: 'doing',
    updatedAt: '2026-09-18T03:00:00.000Z',
    session: { updatedAt: '2026-09-18T03:00:00.000Z', pendingMessageCount: 1 },
  }];

  assert.deepEqual(
    mergeVersionedSnapshot(snapshot, live, upsertRequirement),
    live,
  );
});

void test('does not let a running Run snapshot overwrite its completed state', () => {
  const completed: Array<{
    id: string;
    requirementId: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
  }> = [{
    id: 'run-1',
    requirementId: 'requirement-1',
    status: 'succeeded',
    startedAt: '2026-09-18T01:00:00.000Z',
    finishedAt: '2026-09-18T02:00:00.000Z',
  }];
  const stale = {
    id: 'run-1',
    requirementId: 'requirement-1',
    status: 'running',
    startedAt: '2026-09-18T01:00:00.000Z',
    finishedAt: null,
  };

  assert.deepEqual(upsertRun(completed, stale), completed);
});

void test('rejects cross-Requirement rows from a targeted Run refresh', () => {
  const current = [
    { id: 'run-2', requirementId: 'requirement-2', startedAt: '2026-09-18T02:00:00.000Z' },
  ];

  assert.deepEqual(
    replaceRequirementRuns(current, 'requirement-1', [
      { id: 'wrong-run', requirementId: 'requirement-2', startedAt: '2026-09-18T03:00:00.000Z' },
    ]),
    current,
  );
});

void test('does not apply an in-flight scoped response after its Requirement is removed', () => {
  const current = [{ id: 'requirement-2' }];
  const removedRequirementIds = new Set(['requirement-1']);

  assert.equal(
    applyRequirementScopedUpdate(
      current,
      'requirement-1',
      removedRequirementIds,
      (items) => [...items, { id: 'requirement-1' }],
    ),
    current,
  );
  assert.deepEqual(
    applyRequirementScopedUpdate(
      current,
      'requirement-2',
      removedRequirementIds,
      (items) => [...items, { id: 'requirement-3' }],
    ),
    [{ id: 'requirement-2' }, { id: 'requirement-3' }],
  );
});

void test('routes legacy SSE payloads to precise resource refreshes', () => {
  assert.deepEqual(refreshTargetsForManagerEvent(managerEvent('message.created')), [
    { scope: 'messages', requirementId: 'requirement-1' },
    { scope: 'requirement', requirementId: 'requirement-1', includeRuns: false },
  ]);
  assert.deepEqual(refreshTargetsForManagerEvent(managerEvent('run.started')), [
    { scope: 'requirement', requirementId: 'requirement-1', includeRuns: true },
  ]);
  assert.deepEqual(refreshTargetsForManagerEvent(managerEvent('pull_request.updated')), [
    { scope: 'pull_requests', requirementId: 'requirement-1' },
  ]);
  assert.deepEqual(refreshTargetsForManagerEvent(managerEvent('timer.fired')), [
    { scope: 'timers', requirementId: 'requirement-1' },
  ]);
  assert.deepEqual(refreshTargetsForManagerEvent(managerEvent(
    'review_request.started',
    { pullRequestId: 'pull-request-1' },
  )), [
    {
      scope: 'review_requests',
      pullRequestId: 'pull-request-1',
      requirementId: 'requirement-1',
    },
    { scope: 'requirement', requirementId: 'requirement-1', includeRuns: true },
  ]);
});

void test('does not refresh when a common SSE event carries persisted resources', () => {
  const payloads: Array<[string, Record<string, unknown>]> = [
    ['requirement.created', { requirement: { id: 'requirement-1' } }],
    ['message.created', { message: { id: 'message-1', requirementId: 'requirement-1' }, requirement: { id: 'requirement-1' } }],
    ['run.started', { run: { id: 'run-1', requirementId: 'requirement-1' }, requirement: { id: 'requirement-1' } }],
    ['run.succeeded', { run: { id: 'run-1', requirementId: 'requirement-1' }, requirement: { id: 'requirement-1' } }],
    ['pull_request.updated', { pullRequest: { id: 'pull-request-1', requirementId: 'requirement-1' } }],
    ['review_request.started', {
      pullRequest: { id: 'pull-request-1', requirementId: 'requirement-1' },
      reviewRequest: { id: 'review-1', pullRequestId: 'pull-request-1' },
      run: { id: 'run-1', requirementId: 'requirement-1' },
    }],
    ['timer.created', { timer: { id: 'timer-1', requirementId: 'requirement-1' } }],
    ['timer.fired', { timer: { id: 'timer-1', requirementId: 'requirement-1' } }],
    ['manager.configuration.updated', { configuration: {} }],
    ['agent_models.updated', { modelCatalog: {} }],
  ];

  for (const [type, payload] of payloads) {
    assert.deepEqual(refreshTargetsForManagerEvent(managerEvent(type, payload)), [], type);
  }
});

void test('routes a cross-Requirement payload to a scoped repair instead of applying it', () => {
  assert.deepEqual(refreshTargetsForManagerEvent(managerEvent('message.created', {
    message: { id: 'message-2', requirementId: 'requirement-2' },
    requirement: { id: 'requirement-2' },
  })), [
    { scope: 'messages', requirementId: 'requirement-1' },
    { scope: 'requirement', requirementId: 'requirement-1', includeRuns: false },
  ]);
});

void test('coalesces burst refreshes without mixing Requirement scopes', () => {
  assert.deepEqual(
    mergeRefreshTargets(
      [
        { scope: 'requirement', requirementId: 'requirement-1', includeRuns: false },
        { scope: 'messages', requirementId: 'requirement-1' },
      ],
      [
        { scope: 'requirement', requirementId: 'requirement-1', includeRuns: true },
        { scope: 'requirement', requirementId: 'requirement-2', includeRuns: false },
        { scope: 'messages', requirementId: 'requirement-1' },
      ],
    ),
    [
      { scope: 'requirement', requirementId: 'requirement-1', includeRuns: true },
      { scope: 'messages', requirementId: 'requirement-1' },
      { scope: 'requirement', requirementId: 'requirement-2', includeRuns: false },
    ],
  );
});
