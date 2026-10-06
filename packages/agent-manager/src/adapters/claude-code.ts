import { randomUUID } from 'node:crypto';

import type {
  AgentAdapter,
  AgentInvocation,
  NormalizedAgentEvent,
  NormalizedAgentTrace,
  RdInvocationInput,
  ReviewInvocationInput,
} from './types.js';

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
