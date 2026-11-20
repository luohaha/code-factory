import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeCodeAdapter } from '../src/runtime/adapters/claude-code.ts';
import { CodexAdapter } from '../src/runtime/adapters/codex.ts';
import type { NormalizedAgentEvent, StreamingAgentInvocation } from '../src/runtime/adapters/types.ts';

function protocolFixture(invocation: StreamingAgentInvocation) {
  const writes: Record<string, unknown>[] = [];
  const events: NormalizedAgentEvent[] = [];
  const failures: string[] = [];
  let unsupported = false;
  let closed = false;
  const protocol = invocation.connect({
    write: (message) => {
      if (closed) return false;
      writes.push(message);
      return true;
    },
    emit: (event) => { events.push(event); },
    endInput: () => { closed = true; },
    complete: () => {},
    fail: (message) => { failures.push(message); },
    unsupported: () => { unsupported = true; },
  });
  protocol.start();
  return { protocol, writes, events, failures, unsupported: () => unsupported, closed: () => closed,
    receive: (message: Record<string, unknown>) => protocol.receive(JSON.stringify(message)) };
}

test('Codex negotiates metadata-only resume without requesting full history', () => {
  const adapter = new CodexAdapter();
  const input = { prompt: 'continue', nativeSessionId: 'saved-thread' };
  const { receive, writes, events } = protocolFixture(adapter.buildStreamingRdInvocation(adapter.buildRdInvocation(input), input, '/workspace'));
  assert.deepEqual((writes[0]?.params as Record<string, unknown>).capabilities, { experimentalApi: true });
  receive({ id: writes[0]!.id, result: {} });
  const resume = writes.at(-1)!;
  assert.equal(resume.method, 'thread/resume');
  assert.equal((resume.params as Record<string, unknown>).excludeTurns, true);
  assert.equal((resume.params as Record<string, unknown>).threadId, 'saved-thread');
  receive({ id: resume.id, result: { thread: { id: 'saved-thread' } } });
  assert.equal(events[0]?.nativeSessionId, 'saved-thread');
  assert.equal(writes.at(-1)?.method, 'turn/start');
});

test('Codex falls back rather than loading full history when metadata-only resume is gated', () => {
  const adapter = new CodexAdapter();
  const input = { prompt: 'continue', nativeSessionId: 'saved-thread' };
  const legacy = adapter.buildRdInvocation(input);
  const { receive, writes, unsupported } = protocolFixture(adapter.buildStreamingRdInvocation(legacy, input, '/workspace'));
  receive({ id: writes[0]!.id, result: {} });
  const resume = writes.at(-1)!;
  receive({ id: resume.id, error: { code: -32600, message: 'thread/resume.excludeTurns requires experimentalApi capability' } });
  assert.equal(unsupported(), true);
  assert.equal(writes.at(-1), resume);
  assert.deepEqual(legacy.args.slice(-3), ['resume', 'saved-thread', '-']);
});

test('Codex reports bounded startup categories without echoing raw provider errors', () => {
  const adapter = new CodexAdapter();
  const input = { prompt: 'private prompt', nativeSessionId: 'saved-thread' };
  const invocation = adapter.buildStreamingRdInvocation(adapter.buildRdInvocation(input), input, '/workspace');
  for (const [stage, message, reason] of [
    ['initialize', 'not logged in: private token', 'check Codex authentication'],
    ['thread/resume', 'no rollout found for thread id saved-thread', 'saved thread transcript not found'],
    ['turn/start', 'bad configuration: ' + 'private prompt '.repeat(500), 'check Codex configuration'],
  ]) {
    const { receive, writes, failures } = protocolFixture(invocation);
    if (stage !== 'initialize') receive({ id: writes[0]!.id, result: {} });
    if (stage === 'turn/start') receive({ id: writes.at(-1)!.id, result: { thread: { id: 'saved-thread' } } });
    const request = writes.at(-1)!;
    assert.equal(request.method, stage);
    receive({ id: request.id, error: { code: -32603, message, data: { token: 'private token' } } });
    assert.equal(failures.length, 1);
    assert.ok(failures[0]!.endsWith(`(RPC -32603: ${reason})`));
  }
});

test('Codex sends startup replies in order when the turn notification precedes the response', () => {
  const adapter = new CodexAdapter();
  const input = { prompt: 'start', nativeSessionId: null };
  const { protocol, receive, writes } = protocolFixture(adapter.buildStreamingRdInvocation(adapter.buildRdInvocation(input), input, '/workspace'));
  receive({ id: writes[0]!.id, result: {} });
  receive({ id: writes.at(-1)!.id, result: { thread: { id: 'thread' } } });
  const startTurn = writes.at(-1)!;
  assert.equal(startTurn.method, 'turn/start');
  assert.equal(protocol.steer({ text: 'first', imagePaths: [] }, () => {}), 'submitted');
  receive({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn' } } });
  assert.equal(protocol.steer({ text: 'second', imagePaths: [] }, () => {}), 'submitted');
  receive({ id: startTurn.id, result: { turn: { id: 'turn' } } });
  const steers = writes.filter((frame) => frame.method === 'turn/steer')
    .map((frame) => (frame.params as { input: Array<{ text: string }> }).input[0]?.text);
  assert.deepEqual(steers, ['first', 'second']);
});

test('Claude closes stdin after a bounded wait if an unanswered reply never starts another turn', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const adapter = new ClaudeCodeAdapter();
  const invocation = adapter.buildRdInvocation({ prompt: 'start', nativeSessionId: null });
  const { protocol, receive, closed } = protocolFixture(adapter.buildStreamingRdInvocation(invocation));
  assert.equal(protocol.steer({ text: 'try another direction', imagePaths: [] }, () => assert.fail('unanswered input')), 'submitted');
  receive({ type: 'result', subtype: 'success', result: 'initial response', user_message_uuids: [] });
  assert.equal(closed(), false);
  t.mock.timers.tick(10_000);
  assert.equal(closed(), true);
  assert.equal(protocol.steer({ text: 'retry', imagePaths: [] }, () => {}), 'defer');
  protocol.dispose?.();
});

test('Claude keeps resumed stdin open when a background task reports a result before the RD turn', () => {
  const adapter = new ClaudeCodeAdapter();
  const invocation = adapter.buildRdInvocation({ prompt: 'resume work', nativeSessionId: 'saved-session' });
  const { protocol, receive, writes, events, closed } = protocolFixture(adapter.buildStreamingRdInvocation(invocation));
  receive({ type: 'system', subtype: 'init', session_id: 'saved-session' });
  receive({ type: 'result', subtype: 'success', origin: { kind: 'task-notification' }, result: '' });
  assert.equal(closed(), false);
  assert.equal(events.some((event) => event.kind === 'completed'), false);

  let delivered = false;
  assert.equal(protocol.steer({ text: 'what is the plan?', imagePaths: [] }, () => { delivered = true; }), 'submitted');
  const reply = writes[1]!;
  receive({ ...reply, isReplay: true });
  receive({ type: 'result', subtype: 'success', origin: { kind: 'task-notification' }, result: '' });
  assert.equal(delivered, false);
  assert.equal(closed(), false);

  receive({
    type: 'result', subtype: 'success', origin: { kind: 'task-notification' }, result: 'Here is the plan',
    user_message_uuids: [writes[0]!.uuid, reply.uuid],
  });
  assert.equal(delivered, true);
  assert.equal(closed(), true);
  assert.equal(events.at(-1)?.message, 'Here is the plan');
});

test('Claude accepts a reply after a result while background work keeps the process alive', () => {
  const adapter = new ClaudeCodeAdapter();
  const invocation = adapter.buildRdInvocation({ prompt: 'start the build', nativeSessionId: null });
  const { protocol, receive, writes, closed } = protocolFixture(adapter.buildStreamingRdInvocation(invocation));
  const ambient = { task_id: 'watcher', task_type: 'local_bash', ambient: true };
  const build = { task_id: 'build', task_type: 'local_bash' };
  receive({ type: 'system', subtype: 'background_tasks_changed', tasks: [ambient, build] });
  receive({ type: 'result', subtype: 'success', user_message_uuids: [writes[0]!.uuid] });
  assert.equal(closed(), false);

  let delivered = false;
  assert.equal(protocol.steer({ text: 'what changed?', imagePaths: [] }, () => { delivered = true; }), 'submitted');
  receive({ type: 'result', subtype: 'success', user_message_uuids: [writes[1]!.uuid] });
  assert.equal(delivered, true);
  assert.equal(closed(), false);

  receive({ type: 'system', subtype: 'background_tasks_changed', tasks: [ambient] });
  assert.equal(closed(), true);
});

test('Claude keeps waiting for a submitted reply when the last background task ends', () => {
  const adapter = new ClaudeCodeAdapter();
  const invocation = adapter.buildRdInvocation({ prompt: 'start the build', nativeSessionId: null });
  const { protocol, receive, writes, closed } = protocolFixture(adapter.buildStreamingRdInvocation(invocation));
  receive({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'build', task_type: 'local_bash' }] });
  receive({ type: 'result', subtype: 'success', user_message_uuids: [writes[0]!.uuid] });
  let delivered = false;
  assert.equal(protocol.steer({ text: 'summarize the build', imagePaths: [] }, () => { delivered = true; }), 'submitted');

  receive({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  assert.equal(closed(), false);
  receive({ type: 'result', subtype: 'success', user_message_uuids: [writes[1]!.uuid] });
  assert.equal(delivered, true);
  assert.equal(closed(), true);
});

test('Claude follow-up init keeps stdin open before the first slow assistant response', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const adapter = new ClaudeCodeAdapter();
  const invocation = adapter.buildRdInvocation({ prompt: 'start', nativeSessionId: null });
  const { protocol, receive, writes, closed } = protocolFixture(adapter.buildStreamingRdInvocation(invocation));
  receive({ type: 'system', subtype: 'init', session_id: 'main' });
  const delivered: string[] = [];
  protocol.steer({ text: 'second', imagePaths: [] }, () => delivered.push('second'));
  receive({ type: 'result', subtype: 'success', user_message_uuids: [] });
  receive({ type: 'system', subtype: 'init', session_id: 'main' });
  t.mock.timers.tick(12_000);
  assert.equal(closed(), false);
  assert.equal(protocol.steer({ text: 'third', imagePaths: [] }, () => delivered.push('third')), 'submitted');
  receive({ type: 'result', subtype: 'success', user_message_uuids: writes.slice(1).map((message) => message.uuid) });
  assert.deepEqual(delivered, ['second', 'third']);
  assert.equal(closed(), true);
  protocol.dispose?.();
});

test('Codex starts and resumes through stdin without disabling native context discovery', () => {
  const adapter = new CodexAdapter();
  const first = adapter.buildRdInvocation({ prompt: 'implement it', nativeSessionId: null });
  assert.equal(first.command, 'codex');
  assert.equal(first.input, 'implement it');
  assert.deepEqual(first.args, ['exec', '--json', '--color', 'never', '--dangerously-bypass-approvals-and-sandbox', '-']);

  const resumed = adapter.buildRdInvocation({ prompt: 'continue', nativeSessionId: 'thread-1' });
  assert.deepEqual(resumed.args, ['exec', '--json', '--color', 'never', '--dangerously-bypass-approvals-and-sandbox', 'resume', 'thread-1', '-']);
  assert.ok(!resumed.args.includes('--cd'));
  assert.ok(!first.args.includes('--ignore-user-config'));
  assert.ok(!resumed.args.includes('--ignore-user-config'));

  const withImages = adapter.buildRdInvocation({
    prompt: 'inspect screenshots',
    nativeSessionId: 'thread-1',
    imagePaths: ['/tmp/first.png', '/tmp/second.webp'],
  });
  assert.deepEqual(withImages.args.slice(-5), [
    '--image',
    '/tmp/first.png',
    '--image',
    '/tmp/second.webp',
    '-',
  ]);
});

test('Codex reviewer is ephemeral and receives a prompt through stdin', () => {
  const invocation = new CodexAdapter().buildReviewInvocation({
    prompt: 'Review GitHub PR https://github.com/acme/repo/pull/7',
    developerInstructions: 'Publish review comments.',
  });
  assert.deepEqual(invocation.args.slice(0, 6), [
    'exec',
    '--json',
    '--color',
    'never',
    '--ephemeral',
    '--dangerously-bypass-approvals-and-sandbox',
  ]);
  assert.equal(invocation.args.at(-1), '-');
  assert.ok(!invocation.args.includes('review'));
  assert.ok(!invocation.args.includes('--base'));
  assert.ok(invocation.args.some((value) => value.includes('Publish review comments.')));
  assert.equal(invocation.input, 'Review GitHub PR https://github.com/acme/repo/pull/7');
});

test('Claude Code persists RD sessions but not reviewer sessions', () => {
  const adapter = new ClaudeCodeAdapter();
  const first = adapter.buildRdInvocation({ prompt: 'implement it', nativeSessionId: null });
  assert.ok(first.args.includes('--session-id'));
  assert.ok(first.args.includes('--dangerously-skip-permissions'));
  assert.ok(!first.args.includes('--permission-mode'));
  assert.ok(!first.args.includes('--add-dir'));
  assert.ok(!first.args.includes('--bare'));
  assert.ok(!first.args.includes('--disable-slash-commands'));
  assert.ok(!first.args.includes('--setting-sources'));

  const resumed = adapter.buildRdInvocation({ prompt: 'continue', nativeSessionId: 'session-1' });
  assert.deepEqual(resumed.args.slice(-2), ['--resume', 'session-1']);
  assert.ok(!resumed.args.includes('--bare'));
  assert.ok(!resumed.args.includes('--disable-slash-commands'));

  const review = adapter.buildReviewInvocation({ prompt: 'Review GitHub PR https://github.com/acme/repo/pull/7' });
  assert.ok(review.args.includes('--no-session-persistence'));
  assert.ok(review.args.includes('--dangerously-skip-permissions'));
  assert.ok(!review.args.includes('--permission-mode'));
  assert.equal(review.input, 'Review GitHub PR https://github.com/acme/repo/pull/7');
  assert.doesNotMatch(review.input, /^\/review/);
});

test('adapters normalize native session identifiers', () => {
  const codex = new CodexAdapter().parseLine('{"type":"thread.started","thread_id":"codex-1"}');
  const claude = new ClaudeCodeAdapter().parseLine('{"type":"system","subtype":"init","session_id":"claude-1"}');
  assert.equal(codex?.nativeSessionId, 'codex-1');
  assert.equal(claude?.nativeSessionId, 'claude-1');
});

test('Codex preserves the reason nested in a failed turn', () => {
  const event = new CodexAdapter().parseLine(JSON.stringify({
    type: 'turn.failed',
    error: { message: 'Selected model is at capacity. Please try a different model.' },
  }));
  assert.equal(event?.kind, 'error');
  assert.equal(event?.message, 'Selected model is at capacity. Please try a different model.');
  assert.equal(event?.traces?.[0]?.detail, event?.message);
});

test('Codex normalizes commands, results, reasoning, and Agent messages into trace events', () => {
  const adapter = new CodexAdapter();
  const started = adapter.parseLine(JSON.stringify({
    type: 'item.started',
    item: { id: 'item-1', type: 'command_execution', command: 'npm test', status: 'in_progress' },
  }));
  const completed = adapter.parseLine(JSON.stringify({
    type: 'item.completed',
    item: { id: 'item-1', type: 'command_execution', command: 'npm test', aggregated_output: 'ok', exit_code: 0 },
  }));
  const reasoning = adapter.parseLine(JSON.stringify({
    type: 'item.completed',
    item: { id: 'item-2', type: 'reasoning', text: 'Inspect the failing test first.' },
  }));
  const message = adapter.parseLine(JSON.stringify({
    type: 'item.completed',
    item: { id: 'item-3', type: 'agent_message', text: 'The fix is ready.' },
  }));

  assert.deepEqual(started?.traces?.[0], {
    kind: 'tool_call',
    status: 'started',
    title: 'Run command',
    detail: 'npm test',
    toolName: 'shell',
    toolCallId: 'item-1',
    nativeType: 'item.started',
  });
  assert.equal(completed?.traces?.[0]?.kind, 'tool_result');
  assert.match(completed?.traces?.[0]?.detail ?? '', /ok/);
  assert.equal(reasoning?.kind, 'other');
  assert.equal(reasoning?.traces?.[0]?.kind, 'reasoning');
  assert.equal(message?.kind, 'message');
  assert.equal(message?.message, 'The fix is ready.');
  assert.equal(message?.traces?.[0]?.kind, 'assistant_message');
});

test('Claude Code normalizes tool use and tool results into correlated trace events', () => {
  const adapter = new ClaudeCodeAdapter();
  const call = adapter.parseLine(JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: 'Check the repository.' },
        { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'git status' } },
      ],
    },
  }));
  const result = adapter.parseLine(JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'clean' }] },
  }));

  assert.deepEqual(call?.traces?.map((trace) => trace.kind), ['reasoning', 'tool_call']);
  assert.equal(call?.traces?.[1]?.toolName, 'Bash');
  assert.equal(call?.traces?.[1]?.toolCallId, 'tool-1');
  assert.equal(result?.traces?.[0]?.kind, 'tool_result');
  assert.equal(result?.traces?.[0]?.toolCallId, 'tool-1');
  assert.equal(result?.traces?.[0]?.detail, 'clean');
});

for (const nativeSessionId of [null, 'existing-session']) {
  test(`RD adapters inject manager guidance for ${nativeSessionId ? 'resumed' : 'new'} sessions`, () => {
    const codex = new CodexAdapter().buildRdInvocation({
      prompt: 'implement it',
      nativeSessionId,
      developerInstructions: 'Track PRs through Code Factory.',
    });
    assert.ok(codex.args.includes('-c'));
    assert.ok(codex.args.some((value) => value.includes('developer_instructions=') && value.includes('Track PRs')));

    const claude = new ClaudeCodeAdapter().buildRdInvocation({
      prompt: 'implement it',
      nativeSessionId,
      developerInstructions: 'Track PRs through Code Factory.',
    });
    const flag = claude.args.indexOf('--append-system-prompt');
    assert.ok(flag >= 0);
    assert.equal(claude.args[flag + 1], 'Track PRs through Code Factory.');
  });
}

test('adapters pass explicit model and reasoning effort to both RD and Reviewer CLIs', () => {
  const codex = new CodexAdapter();
  const codexRd = codex.buildRdInvocation({
    prompt: 'implement it',
    nativeSessionId: 'thread-1',
    model: 'gpt-5.6',
    reasoningEffort: 'max',
  });
  assert.deepEqual(codexRd.args.slice(codexRd.args.indexOf('--model'), codexRd.args.indexOf('--model') + 2), ['--model', 'gpt-5.6']);
  assert.ok(codexRd.args.includes('model_reasoning_effort="max"'));

  const codexReview = codex.buildReviewInvocation({
    prompt: 'review it',
    model: 'gpt-5.5',
    reasoningEffort: 'high',
  });
  assert.ok(codexReview.args.includes('gpt-5.5'));
  assert.ok(codexReview.args.includes('model_reasoning_effort="high"'));

  const claude = new ClaudeCodeAdapter();
  const claudeRd = claude.buildRdInvocation({
    prompt: 'implement it',
    nativeSessionId: null,
    model: 'claude-opus-4-6',
    reasoningEffort: 'xhigh',
  });
  assert.deepEqual(claudeRd.args.slice(claudeRd.args.indexOf('--model'), claudeRd.args.indexOf('--model') + 4), [
    '--model',
    'claude-opus-4-6',
    '--effort',
    'xhigh',
  ]);

  const claudeReview = claude.buildReviewInvocation({
    prompt: 'review it',
    model: 'sonnet',
    reasoningEffort: 'medium',
  });
  assert.ok(claudeReview.args.includes('sonnet'));
  assert.deepEqual(claudeReview.args.slice(claudeReview.args.indexOf('--effort'), claudeReview.args.indexOf('--effort') + 2), ['--effort', 'medium']);
});
