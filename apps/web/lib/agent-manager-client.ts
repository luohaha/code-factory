export type AgentProvider = 'codex' | 'claude-code';
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

export interface WorkspaceDto {
  root: string;
  databasePath: string;
}

export interface ManagerEventDto {
  id: number;
  type: string;
  requirementId: string | null;
  sessionId: string | null;
  runId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface RequirementMessageDto {
  id: string;
  requirementId: string;
  sessionId: string;
  runId: string | null;
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
  targetHeadSha: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  requestedBy: 'human';
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
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
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('仅支持 HTTP 或 HTTPS 地址');
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

  async listRequirements(): Promise<RequirementDto[]> {
    const response = await this.request<{ items: RequirementDto[] }>('/api/requirements');
    return response.items;
  }

  async listRuns(): Promise<AgentRunDto[]> {
    const response = await this.request<{ items: AgentRunDto[] }>('/api/runs');
    return response.items;
  }

  async listMessages(requirementId: string): Promise<RequirementMessageDto[]> {
    const response = await this.request<{ items: RequirementMessageDto[] }>(
      `/api/requirements/${encodeURIComponent(requirementId)}/messages`,
    );
    return response.items;
  }

  async listPullRequests(): Promise<PullRequestDto[]> {
    const response = await this.request<{ items: PullRequestDto[] }>('/api/pull-requests');
    return response.items;
  }

  async listReviewRequests(): Promise<ReviewRequestDto[]> {
    const response = await this.request<{ items: ReviewRequestDto[] }>('/api/review-requests');
    return response.items;
  }

  createRequirement(input: { title: string; description: string; provider: AgentProvider }): Promise<RequirementDto> {
    return this.request('/api/requirements', { method: 'POST', body: JSON.stringify(input) });
  }

  startRequirement(id: string, message?: string, attachmentIds: string[] = []): Promise<{ accepted: true }> {
    return this.action(id, 'start', {
      ...(message ? { message } : {}),
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    });
  }

  replyToRequirement(id: string, message: string, attachmentIds: string[] = []): Promise<{ accepted: true; queued: boolean }> {
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
      throw new AgentManagerApiError(`无法连接 Agent Manager：${this.baseUrl}`, 0);
    }
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new AgentManagerApiError(body.error || `附件上传失败：${response.status}`, response.status);
    return body as MessageAttachmentDto;
  }

  attachmentUrl(id: string): string {
    return `${this.baseUrl}/api/attachments/${encodeURIComponent(id)}`;
  }

  requestReview(id: string, provider: AgentProvider): Promise<{ accepted: true }> {
    return this.request(`/api/pull-requests/${encodeURIComponent(id)}/review-requests`, {
      method: 'POST',
      body: JSON.stringify({ provider }),
    });
  }

  confirmRequirement(id: string): Promise<RequirementDto> {
    return this.action(id, 'confirm', {});
  }

  retryRequirement(id: string): Promise<{ accepted: true }> {
    return this.action(id, 'start', { message: '继续上一次失败的任务。先检查当前仓库状态，再完成剩余工作并运行必要测试。' });
  }

  connectEvents(callbacks: {
    onEvent: (event: ManagerEventDto) => void;
    onOpen: () => void;
    onError: () => void;
  }): () => void {
    const source = new EventSource(`${this.baseUrl}/api/events`);
    const types = [
      'requirement.created',
      'requirement.completed',
      'run.started',
      'run.succeeded',
      'run.failed',
      'run.timed_out',
      'run.cancelled',
      'message.created',
      'pull_request.created',
      'pull_request.updated',
      'review_request.started',
      'manager.reconciled',
    ];
    const listener = (raw: Event) => {
      try {
        const event = raw as MessageEvent<string>;
        callbacks.onEvent(JSON.parse(event.data) as ManagerEventDto);
      } catch {
        // Ignore malformed event payloads; the next valid event or manual refresh repairs state.
      }
    };
    for (const type of types) source.addEventListener(type, listener);
    source.onopen = callbacks.onOpen;
    source.onerror = callbacks.onError;
    return () => {
      for (const type of types) source.removeEventListener(type, listener);
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
      throw new AgentManagerApiError(`无法连接 Agent Manager：${this.baseUrl}`, 0);
    }
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new AgentManagerApiError(body.error || `Agent Manager 返回 ${response.status}`, response.status);
    return body as T;
  }
}
