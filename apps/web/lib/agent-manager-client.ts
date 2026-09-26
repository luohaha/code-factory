import { MANAGER_EVENT_TYPES } from './manager-event-types.ts';

export type AgentProvider = 'codex' | 'claude-code';
export type AgentReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface AgentConfiguration {
  provider: AgentProvider;
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
}

export interface RequirementAgentConfigurationUpdate {
  provider?: AgentProvider;
  model?: string | null;
  reasoningEffort?: AgentReasoningEffort | null;
}

export interface AgentModelDto {
  id: string;
  displayName: string;
  description: string | null;
}

export interface AgentModelProviderCatalogDto {
  provider: AgentProvider;
  models: AgentModelDto[];
  refreshedAt: string | null;
  stale: boolean;
}

export interface AgentModelCatalogDto {
  refreshIntervalSeconds: number;
  providers: AgentModelProviderCatalogDto[];
}
export type RequirementStatus = 'todo' | 'doing' | 'waiting_confirmation' | 'done' | 'cancelled';
export type SessionState = 'idle' | 'running' | 'waiting_human' | 'failed' | 'completed';
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled';

export interface AgentSessionDto {
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

export interface RequirementDto {
  id: string;
  title: string;
  description: string;
  status: RequirementStatus;
  provider: AgentProvider;
  model: string | null;
  reasoningEffort: AgentReasoningEffort | null;
  createdBy: 'human' | 'rd_agent';
  parentRequirementId: string | null;
  sourceSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  session: AgentSessionDto;
}

export interface AgentRunDto {
  id: string;
  requirementId: string;
  sessionId: string | null;
  role: 'rd' | 'reviewer';
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
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  outputTokens: number | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface AgentStatisticsDto {
  provider: AgentProvider;
  model: string | null;
  rdRuns: number;
  reviewerRuns: number;
  succeededRuns: number;
  failedRuns: number;
  timedOutRuns: number;
  cancelledRuns: number;
  runsWithTokenUsage: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
}

export interface StatisticsSnapshotDto {
  generatedAt: string;
  range: { from: string | null; to: string; provider: AgentProvider | null };
  summary: {
    rdRuns: number;
    reviewerRuns: number;
    humanMessages: number;
    runsPerHumanMessage: number | null;
    requirementsCreated: number;
    humanCreatedRequirements: number;
    agentCreatedRequirements: number;
    succeededRuns: number;
    failedRuns: number;
    timedOutRuns: number;
    cancelledRuns: number;
    activeRuns: number;
    maxConcurrentRuns: number;
    successRate: number | null;
  };
  tokens: {
    runsWithUsage: number;
    inputTokens: number;
    cachedInputTokens: number;
    cacheCreationInputTokens: number;
    outputTokens: number;
    cacheHitRate: number | null;
  };
  byAgent: AgentStatisticsDto[];
  activity: Array<{
    date: string;
    rdRuns: number;
    humanMessages: number;
    humanCreatedRequirements: number;
    agentCreatedRequirements: number;
    succeededRuns: number;
    failedRuns: number;
    maxConcurrentRuns: number;
  }>;
}

export interface AgentTraceEventDto {
  id: string;
  runId: string;
  sequence: number;
  kind: 'lifecycle' | 'reasoning' | 'assistant_message' | 'tool_call' | 'tool_result' | 'error';
  status: 'started' | 'completed' | 'failed' | null;
  title: string;
  detail: string | null;
  toolName: string | null;
  toolCallId: string | null;
  nativeType: string | null;
  createdAt: string;
}

export interface WorkspaceDto {
  root: string;
  databasePath: string;
  logFilePath: string | null;
}

export interface AgentManagerConfiguration {
  host: string;
  port: number;
  allowedOrigin: string | null;
  openDashboard: boolean;
  databasePath: string | null;
  commitCoAuthorEnabled: boolean;
  pullRequestReconcileIntervalSeconds: number;
  cancelledRequirementRetentionDays: number;
  doneRequirementRetentionDays: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  logFilePath: string | null;
  logMaxSize: string | number;
  logMaxFiles: string | number;
}

export interface AgentManagerConfigurationSnapshot {
  path: string | null;
  values: AgentManagerConfiguration;
  restartRequired: boolean;
  restartRequiredFields: Array<keyof AgentManagerConfiguration>;
}

export interface ManagerEventDto {
  id: number;
  type: string;
  requirementId: string | null;
  sessionId: string | null;
  runId: string | null;
  payload: ManagerEventPayloadDto;
  createdAt: string;
}

export interface ManagerEventPayloadDto extends Record<string, unknown> {
  requirement?: RequirementDto | null;
  requirementIds?: string[];
  run?: AgentRunDto | null;
  trace?: AgentTraceEventDto | null;
  message?: RequirementMessageDto | null;
  pullRequest?: PullRequestDto | null;
  reviewRequest?: ReviewRequestDto | null;
  timer?: AgentTimerDto | null;
  timers?: AgentTimerDto[];
  configuration?: AgentManagerConfigurationSnapshot;
  modelCatalog?: AgentModelCatalogDto;
}

export interface RequirementMessageDto {
  id: string;
  requirementId: string;
  sessionId: string;
  runId: string | null;
  sourceRequirementId: string | null;
  author: 'human' | 'rd_agent' | 'reviewer' | 'system';
  body: string;
  attachments: MessageAttachmentDto[];
  sequence: number;
  deliverToRd: boolean;
  createdAt: string;
}

export interface MessageAttachmentDto {
  id: string;
  requirementId: string;
  messageId: string | null;
  fileName: string;
  kind: 'image' | 'file';
  mediaType: string;
  byteSize: number;
  createdAt: string;
}

export type PullRequestStatus = 'draft' | 'open' | 'closed' | 'merged';

export interface PullRequestDto {
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

export interface ReviewRequestDto {
  id: string;
  pullRequestId: string;
  runId: string;
  provider: AgentProvider;
  model: string | null;
  reasoningEffort: AgentReasoningEffort | null;
  targetHeadSha: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  requestedBy: 'human';
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface AgentTimerDto {
  id: string;
  requirementId: string;
  description: string;
  schedule: 'once' | 'recurring';
  intervalSeconds: number;
  status: 'active' | 'completed' | 'cancelled';
  nextFireAt: string | null;
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SearchResultDto {
  kind: 'requirement' | 'message' | 'pull_request';
  sourceId: string;
  requirementId: string;
  title: string;
  excerpt: string;
  score: number;
  fullTextScore: number;
  vectorScore: number;
  updatedAt: string;
}

export interface RequirementActionAcceptedDto {
  accepted: true;
  requirementId: string;
  action: 'start';
  requirement: RequirementDto;
  run: AgentRunDto | null;
  message: RequirementMessageDto | null;
}

export const DEFAULT_AGENT_MANAGER_URL = 'http://127.0.0.1:4310';

export class AgentManagerApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function normalizeManagerUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('Only HTTP and HTTPS URLs are supported');
  return url.toString().replace(/\/$/, '');
}

export class AgentManagerClient {
  readonly baseUrl: string;

  constructor(baseUrl = DEFAULT_AGENT_MANAGER_URL) {
    this.baseUrl = normalizeManagerUrl(baseUrl);
  }

  getWorkspace(): Promise<WorkspaceDto> {
    return this.request('/api/workspace');
  }

  getConfiguration(): Promise<AgentManagerConfigurationSnapshot> {
    return this.request('/api/configuration');
  }

  listAgentModels(): Promise<AgentModelCatalogDto> {
    return this.request('/api/agent-models');
  }

  updateConfiguration(values: Partial<AgentManagerConfiguration>): Promise<AgentManagerConfigurationSnapshot> {
    return this.request('/api/configuration', { method: 'PATCH', body: JSON.stringify(values) });
  }

  async listRequirements(): Promise<RequirementDto[]> {
    const response = await this.request<{ items: RequirementDto[] }>('/api/requirements');
    return response.items;
  }

  getRequirement(id: string): Promise<RequirementDto> {
    return this.request(`/api/requirements/${encodeURIComponent(id)}`);
  }

  async search(query: string, limit = 100): Promise<SearchResultDto[]> {
    const parameters = new URLSearchParams({ q: query, limit: String(limit) });
    const response = await this.request<{ items: SearchResultDto[] }>(`/api/search?${parameters.toString()}`);
    return response.items;
  }

  async listRuns(requirementId?: string): Promise<AgentRunDto[]> {
    const response = await this.request<{ items: AgentRunDto[] }>(
      requirementId
        ? `/api/runs?${new URLSearchParams({ requirementId }).toString()}`
        : '/api/runs',
    );
    return response.items;
  }

  getStatistics(input: { from?: string; to?: string; provider?: AgentProvider } = {}): Promise<StatisticsSnapshotDto> {
    const parameters = new URLSearchParams();
    if (input.from) parameters.set('from', input.from);
    if (input.to) parameters.set('to', input.to);
    if (input.provider) parameters.set('provider', input.provider);
    const query = parameters.size > 0 ? `?${parameters.toString()}` : '';
    return this.request(`/api/statistics${query}`);
  }

  async listAgentTrace(runId: string): Promise<AgentTraceEventDto[]> {
    const response = await this.request<{ items: AgentTraceEventDto[] }>(
      `/api/runs/${encodeURIComponent(runId)}/trace`,
    );
    return response.items;
  }

  async listRequirementAgentTrace(requirementId: string): Promise<AgentTraceEventDto[]> {
    const response = await this.request<{ items: AgentTraceEventDto[] }>(
      `/api/requirements/${encodeURIComponent(requirementId)}/trace`,
    );
    return response.items;
  }

  async listMessages(requirementId: string): Promise<RequirementMessageDto[]> {
    const response = await this.request<{ items: RequirementMessageDto[] }>(
      `/api/requirements/${encodeURIComponent(requirementId)}/messages`,
    );
    return response.items;
  }

  async listAgentTimers(requirementId?: string): Promise<AgentTimerDto[]> {
    const response = await this.request<{ items: AgentTimerDto[] }>(
      requirementId
        ? `/api/requirements/${encodeURIComponent(requirementId)}/timers`
        : '/api/timers',
    );
    return response.items;
  }

  createAgentTimer(
    requirementId: string,
    input: { description: string; schedule: 'once' | 'recurring'; intervalSeconds: number },
  ): Promise<AgentTimerDto> {
    return this.request(`/api/requirements/${encodeURIComponent(requirementId)}/timers`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  cancelAgentTimer(requirementId: string, timerId: string): Promise<AgentTimerDto> {
    return this.request(
      `/api/requirements/${encodeURIComponent(requirementId)}/timers/${encodeURIComponent(timerId)}`,
      { method: 'DELETE' },
    );
  }

  async listPullRequests(requirementId?: string): Promise<PullRequestDto[]> {
    const response = await this.request<{ items: PullRequestDto[] }>(
      requirementId
        ? `/api/pull-requests?${new URLSearchParams({ requirementId }).toString()}`
        : '/api/pull-requests',
    );
    return response.items;
  }

  async listReviewRequests(pullRequestId?: string): Promise<ReviewRequestDto[]> {
    const response = await this.request<{ items: ReviewRequestDto[] }>(
      pullRequestId
        ? `/api/review-requests?${new URLSearchParams({ pullRequestId }).toString()}`
        : '/api/review-requests',
    );
    return response.items;
  }

  createRequirement(input: { title: string; description: string } & AgentConfiguration): Promise<RequirementDto> {
    return this.request('/api/requirements', { method: 'POST', body: JSON.stringify(input) });
  }

  updateRequirementAgentConfiguration(
    id: string,
    input: RequirementAgentConfigurationUpdate,
  ): Promise<RequirementDto> {
    return this.request(`/api/requirements/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  }

  deleteRequirement(id: string): Promise<void> {
    return this.request(`/api/requirements/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  startRequirement(id: string, message?: string, attachmentIds: string[] = []): Promise<RequirementActionAcceptedDto> {
    return this.action(id, 'start', {
      ...(message ? { message } : {}),
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    });
  }

  replyToRequirement(
    id: string,
    message: string,
    attachmentIds: string[] = [],
  ): Promise<{
    accepted: true;
    queued: boolean;
    message: RequirementMessageDto;
    requirement: RequirementDto;
  }> {
    return this.action(id, 'reply', { message, attachmentIds });
  }

  interruptRequirement(id: string): Promise<{ accepted: true; runId: string }> {
    return this.action(id, 'interrupt', {});
  }

  async uploadMessageAttachment(requirementId: string, file: File): Promise<MessageAttachmentDto> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/requirements/${encodeURIComponent(requirementId)}/attachments`, {
        method: 'POST',
        headers: {
          'content-type': file.type || 'application/octet-stream',
          'x-file-name': encodeURIComponent(file.name || 'attachment'),
        },
        body: file,
      });
    } catch {
      throw new AgentManagerApiError(`Unable to connect to Agent Manager: ${this.baseUrl}`, 0);
    }
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new AgentManagerApiError(body.error || `Attachment upload failed: ${response.status}`, response.status);
    return body as MessageAttachmentDto;
  }

  attachmentUrl(id: string): string {
    return `${this.baseUrl}/api/attachments/${encodeURIComponent(id)}`;
  }

  requestReview(id: string, configuration: AgentConfiguration): Promise<{
    accepted: true;
    reviewRequest: ReviewRequestDto | null;
    run: AgentRunDto | null;
  }> {
    return this.request(`/api/pull-requests/${encodeURIComponent(id)}/review-requests`, {
      method: 'POST',
      body: JSON.stringify(configuration),
    });
  }

  confirmRequirement(id: string): Promise<RequirementDto> {
    return this.action(id, 'confirm', {});
  }

  retryRequirement(id: string): Promise<RequirementActionAcceptedDto> {
    return this.action(id, 'start', { message: 'Continue the previously failed task. Inspect the current repository state first, then finish the remaining work and run the necessary tests.' });
  }

  connectEvents(callbacks: {
    onEvent: (event: ManagerEventDto) => void;
    onOpen: () => void;
    onError: () => void;
  }): () => void {
    const source = new EventSource(`${this.baseUrl}/api/events`);
    const listener = (raw: Event) => {
      try {
        const event = raw as MessageEvent<string>;
        callbacks.onEvent(JSON.parse(event.data) as ManagerEventDto);
      } catch {
        // Ignore malformed event payloads; the next valid event or manual refresh repairs state.
      }
    };
    for (const type of MANAGER_EVENT_TYPES) source.addEventListener(type, listener);
    source.onopen = callbacks.onOpen;
    source.onerror = callbacks.onError;
    return () => {
      for (const type of MANAGER_EVENT_TYPES) source.removeEventListener(type, listener);
      source.close();
    };
  }

  private action<T>(id: string, action: string, body: Record<string, unknown>): Promise<T> {
    return this.request(`/api/requirements/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      const headers = new Headers(init?.headers);
      headers.set('content-type', 'application/json');
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers,
      });
    } catch {
      throw new AgentManagerApiError(`Unable to connect to Agent Manager: ${this.baseUrl}`, 0);
    }
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new AgentManagerApiError(body.error || `Agent Manager returned ${response.status}`, response.status);
    return body as T;
  }
}
