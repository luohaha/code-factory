import type {
  AgentAdapter,
  AgentInvocation,
  NormalizedAgentEvent,
  NormalizedAgentTrace,
  RdInvocationInput,
  ReviewInvocationInput,
} from './types.js';

function textFromItem(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.text === 'string') return item.text;
  if (typeof item.content === 'string') return item.content;
  return undefined;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === 'string' ? value[key] : undefined;
}

function jsonDetail(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function codexItemTrace(
  nativeType: string,
  value: unknown,
  phase: 'started' | 'completed',
): NormalizedAgentTrace | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  const itemType = stringField(item, 'type') ?? 'item';
  const toolCallId = stringField(item, 'id');
  if (itemType === 'agent_message') {
    const detail = textFromItem(item);
    if (!detail) return undefined;
    return { kind: 'assistant_message', status: 'completed', title: 'Agent message', detail, nativeType };
  }
  if (itemType === 'reasoning') {
    const detail = textFromItem(item);
    if (!detail || phase === 'started') return undefined;
    return { kind: 'reasoning', status: 'completed', title: 'Reasoning', detail, nativeType };
  }
  if (itemType === 'command_execution') {
    const command = stringField(item, 'command');
    const output = stringField(item, 'aggregated_output');
    const exitCode = typeof item.exit_code === 'number' ? item.exit_code : undefined;
    if (phase === 'started') {
      return {
        kind: 'tool_call',
        status: 'started',
        title: 'Run command',
        ...(command ? { detail: command } : {}),
        toolName: 'shell',
        ...(toolCallId ? { toolCallId } : {}),
        nativeType,
      };
    }
    const detail = [command ? `$ ${command}` : '', output ?? '', exitCode === undefined ? '' : `Exit code: ${exitCode}`]
      .filter(Boolean).join('\n\n');
    return {
      kind: 'tool_result',
      status: exitCode === undefined || exitCode === 0 ? 'completed' : 'failed',
      title: 'Command result',
      ...(detail ? { detail } : {}),
      toolName: 'shell',
      ...(toolCallId ? { toolCallId } : {}),
      nativeType,
    };
  }
  if (itemType === 'mcp_tool_call') {
    const server = stringField(item, 'server');
    const tool = stringField(item, 'tool');
    const toolName = [server, tool].filter(Boolean).join('.') || 'MCP tool';
    if (phase === 'started') {
      const detail = jsonDetail(item.arguments ?? item.input);
      return {
        kind: 'tool_call',
        status: 'started',
        title: `Call ${toolName}`,
        ...(detail ? { detail } : {}),
        toolName,
        ...(toolCallId ? { toolCallId } : {}),
        nativeType,
      };
    }
    const error = jsonDetail(item.error);
    const result = jsonDetail(item.result ?? item.output);
    const detail = error ?? result;
    return {
      kind: 'tool_result',
      status: error ? 'failed' : 'completed',
      title: `${toolName} result`,
      ...(detail ? { detail } : {}),
      toolName,
      ...(toolCallId ? { toolCallId } : {}),
      nativeType,
    };
  }
  if (itemType === 'web_search') {
    const detail = jsonDetail(item.query ?? item.action ?? item);
    return {
      kind: phase === 'started' ? 'tool_call' : 'tool_result',
      status: phase,
      title: phase === 'started' ? 'Search the web' : 'Web search result',
      ...(detail ? { detail } : {}),
      toolName: 'web_search',
      ...(toolCallId ? { toolCallId } : {}),
      nativeType,
    };
  }
  if (itemType === 'file_change') {
    const detail = jsonDetail(item.changes ?? item);
    return {
      kind: phase === 'started' ? 'tool_call' : 'tool_result',
      status: phase,
      title: phase === 'started' ? 'Apply file changes' : 'File changes applied',
      ...(detail ? { detail } : {}),
      toolName: 'file_change',
      ...(toolCallId ? { toolCallId } : {}),
      nativeType,
    };
  }
  const detail = phase === 'completed' ? jsonDetail(item) : undefined;
  return {
    kind: 'lifecycle',
    status: phase,
    title: itemType.replaceAll('_', ' '),
    ...(detail ? { detail } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    nativeType,
  };
}

export class CodexAdapter implements AgentAdapter {
  readonly provider = 'codex' as const;

  buildRdInvocation(input: RdInvocationInput): AgentInvocation {
    const common = ['--json', '--color', 'never', '--dangerously-bypass-approvals-and-sandbox'];
    if (input.model) common.push('--model', input.model);
    if (input.reasoningEffort) common.push('-c', `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`);
    const images = (input.imagePaths ?? []).flatMap((path) => ['--image', path]);
    if (input.developerInstructions) {
      common.push('-c', `developer_instructions=${JSON.stringify(input.developerInstructions)}`);
    }
    return input.nativeSessionId
      ? { command: 'codex', args: ['exec', ...common, 'resume', input.nativeSessionId, ...images, '-'], input: input.prompt }
      : { command: 'codex', args: ['exec', ...common, ...images, '-'], input: input.prompt };
  }

  buildReviewInvocation(input: ReviewInvocationInput): AgentInvocation {
    const configurationArgs = [
      ...(input.model ? ['--model', input.model] : []),
      ...(input.reasoningEffort ? ['-c', `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`] : []),
    ];
    const instructionArgs = input.developerInstructions
      ? ['-c', `developer_instructions=${JSON.stringify(input.developerInstructions)}`]
      : [];
    return {
      command: 'codex',
      args: [
        'exec',
        '--json',
        '--color',
        'never',
        '--ephemeral',
        '--dangerously-bypass-approvals-and-sandbox',
        ...configurationArgs,
        ...instructionArgs,
        '-',
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
    const nativeSessionId = typeof raw.thread_id === 'string'
      ? raw.thread_id
      : typeof raw.session_id === 'string' ? raw.session_id : undefined;
    if (type === 'thread.started') {
      return {
        kind: 'session_started',
        ...(nativeSessionId ? { nativeSessionId } : {}),
        traces: [{ kind: 'lifecycle', status: 'started', title: 'Native session started', nativeType: type }],
        raw,
      };
    }
    if (type === 'turn.started') {
      return {
        kind: 'other',
        traces: [{ kind: 'lifecycle', status: 'started', title: 'Agent turn started', nativeType: type }],
        raw,
      };
    }
    if (type === 'item.started' || type === 'item.completed') {
      const phase = type === 'item.started' ? 'started' : 'completed';
      const trace = codexItemTrace(type, raw.item, phase);
      const item = raw.item && typeof raw.item === 'object' ? raw.item as Record<string, unknown> : {};
      const message = type === 'item.completed' && item.type === 'agent_message'
        ? textFromItem(item)
        : undefined;
      return {
        kind: message ? 'message' : 'other',
        ...(message ? { message } : {}),
        ...(trace ? { traces: [trace] } : {}),
        raw,
      };
    }
    if (type === 'turn.completed') {
      return {
        kind: 'completed',
        traces: [{ kind: 'lifecycle', status: 'completed', title: 'Agent turn completed', nativeType: type }],
        raw,
      };
    }
    if (type.includes('error') || type === 'turn.failed') {
      const message = typeof raw.message === 'string' ? raw.message : type;
      return {
        kind: 'error',
        message,
        traces: [{ kind: 'error', status: 'failed', title: 'Agent error', detail: message, nativeType: type }],
        raw,
      };
    }
    return { kind: 'other', ...(nativeSessionId ? { nativeSessionId } : {}), raw };
  }
}
