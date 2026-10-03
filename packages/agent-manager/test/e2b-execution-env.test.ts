import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
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
        onStderr?: (value: string) => void;
      }) {
        commands.push({ command, cwd: options.cwd, envs: options.envs });
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
  const service = new E2BSandboxService(sdk.client, () => 'test-key');
  const created = await service.create('custom-template');
  assert.equal(created.sandboxId, 'e2b-test-123');
  assert.deepEqual(sdk.createOptions, { template: 'custom-template', apiKey: 'test-key', timeoutMs: 600_000,
    lifecycle: { onTimeout: 'pause', autoResume: true } });
  assert.equal((await service.connect(created.sandboxId)).sandboxId, created.sandboxId);
  assert.equal((await service.getInfo(created.sandboxId)).state, 'paused');
  assert.equal(await service.pause(created.sandboxId), true);
  assert.equal(await service.kill(created.sandboxId), true);
  assert.throws(() => new E2BSandboxService(sdk.client, () => undefined).apiKey(), /E2B_API_KEY/);
});

test('E2B ExecutionEnv uses the remote SDK for files and shell commands', async () => {
  const sdk = fakeSdk();
  const env = new E2BExecutionEnv(sdk.handle, '/home/user/repo', { GH_TOKEN: 'temporary-token' });
  const context = BACKGROUND_CONTEXT;
  assert.equal(env.id, 'e2b:e2b-test-123');
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
    new E2BSandboxService(sdk.client, () => 'test-key'));
  try {
    const outcome = await service.run({ requirementId: 'req_e2b', sessionId: 'ses_e2b',
      nativeSessionId: null, forkSourceNativeSessionId: null, prompt: 'Use remote tools',
      model: 'faux/faux-1', reasoningEffort: null, cwd: '/home/user/repo',
      sandbox: { kind: 'e2b', providerSandboxId: 'e2b-test-123' }, environment: {}, instructions: 'Test',
      signal: new AbortController().signal, timeoutMs: 30_000,
      onNativeSession: () => undefined, onEvent: () => undefined });
    assert.equal(outcome.status, 'succeeded');
    assert.equal(outcome.finalMessage, 'Remote tools succeeded');
    assert.equal(new TextDecoder().decode(sdk.data.get('/home/user/repo/note.txt')), 'after\n');
    assert(sdk.commands.some((entry) => entry.command === 'echo hello' && entry.cwd === '/home/user/repo'));
    assert.equal(existsSync(join(directory, 'note.txt')), false);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
