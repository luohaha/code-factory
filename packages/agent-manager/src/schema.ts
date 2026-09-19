export const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS requirements (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('todo', 'doing', 'waiting_confirmation', 'done', 'cancelled')),
    provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude-code')),
    model TEXT,
    reasoning_effort TEXT CHECK (reasoning_effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
    created_by TEXT NOT NULL DEFAULT 'human' CHECK (created_by IN ('human', 'rd_agent')),
    parent_requirement_id TEXT REFERENCES requirements(id) ON DELETE SET NULL,
    source_session_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS agent_sessions (
    id TEXT PRIMARY KEY,
    requirement_id TEXT NOT NULL UNIQUE REFERENCES requirements(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude-code')),
    native_session_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('idle', 'running', 'waiting_human', 'waiting_review', 'failed', 'completed')),
    last_error TEXT,
    last_consumed_message_sequence INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES agent_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('rd', 'reviewer')),
    provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude-code')),
    model TEXT,
    reasoning_effort TEXT CHECK (reasoning_effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
    status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'timed_out', 'cancelled')),
    task_summary TEXT NOT NULL,
    native_session_id TEXT,
    exit_code INTEGER,
    error TEXT,
    input_from_sequence INTEGER,
    input_to_sequence INTEGER,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    CHECK ((role = 'rd' AND session_id IS NOT NULL) OR (role = 'reviewer' AND session_id IS NULL))
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS manager_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    requirement_id TEXT REFERENCES requirements(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES agent_sessions(id) ON DELETE CASCADE,
    run_id TEXT REFERENCES agent_runs(id) ON DELETE CASCADE,
    payload_json TEXT NOT NULL,
    idempotency_key TEXT UNIQUE,
    created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS requirement_messages (
    id TEXT PRIMARY KEY,
    requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
    source_requirement_id TEXT REFERENCES requirements(id) ON DELETE SET NULL,
    author TEXT NOT NULL CHECK (author IN ('human', 'rd_agent', 'reviewer', 'system')),
    body TEXT NOT NULL,
    sequence INTEGER NOT NULL DEFAULT 0,
    deliver_to_rd INTEGER NOT NULL DEFAULT 0 CHECK (deliver_to_rd IN (0, 1)),
    created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS message_attachments (
    id TEXT PRIMARY KEY,
    requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
    message_id TEXT REFERENCES requirement_messages(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'file')),
    media_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL CHECK (byte_size > 0),
    local_path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS pending_attachment_deletions (
    local_path TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS pull_requests (
    id TEXT PRIMARY KEY,
    requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
    repository TEXT NOT NULL,
    number INTEGER NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    base_branch TEXT NOT NULL,
    head_branch TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft', 'open', 'closed', 'merged')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (repository, number)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS pull_request_observations (
    pull_request_id TEXT PRIMARY KEY REFERENCES pull_requests(id) ON DELETE CASCADE,
    initialized_at TEXT NOT NULL,
    check_states_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS agent_trigger_receipts (
    trigger_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (trigger_id, idempotency_key)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS agent_timers (
    id TEXT PRIMARY KEY,
    requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
    description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 500),
    schedule TEXT NOT NULL CHECK (schedule IN ('once', 'recurring')),
    interval_seconds INTEGER NOT NULL CHECK (interval_seconds > 0),
    status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
    next_fire_at TEXT,
    last_fired_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((status = 'active' AND next_fire_at IS NOT NULL) OR (status != 'active' AND next_fire_at IS NULL))
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS review_requests (
    id TEXT PRIMARY KEY,
    pull_request_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude-code')),
    model TEXT,
    reasoning_effort TEXT CHECK (reasoning_effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
    target_head_sha TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
    requested_by TEXT NOT NULL CHECK (requested_by IN ('human')),
    error TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS search_documents (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('requirement', 'message', 'pull_request')),
    source_id TEXT NOT NULL,
    requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    keywords TEXT NOT NULL,
    embedding BLOB NOT NULL,
    embedding_version INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (kind, source_id)
  ) STRICT`,
  `DROP INDEX IF EXISTS one_active_rd_run_per_workspace`,
  `CREATE UNIQUE INDEX IF NOT EXISTS one_active_rd_run_per_session
    ON agent_runs (session_id) WHERE role = 'rd' AND status = 'running'`,
  `DROP INDEX IF EXISTS one_active_reviewer_per_requirement`,
  `CREATE UNIQUE INDEX IF NOT EXISTS one_active_review_per_pull_request
    ON review_requests (pull_request_id) WHERE status = 'running'`,
  `CREATE INDEX IF NOT EXISTS requirements_status_updated
    ON requirements (status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS runs_requirement_started
    ON agent_runs (requirement_id, started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS events_created
    ON manager_events (id, created_at)`,
  `CREATE INDEX IF NOT EXISTS events_run_type_id
    ON manager_events (run_id, type, id)`,
  `CREATE INDEX IF NOT EXISTS events_requirement_type_id
    ON manager_events (requirement_id, type, id)`,
  `CREATE INDEX IF NOT EXISTS messages_requirement_created
    ON requirement_messages (requirement_id, created_at, id)`,
  `CREATE INDEX IF NOT EXISTS attachments_requirement_created
    ON message_attachments (requirement_id, created_at, id)`,
  `CREATE INDEX IF NOT EXISTS pull_requests_requirement_updated
    ON pull_requests (requirement_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS agent_trigger_receipts_requirement
    ON agent_trigger_receipts (requirement_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS agent_timers_due
    ON agent_timers (status, next_fire_at)`,
  `CREATE INDEX IF NOT EXISTS agent_timers_requirement
    ON agent_timers (requirement_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS review_requests_pull_request_created
    ON review_requests (pull_request_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS search_documents_requirement_updated
    ON search_documents (requirement_id, updated_at DESC)`,
] as const;

/** Indexes that depend on columns added by legacy-schema migration. */
export const postMigrationSchemaStatements = [
  `CREATE INDEX IF NOT EXISTS requirements_parent_updated
    ON requirements (parent_requirement_id, updated_at DESC)`,
] as const;
