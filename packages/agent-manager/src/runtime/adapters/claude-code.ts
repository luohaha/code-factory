import { randomUUID } from 'node:crypto';

import type {
  AgentAdapter,
  AgentInvocation,
  NormalizedAgentEvent,
  NormalizedAgentTrace,
  RdInvocationInput,
  ReviewInvocationInput,
  StreamingAgentInvocation,
} from './types.js';

const FOLLOW_UP_START_TIMEOUT_MS = 10_000;

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

  buildStreamingRdInvocation(legacy: AgentInvocation): StreamingAgentInvocation {
    return {
      ...legacy,
      args: [...legacy.args, '--input-format', 'stream-json', '--replay-user-messages'],
      isUnsupported: (stderr) => /(?:unknown|unrecognized) option ['"]?--(?:input-format|replay-user-messages)\b/i.test(stderr),
      connect: (io) => {
        const pending = new Map<string, () => void>();
        const replayed = new Set<string>();
        const initialMessageId = randomUUID();
        let sessionId: string | undefined;
        let closing = false;
        let completedRdTurn = false;
        let hasBackgroundWork = false;
        let followUpTimer: NodeJS.Timeout | undefined;
        const clearFollowUpTimer = () => {
          if (followUpTimer) clearTimeout(followUpTimer);
          followUpTimer = undefined;
        };
        const closeInput = () => {
          clearFollowUpTimer();
          if (closing) return;
          closing = true;
          io.endInput();
        };
        const closeWhenIdle = () => {
          if (completedRdTurn && !hasBackgroundWork && pending.size === 0) closeInput();
        };
        const send = (text: string, uuid: string) => io.write({
          type: 'user', message: { role: 'user', content: text }, uuid, parent_tool_use_id: null,
        });
        return {
          dispose: clearFollowUpTimer,
          start: () => { send(legacy.input, initialMessageId); },
          steer: (input, onDelivered) => {
            if (closing) return 'defer';
            const uuid = randomUUID();
            if (!send(input.text, uuid)) return 'defer';
            pending.set(uuid, onDelivered);
            return 'submitted';
          },
          receive: (line) => {
            const event = this.parseLine(line);
            if (!event) return;
            const raw = event.raw;
            if (raw.type === 'system' && raw.subtype === 'init' && typeof raw.session_id === 'string' && raw.parent_tool_use_id == null) {
              sessionId ??= raw.session_id;
              if (raw.session_id === sessionId) clearFollowUpTimer();
            }
            if (raw.type === 'system' && raw.subtype === 'background_tasks_changed' && Array.isArray(raw.tasks)) {
              hasBackgroundWork = raw.tasks.some((task: unknown) => task && typeof task === 'object'
                && 'task_id' in task && typeof task.task_id === 'string'
                && (!('ambient' in task) || task.ambient !== true));
              closeWhenIdle();
            }
            if (raw.type === 'user' && raw.isReplay === true && typeof raw.uuid === 'string' && pending.has(raw.uuid)) {
              replayed.add(raw.uuid);
              clearFollowUpTimer();
            }
            if (raw.type !== 'result') {
              if (raw.type === 'assistant' && raw.parent_tool_use_id == null) clearFollowUpTimer();
              io.emit(event);
              return;
            }
            const answered = Array.isArray(raw.user_message_uuids) ? raw.user_message_uuids
              : typeof raw.user_message_uuid === 'string' ? [raw.user_message_uuid] : undefined;
            const origin = raw.origin;
            // A background task can emit its own result before Claude handles the resumed prompt.
            if (origin && typeof origin === 'object' && 'kind' in origin && origin.kind === 'task-notification'
              && !answered?.some((uuid: unknown) => uuid === initialMessageId || (typeof uuid === 'string' && pending.has(uuid)))) {
              return;
            }
            clearFollowUpTimer();
            if (event.kind === 'completed' && raw.subtype === 'success') {
              for (const uuid of answered ?? replayed) {
                if (typeof uuid !== 'string') continue;
                pending.get(uuid)?.();
                pending.delete(uuid);
              }
              completedRdTurn = true;
              io.complete();
              if (!closing && pending.size > 0) {
                followUpTimer = setTimeout(closeInput, FOLLOW_UP_START_TIMEOUT_MS);
                followUpTimer.unref();
              } else {
                closeWhenIdle();
              }
            } else {
              closeInput();
            }
            replayed.clear();
            io.emit(event);
          },
        };
      },
    };
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

    if (!raw || typeof raw !== 'object') return null;
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
      const failed = raw.is_error === true || (typeof raw.subtype === 'string' && raw.subtype.startsWith('error'));
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
