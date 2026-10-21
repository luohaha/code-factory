import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import type { E2BHandle } from './e2b-execution-env.js';

export function validateTransferPaths(localPath: string, remotePath: string): void {
  if (!isAbsolute(localPath) || localPath.includes('\0')) throw new TypeError('localPath must be an absolute host file path');
  if (!remotePath.trim() || remotePath.includes('\0')) throw new TypeError('remotePath must be a non-empty sandbox file path');
}

/** Stream bytes outside model context; never include file contents or raw provider errors in tool results. */
export async function uploadE2BFile(sandbox: E2BHandle, localPath: string, remotePath: string,
  signal?: AbortSignal): Promise<number> {
  signal?.throwIfAborted();
  const file = await open(localPath, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new TypeError('localPath must refer to a regular file');
    const stream = file.createReadStream({ autoClose: false, ...(signal ? { signal } : {}) });
    try {
      // Node and DOM declarations differ, but both represent WHATWG byte streams at this SDK boundary.
      await sandbox.files.write(remotePath, Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, signal ? { signal } : {});
      signal?.throwIfAborted();
      return stream.bytesRead;
    } finally { stream.destroy(); }
  } finally { await file.close(); }
}

export async function downloadE2BFile(sandbox: E2BHandle, remotePath: string, localPath: string,
  overwrite: boolean, signal?: AbortSignal): Promise<number> {
  signal?.throwIfAborted();
  await mkdir(dirname(localPath), { recursive: true });
  const temporary = join(dirname(localPath), `.code-factory-download-${randomUUID()}`);
  try {
    const stream = await sandbox.files.read(remotePath, { format: 'stream', ...(signal ? { signal } : {}) });
    await pipeline(Readable.fromWeb(stream as unknown as NodeReadableStream<Uint8Array>), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
      signal ? { signal } : {});
    signal?.throwIfAborted();
    const { size } = await stat(temporary);
    if (overwrite) await rename(temporary, localPath);
    else await link(temporary, localPath); // Atomic no-clobber publication after the complete download.
    return size;
  } finally { await unlink(temporary).catch(() => undefined); }
}
