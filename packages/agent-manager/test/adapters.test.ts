import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeCodeAdapter } from '../src/adapters/claude-code.ts';
import { CodexAdapter } from '../src/adapters/codex.ts';

test('Codex starts and resumes through stdin without overriding the workspace', () => {
  const adapter = new CodexAdapter();
  const first = adapter.buildRdInvocation({ prompt: 'implement it', nativeSessionId: null });
  assert.equal(first.command, 'codex');
  assert.equal(first.input, 'implement it');
  assert.deepEqual(first.args, ['exec', '--json', '--color', 'never', '--dangerously-bypass-approvals-and-sandbox', '-']);

  const resumed = adapter.buildRdInvocation({ prompt: 'continue', nativeSessionId: 'thread-1' });
  assert.deepEqual(resumed.args, ['exec', '--json', '--color', 'never', '--dangerously-bypass-approvals-and-sandbox', 'resume', 'thread-1', '-']);
  assert.ok(!resumed.args.includes('--cd'));

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

test('Codex reviewer is ephemeral and scoped to a base branch', () => {
  const invocation = new CodexAdapter().buildReviewInvocation({
    prompt: 'review carefully',
    baseBranch: 'main',
    developerInstructions: 'Publish review comments.',
  });
  assert.deepEqual(invocation.args.slice(0, 5), [
    'exec',
    'review',
    '--json',
    '--ephemeral',
    '--dangerously-bypass-approvals-and-sandbox',
  ]);
  assert.deepEqual(invocation.args.slice(-2), [
    '--base',
    'main',
  ]);
  assert.ok(!invocation.args.includes('-'));
  assert.ok(invocation.args.some((value) => value.includes('Publish review comments.') && value.includes('review carefully')));
  assert.equal(invocation.input, '');
});

test('Claude Code persists RD sessions but not reviewer sessions', () => {
  const adapter = new ClaudeCodeAdapter();
  const first = adapter.buildRdInvocation({ prompt: 'implement it', nativeSessionId: null });
  assert.ok(first.args.includes('--session-id'));
  assert.ok(first.args.includes('--dangerously-skip-permissions'));
  assert.ok(!first.args.includes('--permission-mode'));
  assert.ok(!first.args.includes('--add-dir'));

  const resumed = adapter.buildRdInvocation({ prompt: 'continue', nativeSessionId: 'session-1' });
  assert.deepEqual(resumed.args.slice(-2), ['--resume', 'session-1']);

  const review = adapter.buildReviewInvocation({ prompt: 'focus on tests', baseBranch: 'main' });
  assert.ok(review.args.includes('--no-session-persistence'));
  assert.ok(review.args.includes('--dangerously-skip-permissions'));
  assert.ok(!review.args.includes('--permission-mode'));
  assert.match(review.input, /^\/review/);
});

test('adapters normalize native session identifiers', () => {
  const codex = new CodexAdapter().parseLine('{"type":"thread.started","thread_id":"codex-1"}');
  const claude = new ClaudeCodeAdapter().parseLine('{"type":"system","subtype":"init","session_id":"claude-1"}');
  assert.equal(codex?.nativeSessionId, 'codex-1');
  assert.equal(claude?.nativeSessionId, 'claude-1');
});

test('RD adapters inject manager guidance as developer or appended system instructions', () => {
  const codex = new CodexAdapter().buildRdInvocation({
    prompt: 'implement it',
    nativeSessionId: null,
    developerInstructions: 'Track PRs through Code Factory.',
  });
  assert.ok(codex.args.includes('-c'));
  assert.ok(codex.args.some((value) => value.includes('developer_instructions=') && value.includes('Track PRs')));

  const claude = new ClaudeCodeAdapter().buildRdInvocation({
    prompt: 'implement it',
    nativeSessionId: null,
    developerInstructions: 'Track PRs through Code Factory.',
  });
  const flag = claude.args.indexOf('--append-system-prompt');
  assert.ok(flag >= 0);
  assert.equal(claude.args[flag + 1], 'Track PRs through Code Factory.');
});
