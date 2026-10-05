import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { CommandExitError, FileType } from 'e2b';
import type { SandboxInfo, SandboxOpts } from 'e2b';

import { E2BExecutionEnv, E2BSandboxService, type E2BClient, type E2BHandle } from '../src/e2b-execution-env.js';
import { NativeAgentService } from '../src/native-agent.js';

function fakeSdk() {
  const data = new Map<string, Uint8Array>();
  const commands: Array<{ command: string; cwd: string | undefined; envs: Record<string, string> | undefined }> = [];
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const handle = {
    sandboxId: 'e2b-test-123',
    files: {
      async read(path: string, options?: { format?: string }) {
        const content = data.get(path);
        if (!content) throw new Error(`Missing ${path}`);
        return options?.format === 'bytes' ? content : decoder.decode(content);
      },
      async write(path: string, value: string | ArrayBuffer) {
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
        onStderr?: (value: string) => void; background?: boolean;
      }) {
        commands.push({ command, cwd: options.cwd, envs: options.envs });
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
      return handle;
    },
    async getInfo(id) { return { sandboxId: id, state: 'paused' } as SandboxInfo; },
    async pause() { return true; },
    async kill() { return true; },
  };
  return { handle, client, data, commands, get createOptions() { return createOptions; } };
}

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
  const env = new E2BExecutionEnv(sdk.handle, '/home/user/repo', { GH_TOKEN: 'temporary-token' });
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

test('pi-durable read, write, edit and bash use the selected E2B sandbox', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-factory-e2b-native-'));
  const sdk = fakeSdk();
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('write', { path: 'note.txt', content: 'before\n' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('edit', { path: 'note.txt', edits: [{ oldText: 'before', newText: 'after' }] }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('read', { path: 'note.txt' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('bash', { command: 'echo hello' }), { stopReason: 'toolUse' }),
    (context) => fauxAssistantMessage(JSON.stringify(context.messages).includes('after') ? 'Remote tools succeeded' : 'Missing remote edit'),
  ]);
  const service = new NativeAgentService(join(directory, 'native.sqlite'), models,
    new E2BSandboxService(sdk.client));
  try {
    const outcome = await service.run({ requirementId: 'req_e2b', sessionId: 'ses_e2b',
      nativeSessionId: null, forkSourceNativeSessionId: null, prompt: 'Use remote tools',
      model: 'faux/faux-1', reasoningEffort: null, cwd: '/home/user/repo',
      sandbox: { kind: 'e2b', providerSandboxId: 'e2b-test-123',
        credentials: { domain: 'e2b.example', apiKey: 'test-key' }, forwardGitHubToken: false },
      environment: {}, instructions: 'Test',
      signal: new AbortController().signal, timeoutMs: 30_000,
      onNativeSession: () => undefined, onEvent: () => undefined });
    assert.equal(outcome.status, 'succeeded');
    assert.equal(outcome.finalMessage, 'Remote tools succeeded');
    assert.equal(new TextDecoder().decode(sdk.data.get('/home/user/repo/note.txt')), 'after\n');
    assert(sdk.commands.some((entry) => entry.command.includes('echo hello') && entry.cwd === '/home/user/repo'));
    assert.equal(sdk.commands.some((entry) => entry.envs?.GH_TOKEN !== undefined), false);
    assert.equal(existsSync(join(directory, 'note.txt')), false);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
