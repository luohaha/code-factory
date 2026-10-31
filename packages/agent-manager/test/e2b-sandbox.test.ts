import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { SandboxInfo, SandboxOpts } from 'e2b';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';

import { AgentManager } from '../src/core/agent-manager.js';
import { E2BCredentialStore, e2bCredentialsPath } from '../src/runtime/e2b-credentials.js';
import { E2BSandboxService, e2bResourceTemplateName, type E2BClient, type E2BCredentials, type E2BHandle,
  type E2BTemplateBuildRequest } from '../src/runtime/e2b-execution-env.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { NativeAgentService, type NativeRunInput } from '../src/runtime/native-agent.js';
import { createAgentManagerServer } from '../src/http/server.js';
import { sandboxesTableSql, schemaStatements } from '../src/storage/schema.js';
import { SqliteAgentManagerStore } from '../src/storage/sqlite-store.js';
import type { ManagerEvent, RunOutcome, Sandbox } from '../src/core/types.js';

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

function fakeE2B(settings: { additionalCredentials?: E2BCredentials[]; home?: string;
  beforeConnect?: () => Promise<void>; beforeGetInfo?: () => Promise<void>;
  waitForCommand?: (command: string) => Promise<void>;
  before?: (action: 'status' | 'pause' | 'resume', signal?: AbortSignal) => Promise<void> } = {}) {
  let state: 'running' | 'paused' = 'running';
  let killed = false;
  const calls: string[] = [];
  const createOptions: SandboxOpts[] = [];
  const templateBuilds: E2BTemplateBuildRequest[] = [];
  let creates = 0;
  const remoteCommands: Array<{ command: string; cwd: string | undefined; envs: Record<string, string> | undefined }> = [];
  const remoteFiles = new Map<string, string>();
  const remoteWrites: Array<{ path: string; content: string }> = [];
  const home = settings.home ?? '/home/user';
  const check = (credentials: { apiKey?: string; domain?: string }) => {
    if (settings.additionalCredentials?.some((accepted) =>
      accepted.apiKey === credentials.apiKey && accepted.domain === credentials.domain)) return;
    assert.equal(credentials.apiKey, 'test-key');
    assert.equal(credentials.domain, 'e2b.example');
  };
  const handle = (id: string) => ({ sandboxId: id,
    files: {
      exists: async (path: string) => path === home || remoteFiles.has(path),
      write: async (path: string, content: string) => {
        remoteFiles.set(path, content);
        remoteWrites.push({ path, content });
      },
      remove: async (path: string) => { remoteFiles.delete(path); },
    },
    commands: { run: async (command: string, runOptions?: { envs?: Record<string, string>; cwd?: string;
      background?: boolean; onStdout?: (chunk: string) => void }) => { calls.push(`command:${command}`);
      remoteCommands.push({ command, cwd: runOptions?.cwd, envs: runOptions?.envs });
      if (command === 'pwd') return { exitCode: 0, stdout: `${home}\n` };
      if (runOptions?.background) {
        const path = command.match(/ > '([^']+)' 2>&1$/)?.[1];
        assert(path);
        remoteFiles.set(path, 'Remote command completed\n');
        return { wait: async () => { await settings.waitForCommand?.(command); return { exitCode: 0 }; }, kill: async () => true };
      }
      if (command.startsWith('if test -f ')) {
        const path = command.match(/test -f '([^']+)'/)?.[1];
        assert(path);
        const offset = Number(command.match(/tail -c \+(\d+)/)?.[1]) - 1;
        return { exitCode: 0, stdout: Buffer.from(remoteFiles.get(path) ?? '').subarray(offset, offset + 65_536).toString('base64') };
      }
      return { exitCode: 0, stdout: '' };
    } },
  }) as unknown as E2BHandle;
  const client: E2BClient = {
    async create(options) {
      calls.push(`create:${options.template}`);
      check(options);
      createOptions.push(options);
      const created = creates++;
      return handle(created === 0 ? 'created-e2b-id' : `created-e2b-id-${created}`);
    },
    async buildTemplate(request) {
      check(request.credentials);
      templateBuilds.push(request);
      return `derived-${request.cpuCount}cpu-${request.memoryMB}mb`;
    },
    async connect(id, options) {
      check(options);
      await settings.beforeConnect?.();
      await settings.before?.('resume', options.signal);
      calls.push(`connect:${id}`);
      state = 'running';
      return handle(id);
    },
    async getInfo(id, options) {
      check(options);
      await settings.before?.('status', options.signal);
      calls.push(`info:${id}`);
      await settings.beforeGetInfo?.();
      return { sandboxId: id, templateId: 'base', state, cpuCount: 2, memoryMB: 512 } as SandboxInfo;
    },
    async pause(id, options) {
      check(options);
      await settings.before?.('pause', options.signal);
      calls.push(`pause:${id}`); state = 'paused'; return true;
    },
    async kill(id, options) { check(options); calls.push(`kill:${id}`); killed = true; return true; },
  };
  return { service: new E2BSandboxService(client), calls, remoteCommands,
    remoteFiles, remoteWrites, createOptions, templateBuilds,
    get killed() { return killed; } };
}

for (const mode of ['stop', 'timeout'] as const) {
  for (const action of ['status', 'pause', 'resume'] as const) {
    test(`Native sandbox_${action} cancels its provider request on ${mode}`, async () => {
      const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-lifecycle-cancel-'));
      let enabled = false;
      let receivedSignal: AbortSignal | undefined;
      let providerCompleted = false;
      let started!: () => void;
      const requestStarted = new Promise<void>((resolve) => { started = resolve; });
      const sdk = fakeE2B({ before: async (operation, signal) => {
        if (!enabled || operation !== action) return;
        receivedSignal = signal;
        started();
        await delay(1_000, undefined, signal ? { signal } : {});
        providerCompleted = true;
      } });
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([fauxAssistantMessage(fauxToolCall(`sandbox_${action}`, {}), { stopReason: 'toolUse' })]);
      const manager = new AgentManager({ workspaceRoot: directory, databasePath: ':memory:',
        store: new SqliteAgentManagerStore(':memory:'), e2bService: sdk.service,
        nativeService: new NativeAgentService(join(directory, 'native.sqlite'), models, sdk.service),
        timeoutMs: mode === 'timeout' ? 300 : 30_000, logger: createLogger({ level: 'silent' }) });
      try {
        const workspace = await manager.createE2BSandbox({ name: 'Cancellation', domain: 'e2b.example', apiKey: 'test-key' });
        if (action === 'resume') await manager.pauseSandbox(workspace.id);
        const before = manager.listSandboxes().find((item) => item.id === workspace.id);
        const requirement = manager.createRequirement({ title: 'Cancel lifecycle', description: 'Exercise cancellation',
          provider: 'native-agent', model: 'faux/faux-1', sandboxId: workspace.id });
        enabled = true;
        const run = manager.runRequirement(requirement.id);
        await Promise.race([requestStarted, run.then(() => assert.fail('Run ended before its lifecycle request started'))]);
        if (mode === 'stop') manager.interruptRdRun(requirement.id, 'stop');
        await run;
        assert.equal(receivedSignal?.aborted, true);
        assert.equal(providerCompleted, false);
        assert.deepEqual(manager.listRuns(requirement.id).map((item) => item.status), [mode === 'stop' ? 'cancelled' : 'timed_out']);
        assert.deepEqual(manager.listSandboxes().find((item) => item.id === workspace.id), before,
          'cancellation must not persist a lifecycle result or an unreachable health status');
        assert.equal(manager.getRequirement(requirement.id)?.session.lastConsumedMessageSequence, 0);
      } finally {
        enabled = false;
        await manager.close(); rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}

test('native lifecycle tools preserve E2B pause and apply environment edits on a later remote Run', async () => {
  for (const largeInput of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-agent-lifecycle-'));
    const sdk = fakeE2B();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    let transcript = '';
    const call = (name: string) => fauxAssistantMessage(fauxToolCall(name, {}), { stopReason: 'toolUse' });
    // Use actual CodingTools between resume and pause so the lazy environment is exercised.
    faux.setResponses([
      call('sandbox_resume'),
      fauxAssistantMessage(fauxToolCall('bash', { command: 'echo ready' }), { stopReason: 'toolUse' }),
      call('sandbox_pause'), call('sandbox_status'),
      (context) => { transcript = JSON.stringify(context.messages); return fauxAssistantMessage('Paused until needed'); },
      call('sandbox_status'), fauxAssistantMessage('Still paused'),
    ]);
    const manager = new AgentManager({ workspaceRoot: directory, databasePath: ':memory:',
      store: new SqliteAgentManagerStore(':memory:'), e2bService: sdk.service,
      nativeService: new NativeAgentService(join(directory, 'native.sqlite'), models, sdk.service),
      logger: createLogger({ level: 'silent' }) });
    try {
      const workspace = await manager.createE2BSandbox({ name: 'Agent controlled', domain: 'e2b.example', apiKey: 'test-key',
        environmentVariables: { GH_TOKEN: 'lifecycle-token', CUSTOM: 'before-edit' } });
      const requirement = manager.createRequirement({ title: 'Control E2B',
        description: largeInput ? 'Long description. '.repeat(300) : 'Pause when remote work is finished',
        provider: 'native-agent', model: 'faux/faux-1', sandboxId: workspace.id });
      assert.equal((await manager.runRequirement(requirement.id)).session.state, 'waiting_human');
      assert.equal(manager.listSandboxes().find((item) => item.id === workspace.id)?.status, 'paused');
      assert.equal(transcript.includes('test-key'), false);
      assert.equal(transcript.includes('lifecycle-token'), false);
      assert.equal(transcript.includes('"isError":true'), false);
      assert.deepEqual(sdk.remoteCommands.find((entry) => entry.command.includes('echo ready'))?.envs,
        { GH_TOKEN: 'lifecycle-token', CUSTOM: 'before-edit' });
      const lastPause = sdk.calls.lastIndexOf('pause:created-e2b-id');
      assert(lastPause !== -1);
      assert(sdk.calls.slice(lastPause + 1).every((entry) => entry === 'info:created-e2b-id'));
      if (largeInput) assert(sdk.remoteFiles.size > 0, 'cleanup must not issue remote I/O after pausing');
      else {
        const before = sdk.calls.length;
        assert.equal((await manager.runRequirement(requirement.id, 'Only check sandbox status')).session.state, 'waiting_human');
        assert.deepEqual(sdk.calls.slice(before), ['info:created-e2b-id']);
        const beforeEdit = sdk.calls.length;
        await manager.updateSandbox(workspace.id, { environmentVariables: { GH_TOKEN: null, CUSTOM: 'after-edit' } });
        assert.equal(sdk.calls.length, beforeEdit, 'editing variables must not wake the sandbox');
        faux.setResponses([
          call('sandbox_resume'),
          fauxAssistantMessage(fauxToolCall('bash', { command: 'echo after-edit' }), { stopReason: 'toolUse' }),
          call('sandbox_pause'), fauxAssistantMessage('Paused after using the updated environment'),
        ]);
        assert.equal((await manager.runRequirement(requirement.id, 'Use the updated environment')).session.state, 'waiting_human');
        assert.deepEqual(sdk.remoteCommands.find((entry) => entry.command.includes('echo after-edit'))?.envs,
          { CUSTOM: 'after-edit' });
        const updated = manager.listSandboxes().find((item) => item.id === workspace.id);
        assert.equal(updated?.status, 'paused');
        assert.deepEqual(updated?.environmentVariableNames, ['CUSTOM']);
      }
    } finally { await manager.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});

test('active Native tools refresh variables before first connection, after pause/resume, and in the continued conversation', { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-dynamic-pause-'));
  const databasePath = join(directory, 'factory.sqlite');
  const sdk = fakeE2B();
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const beforeFirst = gate(); const releaseFirst = gate();
  const paused = gate(); const releasePaused = gate();
  const call = (name: string) => fauxAssistantMessage(fauxToolCall(name, {}), { stopReason: 'toolUse' });
  const bash = (command: string) => fauxAssistantMessage(fauxToolCall('bash', { command }), { stopReason: 'toolUse' });
  faux.setResponses([
    async () => { beforeFirst.release(); await releaseFirst.wait; return bash('echo initial-command'); },
    call('sandbox_pause'), call('sandbox_status'),
    async () => { paused.release(); await releasePaused.wait; return call('sandbox_resume'); },
    bash('echo resumed-command'), fauxAssistantMessage('Done'),
    bash('echo continued-command'), fauxAssistantMessage('Continued'),
  ]);
  const manager = new AgentManager({ workspaceRoot: directory, databasePath,
    store: new SqliteAgentManagerStore(databasePath), e2bService: sdk.service,
    nativeService: new NativeAgentService(join(directory, 'native.sqlite'), models, sdk.service),
    logger: createLogger({ level: 'silent' }) });
  const secrets = new E2BCredentialStore(e2bCredentialsPath(databasePath));
  let run: ReturnType<AgentManager['runRequirement']> | undefined;
  try {
    const sandbox = await manager.createE2BSandbox({ name: 'Paused edits', domain: 'e2b.example', apiKey: 'test-key',
      environmentVariables: { GH_TOKEN: 'pause-original-token', CUSTOM: 'pause-original', REMOVE: 'pause-remove' } });
    await manager.pauseSandbox(sandbox.id);
    const requirement = manager.createRequirement({ title: 'Edit while paused', description: 'Use remote commands',
      provider: 'native-agent', model: 'faux/faux-1', sandboxId: sandbox.id });
    run = manager.runRequirement(requirement.id);
    await beforeFirst.wait;
    const before = sdk.calls.length;
    const first = await manager.updateSandbox(sandbox.id, { environmentVariables: { CUSTOM: 'pause-before-first', ADDED: 'pause-added' } });
    assert.equal(sdk.calls.length, before, 'active variable edits must not connect a paused sandbox');
    assert.equal(secrets.read(sandbox.credentialRef!), null);
    releaseFirst.release();
    await paused.wait;
    assert.deepEqual(sdk.remoteCommands.find((entry) => entry.command.includes('echo initial-command'))?.envs,
      { GH_TOKEN: 'pause-original-token', CUSTOM: 'pause-before-first', REMOVE: 'pause-remove', ADDED: 'pause-added' });
    const beforePausedEdit = sdk.calls.length;
    const second = await manager.updateSandbox(sandbox.id, { environmentVariables: { GH_TOKEN: null, CUSTOM: 'pause-after', REMOVE: null } });
    assert.equal(sdk.calls.length, beforePausedEdit);
    assert.equal(second.status, 'paused');
    assert.equal(secrets.read(first.credentialRef!), null);
    releasePaused.release();
    const finished = await run;
    assert.equal(finished.session.state, 'waiting_human');
    assert.deepEqual(sdk.remoteCommands.find((entry) => entry.command.includes('echo resumed-command'))?.envs,
      { CUSTOM: 'pause-after', ADDED: 'pause-added' });
    assert.equal(manager.listSandboxes().find((item) => item.id === sandbox.id)?.credentialRef, second.credentialRef);
    await manager.updateSandbox(sandbox.id, { environmentVariables: { CUSTOM: 'pause-continued', ADDED: null } });
    const continued = await manager.runRequirement(requirement.id, 'Continue with latest variables');
    assert.equal(continued.session.nativeSessionId, finished.session.nativeSessionId);
    assert(manager.listRuns(requirement.id).every((item) => item.status === 'succeeded'));
    assert.deepEqual(sdk.remoteCommands.find((entry) => entry.command.includes('echo continued-command'))?.envs, { CUSTOM: 'pause-continued' });
    assert.equal(secrets.read(second.credentialRef!), null);
  } finally {
    releaseFirst.release(); releasePaused.release();
    await run;
    secrets.close(); await manager.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('native sandbox pause excludes only its own active RD Run and protects shared RD and Reviewer Runs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-shared-pause-'));
  const sdk = fakeE2B();
  const captured: Array<{ input: NativeRunInput; finish: (outcome: RunOutcome) => void }> = [];
  class ControlledNativeService extends NativeAgentService {
    override run(input: NativeRunInput): Promise<RunOutcome> {
      return new Promise((finish) => { captured.push({ input, finish }); });
    }
  }
  const manager = new AgentManager({ workspaceRoot: directory, databasePath: ':memory:',
    store: new SqliteAgentManagerStore(':memory:'), e2bService: sdk.service,
    nativeService: new ControlledNativeService(join(directory, 'native.sqlite')),
    logger: createLogger({ level: 'silent' }) });
  const finished: RunOutcome = { status: 'failed', exitCode: null, nativeSessionId: null, finalMessage: null, error: 'Test finished' };
  try {
    const workspace = await manager.createE2BSandbox({ name: 'Shared', domain: 'e2b.example', apiKey: 'test-key' });
    const requirements = ['First', 'Second'].map((title) => manager.createRequirement({ title, description: 'Shared E2B',
      provider: 'native-agent', sandboxId: workspace.id }));
    const first = requirements[0]!;
    const second = requirements[1]!;
    const firstRun = manager.runRequirement(first.id);
    const control = captured[0]?.input.sandbox?.control;
    assert(control);
    await assert.rejects(manager.pauseSandbox(workspace.id), /active RD Run/);
    const secondRun = manager.runRequirement(second.id);
    await assert.rejects(control('pause'), /active RD Run/);
    assert.equal(sdk.calls.some((entry) => entry.startsWith('pause:')), false);
    captured[1]!.finish(finished);
    await secondRun;
    const pr = manager.trackPullRequest({ requirementId: second.id, repository: 'example/repo', number: 9,
      url: 'https://github.com/example/repo/pull/9', title: 'Shared PR', baseBranch: 'main',
      headBranch: 'feature', headSha: 'abc123', status: 'open' });
    const review = manager.requestReview(pr.id, { provider: 'native-agent' });
    assert.equal(captured[2]?.input.sandbox?.control, undefined);
    await assert.rejects(control('pause'), /active Reviewer Run/);
    captured[2]!.finish(finished);
    await review;
    assert.equal((await control('pause')).status, 'paused');
    assert.equal((await control('status')).status, 'paused');
    assert.equal((await control('resume')).status, 'running');
    captured[0]!.finish(finished);
    await firstRun;
    await assert.rejects(control('pause'), /active Native Agent RD Run/);
  } finally {
    for (const pending of captured) pending.finish(finished);
    await manager.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('active shared Native RD and Reviewer tools use live environment patches without changing launched commands', { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-dynamic-shared-'));
  const databasePath = join(directory, 'factory.sqlite');
  const names = ['first', 'second', 'reviewer'] as const;
  const started = names.map(() => gate());
  const completion = names.map(() => gate());
  const healthStarted = gate();
  const healthCompletion = gate();
  let holdHealth = false;
  const sdk = fakeE2B({
    waitForCommand: async (command) => {
      const index = names.findIndex((name) => command.includes(`hold-${name}`));
      if (index !== -1) { started[index]!.release(); await completion[index]!.wait; }
    },
    beforeGetInfo: async () => {
      if (!holdHealth) return;
      holdHealth = false;
      healthStarted.release();
      await healthCompletion.wait;
    },
  });
  const models = createModels();
  const transcripts: string[] = [];
  for (const name of names) {
    const faux = fauxProvider({ provider: name, api: `faux-shared-${name}` });
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('bash', { command: `echo hold-${name}` }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('bash', { command: `echo next-${name}` }), { stopReason: 'toolUse' }),
      (context) => { transcripts.push(JSON.stringify(context)); return fauxAssistantMessage(`${name} finished`); },
      fauxAssistantMessage('RD accepted the review'),
    ]);
  }
  const store = new SqliteAgentManagerStore(databasePath);
  const manager = new AgentManager({ workspaceRoot: directory, databasePath, store, e2bService: sdk.service,
    nativeService: new NativeAgentService(join(directory, 'native.sqlite'), models, sdk.service),
    logger: createLogger({ level: 'silent' }) });
  const server = createAgentManagerServer(manager);
  const secrets = new E2BCredentialStore(e2bCredentialsPath(databasePath));
  const runs: Array<ReturnType<AgentManager['runRequirement']>> = [];
  let review: Promise<RunOutcome> | undefined;
  let health: ReturnType<AgentManager['checkSandboxHealth']> | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const originalEnvironment = { GITHUB_TOKEN: 'live-original-token', REPLACE: 'live-before', REMOVE: 'live-removed', KEEP: 'live-kept' };
    const sandbox = await manager.createE2BSandbox({ name: 'Live shared', domain: 'e2b.example', apiKey: 'test-key',
      environmentVariables: originalEnvironment });
    const requirements = names.slice(0, 2).map((name) => manager.createRequirement({ title: name, description: 'Use shared E2B',
      provider: 'native-agent', model: `${name}/faux-1`, sandboxId: sandbox.id }));
    for (const [index, requirement] of requirements.entries()) {
      runs.push(manager.runRequirement(requirement.id));
      await started[index]!.wait;
    }
    const pr = manager.trackPullRequest({ requirementId: requirements[1]!.id, repository: 'example/repo', number: 9,
      url: 'https://github.com/example/repo/pull/9', title: 'Live review', baseBranch: 'main',
      headBranch: 'feature', headSha: 'abc123', status: 'open' });
    review = manager.requestReview(pr.id, { provider: 'native-agent', model: 'reviewer/faux-1' });
    await started[2]!.wait;
    for (const requirement of requirements) assert.equal(manager.getRequirement(requirement.id)?.session.state, 'running');
    assert.equal(manager.listReviewRequests(pr.id)[0]?.status, 'running');
    const launched = sdk.remoteCommands.filter((entry) => entry.command.includes('echo hold-'));
    assert.equal(launched.length, 3);
    for (const command of launched) assert.deepEqual(command.envs, originalEnvironment);

    holdHealth = true;
    health = manager.checkSandboxHealth(sandbox.id);
    await healthStarted.wait;
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sandboxes/${sandbox.id}`;
    const patch = async (environmentVariables: Record<string, string | null>) => {
      const response = await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ environmentVariables }) });
      const body = await response.json() as { credentialRef: string; environmentVariableNames: string[] };
      assert.equal(response.status, 200);
      assert.equal(JSON.stringify(body).includes('live-'), false, 'responses contain names, never values');
      return body;
    };
    const edited = await patch({ GITHUB_TOKEN: 'live-replacement-token', REPLACE: 'live-after', REMOVE: null, ADDED: 'live-added' });
    const concurrent = await Promise.all([patch({ ALPHA: 'live-alpha' }), patch({ BETA: 'live-beta' })]);
    const expected = { GITHUB_TOKEN: 'live-replacement-token', REPLACE: 'live-after', KEEP: 'live-kept',
      ADDED: 'live-added', ALPHA: 'live-alpha', BETA: 'live-beta' };
    const current = store.getSandbox(sandbox.id)!;
    healthCompletion.release();
    assert.equal((await health).credentialRef, current.credentialRef, 'health must not restore an obsolete reference');
    assert.equal(secrets.read(sandbox.credentialRef!), null);
    assert.equal(secrets.read(edited.credentialRef), null);
    for (const result of concurrent) if (result.credentialRef !== current.credentialRef) assert.equal(secrets.read(result.credentialRef), null);
    assert.deepEqual(secrets.readEnvironment(current.credentialRef!), expected);
    for (const command of launched) assert.deepEqual(command.envs, originalEnvironment, 'already launched commands retain their environment');

    completion[0]!.release(); completion[1]!.release();
    await Promise.all(runs);
    for (const requirement of requirements) assert(manager.listRuns(requirement.id).some((run) => run.role === 'rd' && run.status === 'succeeded'));
    await assert.rejects(manager.updateSandbox(sandbox.id, { domain: 'new.e2b.example' }), /active Reviewer Run/);
    await assert.rejects(manager.updateSandbox(sandbox.id, { apiKey: 'new-key' }), /active Reviewer Run/);
    await patch({ REVIEW_ONLY: 'live-review-only' });
    const followup = new Promise<void>((resolve) => {
      manager.on('event', (event: ManagerEvent) => {
        if (event.type === 'run.succeeded' && event.requirementId === requirements[1]!.id && event.payload.role === 'rd') resolve();
      });
    });
    completion[2]!.release();
    assert.equal((await review).status, 'succeeded');
    await followup;
    for (const name of names) {
      const next = sdk.remoteCommands.find((entry) => entry.command.includes(`echo next-${name}`));
      assert(next, 'a real Native bash tool must launch its next command');
      assert.deepEqual(next.envs, { ...expected, ...(name === 'reviewer' ? { REVIEW_ONLY: 'live-review-only' } : {}) });
      assert.equal(Object.hasOwn(next.envs!, 'REMOVE'), false);
    }
    for (const requirement of requirements) transcripts.push(JSON.stringify(manager.listMessages(requirement.id)));
    assert.equal(transcripts.join().includes('live-'), false, 'values must not enter model context or conversation events');
    const database = new DatabaseSync(e2bCredentialsPath(databasePath));
    try { assert.equal(database.prepare('SELECT COUNT(*) AS count FROM e2b_credentials').get()?.count, 1); }
    finally { database.close(); }
  } finally {
    completion.forEach((item) => item.release()); healthCompletion.release();
    await Promise.allSettled([...runs, ...(review ? [review] : []), ...(health ? [health] : [])]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    secrets.close(); await manager.close();
    try {
      for (const path of [databasePath, join(directory, 'native.sqlite')]) assert.equal(readFileSync(path).includes('live-'), false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test('E2B domain defaults apply to creation, attachment and blank edits while omitted edits preserve custom domains', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-default-domain-'));
  const sdk = fakeE2B({ additionalCredentials: [{ domain: 'e2b.app', apiKey: 'test-key' }] });
  const store = new SqliteAgentManagerStore(':memory:');
  const manager = new AgentManager({ workspaceRoot: directory, databasePath: ':memory:', store,
    e2bService: sdk.service, logger: createLogger({ level: 'silent' }) });
  const server = createAgentManagerServer(manager);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sandboxes`;
  const request = (path: string, method: string, body?: unknown) => fetch(`${base}${path}`, {
    method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  try {
    for (const fields of [{}, { domain: '' }, { domain: ' \t ' }, { providerSandboxId: 'external-e2b-id' }]) {
      const response = await request('', 'POST', { kind: 'e2b', name: 'Default domain', apiKey: 'test-key',
        ...fields, environmentVariables: { CUSTOM: 'saved' } });
      assert.equal(response.status, 201);
      const sandbox = await response.json() as Sandbox;
      assert.equal(sandbox.domain, 'e2b.app');
      assert.equal(store.getSandbox(sandbox.id)?.domain, 'e2b.app');
      assert.equal((await request(`/${sandbox.id}/health`, 'GET')).status, 200);
      const custom = await request(`/${sandbox.id}`, 'PATCH', { domain: ' E2B.EXAMPLE ' });
      assert.equal(custom.status, 200);
      assert.equal((await custom.json() as Sandbox).domain, 'e2b.example');
      const renamed = await request(`/${sandbox.id}`, 'PATCH', { name: 'Keep custom domain' });
      assert.equal(renamed.status, 200);
      assert.equal((await renamed.json() as Sandbox).domain, 'e2b.example');
      const reset = await request(`/${sandbox.id}`, 'PATCH', { domain: 'domain' in fields ? fields.domain : '' });
      assert.equal(reset.status, 200);
      assert.equal((await reset.json() as Sandbox).domain, 'e2b.app');
      assert.deepEqual(manager.listSandboxes().find((item) => item.id === sandbox.id)?.environmentVariableNames, ['CUSTOM']);
      assert.equal((await request(`/${sandbox.id}`, 'DELETE')).status, 204);
    }
    const calls = sdk.calls.length;
    for (const domain of [null, 42, 'https://e2b.app']) {
      assert.equal((await request('', 'POST', { kind: 'e2b', name: 'Invalid domain', apiKey: 'test-key', domain })).status, 400);
    }
    assert.equal(sdk.calls.length, calls, 'invalid domains must be rejected before provisioning');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('E2B sandbox API provisions, allows reuse, checks health and controls lifecycle', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-api-'));
  const databasePath = join(directory, 'factory.sqlite');
  const sdk = fakeE2B();
  const manager = new AgentManager({ workspaceRoot: directory, databasePath,
    store: new SqliteAgentManagerStore(databasePath), e2bService: sdk.service,
    logger: createLogger({ level: 'silent' }) });
  const server = createAgentManagerServer(manager);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  let attachedId: string | null = null;
  let attachedRef: string | null = null;
  const credentials = { domain: 'e2b.example', apiKey: 'test-key' };
  const request = (path: string, method: string, body?: unknown) => fetch(`${base}${path}`, {
    method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  try {
    for (const fields of [{ cwd: '/repo' }, { cwd: null }, { repositoryUrl: 'https://github.com/example/repo.git' }]) {
      const rejected = await request('/sandboxes', 'POST', { kind: 'e2b', name: 'Removed options',
        ...credentials, ...fields });
      assert.equal(rejected.status, 400);
    }
    assert.deepEqual(sdk.calls, []);
    const created = await request('/sandboxes', 'POST', { kind: 'e2b', name: 'Reusable',
      ...credentials });
    assert.equal(created.status, 201);
    const sandbox = await created.json() as { id: string; providerSandboxId: string; status: string;
      credentialEnvVar: string | null; credentialRef: string; domain: string; repositoryUrl: string | null; cwd: string | null };
    assert.equal(sandbox.providerSandboxId, 'created-e2b-id');
    assert.equal(sandbox.credentialEnvVar, null);
    assert.equal(sandbox.domain, 'e2b.example');
    assert.match(sandbox.credentialRef, /^e2b_/);
    assert.equal(sandbox.repositoryUrl, null);
    assert.equal(sandbox.cwd, null);
    assert.equal(JSON.stringify(sandbox).includes('test-key'), false);
    assert.equal(sandbox.status, 'running');
    assert.equal('sharing' in sandbox, false);
    assert.deepEqual(sdk.remoteCommands, []);
    assert.equal((await request('/sandboxes', 'POST', { kind: 'e2b', name: 'Duplicate',
      ...credentials, providerSandboxId: 'created-e2b-id' })).status, 409);

    const first = await request('/requirements', 'POST', { title: 'First', description: 'Uses E2B',
      provider: 'native-agent', sandboxId: sandbox.id });
    assert.equal(first.status, 201);
    const requirement = await first.json() as { id: string };
    const second = await request('/requirements', 'POST', { title: 'Second', description: 'Reuses E2B',
      provider: 'native-agent', sandboxId: sandbox.id });
    assert.equal(second.status, 201);
    const secondRequirement = await second.json() as { id: string; sandboxId: string };
    assert.equal(secondRequirement.sandboxId, sandbox.id);
    assert.equal((await request('/requirements', 'POST', { title: 'Headless', description: 'Cannot use E2B',
      provider: 'codex', sandboxId: sandbox.id })).status, 400);

    const health = await request(`/sandboxes/${sandbox.id}/health`, 'GET');
    assert.equal((await health.json() as { status: string }).status, 'running');
    const paused = await request(`/sandboxes/${sandbox.id}/pause`, 'POST');
    assert.equal((await paused.json() as { status: string }).status, 'paused');
    const resumed = await request(`/sandboxes/${sandbox.id}/resume`, 'POST');
    assert.equal((await resumed.json() as { status: string }).status, 'running');
    assert.equal((await request(`/sandboxes/${sandbox.id}`, 'DELETE')).status, 409);
    const switched = await request(`/requirements/${requirement.id}`, 'PATCH', { provider: 'codex' });
    assert.equal(switched.status, 200);
    assert.equal((await switched.json() as { sandboxId: string | null }).sandboxId, null);
    assert.equal((await request(`/sandboxes/${sandbox.id}`, 'DELETE')).status, 409);
    assert.equal((await request(`/requirements/${secondRequirement.id}`, 'PATCH', { provider: 'codex' })).status, 200);
    assert.equal((await request(`/sandboxes/${sandbox.id}`, 'DELETE')).status, 204);
    assert.equal(sdk.killed, true);
    const attached = await request('/sandboxes', 'POST', { kind: 'e2b', name: 'Attached',
      ...credentials, providerSandboxId: 'external-e2b-id' });
    assert.equal(attached.status, 201);
    const attachedRecord = await attached.json() as { id: string; credentialRef: string };
    attachedId = attachedRecord.id;
    attachedRef = attachedRecord.credentialRef;
    for (const number of [1, 2]) {
      assert.equal((await request('/requirements', 'POST', { title: `Shared ${number}`, description: 'Same E2B',
        provider: 'native-agent', sandboxId: attachedId })).status, 201);
    }
    assert(sdk.calls.includes('connect:external-e2b-id'));
    assert.deepEqual(sdk.remoteCommands, []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
    if (attachedId) {
      const reopened = new SqliteAgentManagerStore(databasePath);
      try {
        assert.equal(reopened.getSandbox(attachedId)?.providerSandboxId, 'external-e2b-id');
        assert.equal('sharing' in reopened.getSandbox(attachedId)!, false);
        assert.equal(reopened.getSandbox(attachedId)?.domain, 'e2b.example');
        assert.equal(reopened.getSandbox(attachedId)?.credentialRef, attachedRef);
      } finally { reopened.close(); }
      const secrets = new E2BCredentialStore(e2bCredentialsPath(databasePath));
      try { assert.equal(secrets.read(attachedRef!), 'test-key'); }
      finally { secrets.close(); }
      assert.equal(statSync(e2bCredentialsPath(databasePath)).mode & 0o777, 0o600);
      assert.equal(readFileSync(databasePath).includes('test-key'), false);
      const restarted = new AgentManager({ workspaceRoot: directory, databasePath,
        store: new SqliteAgentManagerStore(databasePath), e2bService: sdk.service,
        logger: createLogger({ level: 'silent' }) });
      try { assert.equal((await restarted.checkSandboxHealth(attachedId)).status, 'running'); }
      finally { await restarted.close(); }
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('E2B creation ignores the managed workspace Git origin without preparing remote contents', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-origin-'));
  const databasePath = join(directory, 'factory.sqlite');
  execFileSync('git', ['init', directory]);
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:example/repo.git'], { cwd: directory });
  const sdk = fakeE2B();
  const manager = new AgentManager({ workspaceRoot: directory, databasePath,
    store: new SqliteAgentManagerStore(databasePath), e2bService: sdk.service,
    logger: createLogger({ level: 'silent' }) });
  const server = createAgentManagerServer(manager);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sandboxes`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'e2b', name: 'Simple', domain: 'e2b.example', apiKey: 'test-key' }),
    });
    assert.equal(response.status, 201);
    const sandbox = await response.json() as { id: string; repositoryUrl: string | null; cwd: string | null };
    assert.equal(sandbox.repositoryUrl, null);
    assert.equal(sandbox.cwd, null);
    assert.equal('sharing' in sandbox, false);
    assert.equal(sdk.remoteCommands.length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('E2B workspace settings reject repository and directory configuration', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-options-'));
  const sdk = fakeE2B();
  const manager = new AgentManager({ workspaceRoot: directory, databasePath: ':memory:',
    store: new SqliteAgentManagerStore(':memory:'), e2bService: sdk.service,
    logger: createLogger({ level: 'silent' }) });
  const server = createAgentManagerServer(manager);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const workspace = await manager.createE2BSandbox({ name: 'No checkout', domain: 'e2b.example', apiKey: 'test-key' });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sandboxes/${workspace.id}`;
    for (const body of [{ cwd: '/repo' }, { cwd: null }, { repositoryUrl: 'https://github.com/example/repo.git' }]) {
      const response = await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 400);
    }
    assert.equal(manager.listSandboxes().find((item) => item.id === workspace.id)?.cwd, null);
    assert.deepEqual(sdk.remoteCommands, []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('E2B workspace settings can be edited and credentials rotate without exposing keys', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-edit-'));
  const databasePath = join(directory, 'factory.sqlite');
  const sdk = fakeE2B({ additionalCredentials: [{ domain: 'new.e2b.example', apiKey: 'new-key' }] });
  const manager = new AgentManager({ workspaceRoot: directory, databasePath,
    store: new SqliteAgentManagerStore(databasePath), e2bService: sdk.service,
    logger: createLogger({ level: 'silent' }) });
  const server = createAgentManagerServer(manager);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sandboxes`;
  try {
    const created = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'e2b', name: 'Original', domain: 'e2b.example', apiKey: 'test-key' }) });
    assert.equal(created.status, 201);
    const first = await created.json() as { id: string; credentialRef: string };
    const updated = await fetch(`${base}/${first.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed', domain: 'new.e2b.example', apiKey: 'new-key' }) });
    assert.equal(updated.status, 200);
    const second = await updated.json() as { id: string; name: string; domain: string;
      credentialRef: string };
    assert.equal(second.name, 'Renamed');
    assert.equal(second.domain, 'new.e2b.example');
    assert.equal('sharing' in second, false);
    assert.notEqual(second.credentialRef, first.credentialRef);
    assert.equal(JSON.stringify(second).includes('new-key'), false);
    const secrets = new E2BCredentialStore(e2bCredentialsPath(databasePath));
    try {
      assert.equal(secrets.read(first.credentialRef), null);
      assert.equal(secrets.read(second.credentialRef), 'new-key');
    } finally { secrets.close(); }
    assert.equal((await fetch(`${base}/${first.id}/health`)).status, 200);
    assert.equal((await fetch(`${base}/${first.id}`, { method: 'DELETE' })).status, 204);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a Native Reviewer for an E2B Requirement uses the same remote execution environment without a CLI', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-review-'));
  const databasePath = join(directory, 'factory.sqlite');
  const sdk = fakeE2B();
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('bash', { command: 'gh pr view https://github.com/example/repo/pull/7' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Remote review completed'),
    fauxAssistantMessage('RD saw the review'),
  ]);
  const manager = new AgentManager({ workspaceRoot: directory, databasePath,
    store: new SqliteAgentManagerStore(databasePath), e2bService: sdk.service,
    nativeService: new NativeAgentService(join(directory, 'native.sqlite'), models, sdk.service),
    logger: createLogger({ level: 'silent' }) });
  try {
    const workspace = await manager.createE2BSandbox({ name: 'Review remote', domain: 'e2b.example',
      apiKey: 'test-key', environmentVariables: { GH_TOKEN: 'review-runtime-token', REVIEW_MODE: 'configured' } });
    const requirement = manager.createRequirement({ title: 'Remote work', description: 'Review PR',
      provider: 'native-agent', model: 'faux/faux-1', sandboxId: workspace.id });
    const pullRequest = manager.trackPullRequest({ requirementId: requirement.id, repository: 'example/repo',
      number: 7, url: 'https://github.com/example/repo/pull/7', title: 'Remote PR',
      baseBranch: 'main', headBranch: 'feature', headSha: 'abc123def456', status: 'open' });
    assert.throws(() => manager.requestReview(pullRequest.id, { provider: 'codex' }), /Native Agent Reviewer/);
    const outcome = await manager.requestReview(pullRequest.id, { provider: 'native-agent' });
    assert.equal(outcome.status, 'succeeded');
    assert(sdk.remoteCommands.some((entry) => entry.command.includes('gh pr view') && entry.cwd === undefined
      && entry.envs?.GH_TOKEN === 'review-runtime-token' && entry.envs?.REVIEW_MODE === 'configured'));
    assert.equal(manager.listMessages(requirement.id).find((message) => message.author === 'reviewer')?.body, 'Remote review completed');
  } finally {
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('large Native Agent input is available in E2B during the Run and removed afterward', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-handoff-'));
  const databasePath = join(directory, 'factory.sqlite');
  const sdk = fakeE2B();
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let handoff = '';
  faux.setResponses([fauxAssistantMessage('Remote input handled'), (context) => {
    handoff = JSON.stringify(context.messages);
    return fauxAssistantMessage('Remote context restored');
  }]);
  const store = new SqliteAgentManagerStore(databasePath);
  const manager = new AgentManager({ workspaceRoot: directory, databasePath,
    store, e2bService: sdk.service,
    nativeService: new NativeAgentService(join(directory, 'native.sqlite'), models, sdk.service),
    logger: createLogger({ level: 'silent' }) });
  const description = `${'Long description. '.repeat(300)}Final acceptance criterion.`;
  const pendingBody = `${'Long pending instruction. '.repeat(6_000)}Final pending clause.`;
  try {
    const workspace = await manager.createE2BSandbox({ name: 'Large remote input', domain: 'e2b.example',
      apiKey: 'test-key' });
    const requirement = manager.createRequirement({ title: 'Remote input', description,
      provider: 'native-agent', model: 'faux/faux-1', sandboxId: workspace.id });
    const completed = await manager.runRequirement(requirement.id, pendingBody);
    assert.equal(completed.status, 'waiting_confirmation');
    assert.equal(completed.session.pendingMessageCount, 0);
    assert.deepEqual(sdk.remoteWrites.map((write) => write.content), [description, pendingBody]);
    assert.ok(sdk.remoteWrites.every((write) => write.path.startsWith('/tmp/code-factory-')));
    assert.equal(sdk.remoteFiles.size, 0);
    store.setNativeSessionId(requirement.session.id, null, new Date().toISOString());
    const restored = await manager.runRequirement(requirement.id, 'Continue in the remote workspace');
    assert.equal(restored.status, 'waiting_confirmation');
    assert.match(handoff, /Selected E2B workspace: SDK default user home directory/);
    assert.equal(handoff.includes(directory), false);
  } finally {
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Native Agents clone repositories on demand and new sandboxes use remote GitHub authentication', async () => {
  const savedToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'test-manager-github-token';
  try {
    for (const legacy of [false, true]) {
      const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-demand-'));
      const sdk = fakeE2B();
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall('bash', { command: 'git clone https://github.com/example/repo.git' }), { stopReason: 'toolUse' }),
        (context) => {
          assert.equal(JSON.stringify(context.messages).includes('"isError":true'), false);
          return fauxAssistantMessage('Repository prepared');
        },
      ]);
      const store = new SqliteAgentManagerStore(':memory:');
      const manager = new AgentManager({ workspaceRoot: directory, databasePath: ':memory:', store, e2bService: sdk.service,
        nativeService: new NativeAgentService(join(directory, 'native.sqlite'), models, sdk.service),
        logger: createLogger({ level: 'silent' }) });
      try {
        const workspace = await manager.createE2BSandbox({ name: 'On demand', domain: 'e2b.example', apiKey: 'test-key' });
        assert.deepEqual(sdk.remoteCommands, []);
        if (legacy) store.updateSandbox({ ...workspace, cwd: '/legacy/checkout', repositoryUrl: 'https://github.com/example/repo.git' });
        const requirement = manager.createRequirement({ title: 'Clone a repository', description: 'Clone example/repo as needed',
          provider: 'native-agent', model: 'faux/faux-1', sandboxId: workspace.id });
        const outcome = await manager.runRequirement(requirement.id);
        assert.equal(outcome.status, 'waiting_confirmation');
        const cloned = sdk.remoteCommands.find((entry) => entry.command.includes('git clone https://github.com/example/repo.git'));
        assert(cloned);
        assert.equal(cloned.cwd, legacy ? '/legacy/checkout' : undefined);
        assert.equal(cloned.envs?.GH_TOKEN !== undefined, legacy);
      } finally {
        await manager.close();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  } finally {
    if (savedToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = savedToken;
  }
});

test('legacy sandbox records survive E2B schema migration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-migrate-'));
  const databasePath = join(directory, 'factory.sqlite');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`CREATE TABLE sandboxes (id TEXT PRIMARY KEY, name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('local', 'local-sandbox')), cwd TEXT NOT NULL, created_at TEXT NOT NULL) STRICT`);
  legacy.prepare('INSERT INTO sandboxes VALUES (?, ?, ?, ?, ?)').run('old', 'Existing', 'local-sandbox',
    '/tmp/existing', '2026-01-01T00:00:00Z');
  legacy.close();
  try {
    const store = new SqliteAgentManagerStore(databasePath);
    try {
      assert.deepEqual(store.getSandbox('old'), { id: 'old', name: 'Existing', kind: 'local-sandbox',
        cwd: '/tmp/existing', providerSandboxId: null, credentialEnvVar: null, domain: null,
        credentialRef: null, repositoryUrl: null, template: null, cpuCount: null, memoryMB: null,
        status: 'unknown', checkedAt: null, createdAt: '2026-01-01T00:00:00Z' });
    } finally { store.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('sandbox cwd accepts null in new and migrated schemas', () => {
  for (const definition of ['TEXT', 'TEXT NOT NULL', "TEXT CHECK (cwd IS NOT NULL OR kind = 'e2b')"]) {
    const directory = mkdtempSync(join(tmpdir(), 'code-factory-nullable-cwd-'));
    const databasePath = join(directory, 'factory.sqlite');
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(sandboxesTableSql.replace('cwd TEXT,', `cwd ${definition},`));
    legacy.prepare('INSERT INTO sandboxes (id, name, kind, cwd, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('existing', 'Existing workspace', 'local', '/existing', '2026-01-01T00:00:00Z');
    legacy.close();
    try {
      const store = new SqliteAgentManagerStore(databasePath);
      try {
        const workspace = store.getSandbox('existing');
        assert(workspace);
        assert.equal(workspace.cwd, '/existing');
        store.updateSandbox({ ...workspace, cwd: null });
        assert.equal(store.getSandbox('existing')?.cwd, null);
      } finally { store.close(); }
      const reopened = new SqliteAgentManagerStore(databasePath);
      try { assert.equal(reopened.getSandbox('existing')?.cwd, null); }
      finally { reopened.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test('E2B records created before per-sandbox credentials gain nullable settings', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-settings-'));
  const databasePath = join(directory, 'factory.sqlite');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`CREATE TABLE sandboxes (id TEXT PRIMARY KEY, name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('local', 'local-sandbox', 'e2b')), cwd TEXT NOT NULL,
    provider_sandbox_id TEXT, credential_env_var TEXT, template TEXT,
    status TEXT NOT NULL, checked_at TEXT, created_at TEXT NOT NULL) STRICT`);
  legacy.prepare('INSERT INTO sandboxes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'old-e2b', 'Existing E2B', 'e2b', '/home/user/repo', 'provider-id', 'E2B_API_KEY',
    'base', 'running', null, '2026-01-01T00:00:00Z');
  for (const statement of schemaStatements) legacy.exec(statement);
  legacy.prepare(`INSERT INTO requirements (id, title, description, status, provider, sandbox_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('bound', 'Existing requirement', 'Keep workspace', 'todo', 'native-agent',
    'old-e2b', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  legacy.close();
  try {
    const store = new SqliteAgentManagerStore(databasePath);
    try {
      const sandbox = store.getSandbox('old-e2b');
      assert.equal(sandbox?.providerSandboxId, 'provider-id');
      assert.equal(sandbox?.cwd, '/home/user/repo');
      assert.equal(sandbox?.credentialEnvVar, 'E2B_API_KEY');
      assert.equal(sandbox?.domain, null);
      assert.equal(sandbox?.credentialRef, null);
      assert.equal(sandbox?.repositoryUrl, null);
      assert.equal('sharing' in sandbox!, false);
    } finally { store.close(); }
    const inspected = new DatabaseSync(databasePath);
    try {
      assert.equal(inspected.prepare('SELECT sandbox_id FROM requirements WHERE id = ?').get('bound')?.sandbox_id, 'old-e2b');
      assert.deepEqual(inspected.prepare('PRAGMA foreign_key_check').all(), []);
      const reopened = new SqliteAgentManagerStore(databasePath);
      try { assert.equal(reopened.getSandbox('old-e2b')?.cwd, '/home/user/repo'); }
      finally { reopened.close(); }
    } finally { inspected.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Native RD instructions let the Agent select and clone its own repository in an empty E2B sandbox', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-agent-setup-'));
  const databasePath = join(directory, 'factory.sqlite');
  const sdk = fakeE2B();
  const requests: NativeRunInput[] = [];
  class RecordingNativeService extends NativeAgentService {
    override async run(input: NativeRunInput): Promise<RunOutcome> {
      requests.push(input);
      return { status: 'succeeded', exitCode: 0, nativeSessionId: null, finalMessage: null, error: null };
    }
  }
  const manager = new AgentManager({ workspaceRoot: directory, databasePath,
    store: new SqliteAgentManagerStore(databasePath), e2bService: sdk.service,
    nativeService: new RecordingNativeService(join(directory, 'native.sqlite')),
    logger: createLogger({ level: 'silent' }) });
  try {
    const sandbox = await manager.createE2BSandbox({ name: 'Empty sandbox', domain: 'e2b.example', apiKey: 'test-key',
      environmentVariables: { GH_TOKEN: 'runtime-only-token', CUSTOM: 'runtime-only-custom' } });
    const requirement = manager.createRequirement({ title: 'Clone task repository', description: 'Choose code later',
      provider: 'native-agent', sandboxId: sandbox.id });
    await manager.runRequirement(requirement.id);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.sandbox?.cwd, null);
    assert.equal(requests[0]!.sandbox?.forwardGitHubToken, false);
    assert.deepEqual(requests[0]!.sandbox?.getEnvironmentVariables?.(), { GH_TOKEN: 'runtime-only-token', CUSTOM: 'runtime-only-custom' });
    assert.match(requests[0]!.instructions, /Configured environment variable names: CUSTOM, GH_TOKEN/);
    assert.equal(JSON.stringify({ prompt: requests[0]!.prompt, instructions: requests[0]!.instructions }).includes('runtime-only'), false);
    assert.match(requests[0]!.instructions, /This sandbox may be empty/);
    assert.match(requests[0]!.instructions, /Select and clone the repository required by the task/);
    assert.match(requests[0]!.instructions, /if the repository is unspecified, ask the human/);
    assert.doesNotMatch(requests[0]!.instructions, /must already contain a Git checkout|must remain authenticated/);
    await manager.updateSandbox(sandbox.id, { environmentVariables: { GH_TOKEN: 'rotated-token', CUSTOM: null } });
    await manager.runRequirement(requirement.id, 'Use the updated environment');
    assert.deepEqual(requests[1]!.sandbox?.getEnvironmentVariables?.(), { GH_TOKEN: 'rotated-token' });
    assert.deepEqual(requests[0]!.sandbox?.getEnvironmentVariables?.(), { GH_TOKEN: 'rotated-token' });
  } finally {
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('E2B environment API validates, hides values, preserves omitted keys, rotates, removes, and survives restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-environment-'));
  const databasePath = join(directory, 'factory.sqlite');
  const sdk = fakeE2B();
  const manager = new AgentManager({ workspaceRoot: directory, databasePath,
    store: new SqliteAgentManagerStore(databasePath), e2bService: sdk.service,
    logger: createLogger({ level: 'silent' }) });
  const server = createAgentManagerServer(manager);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sandboxes`;
  const send = (path: string, method: string, body: unknown) => fetch(path, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  let savedId = '';
  try {
    const common = { kind: 'e2b', name: 'Configured', domain: 'e2b.example', apiKey: 'test-key' };
    for (const environmentVariables of [[], 'not-an-object', { 'BAD=secret': 'secret' }, { GH_TOKEN: 42 }]) {
      const rejected = await send(base, 'POST', { ...common, environmentVariables });
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.text()).includes('secret'), false);
    }
    assert.equal(sdk.calls.length, 0);
    const local = await send(base, 'POST', { kind: 'local', name: 'Local', cwd: directory,
      environmentVariables: { GH_TOKEN: 'not-for-local' } });
    assert.equal(local.status, 400);
    assert.match(await local.text(), /only supported for E2B/);
    const created = await send(base, 'POST', { ...common,
      environmentVariables: { GH_TOKEN: 'original-github-secret', CUSTOM: '  exact value\n' } });
    assert.equal(created.status, 201);
    const sandbox = await created.json() as { id: string; credentialRef: string; environmentVariableNames: string[] };
    savedId = sandbox.id;
    assert.deepEqual(sandbox.environmentVariableNames, ['CUSTOM', 'GH_TOKEN']);
    assert.equal(JSON.stringify(sandbox).includes('original-github-secret'), false);
    assert.equal((await (await fetch(base)).text()).includes('original-github-secret'), false);
    const secrets = new E2BCredentialStore(e2bCredentialsPath(databasePath));
    try {
      assert.deepEqual(secrets.readEnvironment(sandbox.credentialRef), { GH_TOKEN: 'original-github-secret', CUSTOM: '  exact value\n' });
      const renamed = await send(`${base}/${sandbox.id}`, 'PATCH', { name: 'Renamed', apiKey: 'test-key' });
      assert.equal(renamed.status, 200);
      const rotated = await renamed.json() as { credentialRef: string };
      assert.deepEqual(secrets.readEnvironment(rotated.credentialRef), { GH_TOKEN: 'original-github-secret', CUSTOM: '  exact value\n' });
      assert.equal(secrets.read(sandbox.credentialRef), null);
      const updated = await send(`${base}/${sandbox.id}`, 'PATCH', {
        environmentVariables: { GH_TOKEN: 'replacement-github-secret', CUSTOM: null, EMPTY: '' },
      });
      assert.equal(updated.status, 200);
      const result = await updated.json() as { credentialRef: string; environmentVariableNames: string[] };
      assert.deepEqual(result.environmentVariableNames, ['EMPTY', 'GH_TOKEN']);
      assert.deepEqual(secrets.readEnvironment(result.credentialRef), { GH_TOKEN: 'replacement-github-secret', EMPTY: '' });
      assert.equal(secrets.read(rotated.credentialRef), null);
      assert.equal((await (await fetch(`${base}/${sandbox.id}/health`)).text()).includes('replacement-github-secret'), false);
    } finally { secrets.close(); }
    assert.equal(readFileSync(databasePath).includes('original-github-secret'), false);
    assert.equal(readFileSync(databasePath).includes('replacement-github-secret'), false);
    assert.equal(sdk.remoteCommands.length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
  }
  const restarted = new AgentManager({ workspaceRoot: directory, databasePath,
    store: new SqliteAgentManagerStore(databasePath), e2bService: sdk.service,
    logger: createLogger({ level: 'silent' }) });
  try {
    assert.deepEqual(restarted.listSandboxes().find((sandbox) => sandbox.id === savedId)?.environmentVariableNames, ['EMPTY', 'GH_TOKEN']);
    const cleared = await restarted.updateSandbox(savedId, { environmentVariables: { GH_TOKEN: null, EMPTY: null } });
    assert.deepEqual(cleared.environmentVariableNames, []);
    await restarted.deleteSandbox(savedId);
  } finally {
    await restarted.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const lookupFails of [false, true]) {
  test(`an in-flight ${lookupFails ? 'failed' : 'successful'} health check preserves an environment edit`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-health-edit-'));
    const databasePath = join(directory, 'factory.sqlite');
    let holdLookup = false;
    let finishLookup!: () => void;
    let lookupStarted!: () => void;
    const pendingLookup = new Promise<void>((resolve) => { finishLookup = resolve; });
    const started = new Promise<void>((resolve) => { lookupStarted = resolve; });
    const sdk = fakeE2B({ beforeGetInfo: async () => {
      if (!holdLookup) return;
      holdLookup = false;
      lookupStarted();
      await pendingLookup;
      if (lookupFails) throw new Error('Provider lookup failed');
    } });
    const requests: NativeRunInput[] = [];
    class RecordingNativeService extends NativeAgentService {
      override async run(input: NativeRunInput): Promise<RunOutcome> {
        requests.push(input);
        return { status: 'succeeded', exitCode: 0, nativeSessionId: null, finalMessage: null, error: null };
      }
    }
    const store = new SqliteAgentManagerStore(databasePath);
    const manager = new AgentManager({ workspaceRoot: directory, databasePath, store, e2bService: sdk.service,
      nativeService: new RecordingNativeService(join(directory, 'native.sqlite')),
      logger: createLogger({ level: 'silent' }) });
    const secrets = new E2BCredentialStore(e2bCredentialsPath(databasePath));
    let health: ReturnType<AgentManager['checkSandboxHealth']> | undefined;
    try {
      const sandbox = await manager.createE2BSandbox({ name: 'Original', domain: 'e2b.example', apiKey: 'test-key',
        environmentVariables: { GH_TOKEN: 'original-token' } });
      holdLookup = true;
      health = manager.checkSandboxHealth(sandbox.id);
      await started;
      const updated = await manager.updateSandbox(sandbox.id, { name: 'Edited during lookup',
        environmentVariables: { GH_TOKEN: 'replacement-token', CUSTOM: 'configured' } });
      assert.notEqual(updated.credentialRef, sandbox.credentialRef);
      assert.equal(secrets.read(sandbox.credentialRef!), null);
      finishLookup();
      const checked = await health;
      assert.equal(checked.credentialRef, updated.credentialRef);
      assert.equal(checked.name, updated.name);
      assert.deepEqual(checked.environmentVariableNames, ['CUSTOM', 'GH_TOKEN']);
      assert.equal(checked.status, lookupFails ? 'unreachable' : 'running');
      assert(checked.checkedAt);
      assert.equal(store.getSandbox(sandbox.id)?.credentialRef, updated.credentialRef);
      assert.deepEqual(manager.listSandboxes().find((item) => item.id === sandbox.id), checked);
      assert.deepEqual(secrets.readEnvironment(checked.credentialRef!), { GH_TOKEN: 'replacement-token', CUSTOM: 'configured' });
      const requirement = manager.createRequirement({ title: 'Use edited environment', description: 'Continue after health check',
        provider: 'native-agent', sandboxId: sandbox.id });
      const outcome = await manager.runRequirement(requirement.id);
      assert.equal(outcome.status, 'waiting_confirmation');
      assert.equal(requests[0]?.sandbox?.credentials.apiKey, 'test-key');
      assert.deepEqual(requests[0]?.sandbox?.getEnvironmentVariables?.(), { GH_TOKEN: 'replacement-token', CUSTOM: 'configured' });
    } finally {
      finishLookup();
      await health?.catch(() => undefined);
      secrets.close();
      await manager.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const stage of ['connect', 'status']) {
  for (const rotateKey of [false, true]) {
    test(`${rotateKey ? 'API key' : 'domain'} verification in ${stage} preserves a concurrent environment patch`, async () => {
      const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-connection-edit-'));
      const databasePath = join(directory, 'factory.sqlite');
      let holdVerification = false;
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const beforeVerification = async () => {
        if (!holdVerification) return;
        holdVerification = false;
        entered();
        await gate;
      };
      const sdk = fakeE2B({ additionalCredentials: [
        { domain: 'new.e2b.example', apiKey: 'test-key' }, { domain: 'e2b.example', apiKey: 'new-key' },
      ], ...(stage === 'connect' ? { beforeConnect: beforeVerification } : { beforeGetInfo: beforeVerification }) });
      const requests: NativeRunInput[] = [];
      class RecordingNativeService extends NativeAgentService {
        override async run(input: NativeRunInput): Promise<RunOutcome> {
          requests.push(input);
          return { status: 'succeeded', exitCode: 0, nativeSessionId: null, finalMessage: null, error: null };
        }
      }
      const store = new SqliteAgentManagerStore(databasePath);
      const manager = new AgentManager({ workspaceRoot: directory, databasePath, store, e2bService: sdk.service,
        nativeService: new RecordingNativeService(join(directory, 'native.sqlite')),
        logger: createLogger({ level: 'silent' }) });
      const secrets = new E2BCredentialStore(e2bCredentialsPath(databasePath));
      let connection: ReturnType<AgentManager['updateSandbox']> | undefined;
      try {
        const original = await manager.createE2BSandbox({ name: 'Original', domain: 'e2b.example', apiKey: 'test-key',
          environmentVariables: { GH_TOKEN: 'original-token', KEEP: 'initial', REMOVE: 'remove-me' } });
        holdVerification = true;
        connection = manager.updateSandbox(original.id, rotateKey
          ? { apiKey: 'new-key', environmentVariables: { FROM_CONNECTION: 'added', SHARED: 'connection-value' } }
          : { domain: 'new.e2b.example' });
        await started;
        const edited = await manager.updateSandbox(original.id, { name: 'Edited during verification',
          environmentVariables: { GH_TOKEN: 'replacement-token', REMOVE: null, NEW: 'retained', SHARED: 'environment-value' } });
        assert.equal(secrets.read(original.credentialRef!), null);
        release();
        const saved = await connection;
        const expectedEnvironment = { GH_TOKEN: 'replacement-token', KEEP: 'initial', NEW: 'retained',
          SHARED: rotateKey ? 'connection-value' : 'environment-value', ...(rotateKey ? { FROM_CONNECTION: 'added' } : {}) };
        assert.equal(saved.name, edited.name);
        assert.equal(saved.domain, rotateKey ? 'e2b.example' : 'new.e2b.example');
        assert.deepEqual(saved.environmentVariableNames, Object.keys(expectedEnvironment).sort());
        assert.deepEqual(secrets.readEnvironment(saved.credentialRef!), expectedEnvironment);
        assert.equal(secrets.read(saved.credentialRef!), rotateKey ? 'new-key' : 'test-key');
        if (rotateKey) {
          assert.notEqual(saved.credentialRef, edited.credentialRef);
          assert.equal(secrets.read(edited.credentialRef!), null);
        } else assert.equal(saved.credentialRef, edited.credentialRef);
        assert.equal(store.getSandbox(original.id)?.credentialRef, saved.credentialRef);
        assert.deepEqual(manager.listSandboxes().find((item) => item.id === saved.id), saved);
        const database = new DatabaseSync(e2bCredentialsPath(databasePath));
        try { assert.equal(database.prepare('SELECT COUNT(*) AS count FROM e2b_credentials').get()?.count, 1); }
        finally { database.close(); }
        const requirement = manager.createRequirement({ title: 'Use merged settings', description: 'Run after connection update',
          provider: 'native-agent', sandboxId: saved.id });
        assert.equal((await manager.runRequirement(requirement.id)).status, 'waiting_confirmation');
        assert.deepEqual(requests[0]?.sandbox?.credentials, { domain: saved.domain, apiKey: rotateKey ? 'new-key' : 'test-key' });
        assert.deepEqual(requests[0]?.sandbox?.getEnvironmentVariables?.(), expectedEnvironment);
      } finally {
        release();
        await connection?.catch(() => undefined);
        secrets.close();
        await manager.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}

test('a connection update rejects verification invalidated by a concurrent API key edit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-connection-conflict-'));
  const databasePath = join(directory, 'factory.sqlite');
  let holdConnect = true;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const sdk = fakeE2B({ additionalCredentials: [
    { domain: 'new.e2b.example', apiKey: 'test-key' }, { domain: 'e2b.example', apiKey: 'new-key' },
  ], beforeConnect: async () => {
    if (!holdConnect) return;
    holdConnect = false;
    entered();
    await gate;
  } });
  const manager = new AgentManager({ workspaceRoot: directory, databasePath,
    store: new SqliteAgentManagerStore(databasePath), e2bService: sdk.service,
    logger: createLogger({ level: 'silent' }) });
  const secrets = new E2BCredentialStore(e2bCredentialsPath(databasePath));
  let connection: ReturnType<AgentManager['updateSandbox']> | undefined;
  try {
    const sandbox = await manager.createE2BSandbox({ name: 'Original', domain: 'e2b.example', apiKey: 'test-key' });
    connection = manager.updateSandbox(sandbox.id, { domain: 'new.e2b.example' });
    await started;
    const edited = await manager.updateSandbox(sandbox.id, { apiKey: 'new-key',
      environmentVariables: { GH_TOKEN: 'concurrent-token' } });
    const rejected = assert.rejects(connection, /connection settings changed during verification/);
    release();
    await rejected;
    assert.deepEqual(manager.listSandboxes().find((item) => item.id === sandbox.id), edited);
    assert.equal(secrets.read(edited.credentialRef!), 'new-key');
    assert.deepEqual(secrets.readEnvironment(edited.credentialRef!), { GH_TOKEN: 'concurrent-token' });
    assert.equal(secrets.read(sandbox.credentialRef!), null);
  } finally {
    release();
    await connection?.catch(() => undefined);
    secrets.close();
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('failed sandbox persistence preserves the old environment and removes the uncommitted secret record', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-env-rollback-'));
  const databasePath = join(directory, 'factory.sqlite');
  class FailingStore extends SqliteAgentManagerStore {
    override updateSandbox(_sandbox: Sandbox): Sandbox { throw new Error('Save failed'); }
  }
  const manager = new AgentManager({ workspaceRoot: directory, databasePath,
    store: new FailingStore(databasePath), e2bService: fakeE2B().service,
    logger: createLogger({ level: 'silent' }) });
  try {
    const sandbox = await manager.createE2BSandbox({ name: 'Original', domain: 'e2b.example', apiKey: 'test-key',
      environmentVariables: { GH_TOKEN: 'original-token' } });
    await assert.rejects(manager.updateSandbox(sandbox.id, { environmentVariables: { GH_TOKEN: 'replacement-token' } }), /Save failed/);
    assert.deepEqual(manager.listSandboxes().find((item) => item.id === sandbox.id), sandbox);
    const secrets = new E2BCredentialStore(e2bCredentialsPath(databasePath));
    try { assert.deepEqual(secrets.readEnvironment(sandbox.credentialRef!), { GH_TOKEN: 'original-token' }); }
    finally { secrets.close(); }
    const database = new DatabaseSync(e2bCredentialsPath(databasePath));
    try { assert.equal(database.prepare('SELECT COUNT(*) AS count FROM e2b_credentials').get()?.count, 1); }
    finally { database.close(); }
  } finally {
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('environment edits succeed while an RD Run is active and connection updates remain protected', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-env-active-'));
  const databasePath = join(directory, 'factory.sqlite');
  let finish!: (outcome: RunOutcome) => void;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  class PendingNativeService extends NativeAgentService {
    override run(input: NativeRunInput): Promise<RunOutcome> {
      return new Promise((resolve) => {
        finish = resolve;
        input.signal.addEventListener('abort', () => resolve({ status: 'cancelled', exitCode: null,
          nativeSessionId: null, finalMessage: null, error: 'Stopped' }), { once: true });
        ready();
      });
    }
  }
  let releaseConnection!: () => void;
  let enteredConnection!: () => void;
  const connectionGate = new Promise<void>((resolve) => { releaseConnection = resolve; });
  const connectionStarted = new Promise<void>((resolve) => { enteredConnection = resolve; });
  const sdk = fakeE2B({ additionalCredentials: [{ domain: 'new.e2b.example', apiKey: 'test-key' }],
    beforeConnect: async () => { enteredConnection(); await connectionGate; } });
  let connection: ReturnType<AgentManager['updateSandbox']> | undefined;
  const manager = new AgentManager({ workspaceRoot: directory, databasePath,
    store: new SqliteAgentManagerStore(databasePath), e2bService: sdk.service,
    nativeService: new PendingNativeService(join(directory, 'native.sqlite')),
    logger: createLogger({ level: 'silent' }) });
  try {
    const sandbox = await manager.createE2BSandbox({ name: 'Busy', domain: 'e2b.example', apiKey: 'test-key',
      environmentVariables: { GH_TOKEN: 'original' } });
    connection = manager.updateSandbox(sandbox.id, { domain: 'new.e2b.example' });
    await connectionStarted;
    const requirement = manager.createRequirement({ title: 'Running', description: 'Use environment',
      provider: 'native-agent', sandboxId: sandbox.id });
    const run = manager.runRequirement(requirement.id);
    await started;
    const edited = await manager.updateSandbox(sandbox.id, { environmentVariables: { GH_TOKEN: 'new' } });
    await assert.rejects(manager.updateSandbox(sandbox.id, { domain: 'new.e2b.example' }), /active RD Run/);
    await assert.rejects(manager.updateSandbox(sandbox.id, { apiKey: 'new-key' }), /active RD Run/);
    const rejected = assert.rejects(connection, /active RD Run/);
    releaseConnection();
    await rejected;
    assert.deepEqual(manager.listSandboxes().find((item) => item.id === sandbox.id), edited);
    finish({ status: 'succeeded', exitCode: 0, nativeSessionId: null, finalMessage: null, error: null });
    await run;
    assert.deepEqual((await manager.updateSandbox(sandbox.id, { environmentVariables: { GH_TOKEN: null } })).environmentVariableNames, []);
  } finally {
    releaseConnection();
    await connection?.catch(() => undefined);
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('E2B workspace creation derives a template that allocates the requested vCPU and memory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-resources-'));
  const databasePath = join(directory, 'factory.sqlite');
  const sdk = fakeE2B();
  const manager = new AgentManager({ workspaceRoot: directory, databasePath,
    store: new SqliteAgentManagerStore(databasePath), e2bService: sdk.service,
    logger: createLogger({ level: 'silent' }) });
  try {
    const sandbox = await manager.createE2BSandbox({ name: 'Large sandbox', domain: 'e2b.example', apiKey: 'test-key',
      template: 'custom-template', cpuCount: 4, memoryMB: 4096 });
    assert.deepEqual(sdk.templateBuilds, [{ template: 'custom-template', cpuCount: 4, memoryMB: 4096,
      credentials: { domain: 'e2b.example', apiKey: 'test-key' } }]);
    assert.equal(sdk.createOptions[0]?.template, 'derived-4cpu-4096mb');
    assert.equal(sandbox.template, 'custom-template', 'the workspace keeps the template the human asked for');
    assert.equal(sandbox.cpuCount, 2, 'resources are recorded as E2B last reported them');
    assert.equal(sandbox.memoryMB, 512);
    assert.equal(manager.listSandboxes().find((item) => item.id === sandbox.id)?.cpuCount, 2);
    const checked = await manager.checkSandboxHealth(sandbox.id);
    assert.equal(checked.memoryMB, 512);

    const defaultResources = await manager.createE2BSandbox({ name: 'Default sandbox', domain: 'e2b.example', apiKey: 'test-key' });
    assert.equal(sdk.templateBuilds.length, 1, 'omitting cpuCount and memoryMB never builds a template');
    assert.equal(sdk.createOptions[1]?.template, 'base');
    assert.equal(defaultResources.template, 'base');

    await manager.createE2BSandbox({ name: 'Large sandbox clone', domain: 'e2b.example', apiKey: 'test-key',
      template: 'custom-template', cpuCount: 4, memoryMB: 4096 });
    assert.equal(sdk.templateBuilds.length, 1, 'the same resource shape reuses the derived template');
  } finally {
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('E2B workspace creation rejects incomplete, out-of-range, and attached resource requests', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-resource-validation-'));
  const databasePath = join(directory, 'factory.sqlite');
  const sdk = fakeE2B();
  const manager = new AgentManager({ workspaceRoot: directory, databasePath,
    store: new SqliteAgentManagerStore(databasePath), e2bService: sdk.service,
    logger: createLogger({ level: 'silent' }) });
  try {
    const base = { name: 'Invalid', domain: 'e2b.example', apiKey: 'test-key' };
    await assert.rejects(manager.createE2BSandbox({ ...base, cpuCount: 2 }), /cpuCount and memoryMB must be provided together/);
    await assert.rejects(manager.createE2BSandbox({ ...base, memoryMB: 1024 }), /cpuCount and memoryMB must be provided together/);
    await assert.rejects(manager.createE2BSandbox({ ...base, cpuCount: 0, memoryMB: 1024 }), /cpuCount must be an integer between 1 and 8/);
    await assert.rejects(manager.createE2BSandbox({ ...base, cpuCount: 9, memoryMB: 1024 }), /cpuCount must be an integer between 1 and 8/);
    await assert.rejects(manager.createE2BSandbox({ ...base, cpuCount: 1.5, memoryMB: 1024 }), /cpuCount must be an integer between 1 and 8/);
    await assert.rejects(manager.createE2BSandbox({ ...base, cpuCount: 2, memoryMB: 256 }), /memoryMB must be an integer between 512 and 8192/);
    await assert.rejects(manager.createE2BSandbox({ ...base, cpuCount: 2, memoryMB: 8193 }), /memoryMB must be an integer between 512 and 8192/);
    await assert.rejects(manager.createE2BSandbox({ ...base, providerSandboxId: 'existing-id', cpuCount: 2, memoryMB: 1024 }),
      /cannot be requested when attaching an existing sandbox/);
    assert.deepEqual(sdk.templateBuilds, []);
    assert.deepEqual(sdk.calls, []);
    assert.deepEqual(manager.listSandboxes().filter((item) => item.kind === 'e2b'), []);
  } finally {
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('E2B resource HTTP requests forward cpuCount and memoryMB and surface validation errors', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-resource-http-'));
  const sdk = fakeE2B();
  const manager = new AgentManager({ workspaceRoot: directory, databasePath: ':memory:',
    store: new SqliteAgentManagerStore(':memory:'), e2bService: sdk.service,
    logger: createLogger({ level: 'silent' }) });
  const server = createAgentManagerServer(manager, { logger: createLogger({ level: 'silent' }) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/api/sandboxes`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const created = await post({ kind: 'e2b', name: 'HTTP resources', domain: 'e2b.example', apiKey: 'test-key',
      template: 'custom-template', cpuCount: 8, memoryMB: 8192 });
    assert.equal(created.status, 201);
    const sandbox = await created.json() as Sandbox;
    assert.equal(sandbox.cpuCount, 2);
    assert.equal(sandbox.memoryMB, 512);
    assert.deepEqual(sdk.templateBuilds.map((build) => [build.cpuCount, build.memoryMB]), [[8, 8192]]);

    const partial = await post({ kind: 'e2b', name: 'Partial', domain: 'e2b.example', apiKey: 'test-key', cpuCount: 2 });
    assert.equal(partial.status, 400);
    assert.match(JSON.stringify(await partial.json()), /cpuCount and memoryMB must be provided together/);
    const fractional = await post({ kind: 'e2b', name: 'Fractional', domain: 'e2b.example', apiKey: 'test-key',
      cpuCount: 2.5, memoryMB: 1024 });
    assert.equal(fractional.status, 400);
    const text = await post({ kind: 'e2b', name: 'Text', domain: 'e2b.example', apiKey: 'test-key',
      cpuCount: '2', memoryMB: 1024 });
    assert.equal(text.status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
