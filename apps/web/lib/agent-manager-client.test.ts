import assert from 'node:assert/strict';
import test from 'node:test';

import { MANAGER_EVENT_TYPES } from './manager-event-types.ts';
import { AgentManagerClient } from './agent-manager-client.ts';

void test('subscribes to live Agent trace events', () => {
  assert.ok(MANAGER_EVENT_TYPES.includes('run.trace.appended'));
  assert.ok(MANAGER_EVENT_TYPES.includes('requirement.updated'));
});

void test('attachment download URLs retain the configured remote Manager origin', () => {
  const client = new AgentManagerClient('https://manager.example.ts.net:9443/');
  assert.equal(client.attachmentUrl('att/a b', true), 'https://manager.example.ts.net:9443/api/attachments/att%2Fa%20b?download=1');
  assert.equal(client.attachmentUrl('att_image'), 'https://manager.example.ts.net:9443/api/attachments/att_image');
});
