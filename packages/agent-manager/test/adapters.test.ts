import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeCodeAdapter } from '../src/adapters/claude-code.ts';
import { CodexAdapter } from '../src/adapters/codex.ts';

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

test('Claude Code classifies session quota failures with an absolute reset time', () => {
  const adapter = new ClaudeCodeAdapter();
  assert.deepEqual(
    adapter.classifyFailure(
      "You've hit your session limit · resets 2:30pm (Asia/Shanghai)",
      new Date('2026-09-23T03:12:31.000Z'),
    ),
    { kind: 'session_limit', retryAt: '2026-09-23T06:30:00.000Z' },
  );
  assert.deepEqual(
    adapter.classifyFailure(
      "You've hit your session limit · resets 2:30pm (Asia/Shanghai)",
      new Date('2026-09-23T07:12:31.000Z'),
    ),
    { kind: 'session_limit', retryAt: '2026-09-24T06:30:00.000Z' },
  );
  assert.equal(adapter.classifyFailure('Authentication failed', new Date()), null);
  assert.equal(adapter.classifyFailure(
    "You've hit your session limit · resets later (Asia/Shanghai)",
    new Date(),
  ), null);
});

test('adapters normalize native session identifiers', () => {
  const codex = new CodexAdapter().parseLine('{"type":"thread.started","thread_id":"codex-1"}');
  const claude = new ClaudeCodeAdapter().parseLine('{"type":"system","subtype":"init","session_id":"claude-1"}');
  assert.equal(codex?.nativeSessionId, 'codex-1');
  assert.equal(claude?.nativeSessionId, 'claude-1');
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
