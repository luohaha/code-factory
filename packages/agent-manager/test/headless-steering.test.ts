import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  let resumed = false;
  createInterface({ input: process.stdin }).on('line', (line) => {
    const { id, method, params } = JSON.parse(line);
    if (method === 'initialize') reply(id, {});
    if (method === 'thread/start' || method === 'thread/resume') {
      resumed = method === 'thread/resume';
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
      const prompt = params.input[0].text;
      if (prompt.includes('RESUME_AFTER_STOP')) {
        assert.ok(resumed);
        assert.match(prompt, /START_BEFORE_STOP[\s\S]*CHANGE_BEFORE_STOP[\s\S]*RESUME_AFTER_STOP/);
        complete();
      } else if (prompt.includes('COMPLETE_BEFORE_REPLY')) {
        complete();
        setTimeout(() => {}, 400);
      } else if (prompt.includes('LATE_CORRECTION') || prompt.includes('The complete body of this pending message')) complete();
      else item('started', { id: 'tool', type: 'commandExecution', command: 'sleep' });
    }
    if (method === 'turn/steer') {
      assert.equal(params.expectedTurnId, 'test-turn');
      if (params.input[0].text.includes('CHANGE_BEFORE_STOP')) {
        reply(id, { turnId: 'test-turn' });
        return;
      }
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
  const assert = require('node:assert/strict');
  const emit = (frame) => console.log(JSON.stringify({ session_id: 'test-session', ...frame }));
  const result = (success = true, extra = {}) => emit({ type: 'result',
    subtype: success ? 'success' : 'error_during_execution', is_error: !success, result: success ? 'Finished' : 'Failed', ...extra });
  let initial = true;
  let late;
  const tool = (id) => emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash' }] } });
  createInterface({ input: process.stdin }).on('line', (line) => {
    const frame = JSON.parse(line);
    if (initial) {
      initial = false;
      emit({ type: 'system', subtype: 'init' });
      const prompt = frame.message.content;
      if (prompt.includes('RESUME_AFTER_STOP')) {
        assert.match(prompt, /START_BEFORE_STOP[\s\S]*CHANGE_BEFORE_STOP[\s\S]*RESUME_AFTER_STOP/);
        result();
      } else if (prompt.includes('COMPLETE_BEFORE_REPLY')) {
        result();
        setTimeout(() => {}, 400);
      } else if (prompt.includes('LATE_CORRECTION') || prompt.includes('The complete body of this pending message')) result();
      else tool('tool');
      return;
    }
    if (frame.message.content.includes('CHANGE_BEFORE_STOP')) {
      emit({ ...frame, isReplay: true });
      return;
    }
    if (frame.message.content.includes('LATE_CORRECTION')) {
      emit({ ...frame, isReplay: true });
      result(true, { user_message_uuids: [] });
      if (frame.message.content.includes('WAIT_FOR_THIRD')) {
        late = frame;
        tool('follow-up-tool');
      } else {
        result(!frame.message.content.includes('FAIL_AFTER_REPLAY'), { user_message_uuids: [frame.uuid] });
      }
      return;
    }
    if (late) {
      emit({ ...frame, isReplay: true });
      result(true, { user_message_uuids: [late.uuid, frame.uuid] });
      return;
    }
    emit({ ...frame, isReplay: true });
    result(!frame.message.content.includes('FAIL_AFTER_REPLAY'));
  });
`;

const claudeClosingAfterErrorFixture = String.raw`
  const { existsSync, writeFileSync } = require('node:fs');
  const { createInterface } = require('node:readline');
  const emit = (frame) => console.log(JSON.stringify({ session_id: 'test-session', ...frame }));
  createInterface({ input: process.stdin }).once('line', () => {
    emit({ type: 'system', subtype: 'init' });
    if (existsSync('error-emitted')) {
      emit({ type: 'result', subtype: 'success', result: 'Finished' });
      return;
    }
    writeFileSync('error-emitted', '');
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Failed' });
    const hold = setInterval(() => {
      if (existsSync('release-process')) clearInterval(hold);
    }, 20);
  });
`;

const holdExitedProviderOutput = String.raw`
  const { existsSync } = require('node:fs');
  process.stdin.once('end', () => {
    setTimeout(() => console.log('transport-exit-marker'), 100);
  });
  process.stdin.resume();
  setInterval(() => { if (existsSync('release-process')) process.exit(0); }, 10);
  setTimeout(() => process.exit(1), 3_000).unref();
`;

const claudeAbruptExitFixture = String.raw`
  const { spawn } = require('node:child_process');
  const { existsSync, writeFileSync } = require('node:fs');
  const { createInterface } = require('node:readline');
  const emit = (frame) => console.log(JSON.stringify({ session_id: 'test-session', ...frame }));
  createInterface({ input: process.stdin }).once('line', () => {
    emit({ type: 'system', subtype: 'init' });
    if (existsSync('abrupt-exit')) {
      emit({ type: 'result', subtype: 'success', result: 'Finished' });
      return;
    }
    writeFileSync('abrupt-exit', '');
    const drain = spawn(process.execPath, ['-e', ${JSON.stringify(holdExitedProviderOutput)}],
      { detached: process.platform === 'win32', stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
    drain.once('spawn', () => process.exit(1));
  });
`;

const claudeStdinFixture = (closeInput: boolean) => String.raw`
  const { closeSync, existsSync, writeFileSync } = require('node:fs');
  const { createInterface } = require('node:readline');
  const emit = (frame) => console.log(JSON.stringify({ session_id: 'test-session', ...frame }));
  const input = createInterface({ input: process.stdin });
  input.once('line', () => {
    emit({ type: 'system', subtype: 'init' });
    if (existsSync('peer-closed-input')) {
      emit({ type: 'result', subtype: 'success', result: 'Finished' });
      return;
    }
    writeFileSync('peer-closed-input', '');
    if (${closeInput}) {
      input.close();
      process.stdin.once('close', () => {
        closeSync(0);
        console.log('stdin-marker');
      });
      process.stdin.destroy();
    } else {
      console.log('stdin-marker');
    }
    setInterval(() => {
      if (existsSync('release-process')) process.exit(17);
    }, 20);
  });
`;

function fixture(t: TestContext, provider: 'codex' | 'claude-code', script: string,
  { initialMessage, readyMarker = provider === 'codex' ? 'commandExecution' : 'tool_use', timeoutMs = 3_000 }: {
    initialMessage?: string; readyMarker?: string; timeoutMs?: number;
  } = {}) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'headless-steer-test-'));
  const runner = new HeadlessProcessRunner();
  const requests: ProcessRunRequest[] = [];
  const manager = new AgentManager({
    workspaceRoot, store: new SqliteAgentManagerStore(':memory:'), logger: silentLogger, timeoutMs,
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
      if (line.includes(readyMarker)) resolve();
    });
  });
  const execution = manager.runRequirement(requirement.id, initialMessage);
  return { manager, requirement, ready, execution, requests, workspaceRoot };
}

test('Codex automatically steers attachment-only and repeated replies into one RD Run', { timeout: 8_000 }, async (t) => {
  const { manager, requirement, ready, execution, requests } = fixture(t, 'codex', codexFixture);
  await ready;
  const image = manager.uploadMessageAttachment(requirement.id, {
    fileName: 'sample.png', mediaType: 'image/png',
    data: Buffer.from('89504e470d0a1a0a', 'hex'),
  });
  const first = manager.postHumanMessage(requirement.id, '', [image.id]);
  const runId = manager.listRuns(requirement.id)[0]!.id;
  assert.throws(() => manager.interruptRdRun(requirement.id, 'steer'), /no newer input/);
  assert.ok(manager.getRequirement(requirement.id)!.session.lastConsumedMessageSequence < first.message.sequence);
  const second = manager.postHumanMessage(requirement.id, 'Second correction');
  const current = await execution;
  assert.equal(current.session.pendingMessageCount, 0);
  assert.equal(current.session.lastConsumedMessageSequence, second.message.sequence);
  assert.equal(manager.listRuns(requirement.id)[0]?.status, 'succeeded');
  assert.equal(manager.listRuns(requirement.id)[0]?.id, runId);
  assert.equal(requests.length, 1);
});

for (const provider of ['codex', 'claude-code'] as const) {
  test(`${provider} preserves a correction racing completion`, { timeout: 8_000 }, async (t) => {
    const { manager, requirement, ready, execution, requests } = fixture(t, provider, provider === 'codex' ? codexFixture : claudeFixture);
    await ready;
    const late = manager.postHumanMessage(requirement.id, 'LATE_CORRECTION');
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

  test(`${provider} queues an oversized reply while the completed CLI is exiting`, { timeout: 8_000 }, async (t) => {
    const { manager, requirement, ready, execution } = fixture(t, provider, provider === 'codex' ? codexFixture : claudeFixture, {
      initialMessage: 'COMPLETE_BEFORE_REPLY',
      readyMarker: provider === 'codex' ? '"method":"turn/completed"' : '"type":"result"',
    });
    const initialMessage = manager.listMessages(requirement.id).find((message) => message.author === 'human')!;
    await ready;
    assert.equal(manager.listRuns(requirement.id)[0]?.status, 'running');
    const reply = manager.postHumanMessage(requirement.id, 'x'.repeat(13_000));
    const first = await execution;
    for (let attempt = 0; attempt < 100 && manager.getRequirement(requirement.id)?.session.pendingMessageCount; attempt++) {
      await delay(25);
    }
    assert.equal(first.session.lastConsumedMessageSequence, initialMessage.sequence);
    assert.equal(first.session.pendingMessageCount, 1);
    assert.equal(manager.getRequirement(requirement.id)?.session.lastConsumedMessageSequence, reply.message.sequence);
    assert.deepEqual(manager.listRuns(requirement.id).map((run) => [run.status, run.inputFromSequence]),
      [['succeeded', reply.message.sequence], ['succeeded', initialMessage.sequence]]);
  });
}

for (const outcome of ['failed', 'timed_out', 'cancelled'] as const) {
  test(`Claude Code handles queued replies after input closes and the process settles as ${outcome}`, { timeout: 8_000 }, async (t) => {
    const { manager, requirement, ready, execution, requests, workspaceRoot } = fixture(t, 'claude-code', claudeClosingAfterErrorFixture, {
      initialMessage: 'Initial task',
      readyMarker: 'error_during_execution',
      timeoutMs: outcome === 'timed_out' ? 1_000 : 3_000,
    });
    const initial = manager.listMessages(requirement.id).find((message) => message.author === 'human')!;
    await ready;
    const firstRun = manager.listRuns(requirement.id)[0]!;
    assert.equal(firstRun.status, 'running');
    const reply = manager.postHumanMessage(requirement.id, outcome === 'failed' ? 'x'.repeat(13_000) : 'Change direction');
    assert.equal(reply.queued, true);
    const lastReply = outcome === 'timed_out' ? manager.postHumanMessage(requirement.id, 'One more detail') : reply;
    if (outcome === 'failed') writeFileSync(join(workspaceRoot, 'release-process'), '');
    if (outcome === 'cancelled') manager.interruptRdRun(requirement.id, 'stop');

    const settled = await execution;
    assert.equal(settled.session.lastConsumedMessageSequence, 0);
    assert.equal(settled.session.pendingMessageCount, outcome === 'timed_out' ? 3 : 2);
    assert.equal(manager.listRuns(requirement.id).find((run) => run.id === firstRun.id)?.status, outcome);
    if (outcome === 'cancelled') {
      assert.equal(settled.session.autoResumePaused, true);
      assert.equal(requests.length, 1);
      return;
    }

    for (let attempt = 0; attempt < 100 && manager.getRequirement(requirement.id)?.session.pendingMessageCount; attempt++) {
      await delay(25);
    }
    assert.equal(manager.getRequirement(requirement.id)?.session.lastConsumedMessageSequence, lastReply.message.sequence);
    const runs = manager.listRuns(requirement.id).reverse();
    const expectedRanges = outcome === 'failed'
      ? [[outcome, initial.sequence, initial.sequence], ['succeeded', initial.sequence, initial.sequence], ['succeeded', reply.message.sequence, reply.message.sequence]]
      : [[outcome, initial.sequence, initial.sequence], ['succeeded', initial.sequence, lastReply.message.sequence]];
    assert.deepEqual(runs.map((run) => [run.status, run.inputFromSequence, run.inputToSequence]), expectedRanges);
  });
}

for (const scenario of [
  { name: 'after abrupt provider exit', script: claudeAbruptExitFixture, marker: 'transport-exit-marker', exitCode: 1 },
  { name: 'after the provider closes only stdin', script: claudeStdinFixture(true), marker: 'stdin-marker', exitCode: 17 },
]) {
  for (const body of ['SHORT_LATE_REPLY', 'x'.repeat(13_000)]) {
    test(`headless steering queues a ${body.length > 100 ? 'large' : 'short'} reply ${scenario.name}`, { timeout: 8_000 }, async (t) => {
      const { manager, requirement, ready, execution, workspaceRoot } = fixture(t, 'claude-code', scenario.script, {
        initialMessage: 'Initial task', readyMarker: scenario.marker,
      });
      await ready;
      const firstRun = manager.listRuns(requirement.id)[0]!;
      assert.equal(firstRun.status, 'running');
      const reply = manager.postHumanMessage(requirement.id, body);
      assert.equal(reply.queued, true);
      writeFileSync(join(workspaceRoot, 'release-process'), '');
      const first = await execution;
      for (let attempt = 0; attempt < 60 && manager.getRequirement(requirement.id)?.session.pendingMessageCount; attempt++) {
        await delay(25);
      }
      const settledRun = manager.listRuns(requirement.id).find((run) => run.id === firstRun.id);
      assert.equal(settledRun?.status, 'failed');
      assert.equal(settledRun?.exitCode, scenario.exitCode);
      assert.equal(first.session.lastConsumedMessageSequence, 0);
      assert.equal(first.session.pendingMessageCount, 2);
      const initial = manager.listMessages(requirement.id).find((message) => message.author === 'human')!;
      const ranges = manager.listRuns(requirement.id).reverse().map((run) => [run.status, run.inputFromSequence, run.inputToSequence]);
      const expected = body.length > 100
        ? [['failed', initial.sequence, initial.sequence], ['succeeded', initial.sequence, initial.sequence], ['succeeded', reply.message.sequence, reply.message.sequence]]
        : [['failed', initial.sequence, initial.sequence], ['succeeded', initial.sequence, reply.message.sequence]];
      assert.deepEqual(ranges, expected);
      assert.equal(manager.getRequirement(requirement.id)?.session.lastConsumedMessageSequence, reply.message.sequence);
      assert.equal(manager.getRequirement(requirement.id)?.session.pendingMessageCount, 0);
    });
  }
}

test('headless steering restarts an active provider for an oversized reply when stdin is open', { timeout: 8_000 }, async (t) => {
  const { manager, requirement, ready, execution } = fixture(t, 'claude-code', claudeStdinFixture(false), {
    initialMessage: 'Initial task', readyMarker: 'stdin-marker',
  });
  await ready;
  const reply = manager.postHumanMessage(requirement.id, 'x'.repeat(13_000));
  const first = await execution;
  assert.equal(first.session.lastConsumedMessageSequence, 0);
  for (let attempt = 0; attempt < 60 && manager.getRequirement(requirement.id)?.session.pendingMessageCount; attempt++) {
    await delay(25);
  }
  assert.deepEqual(manager.listRuns(requirement.id).reverse().map((run) => run.status), ['cancelled', 'succeeded', 'succeeded']);
  assert.equal(manager.getRequirement(requirement.id)?.session.lastConsumedMessageSequence, reply.message.sequence);
  assert.equal(manager.getRequirement(requirement.id)?.session.pendingMessageCount, 0);
});

test('Claude Code automatically steers an ordinary reply into the active RD Run', { timeout: 8_000 }, async (t) => {
  const { manager, requirement, ready, execution, requests } = fixture(t, 'claude-code', claudeFixture);
  await ready;
  const reply = manager.postHumanMessage(requirement.id, 'Change the approach');
  const current = await execution;
  assert.equal(current.session.lastConsumedMessageSequence, reply.message.sequence);
  assert.equal(manager.listRuns(requirement.id)[0]?.status, 'succeeded');
  assert.equal(requests.length, 1);
});

test('Claude Code accepts a third message while the follow-up turn runs a tool', { timeout: 8_000 }, async (t) => {
  const { manager, requirement, ready, execution, requests } = fixture(t, 'claude-code', claudeFixture);
  await ready;
  const followUpReady = new Promise<void>((resolve) => {
    manager.on('output', ({ line }: { line: string }) => {
      if (line.includes('follow-up-tool')) resolve();
    });
  });
  manager.postHumanMessage(requirement.id, 'LATE_CORRECTION WAIT_FOR_THIRD');
  await followUpReady;
  const third = manager.postHumanMessage(requirement.id, 'THIRD DIRECTION');
  const current = await execution;
  assert.equal(current.session.lastConsumedMessageSequence, third.message.sequence);
  assert.equal(current.session.pendingMessageCount, 0);
  assert.equal(requests.length, 1);
});

test('a reply offered before streaming rejection starts the replacement Run before one-shot work', { timeout: 8_000 }, async (t) => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'headless-fallback-test-'));
  const runner = new HeadlessProcessRunner();
  const oneShotPrompts: string[] = [];
  const manager = new AgentManager({
    workspaceRoot, store: new SqliteAgentManagerStore(':memory:'), logger: silentLogger, timeoutMs: 3_000,
    runner: {
      run: (request) => {
        assert.ok(request.streamingInvocation);
        return runner.run({
          ...request,
          invocation: {
            ...request.invocation, command: process.execPath,
            args: ['-e', "process.stdin.on('data', (chunk) => process.stdout.write(chunk));"],
          },
          streamingInvocation: {
            ...request.streamingInvocation, command: process.execPath,
            args: ['-e', `console.error("error: unknown option '--input-format'"); process.exitCode = 1;`],
          },
          onOutput: (line) => { oneShotPrompts.push(line); },
        });
      },
    },
  });
  t.after(async () => {
    await manager.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });
  const requirement = manager.createRequirement({ title: 'Fallback', description: 'Initial task', provider: 'claude-code' });
  const initial = manager.runRequirement(requirement.id, 'Do the initial work');
  manager.postHumanMessage(requirement.id, 'STARTUP_CORRECTION');
  const first = await initial;
  assert.equal(first.session.lastConsumedMessageSequence, 0);
  for (let attempt = 0; attempt < 100 && manager.getRequirement(requirement.id)?.session.pendingMessageCount; attempt++) {
    await delay(25);
  }
  assert.deepEqual(manager.listRuns(requirement.id).map((run) => run.status), ['succeeded', 'cancelled']);
  assert.equal(oneShotPrompts.filter((line) => line.includes('Initial task')).length, 1);
  assert.match(oneShotPrompts.join('\n'), /STARTUP_CORRECTION/);
  assert.equal(manager.getRequirement(requirement.id)?.session.pendingMessageCount, 0);
});

test('Claude Code does not count a successful result for the wrong input before a later failure', { timeout: 8_000 }, async (t) => {
  const { manager, requirement, ready, execution, requests } = fixture(t, 'claude-code', claudeFixture);
  await ready;
  const reply = manager.postHumanMessage(requirement.id, 'LATE_CORRECTION FAIL_AFTER_REPLAY');
  const current = await execution;
  assert.equal(current.session.state, 'failed');
  assert.equal(current.session.pendingMessageCount, 1);
  assert.ok(current.session.lastConsumedMessageSequence < reply.message.sequence);
  assert.equal(manager.listRuns(requirement.id)[0]?.inputToSequence, null);
  assert.equal(requests.length, 1);
});

for (const provider of ['codex', 'claude-code'] as const) {
  test(`${provider} stops with pending input and resumes the same conversation on a human reply`, { timeout: 8_000 }, async (t) => {
    const { manager, requirement, ready, execution, requests } = fixture(t, provider,
      provider === 'codex' ? codexFixture : claudeFixture, { initialMessage: 'START_BEFORE_STOP' });
    await ready;
    const original = manager.listMessages(requirement.id).find((message) => message.author === 'human')!;
    const beforeStop = manager.postHumanMessage(requirement.id, 'CHANGE_BEFORE_STOP');
    assert.equal(beforeStop.queued, true);
    manager.interruptRdRun(requirement.id, 'stop');
    const stopped = await execution;
    assert.equal(stopped.status, 'waiting_confirmation');
    assert.equal(stopped.session.state, 'waiting_human');
    assert.equal(stopped.session.autoResumePaused, true);
    assert.equal(stopped.session.pendingMessageCount, 2);
    assert.equal(stopped.session.lastConsumedMessageSequence, 0);
    assert.ok(stopped.session.nativeSessionId);
    assert.deepEqual(manager.listRuns(requirement.id).map((run) => run.status), ['cancelled']);

    const resumed = manager.postHumanMessage(requirement.id, 'RESUME_AFTER_STOP');
    assert.equal(resumed.queued, false);
    assert.equal(resumed.requirement.session.autoResumePaused, false);
    if (provider === 'claude-code') {
      const args = requests[1]?.streamingInvocation?.args ?? [];
      assert.ok(args.includes('--resume'));
      assert.equal(args[args.indexOf('--resume') + 1], stopped.session.nativeSessionId);
    }
    for (let attempt = 0; attempt < 60 && manager.getRequirement(requirement.id)?.session.state === 'running'; attempt++) {
      await delay(25);
    }
    const final = manager.getRequirement(requirement.id)!;
    assert.equal(final.session.id, stopped.session.id);
    assert.equal(final.session.nativeSessionId, stopped.session.nativeSessionId);
    assert.equal(final.session.lastConsumedMessageSequence, resumed.message.sequence);
    assert.equal(final.session.pendingMessageCount, 0);
    assert.equal(requests.length, 2);
    assert.deepEqual(manager.listRuns(requirement.id).map((run) => [run.status, run.inputFromSequence, run.inputToSequence]),
      [['succeeded', original.sequence, resumed.message.sequence], ['cancelled', original.sequence, original.sequence]]);
    assert.deepEqual(manager.listMessages(requirement.id).filter((message) => message.author === 'human').map((message) => message.sequence),
      [original.sequence, beforeStop.message.sequence, resumed.message.sequence]);
  });
}
