import type {
  AgentProvider,
  AgentReasoningEffort,
  AgentRun,
  AgentSession,
  ManagerEvent,
  MessageAttachment,
  MessageAuthor,
  Requirement,
  RequirementMessage,
  PullRequest,
  ReviewRequest,
  AgentTimer,
  AgentTimerSchedule,
  SearchResult,
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
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
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
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
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
  sourceRequirementId?: string;
  author: MessageAuthor;
  body: string;
  attachmentIds?: string[];
  deliverToRd: boolean;
  now: string;
}

export interface CreateMessageAttachmentRecord {
  id: string;
  requirementId: string;
  fileName: string;
  kind: MessageAttachment['kind'];
  mediaType: string;
  byteSize: number;
  localPath: string;
  now: string;
}

export interface AppendExternalMessageRecord extends AppendMessageRecord {
  pullRequestId: string;
  sourceKey: string;
}

export interface AppendAgentTriggerMessageRecord extends AppendMessageRecord {
  triggerId: string;
  idempotencyKey: string;
}

export interface PullRequestObservation {
  pullRequestId: string;
  initializedAt: string;
  checkStates: Record<string, string>;
  updatedAt: string;
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
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
  targetHeadSha: string;
  taskSummary: string;
  now: string;
}

export interface PurgeExpiredRequirementsRecord {
  cancelledBefore: string;
  doneBefore: string;
  now: string;
}

export interface PurgeExpiredRequirementsResult {
  requirements: Array<{
    id: string;
    status: Extract<RequirementStatus, 'cancelled' | 'done'>;
  }>;
}

export interface CreateAgentTimerRecord {
  id: string;
  requirementId: string;
  description: string;
  schedule: AgentTimerSchedule;
  intervalSeconds: number;
  nextFireAt: string;
  now: string;
}

export interface CompleteAgentTimerOccurrenceRecord {
  id: string;
  expectedNextFireAt: string;
  nextFireAt?: string;
  now: string;
}

/** Business-level persistence contract; PostgreSQL can implement this without leaking SQL upward. */
export interface AgentManagerStore {
  close(): void;
  createRequirement(input: CreateRequirementRecord): RequirementWithSession;
  getRequirement(id: string): RequirementWithSession | null;
  listRequirements(): RequirementWithSession[];
  listChildRequirements(parentRequirementId: string): RequirementWithSession[];
  search(query: string, limit?: number): SearchResult[];
  listSessions(): AgentSession[];
  listRuns(requirementId?: string): AgentRun[];
  createMessageAttachment(input: CreateMessageAttachmentRecord): MessageAttachment;
  getMessageAttachment(id: string): MessageAttachment | null;
  appendMessage(input: AppendMessageRecord): RequirementMessage;
  appendAgentTriggerMessage(input: AppendAgentTriggerMessageRecord): RequirementMessage | null;
  /** @deprecated Use appendAgentTriggerMessage for source-neutral trigger delivery. */
  appendExternalMessage(input: AppendExternalMessageRecord): RequirementMessage | null;
  listMessages(requirementId: string): RequirementMessage[];
  listPendingRdMessages(requirementId: string): RequirementMessage[];
  createAgentTimer(input: CreateAgentTimerRecord): AgentTimer;
  getAgentTimer(id: string): AgentTimer | null;
  listAgentTimers(requirementId?: string): AgentTimer[];
  completeAgentTimerOccurrence(input: CompleteAgentTimerOccurrenceRecord): AgentTimer | null;
  cancelAgentTimer(id: string, now: string): AgentTimer;
  upsertPullRequest(input: UpsertPullRequestRecord): PullRequest;
  getPullRequest(id: string): PullRequest | null;
  listPullRequests(requirementId?: string): PullRequest[];
  ensurePullRequestObservation(pullRequestId: string, now: string): { observation: PullRequestObservation; created: boolean };
  updatePullRequestCheckStates(pullRequestId: string, checkStates: Record<string, string>, now: string): PullRequestObservation;
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
  purgeExpiredRequirements(input: PurgeExpiredRequirementsRecord): PurgeExpiredRequirementsResult;
  listPendingAttachmentDeletions(): string[];
  completePendingAttachmentDeletion(localPath: string): void;
  appendEvent(input: AppendEventRecord): ManagerEvent;
  listEvents(afterId: number, limit?: number): ManagerEvent[];
  reconcileInterruptedRuns(now: string): { runIds: string[]; requirementIds: string[] };
}
