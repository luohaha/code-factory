export type AgentProvider = 'codex' | 'claude-code';
export type AgentReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type RequirementStatus =
  | 'todo'
  | 'doing'
  | 'waiting_confirmation'
  | 'done'
  | 'cancelled';

export type SessionState =
  | 'idle'
  | 'running'
  | 'waiting_human'
  | 'failed'
  | 'completed';

export type RunRole = 'rd' | 'reviewer';
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
export type MessageAuthor = 'human' | 'rd_agent' | 'reviewer' | 'system';
export type RequirementCreator = 'human' | 'rd_agent';
export type PullRequestStatus = 'draft' | 'open' | 'closed' | 'merged';
export type ReviewRequestStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';
export type AgentTimerSchedule = 'once' | 'recurring';
export type AgentTimerStatus = 'active' | 'completed' | 'cancelled';
export type SearchDocumentKind = 'requirement' | 'message' | 'pull_request';

export interface AgentModel {
  id: string;
  displayName: string;
  description: string | null;
}

export interface AgentModelProviderCatalog {
  provider: AgentProvider;
  models: AgentModel[];
  refreshedAt: string | null;
  stale: boolean;
}

export interface AgentModelCatalogSnapshot {
  refreshIntervalSeconds: number;
  providers: AgentModelProviderCatalog[];
}

export interface Requirement {
  id: string;
  title: string;
  description: string;
  status: RequirementStatus;
  provider: AgentProvider;
  model: string | null;
  reasoningEffort: AgentReasoningEffort | null;
  createdBy: RequirementCreator;
  parentRequirementId: string | null;
  sourceSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface AgentSession {
  id: string;
  requirementId: string;
  provider: AgentProvider;
  nativeSessionId: string | null;
  state: SessionState;
  lastError: string | null;
  lastConsumedMessageSequence: number;
  pendingMessageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRun {
  id: string;
  requirementId: string;
  sessionId: string | null;
  role: RunRole;
  provider: AgentProvider;
  model: string | null;
  reasoningEffort: AgentReasoningEffort | null;
  status: RunStatus;
  taskSummary: string;
  nativeSessionId: string | null;
  exitCode: number | null;
  error: string | null;
  inputFromSequence: number | null;
  inputToSequence: number | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ManagerEvent {
  id: number;
  type: string;
  requirementId: string | null;
  sessionId: string | null;
  runId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface RequirementMessage {
  id: string;
  requirementId: string;
  sessionId: string;
  runId: string | null;
  author: MessageAuthor;
  body: string;
  attachments: MessageAttachment[];
  sequence: number;
  deliverToRd: boolean;
  createdAt: string;
}

export interface MessageAttachment {
  id: string;
  requirementId: string;
  messageId: string | null;
  fileName: string;
  kind: 'image' | 'file';
  mediaType: string;
  byteSize: number;
  localPath: string;
  createdAt: string;
}

export interface PullRequest {
  id: string;
  requirementId: string;
  repository: string;
  number: number;
  url: string;
  title: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  status: PullRequestStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewRequest {
  id: string;
  pullRequestId: string;
  runId: string;
  provider: AgentProvider;
  model: string | null;
  reasoningEffort: AgentReasoningEffort | null;
  targetHeadSha: string;
  status: ReviewRequestStatus;
  requestedBy: 'human';
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface AgentTimer {
  id: string;
  requirementId: string;
  description: string;
  schedule: AgentTimerSchedule;
  intervalSeconds: number;
  status: AgentTimerStatus;
  nextFireAt: string | null;
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RequirementWithSession extends Requirement {
  session: AgentSession;
}

export interface SearchResult {
  kind: SearchDocumentKind;
  sourceId: string;
  requirementId: string;
  title: string;
  excerpt: string;
  score: number;
  fullTextScore: number;
  vectorScore: number;
  updatedAt: string;
}

export interface CreateRequirementInput {
  title: string;
  description: string;
  provider: AgentProvider;
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
  createdBy?: RequirementCreator;
  parentRequirementId?: string;
  sourceSessionId?: string;
}

export interface TrackPullRequestInput {
  requirementId: string;
  repository: string;
  number: number;
  url: string;
  title: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  status: PullRequestStatus;
}

export interface RunOutcome {
  status: Extract<RunStatus, 'succeeded' | 'failed' | 'timed_out' | 'cancelled'>;
  exitCode: number | null;
  nativeSessionId: string | null;
  finalMessage: string | null;
  error: string | null;
}
