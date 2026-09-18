import assert from 'node:assert/strict';
import test from 'node:test';

import { replaceRequirementRuns, upsertRequirement } from './dashboard-state.ts';

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
