import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { AgentManager } from '../src/agent-manager.ts';
import { dockerInvocation, DOCKER_AGENT_PATH, prepareDockerRun } from '../src/docker-runtime.ts';
import { dockerResources } from '../src/docker-resources.ts';
import { createLogger } from '../src/logger.ts';
import { NativeAgentService, type NativeRunInput } from '../src/native-agent.ts';
import { NativeProfileStore, nativeAuthDatabasePath, profileModel } from '../src/native-auth.ts';
import { HeadlessProcessRunner, type ProcessRunRequest } from '../src/process-runner.ts';
import { createAgentManagerServer } from '../src/server.ts';
import { SqliteAgentManagerStore } from '../src/sqlite-store.ts';
import type { AgentAdapter } from '../src/adapters/types.ts';
import type { DockerResources, RunOutcome } from '../src/types.ts';

const resources: DockerResources = { image: 'code-factory-agent:local', cpus: 1.5, memoryMb: 512 };
const success: RunOutcome = { status: 'succeeded', exitCode: 0, nativeSessionId: null, finalMessage: 'Ready', error: null };
const noOutput: AgentAdapter = { provider: 'codex', parseLine: () => null,
  buildRdInvocation: () => { throw new Error('unused'); }, buildReviewInvocation: () => { throw new Error('unused'); } };

test('Docker arguments bound CPU/memory, preserve paths/user/network and keep credentials out of argv', () => {
  const invocation = dockerInvocation({ resources, name: 'agent-test', cwd: '/home/dev/repo', home: '/home/dev', uid: 501, gid: 20, groups: [20, 80],
    paths: ['/home/dev/repo/attachments', '/external/worktree'], environment: { GH_TOKEN: 'secret', HOME: '/home/dev' },
    invocation: { command: 'codex', args: ['exec', '-'], input: 'task' } });
  const args = invocation.args;
  for (const pair of [['--cpus', '1.5'], ['--memory', '512m'], ['--memory-swap', '512m'],
    ['--network', 'host'], ['--user', '501:20'], ['--group-add', '80'], ['--workdir', '/home/dev/repo'], ['--env', 'GH_TOKEN']]) {
    assert(args.some((value, index) => value === pair[0] && args[index + 1] === pair[1]));
  }
  assert(args.includes('type=bind,source=/home/dev,target=/home/dev'));
  assert(args.includes('type=bind,source=/external/worktree,target=/external/worktree'));
  assert(!args.some((value) => value.includes('attachments') || value.includes('secret')));
  assert.deepEqual(args.slice(-6), ['node', resources.image, '/opt/code-factory/dist/docker-agent-entrypoint.js', 'codex', 'exec', '-']);
  assert.equal(invocation.input, 'task');
  for (const invalid of [false, [], {}, { ...resources, image: '--privileged' }, { ...resources, cpus: NaN },
    { ...resources, cpus: 0 }, { ...resources, memoryMb: 63 }, { ...resources, memoryMb: 512.1 }, { ...resources, privileged: true }]) {
    assert.throws(() => dockerResources(invalid), TypeError);
  }
});

test('Docker configuration migrates, persists and only resets Native context when switching execution mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-docker-store-'));
  const path = join(directory, 'factory.sqlite');
  let store = new SqliteAgentManagerStore(path);
  const now = new Date().toISOString();
  try {
    const initial = store.createRequirement({ requirementId: 'req_native', sessionId: 'ses_native', title: 'Native',
      description: 'work', provider: 'native-agent', createdBy: 'human', now });
    store.setNativeSessionId(initial.session.id, '17', now);
    store.close();
    const legacy = new DatabaseSync(path);
    legacy.exec('ALTER TABLE requirements DROP COLUMN docker_json');
    legacy.close();
    store = new SqliteAgentManagerStore(path);
    assert.equal(store.getRequirement(initial.id)?.docker, null);
    const update = { requirementId: initial.id, title: initial.title, description: initial.description,
      provider: initial.provider, model: null, reasoningEffort: null, sandboxId: null, now };
    assert.equal(store.updateRequirement({ ...update, docker: resources }).session.nativeSessionId, null);
    store.setNativeSessionId(initial.session.id, '28', now);
    const changed = { ...resources, cpus: 2 };
    assert.equal(store.updateRequirement({ ...update, docker: changed }).session.nativeSessionId, '28');
    store.close();
    store = new SqliteAgentManagerStore(path);
    assert.deepEqual(store.getRequirement(initial.id)?.docker, changed);
    assert.equal(store.updateRequirement({ ...update, docker: null }).session.nativeSessionId, null);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('HTTP create/update validates Docker resources and RD/Reviewer runs use the selected configuration for all providers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-docker-api-'));
  const store = new SqliteAgentManagerStore(join(directory, 'factory.sqlite'));
  const requests: Array<ProcessRunRequest | NativeRunInput> = [];
  class Native extends NativeAgentService {
    override async run(input: NativeRunInput): Promise<RunOutcome> { requests.push(input); return success; }
  }
  const manager = new AgentManager({ workspaceRoot: directory, databasePath: join(directory, 'factory.sqlite'), store,
    runner: { run: async (request) => { requests.push(request); return success; } }, nativeService: new Native(join(directory, 'native.sqlite')),
    logger: createLogger({ level: 'silent' }) });
  const server = createAgentManagerServer(manager);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/requirements`;
  const post = (body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const input = { title: 'Work', description: 'Implement', provider: 'codex', docker: resources };
    for (const docker of [{ ...resources, cpus: '1' }, { ...resources, memoryMb: -1 }, true]) {
      assert.equal((await post({ ...input, docker })).status, 400);
    }
    store.createSandbox({ id: 'sbx_cloud', name: 'Cloud', kind: 'e2b', cwd: null, providerSandboxId: 'cloud',
      credentialEnvVar: null, domain: 'e2b.app', credentialRef: null, repositoryUrl: null, template: null,
      status: 'running', checkedAt: null, createdAt: new Date().toISOString() });
    assert.equal((await post({ ...input, provider: 'native-agent', sandboxId: 'sbx_cloud' })).status, 400);
    const editable = manager.createRequirement({ ...input, provider: 'native-agent' });
    assert.throws(() => manager.updateRequirement(editable.id, { sandboxId: 'sbx_cloud' }), /only available for local/);
    for (const provider of ['codex', 'claude-code', 'native-agent'] as const) {
      const response = await post({ ...input, provider });
      assert.equal(response.status, 201);
      const requirement = await response.json() as { id: string; docker: DockerResources };
      assert.deepEqual(requirement.docker, resources);
      await manager.runRequirement(requirement.id);
      assert.deepEqual(requests.at(-1)?.docker, resources);
      const pr = manager.trackPullRequest({ requirementId: requirement.id, repository: 'example/repo', number: requests.length,
        url: 'https://github.com/example/repo/pull/1', title: 'Work', baseBranch: 'main', headBranch: 'feature', headSha: 'abc', status: 'open' });
      await manager.requestReview(pr.id, { provider });
      assert(requests.some((request) => request.docker?.memoryMb === 512 && ('role' in request ? request.role === 'reviewer' : request.timeoutMode === 'elapsed')));
      // Reviewer delivery can automatically resume RD; await it before changing configuration.
      for (let attempt = 0; attempt < 100; attempt++) {
        const current = manager.getRequirement(requirement.id);
        if (current?.session.state !== 'running' && current?.session.pendingMessageCount === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal((await fetch(`${url}/${requirement.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docker: { ...resources, memoryMb: 1024 } }) })).status, 200);
    }
  } finally { await manager.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});

async function fakeDocker(): Promise<{ directory: string; close(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'factory-fake-docker-'));
  const oldPath = process.env.PATH;
  const oldToken = process.env.GH_TOKEN;
  const worker = fileURLToPath(new URL('../src/native-agent-worker.ts', import.meta.url));
  await writeFile(join(directory, 'docker'), `#!${process.execPath}
const fs = require('node:fs'); const cp = require('node:child_process');
const root = ${JSON.stringify(directory)};
const args = process.argv.slice(2);
fs.appendFileSync(root + '/calls', args[0] + '\\n');
if (args[0] === 'create') {
  const name = args[args.indexOf('--name') + 1];
  fs.writeFileSync(root + '/' + name, JSON.stringify(args));
  if (process.env.CODE_FACTORY_TEST_CREATE_DELAY) setTimeout(() => {}, Number(process.env.CODE_FACTORY_TEST_CREATE_DELAY));
} else if (args[0] === 'start') {
  const args = JSON.parse(fs.readFileSync(root + '/' + process.argv.at(-1), 'utf8'));
  const index = args.indexOf('--entrypoint');
  let command = args[index + 1]; let commandArgs = args.slice(index + 3);
  if (commandArgs[0] === '/opt/code-factory/dist/docker-agent-entrypoint.js') { command = commandArgs[1]; commandArgs = commandArgs.slice(2); }
  if (commandArgs[0] === '/opt/code-factory/dist/native-agent-worker.js') commandArgs = ['--import', ${JSON.stringify(import.meta.resolve('tsx'))}, ${JSON.stringify(worker)}];
  const child = cp.spawn(command === 'node' ? ${JSON.stringify(process.execPath)} : command, commandArgs, { stdio: 'inherit' });
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  child.on('exit', (code) => process.exit(code ?? 1));
} else if (args[0] === 'rm') fs.unlinkSync(root + '/' + args.at(-1));
`, { mode: 0o700 });
  process.env.PATH = `${directory}${delimiter}${oldPath ?? ''}`;
  process.env.GH_TOKEN = 'fake-docker-token';
  return { directory, close: async () => {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = oldToken;
    await rm(directory, { recursive: true, force: true });
  } };
}

test('Docker runner streams stdin/output and awaits removal on success, timeout and cancellation', async () => {
  const docker = await fakeDocker();
  try {
    const runner = new HeadlessProcessRunner();
    let output = '';
    const outcome = await runner.run({ docker: resources, invocation: { command: process.execPath,
      args: ['-e', 'process.stdin.on("data", value => console.log(value.toString() + process.env.CODE_FACTORY_REQUIREMENT_ID))'], input: 'prompt:' },
      environment: { CODE_FACTORY_REQUIREMENT_ID: 'req_docker' }, workspaceRoot: docker.directory,
      adapter: noOutput, timeoutMs: 5000, maxOutputBytes: 4096, onOutput: (line) => { output = line; } });
    assert.equal(outcome.status, 'succeeded');
    assert.equal(output, 'prompt:req_docker');
    assert.equal((await readFile(join(docker.directory, 'calls'), 'utf8')).trim(), 'create\nstart\nrm');
    for (const cancelled of [false, true]) {
      const controller = new AbortController();
      const run = runner.run({ docker: resources, invocation: { command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'], input: '' }, workspaceRoot: docker.directory,
        adapter: noOutput, timeoutMs: cancelled ? 5000 : 100, maxOutputBytes: 4096, signal: controller.signal });
      if (cancelled) setTimeout(() => controller.abort(), 100);
      assert.equal((await run).status, cancelled ? 'cancelled' : 'timed_out');
      assert.equal((await readFile(join(docker.directory, 'calls'), 'utf8')).trim().split('\n').at(-1), 'rm');
    }
    const controller = new AbortController();
    const setup = runner.run({ docker: resources, invocation: { command: process.execPath, args: [], input: '' },
      environment: { CODE_FACTORY_TEST_CREATE_DELAY: '200' }, workspaceRoot: docker.directory,
      adapter: noOutput, timeoutMs: 5000, maxOutputBytes: 4096, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    assert.equal((await setup).status, 'cancelled');
    assert.deepEqual((await readFile(join(docker.directory, 'calls'), 'utf8')).trim().split('\n').slice(-2), ['create', 'rm']);
  } finally { await docker.close(); }
});

test('macOS Codex keychain bridge preserves host auth and persists refreshes without Docker argv secrets', { skip: process.platform !== 'darwin' }, async () => {
  const docker = await fakeDocker();
  const codexHome = join(docker.directory, 'codex');
  const original = '{"tokens":{"access_token":"test-access","refresh_token":"test-refresh"}}';
  const refreshed = '{"tokens":{"access_token":"new-access","refresh_token":"new-refresh"}}';
  await mkdir(codexHome);
  await writeFile(join(docker.directory, 'security'), `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === 'find-generic-password') process.stdout.write(${JSON.stringify(original)});
else fs.writeFileSync(${JSON.stringify(join(docker.directory, 'saved-auth'))}, process.argv.at(-1));
`, { mode: 0o700 });
  try {
    for (const existing of [false, true]) {
      if (existing) await writeFile(join(codexHome, 'auth.json'), 'existing-file');
      const run = await prepareDockerRun({ resources, invocation: { command: 'codex', args: ['exec', '-'], input: '' },
        cwd: docker.directory, environment: { CODEX_HOME: codexHome } });
      const args = JSON.parse(await readFile(join(docker.directory, run.invocation.args.at(-1)!), 'utf8')) as string[];
      assert(!JSON.stringify(args).includes('test-access'));
      assert(run.environment.PATH?.startsWith(DOCKER_AGENT_PATH));
      assert.equal(run.environment.GIT_CONFIG_KEY_0, 'credential.https://github.com.helper');
      const mount = args.find((arg) => arg.endsWith(`target=${codexHome}/auth.json`));
      assert(mount);
      const source = mount.split(',source=')[1]!.split(',target=')[0]!;
      assert.equal((await stat(source)).mode & 0o777, 0o600);
      assert.equal(await readFile(source, 'utf8'), original);
      await writeFile(source, refreshed);
      await run.remove();
      assert.equal(await readFile(join(docker.directory, 'saved-auth'), 'utf8'), refreshed);
      await assert.rejects(access(source));
      if (existing) assert.equal(await readFile(join(codexHome, 'auth.json'), 'utf8'), 'existing-file');
      else await assert.rejects(access(join(codexHome, 'auth.json')));
    }
  } finally { await docker.close(); }
});

test('Native Docker worker loads saved profiles, resumes across processes, steers and stops', async () => {
  const docker = await fakeDocker();
  const directory = docker.directory;
  let mode: 'answer' | 'steer' | 'hang' = 'answer';
  let toolSent = false;
  let sawSteer = false;
  let requestStarted: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer profile-secret');
    let body = ''; for await (const chunk of request) body += String(chunk);
    assert.equal((JSON.parse(body) as { model: string }).model, 'custom-model');
    requestStarted?.();
    if (mode === 'hang') return;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (mode === 'steer' && !toolSent) {
      toolSent = true;
      response.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'custom-model',
        choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'sleep_call', type: 'function',
          function: { name: 'bash', arguments: '{"command":"sleep 0.4"}' } }] }, finish_reason: null }] })}\n\n`);
      response.write('data: {"id":"test","object":"chat.completion.chunk","created":1,"model":"custom-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n');
      response.end('data: [DONE]\n\n');
      return;
    }
    if (mode === 'steer') sawSteer = body.includes('Use the new direction');
    response.write('data: {"id":"test","object":"chat.completion.chunk","created":1,"model":"custom-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Docker worker works"},"finish_reason":null}]}\n\n');
    response.write('data: {"id":"test","object":"chat.completion.chunk","created":1,"model":"custom-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const databasePath = join(directory, 'native.sqlite');
  const profiles = new NativeProfileStore(nativeAuthDatabasePath(databasePath));
  const profile = profiles.save({ format: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'profile-secret', modelName: 'custom-model' });
  profiles.close();
  const service = new NativeAgentService(databasePath);
  try {
    const input: NativeRunInput = { requirementId: 'req_worker', sessionId: 'ses_worker', nativeSessionId: null,
      prompt: 'Hello', model: profileModel(profile.id), reasoningEffort: null, cwd: directory,
      docker: resources, environment: {}, instructions: 'Test agent', signal: new AbortController().signal,
      timeoutMs: 10000, onNativeSession: () => undefined, onEvent: () => undefined };
    const first = await service.run(input);
    assert.equal(first.status, 'succeeded', first.error ?? '');
    assert.equal(first.finalMessage, 'Docker worker works');
    assert(first.nativeSessionId);
    const resumed = await service.run({ ...input, nativeSessionId: first.nativeSessionId, prompt: 'Continue' });
    assert.equal(resumed.status, 'succeeded', resumed.error ?? '');
    assert.equal(resumed.nativeSessionId, first.nativeSessionId);
    const reviews = await Promise.all([service.run({ ...input, role: 'reviewer' }), service.run({ ...input, role: 'reviewer' })]);
    assert(reviews.every((review) => review.status === 'succeeded'), JSON.stringify(reviews));
    assert(!(await readdir(directory)).some((name) => name.includes('-reviewer-')));
    mode = 'steer';
    let resolveTool!: () => void;
    const toolStarted = new Promise<void>((resolve) => { resolveTool = resolve; });
    const steeringRun = service.run({ ...input, nativeSessionId: first.nativeSessionId, prompt: 'Run a tool',
      onEvent: (event) => { if (event.traces?.some((trace) => trace.kind === 'tool_call')) resolveTool(); } });
    await toolStarted;
    assert.equal(await service.steer(input.requirementId, 'Use the new direction'), true);
    assert.equal((await steeringRun).status, 'succeeded');
    assert.equal(sawSteer, true);
    mode = 'hang';
    const controller = new AbortController();
    const modelStarted = new Promise<void>((resolve) => { requestStarted = resolve; });
    const cancelled = service.run({ ...input, nativeSessionId: first.nativeSessionId, prompt: 'Wait', signal: controller.signal });
    await modelStarted;
    controller.abort();
    assert.equal((await cancelled).status, 'cancelled');
    assert.equal(await service.steer(input.requirementId, 'Too late'), false);
  } finally { await service.close(); server.close(); await docker.close(); }
});
