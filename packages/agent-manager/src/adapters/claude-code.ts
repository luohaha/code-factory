import { randomUUID } from 'node:crypto';

import type {
  AgentAdapter,
  AgentInvocation,
  NormalizedAgentEvent,
  NormalizedAgentTrace,
  RdInvocationInput,
  ReviewInvocationInput,
} from './types.js';
import type { ProviderLimitClassification } from '../types.js';

const SESSION_LIMIT_PATTERN = /\bsession limit\b[\s\S]*?\bresets\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i;

function zonedParts(value: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  return Object.fromEntries(parts.flatMap((part) => {
    const number = Number(part.value);
    return Number.isFinite(number) ? [[part.type, number]] : [];
  }));
}

function instantForZonedTime(
  date: { year: number; month: number; day: number },
  time: { hour: number; minute: number },
  timeZone: string,
): Date | null {
  const desiredAsUtc = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
  let instant = desiredAsUtc;
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const actual = zonedParts(new Date(instant), timeZone);
      const actualAsUtc = Date.UTC(
        actual.year!, actual.month! - 1, actual.day!, actual.hour!, actual.minute!,
      );
      const adjustment = desiredAsUtc - actualAsUtc;
      instant += adjustment;
      if (adjustment === 0) break;
    }
    const result = new Date(instant);
    const actual = zonedParts(result, timeZone);
    return actual.year === date.year && actual.month === date.month && actual.day === date.day
      && actual.hour === time.hour && actual.minute === time.minute
      ? result
      : null;
  } catch {
    return null;
  }
}

function nextLocalDate(date: { year: number; month: number; day: number }): typeof date {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

export function classifyClaudeCodeFailure(error: string, observedAt: Date): ProviderLimitClassification | null {
  const match = error.match(SESSION_LIMIT_PATTERN);
  if (!match) return null;
  const rawHour = Number(match[1]);
  const minute = Number(match[2] ?? '0');
  const period = match[3]?.toLowerCase();
  const timeZone = match[4]?.trim();
  if (!Number.isInteger(rawHour) || rawHour < 1 || rawHour > 12
    || !Number.isInteger(minute) || minute < 0 || minute > 59 || !period || !timeZone) return null;
  const hour = rawHour % 12 + (period === 'pm' ? 12 : 0);
  let localDate: { year: number; month: number; day: number };
  try {
    const observed = zonedParts(observedAt, timeZone);
    localDate = { year: observed.year!, month: observed.month!, day: observed.day! };
  } catch {
    return null;
  }
  let retryAt = instantForZonedTime(localDate, { hour, minute }, timeZone);
  if (!retryAt) return null;
  if (retryAt.getTime() <= observedAt.getTime()) {
    retryAt = instantForZonedTime(nextLocalDate(localDate), { hour, minute }, timeZone);
  }
  return retryAt && retryAt.getTime() > observedAt.getTime()
    ? { kind: 'session_limit', retryAt: retryAt.toISOString() }
    : null;
}

function assistantText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  const content = (value as Record<string, unknown>).content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((part) => {
    if (!part || typeof part !== 'object') return [];
    const text = (part as Record<string, unknown>).text;
    return typeof text === 'string' ? [text] : [];
  });
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function jsonDetail(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const text = value.flatMap((part) => {
      if (typeof part === 'string') return [part];
      if (!part || typeof part !== 'object') return [];
      const record = part as Record<string, unknown>;
      return typeof record.text === 'string' ? [record.text] : [JSON.stringify(record, null, 2)];
    }).join('\n');
    if (text) return text;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function claudeContentTraces(value: unknown, nativeType: string): NormalizedAgentTrace[] {
  if (!value || typeof value !== 'object') return [];
  const content = (value as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((part): NormalizedAgentTrace[] => {
    if (!part || typeof part !== 'object') return [];
    const block = part as Record<string, unknown>;
    const type = typeof block.type === 'string' ? block.type : '';
    if (type === 'text' && typeof block.text === 'string') {
      return [{ kind: 'assistant_message', status: 'completed', title: 'Agent message', detail: block.text, nativeType }];
    }
    if (type === 'thinking' && typeof block.thinking === 'string') {
      return [{ kind: 'reasoning', status: 'completed', title: 'Reasoning', detail: block.thinking, nativeType }];
    }
    if (type === 'tool_use') {
      const name = typeof block.name === 'string' ? block.name : 'tool';
      const id = typeof block.id === 'string' ? block.id : undefined;
      const detail = jsonDetail(block.input);
      return [{
        kind: 'tool_call',
        status: 'started',
        title: `Call ${name}`,
        ...(detail ? { detail } : {}),
        toolName: name,
        ...(id ? { toolCallId: id } : {}),
        nativeType,
      }];
    }
    if (type === 'tool_result') {
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined;
      const detail = jsonDetail(block.content);
      return [{
        kind: 'tool_result',
        status: block.is_error === true ? 'failed' : 'completed',
        title: block.is_error === true ? 'Tool failed' : 'Tool result',
        ...(detail ? { detail } : {}),
        ...(id ? { toolCallId: id } : {}),
        nativeType,
      }];
    }
    return [];
  });
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly provider = 'claude-code' as const;

  buildRdInvocation(input: RdInvocationInput): AgentInvocation {
    const args = [
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ];
    if (input.model) args.push('--model', input.model);
    if (input.reasoningEffort) args.push('--effort', input.reasoningEffort);
    if (input.nativeSessionId) args.push('--resume', input.nativeSessionId);
    else args.push('--session-id', randomUUID());
    if (input.developerInstructions) args.push('--append-system-prompt', input.developerInstructions);
    return { command: 'claude', args, input: input.prompt };
  }

  buildReviewInvocation(input: ReviewInvocationInput): AgentInvocation {
    const configurationArgs = [
      ...(input.model ? ['--model', input.model] : []),
      ...(input.reasoningEffort ? ['--effort', input.reasoningEffort] : []),
    ];
    const instructionArgs = input.developerInstructions
      ? ['--append-system-prompt', input.developerInstructions]
      : [];
    return {
      command: 'claude',
      args: [
        '--print',
        '--output-format',
        'stream-json',
        '--verbose',
        '--no-session-persistence',
        '--dangerously-skip-permissions',
        ...configurationArgs,
        ...instructionArgs,
      ],
      input: input.prompt,
    };
  }

  classifyFailure(error: string, observedAt: Date): ProviderLimitClassification | null {
    return classifyClaudeCodeFailure(error, observedAt);
  }

  parseLine(line: string): NormalizedAgentEvent | null {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }

    const type = typeof raw.type === 'string' ? raw.type : '';
    const nativeSessionId = typeof raw.session_id === 'string' ? raw.session_id : undefined;
    if (type === 'system' && raw.subtype === 'init') {
      return {
        kind: 'session_started',
        ...(nativeSessionId ? { nativeSessionId } : {}),
        traces: [{ kind: 'lifecycle', status: 'started', title: 'Native session started', nativeType: `${type}.init` }],
        raw,
      };
    }
    if (type === 'assistant') {
      const message = assistantText(raw.message);
      const traces = claudeContentTraces(raw.message, type);
      return {
        kind: message ? 'message' : 'other',
        ...(message ? { message } : {}),
        ...(traces.length > 0 ? { traces } : {}),
        raw,
      };
    }
    if (type === 'user') {
      const traces = claudeContentTraces(raw.message, type);
      return { kind: 'other', ...(traces.length > 0 ? { traces } : {}), raw };
    }
    if (type === 'result') {
      const message = typeof raw.result === 'string' ? raw.result : undefined;
      const failed = raw.is_error === true;
      return {
        kind: failed ? 'error' : 'completed',
        ...(nativeSessionId ? { nativeSessionId } : {}),
        ...(message ? { message } : {}),
        traces: [{
          kind: failed ? 'error' : 'lifecycle',
          status: failed ? 'failed' : 'completed',
          title: failed ? 'Agent run failed' : 'Agent run completed',
          ...(failed && message ? { detail: message } : {}),
          nativeType: type,
        }],
        raw,
      };
    }
    return { kind: 'other', ...(nativeSessionId ? { nativeSessionId } : {}), raw };
  }
}
