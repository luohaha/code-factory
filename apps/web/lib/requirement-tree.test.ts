import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRequirementForest, summarizeRequirementRelations } from './requirement-tree.ts';

interface RequirementRecord {
  id: string;
  parentRequirementId: string | null;
  createdAt: string;
  updatedAt: string;
}

function requirement(
  id: string,
  parentRequirementId: string | null,
  createdAt: string,
  updatedAt = createdAt,
): RequirementRecord {
  return { id, parentRequirementId, createdAt, updatedAt };
}

void test('builds a forest with active roots first and children in creation order', () => {
  const forest = buildRequirementForest([
    requirement('root-old', null, '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z'),
    requirement('child-new', 'root-new', '2026-09-04T00:00:00.000Z'),
    requirement('root-new', null, '2026-09-02T00:00:00.000Z', '2026-09-05T00:00:00.000Z'),
    requirement('child-old', 'root-new', '2026-09-03T00:00:00.000Z'),
  ]);

  assert.deepEqual(forest.map((node) => node.requirement.id), ['root-new', 'root-old']);
  assert.deepEqual(
    forest[0]?.children.map((node) => [node.requirement.id, node.depth]),
    [['child-old', 1], ['child-new', 1]],
  );
});

void test('keeps the ancestor chain when a filtered child is visible', () => {
  const forest = buildRequirementForest([
    requirement('root', null, '2026-09-01T00:00:00.000Z'),
    requirement('branch', 'root', '2026-09-02T00:00:00.000Z'),
    requirement('match', 'branch', '2026-09-03T00:00:00.000Z'),
    requirement('sibling', 'root', '2026-09-04T00:00:00.000Z'),
  ], new Set(['match']));

  assert.equal(forest.length, 1);
  assert.equal(forest[0]?.requirement.id, 'root');
  assert.equal(forest[0]?.children[0]?.requirement.id, 'branch');
  assert.equal(forest[0]?.children[0]?.children[0]?.requirement.id, 'match');
  assert.equal(forest[0]?.children.length, 1);
});

void test('promotes orphaned and cyclic records to safe roots', () => {
  const forest = buildRequirementForest([
    requirement('orphan', 'missing', '2026-09-01T00:00:00.000Z'),
    requirement('cycle-a', 'cycle-b', '2026-09-02T00:00:00.000Z'),
    requirement('cycle-b', 'cycle-a', '2026-09-03T00:00:00.000Z'),
  ]);

  assert.deepEqual(
    new Set(forest.map((node) => node.requirement.id)),
    new Set(['orphan', 'cycle-a', 'cycle-b']),
  );
});

void test('summarizes roots, links, and maximum depth', () => {
  assert.deepEqual(summarizeRequirementRelations([
    requirement('root', null, '2026-09-01T00:00:00.000Z'),
    requirement('child', 'root', '2026-09-02T00:00:00.000Z'),
    requirement('grandchild', 'child', '2026-09-03T00:00:00.000Z'),
    requirement('second-root', null, '2026-09-04T00:00:00.000Z'),
  ]), { roots: 2, linked: 2, levels: 3 });
});
