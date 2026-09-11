import type {
  AgentProvider,
  AgentRun,
  AgentSession,
  ManagerEvent,
  MessageAuthor,
  Requirement,
  RequirementMessage,
  PullRequest,
  ReviewRequest,
  PullRequestStatus,
  RequirementCreator,
  RequirementStatus,
  RequirementWithSession,
  RunOutcome,
  RunRole,
  SessionState,
} from './types.js';

export class StoreConflictError extends Error {}
export class StoreNotFoundError extends Error {}

export interface CreateRequirementRecord {
  requirementId: string;
  sessionId: string;
  title: string;
  description: string;
  provider: AgentProvider;
  createdBy: RequirementCreator;
  parentRequirementId?: string;
  sourceSessionId?: string;
  now: string;
}

export interface BeginRunRecord {
  runId: string;
  requirementId: string;
  role: RunRole;
  provider: AgentProvider;
  taskSummary: string;
  inputFromSequence?: number;
  inputToSequence?: number;
  now: string;
}

export interface AppendEventRecord {
  type: string;
  requirementId?: string;
  sessionId?: string;
  runId?: string;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
  now: string;
}

export interface AppendMessageRecord {
  id: string;
  requirementId: string;
  sessionId: string;
  runId?: string;
  author: MessageAuthor;
  body: string;
  deliverToRd: boolean;
  now: string;
}

export interface UpsertPullRequestRecord {
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
  now: string;
}

export interface BeginReviewRequestRecord {
  id: string;
  runId: string;
  pullRequestId: string;
  requirementId: string;
  provider: AgentProvider;
  targetHeadSha: string;
  taskSummary: string;
  now: string;
}

/** Business-level persistence contract; PostgreSQL can implement this without leaking SQL upward. */
export interface AgentManagerStore {
  close(): void;
  createRequirement(input: CreateRequirementRecord): RequirementWithSession;
  getRequirement(id: string): RequirementWithSession | null;
  listRequirements(): RequirementWithSession[];
  listSessions(): AgentSession[];
  listRuns(requirementId?: string): AgentRun[];
  appendMessage(input: AppendMessageRecord): RequirementMessage;
  listMessages(requirementId: string): RequirementMessage[];
  listPendingRdMessages(requirementId: string): RequirementMessage[];
  upsertPullRequest(input: UpsertPullRequestRecord): PullRequest;
  getPullRequest(id: string): PullRequest | null;
  listPullRequests(requirementId?: string): PullRequest[];
  beginReviewRequest(input: BeginReviewRequestRecord): { pullRequest: PullRequest; reviewRequest: ReviewRequest; run: AgentRun };
  finishReviewRequest(id: string, outcome: RunOutcome, now: string): ReviewRequest;
  listReviewRequests(pullRequestId?: string): ReviewRequest[];
  beginRun(input: BeginRunRecord): { requirement: Requirement; session: AgentSession; run: AgentRun };
  finishRdRun(runId: string, outcome: RunOutcome, now: string): RequirementWithSession;
  finishReviewRun(runId: string, outcome: RunOutcome, now: string): AgentRun;
  setNativeSessionId(sessionId: string, nativeSessionId: string, now: string): void;
  moveSession(requirementId: string, state: SessionState, now: string, lastError?: string | null): AgentSession;
  transitionRequirement(
    requirementId: string,
    expected: RequirementStatus[],
    next: RequirementStatus,
    now: string,
  ): RequirementWithSession;
  appendEvent(input: AppendEventRecord): ManagerEvent;
  listEvents(afterId: number, limit?: number): ManagerEvent[];
  reconcileInterruptedRuns(now: string): { runIds: string[]; requirementIds: string[] };
}
