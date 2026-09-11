import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { schemaStatements } from './schema.js';
import {
  type AgentManagerStore,
  type AppendMessageRecord,
  type AppendEventRecord,
  type BeginReviewRequestRecord,
  type BeginRunRecord,
  type CreateRequirementRecord,
  type UpsertPullRequestRecord,
  StoreConflictError,
  StoreNotFoundError,
} from './store.js';
import type {
  AgentRun,
  AgentSession,
  ManagerEvent,
  Requirement,
  RequirementMessage,
  PullRequest,
  ReviewRequest,
  RequirementStatus,
  RequirementWithSession,
  RunOutcome,
  SessionState,
} from './types.js';

type Row = Record<string, SQLInputValue>;

function requirementFrom(row: Row): Requirement {
  return {
    id: String(row.id),
    title: String(row.title),
    description: String(row.description),
    status: String(row.status) as Requirement['status'],
    provider: String(row.provider) as Requirement['provider'],
    createdBy: String(row.created_by) as Requirement['createdBy'],
    parentRequirementId: row.parent_requirement_id === null ? null : String(row.parent_requirement_id),
    sourceSessionId: row.source_session_id === null ? null : String(row.source_session_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
  };
}

function sessionFrom(row: Row, prefix = ''): AgentSession {
  return {
    id: String(row[`${prefix}id`]),
    requirementId: String(row[`${prefix}requirement_id`]),
    provider: String(row[`${prefix}provider`]) as AgentSession['provider'],
    nativeSessionId: row[`${prefix}native_session_id`] === null ? null : String(row[`${prefix}native_session_id`]),
    state: String(row[`${prefix}state`]) as AgentSession['state'],
    lastError: row[`${prefix}last_error`] === null ? null : String(row[`${prefix}last_error`]),
    lastConsumedMessageSequence: Number(row[`${prefix}last_consumed_message_sequence`] ?? 0),
    pendingMessageCount: Number(row[`${prefix}pending_message_count`] ?? 0),
    createdAt: String(row[`${prefix}created_at`]),
    updatedAt: String(row[`${prefix}updated_at`]),
  };
}

function runFrom(row: Row): AgentRun {
  return {
    id: String(row.id),
    requirementId: String(row.requirement_id),
    sessionId: row.session_id === null ? null : String(row.session_id),
    role: String(row.role) as AgentRun['role'],
    provider: String(row.provider) as AgentRun['provider'],
    status: String(row.status) as AgentRun['status'],
    taskSummary: String(row.task_summary),
    nativeSessionId: row.native_session_id === null ? null : String(row.native_session_id),
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    error: row.error === null ? null : String(row.error),
    inputFromSequence: row.input_from_sequence === null ? null : Number(row.input_from_sequence),
    inputToSequence: row.input_to_sequence === null ? null : Number(row.input_to_sequence),
    startedAt: String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
  };
}

function eventFrom(row: Row): ManagerEvent {
  return {
    id: Number(row.id),
    type: String(row.type),
    requirementId: row.requirement_id === null ? null : String(row.requirement_id),
    sessionId: row.session_id === null ? null : String(row.session_id),
    runId: row.run_id === null ? null : String(row.run_id),
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    createdAt: String(row.created_at),
  };
}

function messageFrom(row: Row): RequirementMessage {
  return {
    id: String(row.id),
    requirementId: String(row.requirement_id),
    sessionId: String(row.session_id),
    runId: row.run_id === null ? null : String(row.run_id),
    author: String(row.author) as RequirementMessage['author'],
    body: String(row.body),
    sequence: Number(row.sequence),
    deliverToRd: Number(row.deliver_to_rd) === 1,
    createdAt: String(row.created_at),
  };
}

function pullRequestFrom(row: Row): PullRequest {
  return {
    id: String(row.id),
    requirementId: String(row.requirement_id),
    repository: String(row.repository),
    number: Number(row.number),
    url: String(row.url),
    title: String(row.title),
    baseBranch: String(row.base_branch),
    headBranch: String(row.head_branch),
    headSha: String(row.head_sha),
    status: String(row.status) as PullRequest['status'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function reviewRequestFrom(row: Row): ReviewRequest {
  return {
    id: String(row.id),
    pullRequestId: String(row.pull_request_id),
    runId: String(row.run_id),
    provider: String(row.provider) as ReviewRequest['provider'],
    targetHeadSha: String(row.target_head_sha),
    status: String(row.status) as ReviewRequest['status'],
    requestedBy: 'human',
    error: row.error === null ? null : String(row.error),
    createdAt: String(row.created_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
  };
}

export class SqliteAgentManagerStore implements AgentManagerStore {
  readonly #db: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
    this.#db = new DatabaseSync(databasePath);
    this.#db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    for (const statement of schemaStatements) this.#db.exec(statement);
    this.migrateLegacySchema();
    this.#db.exec('PRAGMA optimize;');
  }

  close(): void {
    this.#db.close();
  }

  createRequirement(input: CreateRequirementRecord): RequirementWithSession {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare(`INSERT INTO requirements
        (id, title, description, status, provider, created_by, parent_requirement_id, source_session_id, created_at, updated_at)
        VALUES (?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?)`)
        .run(input.requirementId, input.title, input.description, input.provider, input.createdBy ?? 'human',
          input.parentRequirementId ?? null, input.sourceSessionId ?? null, input.now, input.now);
      this.#db.prepare(`INSERT INTO agent_sessions
        (id, requirement_id, provider, state, created_at, updated_at)
        VALUES (?, ?, ?, 'idle', ?, ?)`)
        .run(input.sessionId, input.requirementId, input.provider, input.now, input.now);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return this.requireBundle(input.requirementId);
  }

  getRequirement(id: string): RequirementWithSession | null {
    const row = this.#db.prepare(`SELECT
      r.*, s.id AS s_id, s.requirement_id AS s_requirement_id, s.provider AS s_provider,
      s.native_session_id AS s_native_session_id, s.state AS s_state, s.last_error AS s_last_error,
      s.last_consumed_message_sequence AS s_last_consumed_message_sequence,
      (SELECT COUNT(*) FROM requirement_messages m WHERE m.requirement_id = r.id
        AND m.deliver_to_rd = 1 AND m.sequence > s.last_consumed_message_sequence) AS s_pending_message_count,
      s.created_at AS s_created_at, s.updated_at AS s_updated_at
      FROM requirements r JOIN agent_sessions s ON s.requirement_id = r.id WHERE r.id = ?`).get(id) as Row | undefined;
    if (!row) return null;
    return { ...requirementFrom(row), session: sessionFrom(row, 's_') };
  }

  listRequirements(): RequirementWithSession[] {
    const rows = this.#db.prepare(`SELECT
      r.*, s.id AS s_id, s.requirement_id AS s_requirement_id, s.provider AS s_provider,
      s.native_session_id AS s_native_session_id, s.state AS s_state, s.last_error AS s_last_error,
      s.last_consumed_message_sequence AS s_last_consumed_message_sequence,
      (SELECT COUNT(*) FROM requirement_messages m WHERE m.requirement_id = r.id
        AND m.deliver_to_rd = 1 AND m.sequence > s.last_consumed_message_sequence) AS s_pending_message_count,
      s.created_at AS s_created_at, s.updated_at AS s_updated_at
      FROM requirements r JOIN agent_sessions s ON s.requirement_id = r.id
      WHERE r.status != 'cancelled' ORDER BY r.updated_at DESC`).all() as Row[];
    return rows.map((row) => ({ ...requirementFrom(row), session: sessionFrom(row, 's_') }));
  }

  listSessions(): AgentSession[] {
    return (this.#db.prepare('SELECT * FROM agent_sessions ORDER BY updated_at DESC').all() as Row[]).map((row) => sessionFrom(row));
  }

  listRuns(requirementId?: string): AgentRun[] {
    const rows = requirementId
      ? this.#db.prepare('SELECT * FROM agent_runs WHERE requirement_id = ? ORDER BY started_at DESC').all(requirementId)
      : this.#db.prepare('SELECT * FROM agent_runs ORDER BY started_at DESC').all();
    return (rows as Row[]).map(runFrom);
  }

  appendMessage(input: AppendMessageRecord): RequirementMessage {
    const body = input.body.trim();
    if (!body) throw new TypeError('Message body cannot be empty');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const next = this.#db.prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
        FROM requirement_messages WHERE requirement_id = ?`).get(input.requirementId) as Row;
      this.#db.prepare(`INSERT INTO requirement_messages
        (id, requirement_id, session_id, run_id, author, body, sequence, deliver_to_rd, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.id, input.requirementId, input.sessionId, input.runId ?? null, input.author,
          body, Number(next.sequence), (input.deliverToRd ?? (input.author === 'human' || input.author === 'reviewer')) ? 1 : 0, input.now);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    const row = this.#db.prepare('SELECT * FROM requirement_messages WHERE id = ?').get(input.id) as Row;
    return messageFrom(row);
  }

  listMessages(requirementId: string): RequirementMessage[] {
    if (!this.getRequirement(requirementId)) throw new StoreNotFoundError(`Requirement ${requirementId} not found`);
    return (this.#db.prepare(`SELECT * FROM requirement_messages
      WHERE requirement_id = ? ORDER BY sequence ASC`).all(requirementId) as Row[]).map(messageFrom);
  }

  listPendingRdMessages(requirementId: string): RequirementMessage[] {
    const bundle = this.requireBundle(requirementId);
    return (this.#db.prepare(`SELECT * FROM requirement_messages
      WHERE requirement_id = ? AND deliver_to_rd = 1 AND sequence > ? ORDER BY sequence ASC`)
      .all(requirementId, bundle.session.lastConsumedMessageSequence) as Row[]).map(messageFrom);
  }

  upsertPullRequest(input: UpsertPullRequestRecord): PullRequest {
    this.requireBundle(input.requirementId);
    this.#db.prepare(`INSERT INTO pull_requests
      (id, requirement_id, repository, number, url, title, base_branch, head_branch, head_sha, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repository, number) DO UPDATE SET
        requirement_id = excluded.requirement_id, url = excluded.url, title = excluded.title,
        base_branch = excluded.base_branch, head_branch = excluded.head_branch,
        head_sha = excluded.head_sha, status = excluded.status, updated_at = excluded.updated_at`)
      .run(input.id, input.requirementId, input.repository, input.number, input.url, input.title,
        input.baseBranch, input.headBranch, input.headSha, input.status, input.now, input.now);
    return pullRequestFrom(this.#db.prepare('SELECT * FROM pull_requests WHERE repository = ? AND number = ?')
      .get(input.repository, input.number) as Row);
  }

  getPullRequest(id: string): PullRequest | null {
    const row = this.#db.prepare('SELECT * FROM pull_requests WHERE id = ?').get(id) as Row | undefined;
    return row ? pullRequestFrom(row) : null;
  }

  listPullRequests(requirementId?: string): PullRequest[] {
    const rows = requirementId
      ? this.#db.prepare('SELECT * FROM pull_requests WHERE requirement_id = ? ORDER BY updated_at DESC').all(requirementId)
      : this.#db.prepare('SELECT * FROM pull_requests ORDER BY updated_at DESC').all();
    return (rows as Row[]).map(pullRequestFrom);
  }

  beginReviewRequest(input: BeginReviewRequestRecord): { pullRequest: PullRequest; reviewRequest: ReviewRequest; run: AgentRun } {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const pullRequest = this.getPullRequest(input.pullRequestId);
      if (!pullRequest) throw new StoreNotFoundError(`Pull request ${input.pullRequestId} not found`);
      if (pullRequest.status !== 'open') throw new StoreConflictError(`Pull request ${input.pullRequestId} is ${pullRequest.status}`);
      this.#db.prepare(`INSERT INTO agent_runs
        (id, requirement_id, session_id, role, provider, status, task_summary, started_at)
        VALUES (?, ?, NULL, 'reviewer', ?, 'running', ?, ?)`)
        .run(input.runId, input.requirementId, input.provider, input.taskSummary, input.now);
      this.#db.prepare(`INSERT INTO review_requests
        (id, pull_request_id, run_id, provider, target_head_sha, status, requested_by, created_at)
        VALUES (?, ?, ?, ?, ?, 'running', 'human', ?)`)
        .run(input.id, input.pullRequestId, input.runId, input.provider, input.targetHeadSha, input.now);
      this.#db.exec('COMMIT');
      return {
        pullRequest,
        reviewRequest: this.requireReviewRequest(input.id),
        run: this.requireRun(input.runId),
      };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      if (error instanceof Error && (error.message.includes('one_active_review_per_pull_request')
        || error.message.includes('review_requests.pull_request_id'))) {
        throw new StoreConflictError(`Pull request ${input.pullRequestId} already has an active review`);
      }
      throw error;
    }
  }

  finishReviewRequest(id: string, outcome: RunOutcome, now: string): ReviewRequest {
    const review = this.requireReviewRequest(id);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.updateRun(review.runId, outcome, now);
      this.#db.prepare(`UPDATE review_requests SET status = ?, error = ?, finished_at = ?
        WHERE id = ? AND status = 'running'`)
        .run(outcome.status === 'timed_out' ? 'failed' : outcome.status, outcome.error, now, id);
      this.#db.exec('COMMIT');
      return this.requireReviewRequest(id);
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  listReviewRequests(pullRequestId?: string): ReviewRequest[] {
    const rows = pullRequestId
      ? this.#db.prepare('SELECT * FROM review_requests WHERE pull_request_id = ? ORDER BY created_at DESC').all(pullRequestId)
      : this.#db.prepare('SELECT * FROM review_requests ORDER BY created_at DESC').all();
    return (rows as Row[]).map(reviewRequestFrom);
  }

  beginRun(input: BeginRunRecord): { requirement: Requirement; session: AgentSession; run: AgentRun } {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const bundle = this.requireBundle(input.requirementId);
      if (bundle.status === 'done' || bundle.status === 'cancelled') {
        throw new StoreConflictError(`Requirement ${input.requirementId} is already ${bundle.status}`);
      }

      if (input.role === 'rd') {
        if (bundle.session.state === 'running') {
          throw new StoreConflictError(`Session ${bundle.session.id} already has an active run`);
        }
        this.#db.prepare("UPDATE requirements SET status = 'doing', updated_at = ? WHERE id = ?")
          .run(input.now, input.requirementId);
        this.#db.prepare("UPDATE agent_sessions SET state = 'running', last_error = NULL, updated_at = ? WHERE id = ?")
          .run(input.now, bundle.session.id);
      }

      this.#db.prepare(`INSERT INTO agent_runs
        (id, requirement_id, session_id, role, provider, status, task_summary, input_from_sequence, input_to_sequence, started_at)
        VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`)
        .run(
          input.runId,
          input.requirementId,
          input.role === 'rd' ? bundle.session.id : null,
          input.role,
          input.provider,
          input.taskSummary,
          input.inputFromSequence ?? null,
          input.inputToSequence ?? null,
          input.now,
        );
      this.#db.exec('COMMIT');
      const current = this.requireBundle(input.requirementId);
      return { requirement: current, session: current.session, run: this.requireRun(input.runId) };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      if (error instanceof Error && error.message.includes('one_active_')) {
        throw new StoreConflictError('This Agent session already has an incompatible active run');
      }
      throw error;
    }
  }

  finishRdRun(runId: string, outcome: RunOutcome, now: string): RequirementWithSession {
    const run = this.requireRun(runId);
    if (run.role !== 'rd' || !run.sessionId) throw new StoreConflictError(`${runId} is not an RD run`);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.updateRun(runId, outcome, now);
      if (outcome.status === 'succeeded') {
        this.#db.prepare("UPDATE requirements SET status = 'waiting_confirmation', updated_at = ? WHERE id = ?")
          .run(now, run.requirementId);
        this.#db.prepare(`UPDATE agent_sessions SET state = 'waiting_human', last_error = NULL,
          native_session_id = COALESCE(?, native_session_id),
          last_consumed_message_sequence = MAX(last_consumed_message_sequence, COALESCE(?, last_consumed_message_sequence)),
          updated_at = ? WHERE id = ?`)
          .run(outcome.nativeSessionId, run.inputToSequence, now, run.sessionId);
      } else {
        this.#db.prepare("UPDATE agent_sessions SET state = 'failed', last_error = ?, native_session_id = COALESCE(?, native_session_id), updated_at = ? WHERE id = ?")
          .run(outcome.error ?? `Run ${outcome.status}`, outcome.nativeSessionId, now, run.sessionId);
        this.#db.prepare("UPDATE requirements SET status = 'doing', updated_at = ? WHERE id = ?")
          .run(now, run.requirementId);
      }
      this.#db.exec('COMMIT');
      return this.requireBundle(run.requirementId);
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  finishReviewRun(runId: string, outcome: RunOutcome, now: string): AgentRun {
    const run = this.requireRun(runId);
    if (run.role !== 'reviewer') throw new StoreConflictError(`${runId} is not a reviewer run`);
    this.updateRun(runId, outcome, now);
    return this.requireRun(runId);
  }

  setNativeSessionId(sessionId: string, nativeSessionId: string, now: string): void {
    const result = this.#db.prepare('UPDATE agent_sessions SET native_session_id = ?, updated_at = ? WHERE id = ?')
      .run(nativeSessionId, now, sessionId);
    if (result.changes === 0) throw new StoreNotFoundError(`Session ${sessionId} not found`);
  }

  moveSession(requirementId: string, state: SessionState, now: string, lastError: string | null = null): AgentSession {
    const result = this.#db.prepare('UPDATE agent_sessions SET state = ?, last_error = ?, updated_at = ? WHERE requirement_id = ?')
      .run(state, lastError, now, requirementId);
    if (result.changes === 0) throw new StoreNotFoundError(`Requirement ${requirementId} not found`);
    return this.requireBundle(requirementId).session;
  }

  transitionRequirement(requirementId: string, expected: RequirementStatus[], next: RequirementStatus, now: string): RequirementWithSession {
    if (expected.length === 0) throw new StoreConflictError('At least one expected status is required');
    const placeholders = expected.map(() => '?').join(', ');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.#db.prepare(`UPDATE requirements SET status = ?, updated_at = ?, completed_at = ?
        WHERE id = ? AND status IN (${placeholders})`)
        .run(next, now, next === 'done' ? now : null, requirementId, ...expected);
      if (result.changes === 0) {
        if (!this.getRequirement(requirementId)) throw new StoreNotFoundError(`Requirement ${requirementId} not found`);
        throw new StoreConflictError(`Requirement ${requirementId} cannot transition to ${next}`);
      }
      if (next === 'done') {
        this.#db.prepare("UPDATE agent_sessions SET state = 'completed', last_error = NULL, updated_at = ? WHERE requirement_id = ?")
          .run(now, requirementId);
      }
      this.#db.exec('COMMIT');
      return this.requireBundle(requirementId);
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  appendEvent(input: AppendEventRecord): ManagerEvent {
    const result = this.#db.prepare(`INSERT INTO manager_events
      (type, requirement_id, session_id, run_id, payload_json, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING`)
      .run(
        input.type,
        input.requirementId ?? null,
        input.sessionId ?? null,
        input.runId ?? null,
        JSON.stringify(input.payload ?? {}),
        input.idempotencyKey ?? null,
        input.now,
      );
    if (result.changes === 0 && input.idempotencyKey) {
      const row = this.#db.prepare('SELECT * FROM manager_events WHERE idempotency_key = ?').get(input.idempotencyKey) as Row;
      return eventFrom(row);
    }
    const row = this.#db.prepare('SELECT * FROM manager_events WHERE id = ?').get(result.lastInsertRowid) as Row;
    return eventFrom(row);
  }

  listEvents(afterId: number, limit = 200): ManagerEvent[] {
    const safeLimit = Math.max(1, Math.min(limit, 1_000));
    return (this.#db.prepare('SELECT * FROM manager_events WHERE id > ? ORDER BY id ASC LIMIT ?').all(afterId, safeLimit) as Row[])
      .map(eventFrom);
  }

  reconcileInterruptedRuns(now: string): { runIds: string[]; requirementIds: string[] } {
    const active = this.#db.prepare("SELECT id, requirement_id, role FROM agent_runs WHERE status = 'running'").all() as Row[];
    if (active.length === 0) return { runIds: [], requirementIds: [] };
    const runIds = active.map((row) => String(row.id));
    const requirementIds = [...new Set(active.map((row) => String(row.requirement_id)))];
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare(`UPDATE agent_runs SET status = 'failed', exit_code = NULL,
        error = 'Agent Manager restarted before this Run completed', finished_at = ?
        WHERE status = 'running'`).run(now);
      this.#db.prepare(`UPDATE review_requests SET status = 'failed',
        error = 'Agent Manager restarted before this Review completed', finished_at = ?
        WHERE status = 'running'`).run(now);
      const rdRequirementIds = [...new Set(active
        .filter((row) => String(row.role) === 'rd')
        .map((row) => String(row.requirement_id)))];
      for (const requirementId of rdRequirementIds) {
        this.#db.prepare(`UPDATE agent_sessions SET state = 'failed',
          last_error = 'Agent Manager restarted before the active Run completed', updated_at = ?
          WHERE requirement_id = ?`).run(now, requirementId);
        this.#db.prepare("UPDATE requirements SET status = 'doing', updated_at = ? WHERE id = ? AND status NOT IN ('done', 'cancelled')")
          .run(now, requirementId);
      }
      this.#db.exec('COMMIT');
      return { runIds, requirementIds };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  private requireBundle(id: string): RequirementWithSession {
    const bundle = this.getRequirement(id);
    if (!bundle) throw new StoreNotFoundError(`Requirement ${id} not found`);
    return bundle;
  }

  private requireRun(id: string): AgentRun {
    const row = this.#db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new StoreNotFoundError(`Run ${id} not found`);
    return runFrom(row);
  }

  private requireReviewRequest(id: string): ReviewRequest {
    const row = this.#db.prepare('SELECT * FROM review_requests WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new StoreNotFoundError(`Review request ${id} not found`);
    return reviewRequestFrom(row);
  }

  private migrateLegacySchema(): void {
    const ensureColumn = (table: string, column: string, definition: string): boolean => {
      const columns = this.#db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
      if (columns.some((value) => String(value.name) === column)) return false;
      this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      return true;
    };
    ensureColumn('requirements', 'created_by', "TEXT NOT NULL DEFAULT 'human' CHECK (created_by IN ('human', 'rd_agent'))");
    ensureColumn('requirements', 'parent_requirement_id', 'TEXT REFERENCES requirements(id) ON DELETE SET NULL');
    ensureColumn('requirements', 'source_session_id', 'TEXT');
    ensureColumn('agent_sessions', 'last_consumed_message_sequence', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn('agent_runs', 'input_from_sequence', 'INTEGER');
    ensureColumn('agent_runs', 'input_to_sequence', 'INTEGER');
    const sequenceAdded = ensureColumn('requirement_messages', 'sequence', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn('requirement_messages', 'deliver_to_rd', 'INTEGER NOT NULL DEFAULT 0 CHECK (deliver_to_rd IN (0, 1))');
    this.#db.prepare("UPDATE agent_sessions SET state = 'waiting_human' WHERE state = 'waiting_review'").run();
    if (sequenceAdded) {
      const requirements = this.#db.prepare('SELECT DISTINCT requirement_id FROM requirement_messages').all() as Row[];
      for (const requirement of requirements) {
        const requirementId = String(requirement.requirement_id);
        const messages = this.#db.prepare(`SELECT rowid FROM requirement_messages
          WHERE requirement_id = ? ORDER BY created_at ASC, id ASC`).all(requirementId) as Row[];
        messages.forEach((message, index) => {
          this.#db.prepare(`UPDATE requirement_messages SET sequence = ?,
            deliver_to_rd = CASE WHEN author IN ('human', 'reviewer') THEN 1 ELSE 0 END WHERE rowid = ?`)
            .run(index + 1, Number(message.rowid));
        });
        this.#db.prepare(`UPDATE agent_sessions SET last_consumed_message_sequence = ? WHERE requirement_id = ?`)
          .run(messages.length, requirementId);
      }
    }
    this.#db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS messages_requirement_sequence
      ON requirement_messages (requirement_id, sequence)`);
  }

  private updateRun(runId: string, outcome: RunOutcome, now: string): void {
    const result = this.#db.prepare(`UPDATE agent_runs SET status = ?, native_session_id = ?, exit_code = ?, error = ?, finished_at = ?
      WHERE id = ? AND status = 'running'`)
      .run(outcome.status, outcome.nativeSessionId, outcome.exitCode, outcome.error, now, runId);
    if (result.changes === 0) throw new StoreConflictError(`Run ${runId} is not active`);
  }
}
