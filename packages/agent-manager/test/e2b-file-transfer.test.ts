import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { E2BHandle } from '../src/runtime/e2b-execution-env.js';
import { downloadE2BFile, uploadE2BFile, validateTransferPaths } from '../src/runtime/e2b-file-transfer.js';

function fakeFiles() {
  const files = new Map<string, Uint8Array>();
  const sandbox = { files: {
    async write(path: string, stream: ReadableStream<Uint8Array>) {
      files.set(path, new Uint8Array(await new Response(stream).arrayBuffer()));
    },
    async read(path: string, options: { format: string }) {
      assert.equal(options.format, 'stream');
      const data = files.get(path);
      if (!data) throw new Error('Missing remote file');
      return new ReadableStream<Uint8Array>({ start(controller) {
        for (let i = 0; i < data.length; i += 4096) controller.enqueue(data.slice(i, i + 4096));
        controller.close();
      } });
    },
  } } as unknown as E2BHandle;
  return { sandbox, files };
}

test('E2B transfers stream binary and empty files, create parent paths and preserve existing downloads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-factory-transfer-'));
  const { sandbox, files } = fakeFiles();
  try {
    for (const binary of [Buffer.from(Array.from({ length: 200_000 }, (_, i) => i % 256)), Buffer.alloc(0)]) {
      const source = join(directory, 'source.bin');
      const target = join(directory, 'nested', 'result.bin');
      await writeFile(source, binary);
      assert.equal(await uploadE2BFile(sandbox, source, '/remote/data.bin'), binary.length);
      assert.deepEqual(files.get('/remote/data.bin'), new Uint8Array(binary));
      assert.equal(await downloadE2BFile(sandbox, '/remote/data.bin', target, true), binary.length);
      assert.deepEqual(await readFile(target), binary);
      assert.equal((await stat(target)).mode & 0o777, 0o600);
      files.set('/remote/data.bin', new Uint8Array([1, 2, 3]));
      await assert.rejects(downloadE2BFile(sandbox, '/remote/data.bin', target, false), { code: 'EEXIST' });
      assert.deepEqual(await readFile(target), binary);
      assert.deepEqual(await readdir(join(directory, 'nested')), ['result.bin']);
    }
    await assert.rejects(uploadE2BFile(sandbox, directory, '/remote/directory'), /regular file/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('failed and interrupted downloads never publish partial files or clobber the destination', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-factory-transfer-failure-'));
  const { sandbox } = fakeFiles();
  const target = join(directory, 'result');
  try {
    await writeFile(target, 'original');
    sandbox.files.read = (async () => new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2])); },
      pull(controller) { controller.error(new Error('Disconnected')); },
    })) as E2BHandle['files']['read'];
    await assert.rejects(downloadE2BFile(sandbox, '/failed', target, true), /Disconnected/);
    assert.equal(await readFile(target, 'utf8'), 'original');
    assert.deepEqual(await readdir(directory), ['result']);
    const controller = new AbortController();
    let cancelled = false;
    sandbox.files.read = (async () => new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(new Uint8Array([1, 2])); setTimeout(() => controller.abort(), 10); },
      cancel() { cancelled = true; },
    })) as E2BHandle['files']['read'];
    await assert.rejects(downloadE2BFile(sandbox, '/slow', target, true, controller.signal), { name: 'AbortError' });
    assert.equal(cancelled, true);
    assert.equal(await readFile(target, 'utf8'), 'original');
    assert.deepEqual(await readdir(directory), ['result']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('transfer paths reject ambiguous host paths and invalid remote paths', () => {
  assert.throws(() => validateTransferPaths('relative.txt', '/remote'), /absolute host/);
  assert.throws(() => validateTransferPaths('/local\0', '/remote'), /absolute host/);
  assert.throws(() => validateTransferPaths('/local', '  '), /non-empty/);
  assert.throws(() => validateTransferPaths('/local', '/remote\0'), /non-empty/);
  validateTransferPaths('/local file', 'remote file');
});

test('uploads propagate cancellation and release the host source file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-factory-upload-abort-'));
  const { sandbox } = fakeFiles();
  const controller = new AbortController();
  const source = join(directory, 'input');
  let received = 0;
  sandbox.files.write = (async (_path: string, stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.length;
      controller.abort();
    }
  }) as E2BHandle['files']['write'];
  try {
    await writeFile(source, Buffer.alloc(200_000));
    await assert.rejects(uploadE2BFile(sandbox, source, '/remote', controller.signal), { name: 'AbortError' });
    assert(received > 0);
    assert(received < 200_000);
    await assert.rejects(uploadE2BFile(sandbox, source, '/remote', controller.signal), { name: 'AbortError' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
