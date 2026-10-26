import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { CommandExitError, FileType } from 'e2b';
import type { SandboxInfo, SandboxOpts } from 'e2b';

import { E2BExecutionEnv, E2BSandboxService, type E2BClient, type E2BHandle } from '../src/runtime/e2b-execution-env.js';
import { NativeAgentService } from '../src/runtime/native-agent.js';
import { AgentManager } from '../src/core/agent-manager.js';
import { createAgentManagerServer } from '../src/http/server.js';
import { silentLogger } from '../src/infrastructure/logger.js';
import { SqliteAgentManagerStore } from '../src/storage/sqlite-store.js';

const codingToolNames = ['read', 'write', 'edit', 'bash'];
const controlToolNames = ['artifact_publish', 'pr_register', 'requirement_propose', 'requirement_action',
  'requirement_related', 'requirement_message', 'timer_register', 'timer_show', 'timer_cancel'];
const sandboxToolNames = ['sandbox_status', 'sandbox_pause', 'sandbox_resume', 'sandbox_upload', 'sandbox_download'];

function fakeSdk(defaultDirectory = '/home/user', before: {
  connect?: (signal?: AbortSignal) => Promise<void>;
  discover?: (signal?: AbortSignal) => Promise<void>;
} = {}) {
  const data = new Map<string, Uint8Array>();
  const commands: Array<{ command: string; cwd: string | undefined; hasCwd: boolean; envs: Record<string, string> | undefined }> = [];
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const handle = {
    sandboxId: 'e2b-test-123',
    files: {
      async read(path: string, options?: { format?: string }) {
        const content = data.get(path);
        if (!content) throw new Error(`Missing ${path}`);
        if (options?.format === 'stream') return new ReadableStream({ start(controller) { controller.enqueue(content); controller.close(); } });
        return options?.format === 'bytes' ? content : decoder.decode(content);
      },
      async write(path: string, value: string | ArrayBuffer | ReadableStream<Uint8Array>) {
        if (value instanceof ReadableStream) {
          data.set(path, new Uint8Array(await new Response(value).arrayBuffer()));
          return;
        }
        data.set(path, typeof value === 'string' ? encoder.encode(value) : new Uint8Array(value));
      },
      async exists(path: string) { return data.has(path); },
      async getInfo(path: string) {
        const content = data.get(path);
        if (!content) throw new Error(`Missing ${path}`);
        return { name: path.split('/').at(-1), path, type: FileType.FILE, size: content.byteLength,
          modifiedTime: new Date('2026-01-01T00:00:00Z') };
      },
      async list(path: string) {
        return [...data.keys()].filter((key) => key.startsWith(`${path}/`)).map((key) => ({
          name: key.split('/').at(-1), path: key, type: FileType.FILE, size: data.get(key)!.byteLength,
          modifiedTime: new Date('2026-01-01T00:00:00Z'),
        }));
      },
      async makeDir() { return true; },
      async remove(path: string) { data.delete(path); },
      async rename(from: string, to: string) { data.set(to, data.get(from)!); data.delete(from); },
    },
    commands: {
      async run(command: string, options: {
        cwd?: string; envs?: Record<string, string>; onStdout?: (value: string) => void;
        onStderr?: (value: string) => void; background?: boolean; signal?: AbortSignal;
      }) {
        commands.push({ command, cwd: options.cwd, hasCwd: Object.hasOwn(options, 'cwd'), envs: options.envs });
        if (command === 'pwd') {
          await before.discover?.(options.signal);
          return { exitCode: 0, stdout: `${defaultDirectory}\n`, stderr: '' };
        }
        if (options.background) {
          const path = command.match(/ > '([^']+)' 2>&1$/)?.[1];
          assert(path);
          data.set(path, encoder.encode('hello world\n'));
          return { wait: async () => ({ exitCode: 0 }), kill: async () => true };
        }
        if (command.startsWith('if test -f ')) {
          const path = command.match(/test -f '([^']+)'/)?.[1];
          const offset = Number(command.match(/tail -c \+(\d+)/)?.[1]) - 1;
          assert(path);
          const slice = data.get(path)?.subarray(offset, offset + 65_536) ?? new Uint8Array();
          return { exitCode: 0, stdout: Buffer.from(slice).toString('base64') };
        }
        if (command === 'fail') throw new CommandExitError({ exitCode: 7, stdout: '', stderr: 'failed' });
        options.onStdout?.('hello ');
        options.onStderr?.('world\n');
        return { exitCode: 0, stdout: 'hello ', stderr: 'world\n' };
      },
    },
  } as unknown as E2BHandle;
  let createOptions: SandboxOpts | undefined;
  const client: E2BClient = {
    async create(options) { createOptions = options; return handle; },
    async connect(id, options) {
      assert.equal(id, 'e2b-test-123');
      assert.equal(options.apiKey, 'test-key');
      await before.connect?.(options.signal);
      return handle;
    },
    async getInfo(id) { return { sandboxId: id, state: 'paused' } as SandboxInfo; },
    async pause() { return true; },
    async kill() { return true; },
  };
  return { handle, client, data, commands, get createOptions() { return createOptions; } };
}

for (const role of ['rd', 'reviewer'] as const) {
  for (const stage of ['connect', 'discover'] as const) {
    test(`Native ${role} timeout cancels lazy E2B ${stage}`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'code-factory-e2b-lazy-cancel-'));
      let receivedSignal: AbortSignal | undefined;
      let providerCompleted = false;
      const sdk = fakeSdk('/home/user', { [stage]: async (signal?: AbortSignal) => {
        receivedSignal = signal;
        // The fallback bounds a regression without requiring wall-clock assertions.
        await delay(1_000, undefined, signal ? { signal } : {});
        providerCompleted = true;
      } });
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([fauxAssistantMessage(fauxToolCall('bash', { command: 'echo must-not-run' }), { stopReason: 'toolUse' })]);
      const service = new NativeAgentService(join(directory, 'native.sqlite'), models, new E2BSandboxService(sdk.client));
      const controller = new AbortController();
      try {
        const outcome = await service.run({ role, requirementId: 'req_lazy_cancel', sessionId: 'ses_lazy_cancel',
          nativeSessionId: null, prompt: 'Use remote tools', model: 'faux/faux-1', reasoningEffort: null, cwd: directory,
          sandbox: { kind: 'e2b', providerSandboxId: 'e2b-test-123', cwd: null,
            credentials: { domain: 'e2b.example', apiKey: 'test-key' }, forwardGitHubToken: false },
          environment: {}, instructions: 'Test', signal: controller.signal, timeoutMs: 300, timeoutMode: 'elapsed',
          onNativeSession: () => undefined, onEvent: () => undefined });
        assert.equal(outcome.status, 'timed_out');
        assert.equal(controller.signal.aborted, false, 'the Harness timeout must supply cancellation independently of Stop Run');
        assert.equal(receivedSignal?.aborted, true);
        assert.equal(providerCompleted, false);
        assert(sdk.commands.every((entry) => entry.command === 'pwd'));
        if (stage === 'connect') assert.deepEqual(sdk.commands, []);
      } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
    });
  }
}

test('only E2B RD Runs offer sandbox tools; Default, named local, and Reviewer tools stay scoped', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-factory-native-tool-scope-'));
  const namedDirectory = join(directory, 'named-local');
  await mkdir(namedDirectory);
  const sdk = fakeSdk();
  let connections = 0;
  const e2b = new E2BSandboxService({ ...sdk.client, connect: async (id, options) => {
    connections++;
    return sdk.client.connect(id, options);
  } });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new NativeAgentService(join(directory, 'native.sqlite'), models, e2b);
  const scenarios: Array<{ role: 'rd' | 'reviewer'; remote: boolean; cwd: string }> = [
    { role: 'rd', remote: false, cwd: directory },
    { role: 'rd', remote: true, cwd: directory },
    { role: 'rd', remote: false, cwd: namedDirectory },
    { role: 'reviewer', remote: false, cwd: directory },
    { role: 'reviewer', remote: true, cwd: directory },
  ];
  try {
    for (const [index, scenario] of scenarios.entries()) {
      let offered: string[] = [];
      let prompt = '';
      faux.setResponses([(context) => {
        offered = getCurrentTools(context.messages).map((tool) => tool.name);
        prompt = getCurrentSystemPrompt(context.messages);
        return fauxAssistantMessage('Inspected tool list');
      }]);
      const outcome = await service.run({ role: scenario.role,
        requirementId: `req_scope_${index}`, sessionId: `ses_scope_${index}`, nativeSessionId: null,
        prompt: 'Inspect available tools', model: 'faux/faux-1', reasoningEffort: null, cwd: scenario.cwd,
        ...(scenario.remote ? { sandbox: { kind: 'e2b' as const, providerSandboxId: 'e2b-test-123', cwd: null,
          credentials: { domain: 'e2b.example', apiKey: 'test-key' }, forwardGitHubToken: false } } : {}),
        environment: {}, instructions: 'Test', signal: new AbortController().signal, timeoutMs: 30_000,
        onNativeSession: () => undefined, onEvent: () => undefined });
      assert.equal(outcome.status, 'succeeded');
      const expected = scenario.role === 'reviewer' ? ['read', 'bash']
        : [...codingToolNames, ...controlToolNames, ...(scenario.remote ? sandboxToolNames : [])];
      assert.deepEqual(offered.sort(), expected.sort(), JSON.stringify(scenario));
      assert.equal(prompt.includes('Use sandbox_upload for host attachment paths'), scenario.remote && scenario.role === 'rd');
    }
    assert.equal(connections, 0, 'selecting tools must not connect to E2B');
    assert.deepEqual(sdk.commands, []);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('resumed Native conversations select sandbox tools from the current workspace after service reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-factory-native-tool-resume-'));
  const sdk = fakeSdk();
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const databasePath = join(directory, 'native.sqlite');
  let service = new NativeAgentService(databasePath, models, new E2BSandboxService(sdk.client));
  let nativeSessionId: string | null = null;
  try {
    for (const remote of [true, false, true, false]) {
      let offered: string[] = [];
      let prompt = '';
      faux.setResponses([(context) => {
        offered = getCurrentTools(context.messages).map((tool) => tool.name);
        prompt = getCurrentSystemPrompt(context.messages);
        return fauxAssistantMessage('Workspace tools refreshed');
      }]);
      const outcome = await service.run({ requirementId: 'req_scope_resume', sessionId: 'ses_scope_resume',
        nativeSessionId, prompt: 'Use the current workspace', model: 'faux/faux-1', reasoningEffort: null, cwd: directory,
        ...(remote ? { sandbox: { kind: 'e2b' as const, providerSandboxId: 'e2b-test-123', cwd: null,
          credentials: { domain: 'e2b.example', apiKey: 'test-key' }, forwardGitHubToken: false } } : {}),
        environment: {}, instructions: 'Test', signal: new AbortController().signal, timeoutMs: 30_000,
        onNativeSession: () => undefined, onEvent: () => undefined });
      assert.equal(outcome.status, 'succeeded');
      assert(outcome.nativeSessionId);
      if (nativeSessionId) assert.equal(outcome.nativeSessionId, nativeSessionId);
      nativeSessionId = outcome.nativeSessionId;
      assert.deepEqual(offered.sort(), [...codingToolNames, ...controlToolNames, ...(remote ? sandboxToolNames : [])].sort());
      assert.equal(prompt.includes('Use sandbox_upload for host attachment paths'), remote);
      await service.close();
      service = new NativeAgentService(databasePath, models, new E2BSandboxService(sdk.client));
    }
    assert.deepEqual(sdk.commands, []);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('native sandbox downloads can be explicitly published as browser attachments without model-visible bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-factory-e2b-transfer-'));
  const sdk = fakeSdk('/home/custom');
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const localPath = join(directory, 'attachment.bin');
  const downloaded = join(directory, 'output', 'result.bin');
  const binary = Buffer.from('BINARY_ARTIFACT_CONTENT_STAYS_OUT_OF_CONTEXT\0\xff', 'latin1');
  await writeFile(localPath, binary);
  const manager = new AgentManager({ workspaceRoot: directory, store: new SqliteAgentManagerStore(':memory:'),
    attachmentDirectory: join(directory, 'published'), logger: silentLogger });
  const requirement = manager.createRequirement({ title: 'Publish sandbox result', description: 'Share a binary output', provider: 'native-agent' });
  const server = createAgentManagerServer(manager);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  let transcript = '';
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('sandbox_upload', { localPath, remotePath: 'input/data.bin' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('sandbox_download', { localPath: downloaded, remotePath: 'input/data.bin' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('artifact_publish', { localPath: downloaded, fileName: '沙箱结果.bin' }), { stopReason: 'toolUse' }),
    (context) => { transcript = JSON.stringify(context.messages); return fauxAssistantMessage('File ready'); },
  ]);
  const service = new NativeAgentService(join(directory, 'native.sqlite'), models, new E2BSandboxService(sdk.client));
  try {
    const outcome = await service.run({ requirementId: requirement.id, sessionId: requirement.session.id, nativeSessionId: null,
      prompt: `Process host attachment ${localPath}`, model: 'faux/faux-1', reasoningEffort: null, cwd: directory,
      sandbox: { kind: 'e2b', providerSandboxId: 'e2b-test-123', cwd: null,
        credentials: { domain: 'e2b.example', apiKey: 'test-key' }, forwardGitHubToken: false },
      environment: { CODE_FACTORY_API_URL: `${url}/api`, CODE_FACTORY_REQUIREMENT_ID: requirement.id,
        CODE_FACTORY_SESSION_ID: requirement.session.id }, instructions: 'Test', signal: new AbortController().signal, timeoutMs: 30_000,
      onNativeSession: () => undefined, onEvent: () => undefined });
    assert.equal(outcome.status, 'succeeded');
    assert.deepEqual(await readFile(downloaded), binary);
    assert.deepEqual(sdk.data.get('/home/custom/input/data.bin'), new Uint8Array(binary));
    assert.match(transcript, /byteSize/);
    assert.equal(transcript.includes('test-key'), false);
    assert.equal(transcript.includes('BINARY_ARTIFACT_CONTENT'), false);
    assert.equal(transcript.includes(binary.toString('base64')), false);
    assert.match(transcript, /downloadPath/);
    assert.equal(transcript.includes('"isError":true'), false);
    assert.equal(existsSync(join(directory, 'input')), false);
    const message = manager.listMessages(requirement.id)[0]!;
    assert.equal(message.author, 'rd_agent');
    assert.equal(message.deliverToRd, false);
    assert.equal(message.attachments[0]?.fileName, '沙箱结果.bin');
    const response = await fetch(`${url}/api/attachments/${message.attachments[0]!.id}?download=1`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), binary);
  } finally {
    await service.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('native transfer errors hide provider details and sandbox tools are unavailable in local workspaces', async () => {
  for (const remote of [false, true]) {
    const directory = await mkdtemp(join(tmpdir(), 'code-factory-e2b-tool-errors-'));
    const sdk = fakeSdk();
    sdk.handle.files.write = async () => { throw new Error('provider leaked test-key or file contents'); };
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const localPath = join(directory, 'input');
    await writeFile(localPath, 'private contents');
    let transcript = '';
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('sandbox_upload', { localPath, remotePath: '/input' }), { stopReason: 'toolUse' }),
      ...(remote ? [] : [fauxAssistantMessage(fauxToolCall('sandbox_pause', {}), { stopReason: 'toolUse' })]),
      (context) => { transcript = JSON.stringify(context.messages); return fauxAssistantMessage('Tool failed'); },
    ]);
    const service = new NativeAgentService(join(directory, 'native.sqlite'), models, new E2BSandboxService(sdk.client));
    try {
      const outcome = await service.run({ requirementId: 'req_errors', sessionId: 'ses_errors', nativeSessionId: null,
        prompt: 'Try sandbox tools', model: 'faux/faux-1', reasoningEffort: null, cwd: directory,
        ...(remote ? { sandbox: { kind: 'e2b' as const, providerSandboxId: 'e2b-test-123', cwd: null,
          credentials: { domain: 'e2b.example', apiKey: 'test-key' }, forwardGitHubToken: false } } : {}),
        environment: {}, instructions: 'Test', signal: new AbortController().signal, timeoutMs: 30_000,
        onNativeSession: () => undefined, onEvent: () => undefined });
      assert.equal(outcome.status, 'succeeded');
      assert(transcript.includes('"isError":true'));
      assert(transcript.includes(remote ? 'file upload failed' : 'Tool sandbox_upload is not available'));
      if (!remote) assert(transcript.includes('Tool sandbox_pause is not available'));
      assert.equal(transcript.includes('test-key'), false);
      assert.equal(transcript.includes('private contents'), false);
    } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
  }
});

test('E2B service passes explicit credentials and durable lifecycle to SDK', async () => {
  const sdk = fakeSdk();
  const service = new E2BSandboxService(sdk.client);
  const credentials = { domain: 'e2b.example', apiKey: 'test-key' };
  const created = await service.create('custom-template', credentials);
  assert.equal(created.sandboxId, 'e2b-test-123');
  assert.deepEqual(sdk.createOptions, { template: 'custom-template', ...credentials, timeoutMs: 600_000,
    lifecycle: { onTimeout: 'pause', autoResume: true } });
  assert.equal((await service.connect(created.sandboxId, credentials)).sandboxId, created.sandboxId);
  assert.equal((await service.getInfo(created.sandboxId, credentials)).state, 'paused');
  assert.equal(await service.pause(created.sandboxId, credentials), true);
  assert.equal(await service.kill(created.sandboxId, credentials), true);
});

test('E2B service does not expose provider error text containing an API key', async () => {
  const sdk = fakeSdk();
  const service = new E2BSandboxService({ ...sdk.client,
    create: async () => { throw new Error('provider rejected test-key'); },
  });
  await assert.rejects(service.create('base', { domain: 'e2b.example', apiKey: 'test-key' }), (error: unknown) =>
    error instanceof Error && error.message.includes('creation failed') && !error.message.includes('test-key'));
});

test('E2B ExecutionEnv uses the remote SDK for files and shell commands', async () => {
  const sdk = fakeSdk();
  const env = new E2BExecutionEnv(sdk.handle, '/home/user/repo', () => ({ GH_TOKEN: 'temporary-token' }));
  const context = BACKGROUND_CONTEXT;
  assert.equal(env.id, 'e2b:e2b.app:e2b-test-123');
  assert.deepEqual(await env.absolutePath('src/../note.txt', context), { ok: true, value: '/home/user/repo/note.txt' });
  assert.deepEqual(await env.writeFile('note.txt', 'first\nsecond\n', context), { ok: true, value: undefined });
  assert.deepEqual(await env.readTextFile('note.txt', context), { ok: true, value: 'first\nsecond\n' });
  const bytes = await env.readBinaryFile('note.txt', context);
  assert(bytes.ok);
  assert.equal(new TextDecoder().decode(bytes.value), 'first\nsecond\n');
  assert.deepEqual(await env.readTextLines('note.txt', { maxLines: 1 }, context), { ok: true, value: ['first'] });
  const reader = await env.openTextLineReader('note.txt', context);
  assert(reader.ok);
  assert.deepEqual(await reader.value.readLine(context), { ok: true, value: { text: 'first', terminated: true } });
  assert.deepEqual(await env.fileInfo('note.txt', context), { ok: true, value: {
    name: 'note.txt', path: '/home/user/repo/note.txt', kind: 'file', size: 13,
    mtimeMs: Date.parse('2026-01-01T00:00:00Z'),
  } });
  const output: string[] = [];
  assert.deepEqual(await env.exec('echo hello', { env: { EXTRA: 'yes' }, onOutput: (text) => output.push(text) }, context),
    { ok: true, value: { exitCode: 0 } });
  assert.equal(sdk.commands.at(-1)?.cwd, '/home/user/repo');
  assert.deepEqual(sdk.commands.at(-1)?.envs, { GH_TOKEN: 'temporary-token', EXTRA: 'yes' });
  assert.deepEqual(output, ['hello ', 'world\n']);
  assert.deepEqual(await env.exec('fail', undefined, context), { ok: true, value: { exitCode: 7 } });
  assert.equal(sdk.data.has('/home/user/repo/note.txt'), true);
});

test('foreground and background commands sample a fresh consistent environment once at launch', async () => {
  const sdk = fakeSdk();
  let configured: Record<string, string> = { REPLACE: 'before', REMOVE: 'removed', KEEP: 'saved' };
  let reads = 0;
  const env = new E2BExecutionEnv(sdk.handle, '/home/user/repo', () => { reads++; return configured; });
  for (const spill of [undefined, { afterBytes: 1000, afterLines: 100 }]) {
    const initial = { ...configured };
    const before = reads;
    assert.equal((await env.exec('echo first', { ...(spill ? { spill } : {}) }, BACKGROUND_CONTEXT)).ok, true);
    const first = sdk.commands.findLast((entry) => entry.command.includes('echo first'))!;
    assert.deepEqual(first.envs, initial);
    assert.equal(reads, before + 1);
    configured = { REPLACE: 'after', ADDED: 'added', KEEP: 'saved' };
    assert.equal((await env.exec('echo next', { env: { KEEP: 'tool-override' }, ...(spill ? { spill } : {}) }, BACKGROUND_CONTEXT)).ok, true);
    assert.deepEqual(sdk.commands.findLast((entry) => entry.command.includes('echo next'))?.envs,
      { REPLACE: 'after', ADDED: 'added', KEEP: 'tool-override' });
    assert.deepEqual(first.envs, initial);
    assert.equal(reads, before + 2);
    assert.equal((await env.exec('echo isolated', { inheritEnv: false, env: { ONLY: 'tool' }, ...(spill ? { spill } : {}) }, BACKGROUND_CONTEXT)).ok, true);
    assert.deepEqual(sdk.commands.findLast((entry) => entry.command.includes('echo isolated'))?.envs, { ONLY: 'tool' });
    assert.equal(reads, before + 2, 'inheritEnv=false must bypass the configured environment');
    configured = { REPLACE: 'before', REMOVE: 'removed', KEEP: 'saved' };
  }
});

for (const stage of ['connect', 'discover'] as const) {
  test(`Native commands read environment updates made during lazy ${stage}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'code-factory-e2b-late-env-'));
    let release!: () => void; let entered!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const sdk = fakeSdk('/home/user', { [stage]: async () => { entered(); await pending; } });
    const faux = fauxProvider();
    const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('bash', { command: 'echo after-connection' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Done'),
    ]);
    const service = new NativeAgentService(join(directory, 'native.sqlite'), models, new E2BSandboxService(sdk.client));
    let configured: Record<string, string> = { OLD: 'before' };
    const run = service.run({ requirementId: 'req_late', sessionId: 'ses_late', nativeSessionId: null,
      prompt: 'Use remote commands', model: 'faux/faux-1', reasoningEffort: null, cwd: directory,
      sandbox: { kind: 'e2b', providerSandboxId: 'e2b-test-123', cwd: null,
        credentials: { domain: 'e2b.example', apiKey: 'test-key' }, forwardGitHubToken: false,
        getEnvironmentVariables: () => configured },
      environment: {}, instructions: 'Test', signal: new AbortController().signal, timeoutMs: 30_000,
      onNativeSession: () => undefined, onEvent: () => undefined });
    try {
      await started;
      configured = { NEW: 'after' };
      release();
      assert.equal((await run).status, 'succeeded');
      assert.deepEqual(sdk.commands.find((entry) => entry.command.includes('echo after-connection'))?.envs, { NEW: 'after' });
    } finally {
      release(); await run; await service.close(); await rm(directory, { recursive: true, force: true });
    }
  });
}

test('an unset E2B directory uses the SDK default for commands and relative file paths', async () => {
  const sdk = fakeSdk('/home/custom-user');
  const env = await E2BExecutionEnv.create(sdk.handle, null);
  const context = BACKGROUND_CONTEXT;
  assert.equal(env.cwd, '/home/custom-user');
  assert.deepEqual(await env.writeFile('note.txt', 'contents', context), { ok: true, value: undefined });
  assert(sdk.data.has('/home/custom-user/note.txt'));
  await env.exec('echo hello', undefined, context);
  assert.equal(sdk.commands.at(-1)?.hasCwd, false);
  // pi-durable's bash tool explicitly passes env.cwd.
  await env.exec('echo hello', { cwd: env.cwd }, context);
  assert.equal(sdk.commands.at(-1)?.hasCwd, false);
  const beforeSpill = sdk.commands.length;
  const result = await env.exec('echo hello', {
    cwd: env.cwd, spill: { afterBytes: 1024, afterLines: 100 },
  }, context);
  assert.deepEqual(result, { ok: true, value: { exitCode: 0 } });
  assert(sdk.commands.length > beforeSpill);
  assert(sdk.commands.slice(beforeSpill).every((entry) => !entry.hasCwd));
  await env.exec('pwd', { cwd: 'repo' }, context);
  assert.equal(sdk.commands.at(-1)?.cwd, '/home/custom-user/repo');
  await env.exec('pwd', { cwd: '/tmp' }, context);
  assert.equal(sdk.commands.at(-1)?.cwd, '/tmp');
});

test('E2B default directory discovery fails without exposing provider output', async () => {
  const sdk = fakeSdk('not-an-absolute-path');
  await assert.rejects(E2BExecutionEnv.create(sdk.handle, null), /Could not determine the E2B default working directory/);
});

test('E2B spill reads large remote output in bounded slices and preserves full content', async () => {
  const output = Buffer.from('large α output\n'.repeat(150_000));
  const remote = new Map<string, Buffer>();
  let largestRead = 0;
  const handle = {
    sandboxId: 'large-output',
    files: { remove: async (path: string) => { remote.delete(path); } },
    commands: {
      async run(command: string, options?: { background?: boolean }) {
        if (!options?.background) {
          const path = command.match(/test -f '([^']+)'/)?.[1];
          const offset = Number(command.match(/tail -c \+(\d+)/)?.[1]) - 1;
          assert(path);
          const slice = remote.get(path)?.subarray(offset, offset + 65_536) ?? Buffer.alloc(0);
          largestRead = Math.max(largestRead, slice.length);
          return { exitCode: 0, stdout: slice.toString('base64') };
        }
        const path = command.match(/ > '([^']+)' 2>&1$/)?.[1];
        assert(path);
        remote.set(path, output);
        return { wait: async () => ({ exitCode: 0 }), kill: async () => true };
      },
    },
  } as unknown as E2BHandle;
  const env = new E2BExecutionEnv(handle, '/home/user/repo');
  const hash = createHash('sha256');
  const result = await env.exec('produce large output', { spill: { afterBytes: 1024, afterLines: 50 },
    onOutput: (text) => { hash.update(text); } }, BACKGROUND_CONTEXT);
  assert(result.ok);
  assert.equal(result.value.exitCode, 0);
  assert(result.value.spillPath);
  assert.equal(remote.get(result.value.spillPath)?.equals(output), true);
  assert.equal(hash.digest('hex'), createHash('sha256').update(output).digest('hex'));
  assert(largestRead <= 65_536);
  const belowThreshold = await env.exec('produce large output', { spill: {
    afterBytes: output.byteLength + 1, afterLines: 1_000_000,
  } }, BACKGROUND_CONTEXT);
  assert.deepEqual(belowThreshold, { ok: true, value: { exitCode: 0 } });
  assert.equal(remote.size, 1);
});

test('aborting a spilled E2B command kills the remote process and returns its output path', async () => {
  const controller = new AbortController();
  const remote = new Map<string, Buffer>();
  let killed = 0;
  const handle = {
    sandboxId: 'aborted-output',
    files: { remove: async (path: string) => { remote.delete(path); } },
    commands: {
      async run(command: string, options?: { background?: boolean }) {
        if (options?.background) {
          const path = command.match(/ > '([^']+)' 2>&1$/)?.[1];
          assert(path);
          remote.set(path, Buffer.from('partial output\n'));
          return {
            wait: () => new Promise<never>(() => undefined),
            kill: async () => { killed++; return true; },
          };
        }
        const path = command.match(/test -f '([^']+)'/)?.[1];
        const offset = Number(command.match(/tail -c \+(\d+)/)?.[1]) - 1;
        assert(path);
        return { exitCode: 0, stdout: (remote.get(path)?.subarray(offset) ?? Buffer.alloc(0)).toString('base64') };
      },
    },
  } as unknown as E2BHandle;
  const env = new E2BExecutionEnv(handle, '/home/user/repo');
  const output: string[] = [];
  const result = await env.exec('long-running command', { spill: { afterBytes: 1, afterLines: 1 },
    onOutput: (text) => { output.push(text); controller.abort(); },
  }, withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'aborted');
  assert.equal(killed, 1);
  assert.equal(output.join(''), 'partial output\n');
  assert(result.error.spillPath);
  assert.equal(remote.get(result.error.spillPath)?.toString(), 'partial output\n');
});

test('aborting an idle E2B background command wakes the spill poller', async () => {
  const controller = new AbortController();
  let killed = 0;
  let removed = false;
  const handle = {
    sandboxId: 'idle-command',
    files: { remove: async () => { removed = true; } },
    commands: {
      async run(_command: string, options?: { background?: boolean }) {
        if (options?.background) return {
          wait: () => new Promise<never>(() => undefined),
          kill: async () => { killed++; return true; },
        };
        return { exitCode: 0, stdout: '' };
      },
    },
  } as unknown as E2BHandle;
  const env = new E2BExecutionEnv(handle, '/home/user/repo');
  const pending = env.exec('wait forever', { spill: { afterBytes: 1, afterLines: 1 } },
    withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
  setTimeout(() => controller.abort(), 10);
  const result = await pending;
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'aborted');
  assert.equal(killed, 1);
  assert.equal(removed, true);
});

for (const cwd of ['/home/user/repo', null]) {
  test(`pi-durable tools use the E2B sandbox with ${cwd ?? 'the SDK default directory'}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'code-factory-e2b-native-'));
    const sdk = fakeSdk();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('write', { path: 'note.txt', content: 'before\n' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('edit', { path: 'note.txt', edits: [{ oldText: 'before', newText: 'after' }] }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('read', { path: 'note.txt' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('bash', { command: 'gh pr view --json title' }), { stopReason: 'toolUse' }),
      (context) => fauxAssistantMessage(JSON.stringify(context.messages).includes('after') ? 'Remote tools succeeded' : 'Missing remote edit'),
    ]);
    const service = new NativeAgentService(join(directory, 'native.sqlite'), models,
      new E2BSandboxService(sdk.client));
    try {
      const outcome = await service.run({ requirementId: 'req_e2b', sessionId: 'ses_e2b',
        nativeSessionId: null, prompt: 'Use remote tools',
        model: 'faux/faux-1', reasoningEffort: null, cwd: '/home/user/repo',
        sandbox: { kind: 'e2b', providerSandboxId: 'e2b-test-123', cwd,
          credentials: { domain: 'e2b.example', apiKey: 'test-key' }, forwardGitHubToken: false },
        environment: {}, instructions: 'Test',
        signal: new AbortController().signal, timeoutMs: 30_000,
        onNativeSession: () => undefined, onEvent: () => undefined });
      assert.equal(outcome.status, 'succeeded');
      assert.equal(outcome.finalMessage, 'Remote tools succeeded');
      assert.equal(new TextDecoder().decode(sdk.data.get(`${cwd ?? '/home/user'}/note.txt`)), 'after\n');
      assert(sdk.commands.some((entry) => entry.command.includes('gh pr view --json title') && entry.cwd === (cwd ?? undefined)));
      assert.equal(sdk.commands.some((entry) => entry.envs?.GH_TOKEN !== undefined), false);
      assert.equal(existsSync(join(directory, 'note.txt')), false);
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('live explicit GitHub tokens including empty values suppress host forwarding, and new sandboxes never forward host tokens', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-factory-e2b-token-priority-'));
  const sdk = fakeSdk();
  const faux = fauxProvider();
  const models = createModels(); models.setProvider(faux.provider);
  const service = new NativeAgentService(join(directory, 'native.sqlite'), models, new E2BSandboxService(sdk.client));
  const savedToken = process.env.GH_TOKEN; const savedGithubToken = process.env.GITHUB_TOKEN;
  process.env.GH_TOKEN = 'host-gh-token'; process.env.GITHUB_TOKEN = 'host-github-token';
  try {
    for (const forwardGitHubToken of [false, true]) {
      let configured: Record<string, string> = { GITHUB_TOKEN: 'explicit-token' };
      const bash = (command: string) => fauxAssistantMessage(fauxToolCall('bash', { command }), { stopReason: 'toolUse' });
      faux.setResponses([
        bash('echo configured-token'),
        () => { configured = { GH_TOKEN: '' }; return bash('echo empty-token'); },
        () => { configured = {}; return bash('echo removed-token'); },
        fauxAssistantMessage('Done'),
      ]);
      const outcome = await service.run({ requirementId: 'req_tokens', sessionId: 'ses_tokens', nativeSessionId: null,
        prompt: 'Use remote commands', model: 'faux/faux-1', reasoningEffort: null, cwd: directory,
        sandbox: { kind: 'e2b', providerSandboxId: 'e2b-test-123', cwd: null,
          credentials: { domain: 'e2b.example', apiKey: 'test-key' }, forwardGitHubToken,
          getEnvironmentVariables: () => configured },
        environment: {}, instructions: 'Test', signal: new AbortController().signal, timeoutMs: 30_000,
        onNativeSession: () => undefined, onEvent: () => undefined });
      assert.equal(outcome.status, 'succeeded');
      assert.deepEqual(sdk.commands.findLast((entry) => entry.command.includes('echo configured-token'))?.envs, { GITHUB_TOKEN: 'explicit-token' });
      assert.deepEqual(sdk.commands.findLast((entry) => entry.command.includes('echo empty-token'))?.envs, { GH_TOKEN: '' });
      assert.deepEqual(sdk.commands.findLast((entry) => entry.command.includes('echo removed-token'))?.envs,
        forwardGitHubToken ? { GH_TOKEN: 'host-gh-token', GITHUB_TOKEN: 'host-github-token' } : {});
    }
  } finally {
    await service.close();
    if (savedToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = savedToken;
    if (savedGithubToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = savedGithubToken;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Native commands receive configured variables and refresh them on resume without persisting values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-factory-e2b-env-run-'));
  const sdk = fakeSdk();
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new NativeAgentService(join(directory, 'native.sqlite'), models, new E2BSandboxService(sdk.client));
  const savedToken = process.env.GH_TOKEN;
  const savedGithubToken = process.env.GITHUB_TOKEN;
  process.env.GH_TOKEN = 'host-token-must-not-win';
  delete process.env.GITHUB_TOKEN;
  let nativeSessionId: string | null = null;
  try {
    for (const environmentVariables of [{ GITHUB_TOKEN: 'configured-runtime-token', CUSTOM: 'configured-runtime-value' }, {}]) {
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall('bash', { command: 'use configured environment' }), { stopReason: 'toolUse' }),
        fauxAssistantMessage('Done'),
      ]);
      const outcome = await service.run({ requirementId: 'req_env', sessionId: 'ses_env', nativeSessionId,
        prompt: 'Use the remote environment', model: 'faux/faux-1', reasoningEffort: null, cwd: '/home/user/repo',
        sandbox: { kind: 'e2b', providerSandboxId: 'e2b-test-123', cwd: null,
          credentials: { domain: 'e2b.example', apiKey: 'test-key' }, forwardGitHubToken: true, getEnvironmentVariables: () => environmentVariables },
        environment: {}, instructions: 'Test', signal: new AbortController().signal, timeoutMs: 30_000,
        onNativeSession: (id) => { nativeSessionId = id; }, onEvent: () => undefined });
      assert.equal(outcome.status, 'succeeded');
      const command = sdk.commands.findLast((entry) => entry.command.includes('use configured environment'));
      assert(command);
      assert.equal(command.cwd, undefined);
      if (environmentVariables.GITHUB_TOKEN) {
        assert.equal(command.envs?.GITHUB_TOKEN, 'configured-runtime-token');
        assert.equal(command.envs?.CUSTOM, 'configured-runtime-value');
        assert.equal(command.envs?.GH_TOKEN, undefined);
      } else {
        assert.equal(command.envs?.GITHUB_TOKEN, undefined);
        assert.equal(command.envs?.CUSTOM, undefined);
        assert.equal(command.envs?.GH_TOKEN, 'host-token-must-not-win');
      }
    }
  } finally {
    await service.close();
    if (savedToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = savedToken;
    if (savedGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedGithubToken;
    try {
      const database = await readFile(join(directory, 'native.sqlite'));
      assert.equal(database.includes('configured-runtime-token'), false);
      assert.equal(database.includes('configured-runtime-value'), false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
