import type {
  AgentProvider,
  AgentReasoningEffort,
  AgentTokenUsage,
  AgentTraceKind,
  AgentTraceStatus,
} from '../types.js';

export interface AgentInvocation {
  command: string;
  args: string[];
  input: string;
}

export interface NormalizedAgentEvent {
  kind: 'session_started' | 'message' | 'completed' | 'error' | 'other';
  nativeSessionId?: string;
  message?: string;
  traces?: NormalizedAgentTrace[];
  tokenUsage?: AgentTokenUsage;
  raw: Record<string, unknown>;
}

export interface NormalizedAgentTrace {
  kind: AgentTraceKind;
  status?: AgentTraceStatus;
  title: string;
  detail?: string;
  toolName?: string;
  toolCallId?: string;
  nativeType?: string;
}

export interface RdInvocationInput {
  prompt: string;
  nativeSessionId: string | null;
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
  developerInstructions?: string;
  imagePaths?: string[];
}

export interface ReviewInvocationInput {
  prompt: string;
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
  developerInstructions?: string;
}

export interface AgentAdapter {
  readonly provider: AgentProvider;
  buildRdInvocation(input: RdInvocationInput): AgentInvocation;
  buildReviewInvocation(input: ReviewInvocationInput): AgentInvocation;
  parseLine(line: string): NormalizedAgentEvent | null;
}
