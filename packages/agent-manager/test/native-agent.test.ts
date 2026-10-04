import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';

import { AgentManager } from '../src/agent-manager.js';
import { createLogger } from '../src/logger.js';
import { NativeAgentService } from '../src/native-agent.js';
import { SqliteAgentManagerStore } from '../src/sqlite-store.js';

test('Agent Manager records a native RD Run and conversation reply', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-factory-native-manager-'));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('Implementation ready')]);
  const manager = new AgentManager({ workspaceRoot: directory, store: new SqliteAgentManagerStore(':memory:'),
    nativeService: new NativeAgentService(join(directory, 'native.sqlite'), models),
    logger: createLogger({ level: 'silent' }) });
  try {
    const requirement = manager.createRequirement({ title: 'Native work', description: 'Implement it',
      provider: 'native-agent', model: 'faux/faux-1' });
    const completed = await manager.runRequirement(requirement.id);
    assert.equal(completed.status, 'waiting_confirmation');
    assert.equal(completed.session.state, 'waiting_human');
    assert(completed.session.nativeSessionId);
    assert(manager.listMessages(requirement.id).some((message) => message.author === 'rd_agent' && message.body === 'Implementation ready'));
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('native agent preserves its durable conversation across service reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-factory-native-'));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const first = new NativeAgentService(join(directory, 'native.sqlite'), models);
  const sessions: string[] = [];
  const run = (service: NativeAgentService, nativeSessionId: string | null, prompt: string) => service.run({
    requirementId: 'req_test', sessionId: 'ses_test', nativeSessionId, forkSourceNativeSessionId: null,
    prompt, model: 'faux/faux-1', reasoningEffort: null, cwd: directory, environment: {}, instructions: 'Test agent',
    signal: new AbortController().signal, timeoutMs: 30_000, onNativeSession: (id) => sessions.push(id), onEvent: () => undefined,
  });
  try {
    faux.setResponses([fauxAssistantMessage('First answer')]);
    const initial = await run(first, null, 'First input');
    assert.equal(initial.status, 'succeeded');
    assert.equal(initial.finalMessage, 'First answer');
    assert.equal(sessions.length, 1);
    await first.close();

    const reopened = new NativeAgentService(join(directory, 'native.sqlite'), models);
    try {
      faux.setResponses([fauxAssistantMessage('Second answer')]);
      const continued = await run(reopened, initial.nativeSessionId, 'Second input');
      assert.equal(continued.status, 'succeeded');
      assert.equal(continued.nativeSessionId, initial.nativeSessionId);
      assert.equal(continued.finalMessage, 'Second answer');
    } finally {
      await reopened.close();
    }
  } finally {
    await first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('native steering joins an active tool round', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-factory-steer-'));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new NativeAgentService(join(directory, 'native.sqlite'), models);
  let sawSteer = false;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('bash', { command: 'sleep 0.2' }), { stopReason: 'toolUse' }),
    (context) => {
      sawSteer = JSON.stringify(context.messages).includes('Use the new direction');
      return fauxAssistantMessage('Steered answer');
    },
  ]);
  try {
    const run = service.run({ requirementId: 'req_steer', sessionId: 'ses_steer', nativeSessionId: null,
      forkSourceNativeSessionId: null, prompt: 'Original direction', model: 'faux/faux-1',
      reasoningEffort: null, cwd: directory, environment: {}, instructions: 'Test agent',
      signal: new AbortController().signal, timeoutMs: 30_000, onNativeSession: () => undefined, onEvent: () => undefined });
    for (let attempt = 0; attempt < 100 && faux.state.callCount < 1; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(await service.steer('req_steer', 'Use the new direction'), true);
    const outcome = await run;
    assert.equal(outcome.status, 'succeeded');
    assert.equal(sawSteer, true);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Stop Run during native setup never submits the initial input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-factory-stop-setup-'));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('Unexpected model call')]);
  const service = new NativeAgentService(join(directory, 'native.sqlite'), models);
  const controller = new AbortController();
  try {
    const run = service.run({ requirementId: 'req_stop', sessionId: 'ses_stop', nativeSessionId: null,
      forkSourceNativeSessionId: null, prompt: 'Do work', model: 'faux/faux-1',
      reasoningEffort: null, cwd: directory, environment: {}, instructions: 'Test agent',
      signal: controller.signal, timeoutMs: 30_000, onNativeSession: () => undefined, onEvent: () => undefined });
    controller.abort();
    const outcome = await run;
    assert.equal(outcome.status, 'cancelled');
    assert.equal(faux.state.callCount, 0);
    assert.equal(await service.steer('req_stop', 'Too late'), false);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('native Steering during setup delivers attachment-only input in the same Run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-factory-steer-setup-'));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new NativeAgentService(join(directory, 'native.sqlite'), models);
  const store = new SqliteAgentManagerStore(':memory:');
  const manager = new AgentManager({ workspaceRoot: directory, store, nativeService: service,
    logger: createLogger({ level: 'silent' }) });
  let sawAttachment = false;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('bash', { command: 'sleep 0.2' }), { stopReason: 'toolUse' }),
    (context) => {
      const messages = JSON.stringify(context.messages);
      sawAttachment = messages.includes('[Attachment only]') && messages.includes('steering-notes.txt');
      return fauxAssistantMessage('Steered with attachment');
    },
  ]);
  try {
    const requirement = manager.createRequirement({ title: 'Attachment steering', description: 'Implement it',
      provider: 'native-agent', model: 'faux/faux-1' });
    const run = manager.runRequirement(requirement.id);
    const attachment = manager.uploadMessageAttachment(requirement.id, {
      fileName: 'steering-notes.txt', data: Buffer.from('New direction'),
    });
    const reply = manager.postHumanMessage(requirement.id, '', [attachment.id]);
    assert.equal(reply.queued, true);
    manager.interruptRdRun(requirement.id, 'steer');
    const completed = await run;
    assert.equal(completed.session.state, 'waiting_human');
    assert.equal(sawAttachment, true);
    assert.equal(manager.listRuns(requirement.id).length, 1);
    const recorded = manager.listRuns(requirement.id)[0];
    assert.equal(recorded?.status, 'succeeded');
    assert.equal(recorded.inputToSequence, reply.message.sequence);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('native fork starts a separate conversation with source context', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-factory-fork-'));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new NativeAgentService(join(directory, 'native.sqlite'), models);
  const base = { model: 'faux/faux-1', reasoningEffort: null, cwd: directory, environment: {},
    instructions: 'Test agent', signal: new AbortController().signal, timeoutMs: 30_000,
    onNativeSession: () => undefined, onEvent: () => undefined } as const;
  try {
    faux.setResponses([fauxAssistantMessage('Source answer')]);
    const source = await service.run({ ...base, requirementId: 'req_source', sessionId: 'ses_source',
      nativeSessionId: null, forkSourceNativeSessionId: null, prompt: 'Source task' });
    assert.equal(source.status, 'succeeded');
    let inherited = false;
    faux.setResponses([(context) => {
      inherited = JSON.stringify(context.messages).includes('Source answer');
      return fauxAssistantMessage('Fork answer');
    }]);
    const fork = await service.run({ ...base, requirementId: 'req_fork', sessionId: 'ses_fork',
      nativeSessionId: null, forkSourceNativeSessionId: source.nativeSessionId, prompt: 'Another direction' });
    assert.equal(fork.status, 'succeeded');
    assert.notEqual(fork.nativeSessionId, source.nativeSessionId);
    assert.equal(inherited, true);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('native control-plane tool calls the requirement CLI with session context', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-factory-tools-'));
  const server = createServer((request, response) => {
    assert.equal(request.url, '/api/agent/requirements/req_tools/related?sourceSessionId=ses_tools');
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ parent: null, children: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('requirement_related', {}), { stopReason: 'toolUse' }),
    (context) => fauxAssistantMessage(JSON.stringify(context.messages).includes('children') ? 'Related lookup succeeded' : 'Missing result'),
  ]);
  const service = new NativeAgentService(join(directory, 'native.sqlite'), models);
  const traces: string[] = [];
  try {
    const outcome = await service.run({ requirementId: 'req_tools', sessionId: 'ses_tools', nativeSessionId: null,
      forkSourceNativeSessionId: null, prompt: 'Check related requirements', model: 'faux/faux-1',
      reasoningEffort: null, cwd: directory,
      environment: { CODE_FACTORY_API_URL: `http://127.0.0.1:${address.port}/api`, CODE_FACTORY_REQUIREMENT_ID: 'req_tools', CODE_FACTORY_SESSION_ID: 'ses_tools' },
      instructions: 'Test agent', signal: new AbortController().signal, timeoutMs: 30_000,
      onNativeSession: () => undefined, onEvent: (event) => { for (const trace of event.traces ?? []) traces.push(trace.toolName ?? ''); } });
    assert.equal(outcome.status, 'succeeded');
    assert.equal(outcome.finalMessage, 'Related lookup succeeded');
    assert(traces.includes('requirement_related'));
  } finally {
    await service.close();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('native gh_pr runs inside the selected execution environment with literal arguments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-factory-gh-pr-'));
  const sandbox = join(directory, 'sandbox');
  const binaryDirectory = join(directory, 'bin');
  const marker = join(directory, 'unexpected-file');
  await mkdir(sandbox);
  await mkdir(binaryDirectory);
  const gh = join(binaryDirectory, 'gh');
  await writeFile(gh, '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@"\n');
  await chmod(gh, 0o755);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const literalArgument = `$(touch ${marker})`;
  let sawSandboxCommand = false;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('gh_pr', { action: 'view', args: ['--title', 'two words', literalArgument] }), { stopReason: 'toolUse' }),
    (context) => {
      const messages = JSON.stringify(context.messages);
      sawSandboxCommand = messages.includes(sandbox) && messages.includes('two words') && messages.includes(literalArgument);
      return fauxAssistantMessage(sawSandboxCommand ? 'PR command ran in sandbox' : 'PR command ran elsewhere');
    },
  ]);
  const service = new NativeAgentService(join(directory, 'native.sqlite'), models);
  try {
    const outcome = await service.run({ requirementId: 'req_gh', sessionId: 'ses_gh', nativeSessionId: null,
      forkSourceNativeSessionId: null, prompt: 'Inspect PR', model: 'faux/faux-1', reasoningEffort: null,
      cwd: sandbox, environment: { PATH: `${binaryDirectory}:${process.env.PATH ?? ''}` }, instructions: 'Test agent',
      signal: new AbortController().signal, timeoutMs: 30_000,
      onNativeSession: () => undefined, onEvent: () => undefined });
    assert.equal(outcome.status, 'succeeded');
    assert.equal(sawSandboxCommand, true);
    await assert.rejects(stat(marker), { code: 'ENOENT' });
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('native control-plane tool exposes a failed CLI call as a tool error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-factory-tool-error-'));
  const server = createServer((_request, response) => {
    response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'registration denied' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let sawFailure = false;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('requirement_related', {}), { stopReason: 'toolUse' }),
    (context) => {
      const messages = JSON.stringify(context.messages);
      sawFailure = messages.includes('registration denied') && messages.includes('isError');
      return fauxAssistantMessage(sawFailure ? 'Lookup failed' : 'Lookup appeared successful');
    },
  ]);
  const service = new NativeAgentService(join(directory, 'native.sqlite'), models);
  try {
    const outcome = await service.run({ requirementId: 'req_error', sessionId: 'ses_error', nativeSessionId: null,
      forkSourceNativeSessionId: null, prompt: 'Check related', model: 'faux/faux-1', reasoningEffort: null,
      cwd: directory,
      environment: { CODE_FACTORY_API_URL: `http://127.0.0.1:${address.port}/api`, CODE_FACTORY_REQUIREMENT_ID: 'req_error', CODE_FACTORY_SESSION_ID: 'ses_error' },
      instructions: 'Test agent', signal: new AbortController().signal, timeoutMs: 30_000,
      onNativeSession: () => undefined, onEvent: () => undefined });
    assert.equal(outcome.status, 'succeeded');
    assert.equal(sawFailure, true);
  } finally {
    await service.close();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
