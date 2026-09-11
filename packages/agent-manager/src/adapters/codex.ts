import type { AgentAdapter, AgentInvocation, NormalizedAgentEvent, RdInvocationInput, ReviewInvocationInput } from './types.js';

function textFromItem(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.text === 'string') return item.text;
  if (typeof item.content === 'string') return item.content;
  return undefined;
}

export class CodexAdapter implements AgentAdapter {
  readonly provider = 'codex' as const;

  buildRdInvocation(input: RdInvocationInput): AgentInvocation {
    const common = ['--json', '--color', 'never', '--dangerously-bypass-approvals-and-sandbox'];
    const images = (input.imagePaths ?? []).flatMap((path) => ['--image', path]);
    if (input.developerInstructions) {
      common.push('-c', `developer_instructions=${JSON.stringify(input.developerInstructions)}`);
    }
    return input.nativeSessionId
      ? { command: 'codex', args: ['exec', ...common, 'resume', input.nativeSessionId, ...images, '-'], input: input.prompt }
      : { command: 'codex', args: ['exec', ...common, ...images, '-'], input: input.prompt };
  }

  buildReviewInvocation(input: ReviewInvocationInput): AgentInvocation {
    const instructions = [input.developerInstructions, input.prompt].filter(Boolean).join('\n\n');
    return {
      command: 'codex',
      args: [
        'exec',
        'review',
        '--json',
        '--ephemeral',
        '--dangerously-bypass-approvals-and-sandbox',
        '-c',
        `developer_instructions=${JSON.stringify(instructions)}`,
        '--base',
        input.baseBranch,
      ],
      input: '',
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
    const nativeSessionId = typeof raw.thread_id === 'string'
      ? raw.thread_id
      : typeof raw.session_id === 'string' ? raw.session_id : undefined;
    if (type === 'thread.started') return { kind: 'session_started', ...(nativeSessionId ? { nativeSessionId } : {}), raw };
    if (type === 'item.completed') {
      const message = textFromItem(raw.item);
      return message ? { kind: 'message', message, raw } : { kind: 'other', raw };
    }
    if (type === 'turn.completed') return { kind: 'completed', raw };
    if (type.includes('error') || type === 'turn.failed') {
      const message = typeof raw.message === 'string' ? raw.message : type;
      return { kind: 'error', message, raw };
    }
    return { kind: 'other', ...(nativeSessionId ? { nativeSessionId } : {}), raw };
  }
}
