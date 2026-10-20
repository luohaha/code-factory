import type { AgentTraceEventDto } from './agent-manager-client';

export interface ToolTraceItem {
  kind: 'tool';
  event: AgentTraceEventDto;
  call: AgentTraceEventDto | null;
  result: AgentTraceEventDto | null;
  status: 'running' | 'success' | 'error' | 'incomplete';
  startedAt: number | undefined;
  duration: number | undefined;
}

export type TraceTimelineItem = ToolTraceItem | { kind: 'event'; event: AgentTraceEventDto };

/** Pair only explicit tool IDs within one Run; missing IDs must never guess a match. */
export function buildTraceTimeline(
  trace: readonly AgentTraceEventDto[],
  runningRunIds: ReadonlySet<string>,
): TraceTimelineItem[] {
  const items: TraceTimelineItem[] = [];
  const tools = new Map<string, Map<string, ToolTraceItem>>();

  for (const event of trace) {
    if (event.kind !== 'tool_call' && event.kind !== 'tool_result') {
      items.push({ kind: 'event', event });
      continue;
    }

    let runTools = tools.get(event.runId);
    if (!runTools) {
      runTools = new Map();
      tools.set(event.runId, runTools);
    }
    let item = event.toolCallId ? runTools.get(event.toolCallId) : undefined;
    if (!item) {
      item = {
        kind: 'tool', event, call: null, result: null, status: 'incomplete',
        startedAt: undefined, duration: undefined,
      };
      items.push(item);
      if (event.toolCallId) runTools.set(event.toolCallId, item);
    }
    if (event.kind === 'tool_call') item.call = event;
    else item.result = event;
  }

  for (const item of items) {
    if (item.kind !== 'tool') continue;
    const terminal = item.result ?? item.call;
    item.status = terminal?.status === 'failed' ? 'error'
      : terminal?.status === 'completed' ? 'success'
      : item.call?.status === 'started' && !item.result && runningRunIds.has(item.event.runId)
        ? 'running' : 'incomplete';
    const start = item.call ? Date.parse(item.call.createdAt) : NaN;
    const end = item.result ? Date.parse(item.result.createdAt) : NaN;
    item.startedAt = Number.isFinite(start) ? start : undefined;
    item.duration = Number.isFinite(start) && Number.isFinite(end) && end >= start
      ? end - start : undefined;
  }
  return items;
}
