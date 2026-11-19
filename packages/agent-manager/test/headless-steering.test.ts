import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { AgentManager } from '../src/core/agent-manager.ts';
import { silentLogger } from '../src/infrastructure/logger.ts';
import { HeadlessProcessRunner, type ProcessRunRequest } from '../src/runtime/process-runner.ts';
import { SqliteAgentManagerStore } from '../src/storage/sqlite-store.ts';

const codexFixture = String.raw`
  const { createInterface } = require('node:readline');
  const assert = require('node:assert/strict');
  const emit = (frame) => console.log(JSON.stringify(frame));
  const reply = (id, result) => emit({ id, result });
  const notify = (method, params) => emit({ method, params: { threadId: 'test-thread', turnId: 'test-turn', ...params } });
  const item = (event, item) => notify('item/' + event, { item });
  const complete = () => {
    item('completed', { id: 'answer', type: 'agentMessage', text: 'Finished' });
    notify('turn/completed', { turn: { id: 'test-turn', status: 'completed' } });
  };
  const steering = [];
  createInterface({ input: process.stdin }).on('line', (line) => {
    const { id, method, params } = JSON.parse(line);
    if (method === 'initialize') reply(id, {});
    if (method === 'thread/start' || method === 'thread/resume') {
      if (method === 'thread/resume') assert.equal(params.threadId, 'test-thread');
      assert.equal(params.approvalPolicy, 'never');
      assert.equal(params.sandbox, 'danger-full-access');
      assert.equal(params.model, 'test-model');
      assert.equal(params.config.model_reasoning_effort, 'high');
      assert.match(params.developerInstructions, /code-factory-cli/);
      assert.equal(params.cwd, process.cwd());
      reply(id, { thread: { id: 'test-thread' } });
    }
    if (method === 'turn/start') {
      reply(id, { turn: { id: 'test-turn' } });
      notify('turn/started', { turn: { id: 'test-turn' } });
      if (params.input[0].text.includes('LATE_CORRECTION')) complete();
      else item('started', { id: 'tool', type: 'commandExecution', command: 'sleep' });
    }
    if (method === 'turn/steer') {
      assert.equal(params.expectedTurnId, 'test-turn');
      if (params.input[0].text.includes('LATE_CORRECTION')) {
        complete();
        emit({ id, error: { code: -32602, message: 'No active turn' } });
        return;
      }
      if (steering.length === 0) {
        assert.match(params.input[0].text, /Attachment only/);
        assert.equal(params.input[1].type, 'localImage');
      }
      steering.push(params.clientUserMessageId);
      reply(id, { turnId: 'test-turn' });
      if (steering.length !== 2) return;
      for (const clientId of steering) item('completed', { id: clientId, type: 'userMessage', clientId });
      complete();
    }
  });
`;

const claudeFixture = String.raw`
  const { createInterface } = require('node:readline');
  const emit = (frame) => console.log(JSON.stringify({ session_id: 'test-session', ...frame }));
  const result = (success = true, extra = {}) => emit({ type: 'result',
    subtype: success ? 'success' : 'error_during_execution', is_error: !success, result: success ? 'Finished' : 'Failed', ...extra });
  let initial = true;
  let late;
  createInterface({ input: process.stdin }).on('line', (line) => {
    const frame = JSON.parse(line);
    if (initial) {
      initial = false;
      emit({ type: 'system', subtype: 'init' });
      if (frame.message.content.includes('LATE_CORRECTION')) result();
      else emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool', name: 'Bash' }] } });
      return;
    }
    if (frame.message.content.includes('LATE_CORRECTION')) {
      emit({ ...frame, isReplay: true });
      result(true, { user_message_uuids: [] });
      late = frame;
      return;
    }
    emit({ ...frame, isReplay: true });
    result(!frame.message.content.includes('FAIL_AFTER_REPLAY'));
  }).on('close', () => {
    if (late) result(!late.message.content.includes('FAIL_AFTER_REPLAY'), { user_message_uuids: [late.uuid] });
  });
`;

function fixture(t: TestContext, provider: 'codex' | 'claude-code', script: string) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'headless-steer-test-'));
  const runner = new HeadlessProcessRunner();
  const requests: ProcessRunRequest[] = [];
  const manager = new AgentManager({
    workspaceRoot, store: new SqliteAgentManagerStore(':memory:'), logger: silentLogger, timeoutMs: 3_000,
    runner: {
      run: (request) => {
        requests.push(request);
        assert.ok(request.streamingInvocation);
        return runner.run({
          ...request,
          streamingInvocation: { ...request.streamingInvocation, command: process.execPath, args: ['-e', script] },
        });
      },
    },
  });
  t.after(() => {
    manager.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });
  const requirement = manager.createRequirement({ title: 'Steer', description: 'Start the tool', provider,
    model: 'test-model', reasoningEffort: 'high' });
  const ready = new Promise<void>((resolve) => {
    manager.on('output', ({ line }: { line: string }) => {
      if (line.includes('commandExecution') || line.includes('tool_use')) resolve();
    });
  });
  const execution = manager.runRequirement(requirement.id);
  return { manager, requirement, ready, execution, requests };
}

test('Codex steers attachment-only and repeated input into one RD Run', { timeout: 8_000 }, async (t) => {
  const { manager, requirement, ready, execution, requests } = fixture(t, 'codex', codexFixture);
  await ready;
  const image = manager.uploadMessageAttachment(requirement.id, {
    fileName: 'sample.png', mediaType: 'image/png',
    data: Buffer.from('89504e470d0a1a0a', 'hex'),
  });
  const first = manager.postHumanMessage(requirement.id, '', [image.id]);
  const runId = manager.listRuns(requirement.id)[0]!.id;
  assert.equal(manager.interruptRdRun(requirement.id, 'steer').runId, runId);
  assert.throws(() => manager.interruptRdRun(requirement.id, 'steer'), /no newer input/);
  assert.ok(manager.getRequirement(requirement.id)!.session.lastConsumedMessageSequence < first.message.sequence);
  const second = manager.postHumanMessage(requirement.id, 'Second correction');
  assert.equal(manager.interruptRdRun(requirement.id, 'steer').runId, runId);
  const current = await execution;
  assert.equal(current.session.pendingMessageCount, 0);
  assert.equal(current.session.lastConsumedMessageSequence, second.message.sequence);
  assert.equal(manager.listRuns(requirement.id)[0]?.status, 'succeeded');
  assert.equal(requests.length, 1);
});

for (const provider of ['codex', 'claude-code'] as const) {
  test(`${provider} preserves a correction racing completion`, { timeout: 8_000 }, async (t) => {
    const { manager, requirement, ready, execution, requests } = fixture(t, provider, provider === 'codex' ? codexFixture : claudeFixture);
    await ready;
    const late = manager.postHumanMessage(requirement.id, 'LATE_CORRECTION');
    manager.interruptRdRun(requirement.id, 'steer');
    const first = await execution;
    assert.equal(first.session.state, 'waiting_human');
    if (provider === 'codex') {
      assert.equal(first.session.pendingMessageCount, 1);
      for (let attempt = 0; attempt < 60 && manager.getRequirement(requirement.id)?.session.pendingMessageCount; attempt++) {
        await delay(25);
      }
      assert.equal(requests.length, 2);
    } else {
      assert.equal(first.session.lastConsumedMessageSequence, late.message.sequence);
      assert.equal(requests.length, 1);
    }
    assert.equal(manager.getRequirement(requirement.id)?.session.lastConsumedMessageSequence, late.message.sequence);
    assert.ok(manager.listRuns(requirement.id).every((run) => run.status === 'succeeded'));
  });
}

test('Claude Code does not count a successful result for the wrong input before a later failure', { timeout: 8_000 }, async (t) => {
  const { manager, requirement, ready, execution, requests } = fixture(t, 'claude-code', claudeFixture);
  await ready;
  const reply = manager.postHumanMessage(requirement.id, 'LATE_CORRECTION FAIL_AFTER_REPLAY');
  manager.interruptRdRun(requirement.id, 'steer');
  const current = await execution;
  assert.equal(current.session.state, 'failed');
  assert.equal(current.session.pendingMessageCount, 1);
  assert.ok(current.session.lastConsumedMessageSequence < reply.message.sequence);
  assert.equal(manager.listRuns(requirement.id)[0]?.inputToSequence, null);
  assert.equal(requests.length, 1);
});

test('Stop still pauses a live headless Run with a queued reply', { timeout: 8_000 }, async (t) => {
  const { manager, requirement, ready, execution, requests } = fixture(t, 'codex', codexFixture);
  await ready;
  const reply = manager.postHumanMessage(requirement.id, 'Do not consume without Steering');
  manager.interruptRdRun(requirement.id, 'stop');
  const current = await execution;
  assert.equal(current.session.autoResumePaused, true);
  assert.equal(current.session.pendingMessageCount, 1);
  assert.ok(current.session.lastConsumedMessageSequence < reply.message.sequence);
  assert.equal(requests.length, 1);
});
