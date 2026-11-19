import type {
  AgentProvider,
  AgentReasoningEffort,
  AgentTraceKind,
  AgentTraceStatus,
} from '../../core/types.js';

export interface AgentInvocation {
  command: string;
  args: string[];
  input: string;
}

export interface SteeringInput {
  text: string;
  imagePaths: readonly string[];
}

export type SendSteering = (input: SteeringInput, onDelivered: () => void) => 'submitted' | 'defer' | 'unsupported';

export interface AgentProtocolIO {
  write(message: Record<string, unknown>): boolean;
  emit(event: NormalizedAgentEvent): void;
  endInput(): void;
  complete(): void;
  fail(message: string): void;
  unsupported(): void;
}

export interface AgentProtocol {
  start(): void;
  receive(line: string): void;
  steer: SendSteering;
  dispose?(): void;
}

export interface StreamingAgentInvocation extends AgentInvocation {
  connect(io: AgentProtocolIO): AgentProtocol;
  isUnsupported(stderr: string): boolean;
}

export interface NormalizedAgentEvent {
  kind: 'session_started' | 'message' | 'completed' | 'error' | 'other';
  nativeSessionId?: string;
  message?: string;
  traces?: NormalizedAgentTrace[];
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
  buildStreamingRdInvocation?(legacy: AgentInvocation, input: RdInvocationInput, cwd: string): StreamingAgentInvocation;
  buildReviewInvocation(input: ReviewInvocationInput): AgentInvocation;
  parseLine(line: string): NormalizedAgentEvent | null;
}
