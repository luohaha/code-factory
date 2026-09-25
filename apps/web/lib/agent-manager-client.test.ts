import assert from 'node:assert/strict';
import test from 'node:test';

import { MANAGER_EVENT_TYPES } from './manager-event-types.ts';

void test('subscribes to live Agent trace events', () => {
  assert.ok(MANAGER_EVENT_TYPES.includes('run.trace.appended'));
  assert.ok(MANAGER_EVENT_TYPES.includes('requirement.updated'));
  assert.ok(MANAGER_EVENT_TYPES.includes('provider.limit.detected'));
  assert.ok(MANAGER_EVENT_TYPES.includes('provider.limit.cleared'));
});
