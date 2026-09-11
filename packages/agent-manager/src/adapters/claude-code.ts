import { randomUUID } from 'node:crypto';

import type { AgentAdapter, AgentInvocation, NormalizedAgentEvent, RdInvocationInput, ReviewInvocationInput } from './types.js';

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
    if (input.nativeSessionId) args.push('--resume', input.nativeSessionId);
    else args.push('--session-id', randomUUID());
    if (input.developerInstructions) args.push('--append-system-prompt', input.developerInstructions);
    return { command: 'claude', args, input: input.prompt };
  }

  buildReviewInvocation(input: ReviewInvocationInput): AgentInvocation {
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
        ...instructionArgs,
      ],
      input: `/review Review the current changes against ${input.baseBranch}. ${input.prompt}`,
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
      return { kind: 'session_started', ...(nativeSessionId ? { nativeSessionId } : {}), raw };
    }
    if (type === 'assistant') {
      const message = assistantText(raw.message);
      return message ? { kind: 'message', message, raw } : { kind: 'other', raw };
    }
    if (type === 'result') {
      const message = typeof raw.result === 'string' ? raw.result : undefined;
      return { kind: raw.is_error === true ? 'error' : 'completed', ...(nativeSessionId ? { nativeSessionId } : {}), ...(message ? { message } : {}), raw };
    }
    return { kind: 'other', ...(nativeSessionId ? { nativeSessionId } : {}), raw };
  }
}
