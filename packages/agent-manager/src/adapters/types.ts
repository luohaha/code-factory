import type { AgentProvider } from '../types.js';

export interface AgentInvocation {
  command: string;
  args: string[];
  input: string;
}

export interface NormalizedAgentEvent {
  kind: 'session_started' | 'message' | 'completed' | 'error' | 'other';
  nativeSessionId?: string;
  message?: string;
  raw: Record<string, unknown>;
}

export interface RdInvocationInput {
  prompt: string;
  nativeSessionId: string | null;
  developerInstructions?: string;
  imagePaths?: string[];
}

export interface ReviewInvocationInput {
  prompt: string;
  developerInstructions?: string;
}

export interface AgentAdapter {
  readonly provider: AgentProvider;
  buildRdInvocation(input: RdInvocationInput): AgentInvocation;
  buildReviewInvocation(input: ReviewInvocationInput): AgentInvocation;
  parseLine(line: string): NormalizedAgentEvent | null;
}
