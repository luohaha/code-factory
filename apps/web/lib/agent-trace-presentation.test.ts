import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentTraceEventDto } from './agent-manager-client.ts';
import { buildTraceTimeline, type ToolTraceItem } from './agent-trace-presentation.ts';

function event(id: string, input: Partial<AgentTraceEventDto> = {}): AgentTraceEventDto {
  return {
    id, runId: 'run-1', sequence: 1, kind: 'tool_call', status: 'started',
    title: 'Call shell', detail: 'npm test', toolName: 'shell', toolCallId: 'call-1',
    nativeType: null, createdAt: '2026-10-19T01:00:00.000Z', ...input,
  };
}

function tool(items: ReturnType<typeof buildTraceTimeline>, index = 0): ToolTraceItem {
  const item = items[index];
  assert.equal(item?.kind, 'tool');
  if (item?.kind !== 'tool') throw new Error('Expected tool card');
  return item;
}

void test('pairs interleaved tool calls without losing other chronological events or payloads', () => {
  const call = event('call');
  const other = event('other', { toolCallId: 'call-2', detail: '{"path":"a.ts"}' });
  const reasoning = event('reasoning', { kind: 'reasoning', toolCallId: null });
  const result = event('result', {
    kind: 'tool_result', status: 'completed', toolName: null, detail: 'all tests passed',
    createdAt: '2026-10-19T01:00:02.500Z',
  });
  const items = buildTraceTimeline([call, other, reasoning, result], new Set(['run-1']));
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((item) => item.event.id), ['call', 'other', 'reasoning']);
  assert.equal(tool(items).call, call);
  assert.equal(tool(items).result, result);
  assert.equal(tool(items).status, 'success');
  assert.equal(tool(items).duration, 2500);
  assert.equal(tool(items, 1).status, 'running');
});

void test('same native tool ID in different Runs never merges', () => {
  const items = buildTraceTimeline([
    event('call'),
    event('result', { runId: 'run-2', kind: 'tool_result', status: 'failed' }),
  ], new Set(['run-1']));
  assert.equal(items.length, 2);
  assert.equal(tool(items).status, 'running');
  assert.equal(tool(items, 1).status, 'error');
  assert.equal(tool(items, 1).call, null);
  assert.equal(tool(items, 1).startedAt, undefined);
  assert.equal(tool(items, 1).duration, undefined);
});

void test('missing tool IDs remain separate rather than guessing by tool name', () => {
  const items = buildTraceTimeline([
    event('call', { toolCallId: null }),
    event('result', { toolCallId: null, kind: 'tool_result', status: 'completed' }),
  ], new Set());
  assert.equal(items.length, 2);
  assert.equal(tool(items).status, 'incomplete');
  assert.equal(tool(items, 1).status, 'success');
});

void test('unmatched calls stop spinning when their Run ends, without inventing success', () => {
  const trace = [event('call')];
  assert.equal(tool(buildTraceTimeline(trace, new Set(['run-1']))).status, 'running');
  assert.equal(tool(buildTraceTimeline(trace, new Set())).status, 'incomplete');
  assert.equal(tool(buildTraceTimeline(trace, new Set(['other-run']))).status, 'incomplete');
  assert.equal(trace[0]?.status, 'started');
});

void test('a live failure updates the existing card and retains its input', () => {
  const call = event('call');
  const live = buildTraceTimeline([call], new Set(['run-1']));
  const finished = buildTraceTimeline([call, event('result', {
    kind: 'tool_result', status: 'failed', detail: 'command exited 1',
  })], new Set(['run-1']));
  assert.equal(tool(live).event.id, tool(finished).event.id);
  assert.equal(tool(finished).status, 'error');
  assert.equal(tool(finished).call?.detail, 'npm test');
  assert.equal(tool(finished).result?.detail, 'command exited 1');
});

void test('invalid or backwards timestamps never produce a fabricated duration', () => {
  for (const createdAt of ['invalid', '2026-10-18T01:00:00.000Z']) {
    const items = buildTraceTimeline([
      event('call'), event('result', { kind: 'tool_result', status: 'completed', createdAt }),
    ], new Set());
    assert.equal(tool(items).duration, undefined);
  }
});
