import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ClaudeCodeAdapter } from './adapters/claude-code.js';
import { CodexAdapter } from './adapters/codex.js';
import type { AgentAdapter } from './adapters/types.js';
import { HeadlessProcessRunner, type AgentProcessRunner, type ProcessRunRequest } from './process-runner.js';
import { SqliteAgentManagerStore } from './sqlite-store.js';
import type { AgentManagerStore } from './store.js';
import { StoreConflictError, StoreNotFoundError } from './store.js';
import type {
  AgentProvider,
  CreateRequirementInput,
  ManagerEvent,
  PullRequest,
  RequirementMessage,
  RequirementWithSession,
  ReviewRequest,
  RunOutcome,
  TrackPullRequestInput,
} from './types.js';

export interface AgentManagerOptions {
  workspaceRoot?: string;
  databasePath?: string;
  store?: AgentManagerStore;
  runner?: AgentProcessRunner;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export function defaultDatabasePath(workspaceRoot: string): string {
  const key = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16);
  return join(homedir(), '.code-factory', 'workspaces', key, 'factory.sqlite');
}

export class AgentManager extends EventEmitter {
  readonly workspaceRoot: string;
  readonly databasePath: string;
  readonly #store: AgentManagerStore;
  readonly #runner: AgentProcessRunner;
  readonly #adapters: Record<AgentProvider, AgentAdapter>;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;
  #apiBaseUrl = 'http://127.0.0.1:4310/api';

  constructor(options: AgentManagerOptions = {}) {
    super();
    this.workspaceRoot = realpathSync(options.workspaceRoot ?? process.cwd());
    this.databasePath = options.databasePath ?? defaultDatabasePath(this.workspaceRoot);
    this.#store = options.store ?? new SqliteAgentManagerStore(this.databasePath);
    this.#runner = options.runner ?? new HeadlessProcessRunner();
    this.#adapters = { codex: new CodexAdapter(), 'claude-code': new ClaudeCodeAdapter() };
    this.#timeoutMs = options.timeoutMs ?? 60 * 60 * 1_000;
    this.#maxOutputBytes = options.maxOutputBytes ?? 2 * 1024 * 1024;
    const reconciled = this.#store.reconcileInterruptedRuns(new Date().toISOString());
    if (reconciled.runIds.length > 0) this.publish({ type: 'manager.reconciled', payload: reconciled });
  }

  setApiBaseUrl(value: string): void {
    this.#apiBaseUrl = value.replace(/\/$/, '');
  }

  close(): void {
    this.#store.close();
  }

  createRequirement(input: CreateRequirementInput): RequirementWithSession {
    const title = input.title.trim();
    const description = input.description.trim();
    if (!title) throw new TypeError('title is required');
    if (!description) throw new TypeError('description is required');
    if (input.createdBy === 'rd_agent') {
      if (!input.sourceSessionId) throw new TypeError('sourceSessionId is required for an Agent-created requirement');
      const source = this.#store.listSessions().find((session) => session.id === input.sourceSessionId);
      if (!source) throw new StoreNotFoundError(`Session ${input.sourceSessionId} not found`);
      if (input.parentRequirementId && input.parentRequirementId !== source.requirementId) {
        throw new TypeError('parentRequirementId must belong to sourceSessionId');
      }
    }
    const now = new Date().toISOString();
    const requirementId = `req_${randomUUID()}`;
    const sessionId = `ses_${randomUUID()}`;
    const requirement = this.#store.createRequirement({
      requirementId,
      sessionId,
      title,
      description,
      provider: input.provider,
      createdBy: input.createdBy ?? 'human',
      ...(input.parentRequirementId ? { parentRequirementId: input.parentRequirementId } : {}),
      ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
      now,
    });
    this.publish({
      type: 'requirement.created',
      requirementId,
      sessionId,
      payload: { provider: input.provider, createdBy: requirement.createdBy },
    });
    return requirement;
  }

  getRequirement(id: string): RequirementWithSession | null {
    return this.#store.getRequirement(id);
  }

  listRequirements(): RequirementWithSession[] {
    return this.#store.listRequirements();
  }

  listSessions() {
    return this.#store.listSessions();
  }

  listRuns(requirementId?: string) {
    return this.#store.listRuns(requirementId);
  }

  listMessages(requirementId: string) {
    return this.#store.listMessages(requirementId);
  }

  listPullRequests(requirementId?: string): PullRequest[] {
    return this.#store.listPullRequests(requirementId);
  }

  listReviewRequests(pullRequestId?: string): ReviewRequest[] {
    return this.#store.listReviewRequests(pullRequestId);
  }

  listEvents(afterId = 0) {
    return this.#store.listEvents(afterId);
  }

  trackPullRequest(input: TrackPullRequestInput): PullRequest {
    this.requireRequirement(input.requirementId);
    if (!input.repository.trim()) throw new TypeError('repository is required');
    if (!Number.isInteger(input.number) || input.number <= 0) throw new TypeError('number must be a positive integer');
    for (const field of ['url', 'title', 'baseBranch', 'headBranch', 'headSha'] as const) {
      if (!input[field].trim()) throw new TypeError(`${field} is required`);
    }
    const previous = this.#store.listPullRequests(input.requirementId)
      .find((item) => item.repository === input.repository && item.number === input.number);
    const pullRequest = this.#store.upsertPullRequest({
      id: previous?.id ?? `pr_${randomUUID()}`,
      ...input,
      now: new Date().toISOString(),
    });
    this.publish({
      type: previous ? 'pull_request.updated' : 'pull_request.created',
      requirementId: pullRequest.requirementId,
      sessionId: this.requireRequirement(pullRequest.requirementId).session.id,
      payload: { pullRequest },
    });
    return pullRequest;
  }

  /** Starts a requirement or explicitly retries it. Human messages are persisted before any Run starts. */
  runRequirement(requirementId: string, humanMessage?: string): Promise<RequirementWithSession> {
    const requirement = this.requireRequirement(requirementId);
    if (humanMessage?.trim()) {
      this.appendMessage({
        requirementId,
        sessionId: requirement.session.id,
        author: 'human',
        body: humanMessage,
        deliverToRd: true,
      });
    }
    const current = this.requireRequirement(requirementId);
    if (current.session.state === 'running') return Promise.resolve(current);
    return this.startRdRun(requirementId);
  }

  postHumanMessage(requirementId: string, body: string): { message: RequirementMessage; queued: boolean } {
    const requirement = this.requireRequirement(requirementId);
    if (requirement.status === 'done' || requirement.status === 'cancelled') {
      throw new StoreConflictError(`Requirement ${requirementId} is already ${requirement.status}`);
    }
    const message = this.appendMessage({
      requirementId,
      sessionId: requirement.session.id,
      author: 'human',
      body,
      deliverToRd: true,
    });
    const queued = requirement.session.state === 'running';
    if (!queued) void this.startRdRun(requirementId).catch((error: unknown) => console.error('RD run failed:', error));
    return { message, queued };
  }

  requestReview(
    pullRequestId: string,
    options: { provider: AgentProvider; prompt?: string },
  ): Promise<RunOutcome> {
    const pullRequest = this.requirePullRequest(pullRequestId);
    const requirement = this.requireRequirement(pullRequest.requirementId);
    const runId = `run_${randomUUID()}`;
    const reviewRequestId = `rev_${randomUUID()}`;
    this.#store.beginReviewRequest({
      id: reviewRequestId,
      runId,
      pullRequestId,
      requirementId: requirement.id,
      provider: options.provider,
      targetHeadSha: pullRequest.headSha,
      taskSummary: `Review ${pullRequest.repository}#${pullRequest.number} at ${pullRequest.headSha.slice(0, 8)}`,
      now: new Date().toISOString(),
    });
    this.publish({
      type: 'review_request.started',
      requirementId: requirement.id,
      sessionId: requirement.session.id,
      runId,
      payload: { reviewRequestId, pullRequestId, provider: options.provider, targetHeadSha: pullRequest.headSha },
    });

    const adapter = this.#adapters[options.provider];
    let lastReviewerMessage = '';
    const prompt = [
      `Review GitHub pull request ${pullRequest.url} at immutable head SHA ${pullRequest.headSha}.`,
      'Use GitHub CLI/API to read the PR diff without checking out or modifying the shared working tree.',
      'Publish actionable findings as GitHub review comments at the corresponding file and line whenever possible.',
      'Do not change code. End with a concise summary including links or identifiers for comments you published.',
      options.prompt?.trim() || 'Focus on correctness, regressions, security, and missing tests.',
    ].join('\n');
    return this.execute({
      invocation: adapter.buildReviewInvocation({
        baseBranch: pullRequest.baseBranch,
        prompt,
        developerInstructions: 'You are a short-lived PR reviewer. Review only; do not edit code. Use the native review workflow and publish findings to the specified GitHub PR.',
      }),
      adapter,
      workspaceRoot: this.workspaceRoot,
      timeoutMs: Math.min(this.#timeoutMs, 30 * 60 * 1_000),
      maxOutputBytes: this.#maxOutputBytes,
      onOutput: (line) => this.emit('output', { runId, line }),
      onEvent: (event) => {
        if (!event.message || (event.kind !== 'message' && event.kind !== 'completed')) return;
        const body = event.message.trim();
        if (body) lastReviewerMessage = body;
      },
    }).then((outcome) => {
      this.#store.finishReviewRequest(reviewRequestId, outcome, new Date().toISOString());
      if (outcome.status === 'succeeded') {
        this.appendMessage({
          requirementId: requirement.id,
          sessionId: requirement.session.id,
          runId,
          author: 'reviewer',
          body: lastReviewerMessage || outcome.finalMessage || `Review completed for ${pullRequest.url} at ${pullRequest.headSha}.`,
          deliverToRd: true,
        });
      } else {
        this.appendMessage({
          requirementId: requirement.id,
          sessionId: requirement.session.id,
          runId,
          author: 'system',
          body: outcome.error ?? `Reviewer Run ${outcome.status}`,
          deliverToRd: false,
        });
      }
      this.publishOutcome(requirement.id, requirement.session.id, runId, 'reviewer', outcome);
      if (outcome.status === 'succeeded') this.schedulePendingRdMessages(requirement.id);
      return outcome;
    });
  }

  confirmRequirement(requirementId: string): RequirementWithSession {
    const current = this.#store.transitionRequirement(
      requirementId,
      ['waiting_confirmation'],
      'done',
      new Date().toISOString(),
    );
    this.publish({ type: 'requirement.completed', requirementId, sessionId: current.session.id, payload: {} });
    return current;
  }

  private startRdRun(requirementId: string): Promise<RequirementWithSession> {
    const requirement = this.requireRequirement(requirementId);
    const pendingMessages = this.#store.listPendingRdMessages(requirementId);
    const runId = `run_${randomUUID()}`;
    const isResume = requirement.session.nativeSessionId !== null;
    const inputFromSequence = pendingMessages.at(0)?.sequence;
    const inputToSequence = pendingMessages.at(-1)?.sequence;
    const prompt = this.buildRdPrompt(requirement, pendingMessages, isResume);
    const started = this.#store.beginRun({
      runId,
      requirementId,
      role: 'rd',
      provider: requirement.provider,
      taskSummary: pendingMessages.length > 0
        ? `Process ${pendingMessages.length} new conversation message${pendingMessages.length === 1 ? '' : 's'}`
        : isResume ? 'Resume RD session' : 'Start RD session',
      ...(inputFromSequence === undefined ? {} : { inputFromSequence }),
      ...(inputToSequence === undefined ? {} : { inputToSequence }),
      now: new Date().toISOString(),
    });
    this.publish({
      type: 'run.started',
      requirementId,
      sessionId: started.session.id,
      runId,
      payload: {
        role: 'rd',
        provider: requirement.provider,
        resumed: isResume,
        inputFromSequence: inputFromSequence ?? null,
        inputToSequence: inputToSequence ?? null,
      },
    });

    const adapter = this.#adapters[requirement.provider];
    let lastAgentMessage = '';
    return this.execute({
      invocation: adapter.buildRdInvocation({
        prompt,
        nativeSessionId: requirement.session.nativeSessionId,
        developerInstructions: this.buildRdDeveloperInstructions(requirement),
      }),
      adapter,
      workspaceRoot: this.workspaceRoot,
      timeoutMs: this.#timeoutMs,
      maxOutputBytes: this.#maxOutputBytes,
      onNativeSession: (nativeSessionId) => {
        this.#store.setNativeSessionId(started.session.id, nativeSessionId, new Date().toISOString());
      },
      onOutput: (line) => this.emit('output', { runId, line }),
      onEvent: (event) => {
        if (!event.message || (event.kind !== 'message' && event.kind !== 'completed')) return;
        const body = event.message.trim();
        if (!body || body === lastAgentMessage) return;
        lastAgentMessage = body;
        this.appendMessage({
          requirementId,
          sessionId: started.session.id,
          runId,
          author: 'rd_agent',
          body,
          deliverToRd: false,
        });
      },
    }).then((outcome) => {
      const current = this.#store.finishRdRun(runId, outcome, new Date().toISOString());
      if (outcome.status !== 'succeeded') {
        this.appendMessage({
          requirementId,
          sessionId: current.session.id,
          runId,
          author: 'system',
          body: outcome.error ?? `Agent Run ${outcome.status}`,
          deliverToRd: false,
        });
      }
      this.publishOutcome(requirementId, current.session.id, runId, 'rd', outcome);
      if (outcome.status === 'succeeded') this.schedulePendingRdMessages(requirementId);
      return current;
    });
  }

  private schedulePendingRdMessages(requirementId: string): void {
    queueMicrotask(() => {
      const current = this.requireRequirement(requirementId);
      if (current.status === 'done' || current.status === 'cancelled' || current.session.state === 'running') return;
      if (this.#store.listPendingRdMessages(requirementId).length === 0) return;
      void this.startRdRun(requirementId).catch((error: unknown) => console.error('RD run failed:', error));
    });
  }

  private buildRdPrompt(
    requirement: RequirementWithSession,
    messages: RequirementMessage[],
    isResume: boolean,
  ): string {
    const incoming = messages.map((message) => {
      const author = message.author === 'human' ? 'Human' : message.author === 'reviewer' ? 'Reviewer' : 'System';
      return `[${author} #${message.sequence}]\n${message.body}`;
    }).join('\n\n');
    if (!isResume) {
      return [
        'Implement the following requirement. Inspect repository instructions, modify code, run necessary tests, and report the result.',
        `Title: ${requirement.title}`,
        `Description:\n${requirement.description}`,
        incoming ? `New requirement conversation messages:\n\n${incoming}` : '',
      ].filter(Boolean).join('\n\n');
    }
    return incoming
      ? `Process these new external messages from the requirement conversation. Your own previous output is already in this session and is intentionally omitted.\n\n${incoming}`
      : 'Continue the current requirement. Inspect the current repository state, complete remaining work, and run necessary tests.';
  }

  private buildRdDeveloperInstructions(requirement: RequirementWithSession): string {
    return [
      'You are the long-lived RD Agent for one Code Factory requirement.',
      `Requirement ID: ${requirement.id}`,
      `Agent Session ID: ${requirement.session.id}`,
      `Code Factory API base URL: ${this.#apiBaseUrl}`,
      'When you create or update a GitHub pull request, register its current state by POSTing JSON to /agent/pull-requests.',
      `The payload must include requirementId=${requirement.id}, repository, number, url, title, baseBranch, headBranch, headSha, and status (draft|open|closed|merged).`,
      'When you discover separate follow-up work, you may propose a new TODO requirement by POSTing JSON to /agent/requirements.',
      `Include sourceSessionId=${requirement.session.id}, parentRequirementId=${requirement.id}, title, description, and optionally provider (defaults to your provider).`,
      'Agent-created requirements are proposals and do not start automatically.',
    ].join('\n');
  }

  private requireRequirement(id: string): RequirementWithSession {
    const value = this.#store.getRequirement(id);
    if (!value) throw new StoreNotFoundError(`Requirement ${id} not found`);
    return value;
  }

  private requirePullRequest(id: string): PullRequest {
    const value = this.#store.getPullRequest(id);
    if (!value) throw new StoreNotFoundError(`Pull request ${id} not found`);
    return value;
  }

  private publish(input: {
    type: string;
    requirementId?: string;
    sessionId?: string;
    runId?: string;
    payload?: Record<string, unknown>;
  }): ManagerEvent {
    const event = this.#store.appendEvent({ ...input, now: new Date().toISOString() });
    this.emit('event', event);
    return event;
  }

  private publishOutcome(
    requirementId: string,
    sessionId: string,
    runId: string,
    role: 'rd' | 'reviewer',
    outcome: RunOutcome,
  ): void {
    this.publish({
      type: `run.${outcome.status}`,
      requirementId,
      sessionId,
      runId,
      payload: {
        role,
        exitCode: outcome.exitCode,
        nativeSessionId: outcome.nativeSessionId,
        finalMessage: outcome.finalMessage,
        error: outcome.error,
      },
    });
  }

  private appendMessage(input: {
    requirementId: string;
    sessionId: string;
    runId?: string;
    author: 'human' | 'rd_agent' | 'reviewer' | 'system';
    body: string;
    deliverToRd: boolean;
  }): RequirementMessage {
    const message = this.#store.appendMessage({
      id: `msg_${randomUUID()}`,
      ...input,
      now: new Date().toISOString(),
    });
    this.publish({
      type: 'message.created',
      requirementId: message.requirementId,
      sessionId: message.sessionId,
      ...(message.runId ? { runId: message.runId } : {}),
      payload: { message },
    });
    return message;
  }

  private execute(request: ProcessRunRequest): Promise<RunOutcome> {
    return this.#runner.run(request).catch((error: unknown) => ({
      status: 'failed',
      exitCode: null,
      nativeSessionId: null,
      finalMessage: null,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}
