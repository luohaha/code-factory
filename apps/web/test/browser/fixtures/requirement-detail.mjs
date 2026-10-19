export function detailFixture() {
  const now = Date.now();
  const at = (seconds) => new Date(now + seconds * 1000).toISOString();
  const requirementId = 'req_affectui';
  const runId = 'run_current';
  const requirement = {
    id: requirementId, title: 'Improve Agent execution details',
    description: 'Make tool execution easier to follow while keeping the existing workflow.',
    status: 'doing', provider: 'codex', model: 'gpt-5', reasoningEffort: null,
    sandboxId: null, createdBy: 'human', parentRequirementId: null, sourceSessionId: null,
    createdAt: at(-120), updatedAt: at(-5), completedAt: null,
    session: {
      id: 'ses_affectui', requirementId, provider: 'codex', nativeSessionId: 'native-demo',
      state: 'running', lastError: null, lastConsumedMessageSequence: 1,
      pendingMessageCount: 0, queuedMessageCount: 0, autoResumePaused: false,
      createdAt: at(-120), updatedAt: at(-5),
    },
  };
  const run = {
    id: runId, requirementId, sessionId: requirement.session.id, role: 'rd', provider: 'codex',
    model: 'gpt-5', reasoningEffort: null, status: 'running', taskSummary: requirement.title,
    nativeSessionId: 'native-demo', exitCode: null, error: null, inputFromSequence: 1,
    inputToSequence: 1, startedAt: at(-30), finishedAt: null,
  };
  const traceEvent = (id, seconds, input) => ({
    id, runId, sequence: seconds + 30, kind: 'tool_call', status: 'started',
    title: 'Run command', detail: null, toolName: 'shell', toolCallId: id,
    nativeType: 'item.started', createdAt: at(seconds), ...input,
  });
  const trace = [
    traceEvent('read-start', -25, { toolName: 'read_file', title: 'Read source', detail: '{"path":"apps/web/app/page.tsx"}' }),
    traceEvent('read-end', -24, { kind: 'tool_result', status: 'completed', toolCallId: 'read-start', detail: '{"lines":120,"found":true}' }),
    traceEvent('test-start', -20, { title: 'Run dashboard checks', detail: 'npm test' }),
    traceEvent('test-end', -17, { kind: 'tool_result', status: 'failed', toolCallId: 'test-start', detail: 'Expected the result card to be collapsed.\n1 assertion failed.' }),
    traceEvent('live-start', -5, { toolName: 'search_files', title: 'Inspect the failing assertion', detail: '{"pattern":"tool-call-card","path":"apps/web"}' }),
  ];
  const messages = [{
    id: 'msg_start', requirementId, sequence: 1, author: 'human', body: 'Improve the tool execution view.',
    sourceRequirementId: null, attachments: [], createdAt: at(-30),
  }];
  const configuration = {
    path: null, values: {
      host: '127.0.0.1', port: 4310, allowedOrigin: null, openDashboard: false,
      databasePath: null, commitCoAuthorEnabled: true, jevApiKey: null,
      pullRequestReconcileIntervalSeconds: 30, cancelledRequirementRetentionDays: 7,
      doneRequirementRetentionDays: 365, logLevel: 'info', logFilePath: null,
      logMaxSize: '20m', logMaxFiles: '14d',
    }, jevApiKeyConfigured: false, restartRequired: false, restartRequiredFields: [],
  };
  function reply(path) {
    if (path === '/api/workspace') return { root: '/demo/code-factory', databasePath: '/demo/data.sqlite', logFilePath: null };
    if (path === '/api/configuration') return configuration;
    if (path === '/api/agent-models') return { providers: [], refreshIntervalSeconds: 86400 };
    if (path === '/api/requirements') return { items: [requirement] };
    if (path === `/api/requirements/${requirementId}`) return requirement;
    if (path === '/api/runs') return { items: [run] };
    if (path.endsWith('/trace')) return { items: trace };
    if (path.endsWith('/messages')) return { items: messages, hasMore: false };
    return { items: [] };
  }
  function stop() {
    Object.assign(run, { status: 'cancelled', finishedAt: at(1) });
    Object.assign(requirement, { status: 'waiting_confirmation', updatedAt: at(1) });
    Object.assign(requirement.session, { state: 'waiting_human', autoResumePaused: true, updatedAt: at(1) });
    return managerEvent('run.cancelled', { run, requirement, role: 'rd' });
  }
  function managerEvent(type, payload) {
    return { id: now, type, requirementId, sessionId: requirement.session.id, runId, payload, createdAt: at(1) };
  }
  return { requirement, run, trace, reply, stop, managerEvent };
}
