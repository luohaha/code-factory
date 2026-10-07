import assert from 'node:assert/strict';
import test from 'node:test';

import type { RequirementDto } from './agent-manager-client.ts';
import { summarizeWorkspaceRequirements } from './workspace-board.ts';

type WorkspaceRequirement = Pick<RequirementDto, 'sandboxId' | 'status'>;

void test('groups Requirements by workspace and marks only DOING as active', () => {
  const requirements: WorkspaceRequirement[] = [
    { sandboxId: null, status: 'todo' },
    { sandboxId: 'local', status: 'doing' },
    { sandboxId: 'shared-e2b', status: 'doing' },
    { sandboxId: 'shared-e2b', status: 'waiting_confirmation' },
    { sandboxId: 'idle-local', status: 'done' },
    { sandboxId: 'idle-local', status: 'cancelled' },
  ];

  assert.deepEqual([...summarizeWorkspaceRequirements(requirements)], [
    ['local', { total: 2, doing: 1 }],
    ['shared-e2b', { total: 2, doing: 1 }],
    ['idle-local', { total: 2, doing: 0 }],
  ]);
  assert.equal(summarizeWorkspaceRequirements([]).size, 0);
});
