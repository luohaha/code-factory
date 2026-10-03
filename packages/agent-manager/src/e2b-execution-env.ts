import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';

import type { Context } from '@earendil-works/chord';
import {
  err, ExecutionError, FileError, ok,
  type ExecutionEnv, type FileInfo, type FileKind, type Result,
  type ShellExecOptions, type ShellExecResult, type TextLine, type TextLineReader,
} from '@earendil-works/pi-durable/env';
import { CommandExitError, FileNotFoundError, FileType, Sandbox, TimeoutError } from 'e2b';
import type { SandboxInfo, SandboxOpts } from 'e2b';

export type E2BHandle = Pick<Sandbox, 'sandboxId' | 'files' | 'commands'>;

/** Narrow SDK seam so the same adapter is exercised by deterministic provider tests. */
export interface E2BClient {
  create(options: SandboxOpts): Promise<E2BHandle>;
  connect(id: string, options: { apiKey: string }): Promise<E2BHandle>;
  getInfo(id: string, options: { apiKey: string }): Promise<SandboxInfo>;
  pause(id: string, options: { apiKey: string }): Promise<boolean>;
  kill(id: string, options: { apiKey: string }): Promise<boolean>;
}

export const e2bClient: E2BClient = {
  create: (options) => Sandbox.create(options),
  connect: (id, options) => Sandbox.connect(id, options),
  getInfo: (id, options) => Sandbox.getInfo(id, options),
  pause: (id, options) => Sandbox.pause(id, options),
  kill: (id, options) => Sandbox.kill(id, options),
};

export class E2BSandboxService {
  constructor(
    readonly client: E2BClient = e2bClient,
    readonly credential: () => string | undefined = () => process.env.E2B_API_KEY,
  ) {}

  apiKey(): string {
    const key = this.credential()?.trim();
    if (!key) throw new TypeError('E2B_API_KEY is required for cloud sandboxes');
    return key;
  }

  async create(template = 'base'): Promise<E2BHandle> {
    return this.client.create({ template, apiKey: this.apiKey(), timeoutMs: 600_000,
      lifecycle: { onTimeout: 'pause', autoResume: true } });
  }

  async connect(id: string): Promise<E2BHandle> {
    return this.client.connect(id, { apiKey: this.apiKey() });
  }

  async getInfo(id: string): Promise<SandboxInfo> {
    return this.client.getInfo(id, { apiKey: this.apiKey() });
  }

  async pause(id: string): Promise<boolean> {
    return this.client.pause(id, { apiKey: this.apiKey() });
  }

  async kill(id: string): Promise<boolean> {
    return this.client.kill(id, { apiKey: this.apiKey() });
  }
}

function fileError(error: unknown, path?: string): FileError {
  if (error instanceof FileError) return error;
  const cause = error instanceof Error ? error : new Error(String(error));
  if (cause.name === 'AbortError') return new FileError('aborted', cause.message, path, cause);
  if (error instanceof FileNotFoundError) return new FileError('not_found', cause.message, path, cause);
  return new FileError('unknown', cause.message, path, cause);
}

function executionError(error: unknown): ExecutionError {
  if (error instanceof ExecutionError) return error;
  const cause = error instanceof Error ? error : new Error(String(error));
  if (error instanceof TimeoutError) return new ExecutionError('timeout', cause.message, cause);
  if (cause.name === 'AbortError') return new ExecutionError('aborted', cause.message, cause);
  return new ExecutionError('unknown', cause.message, cause);
}

function kind(type: FileType | undefined): FileKind {
  return type === FileType.DIR ? 'directory' : type === FileType.SYMLINK ? 'symlink' : 'file';
}

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const requestOptions = (context: Context): { signal?: AbortSignal } =>
  context.abortSignal ? { signal: context.abortSignal } : {};

export class E2BExecutionEnv implements ExecutionEnv {
  readonly id: string;
  cwd: string;

  constructor(readonly sandbox: E2BHandle, cwd: string, readonly commandEnv: Readonly<Record<string, string>> = {}) {
    this.id = `e2b:${sandbox.sandboxId}`;
    this.cwd = cwd;
  }

  private path(path: string): string { return posix.resolve(this.cwd, path); }

  private async file<T>(path: string, context: Context, operation: () => Promise<T>): Promise<Result<T, FileError>> {
    if (context.abortSignal?.aborted) return err(new FileError('aborted', 'Operation aborted', path));
    try {
      const value = await operation();
      return context.abortSignal?.aborted ? err(new FileError('aborted', 'Operation aborted', path)) : ok(value);
    } catch (error) { return err(fileError(error, path)); }
  }

  async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
    return ok(this.path(path));
  }

  async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
    return ok(posix.join(...parts));
  }

  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const target = this.path(path);
    return this.file(target, context, () => this.sandbox.files.read(target, requestOptions(context)));
  }

  async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    const read = await this.readTextFile(path, context);
    if (!read.ok) return read;
    const pieces = read.value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    let index = 0;
    return ok({
      readLine: async () => {
        const piece = pieces[index++];
        return ok<TextLine | undefined, FileError>(piece === undefined ? undefined : {
          text: piece.endsWith('\n') ? piece.slice(0, -1) : piece,
          terminated: piece.endsWith('\n'),
        });
      },
      close: async () => undefined,
    });
  }

  async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
    const read = await this.readTextFile(path, context);
    if (!read.ok) return read;
    const lines = read.value.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
  }

  async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    const target = this.path(path);
    return this.file(target, context, () => this.sandbox.files.read(target, { format: 'bytes', ...requestOptions(context) }));
  }

  async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const target = this.path(path);
    return this.file(target, context, async () => { await this.sandbox.files.write(target,
      typeof content === 'string' ? content : content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer,
      requestOptions(context)); });
  }

  async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const target = this.path(path);
    const temp = `/tmp/code-factory-append-${randomUUID()}`;
    try {
      const written = await this.writeFile(temp, content, context);
      if (!written.ok) return written;
      const parent = await this.createDir(posix.dirname(target), { recursive: true }, context);
      if (!parent.ok) return parent;
      const result = await this.exec(`cat -- ${quote(temp)} >> ${quote(target)}; status=$?; rm -f -- ${quote(temp)}; exit "$status"`, undefined, context);
      if (!result.ok || result.value.exitCode !== 0) return err(new FileError('unknown', `Could not append ${target}`, target));
      return ok(undefined);
    } finally {
      await this.sandbox.files.remove(temp).catch(() => undefined);
    }
  }

  async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    const target = this.path(path);
    if (!Number.isSafeInteger(size) || size < 0) return err(new FileError('invalid', 'Invalid file size', target));
    const result = await this.exec(`truncate -s ${size} -- ${quote(target)}`, undefined, context);
    return result.ok && result.value.exitCode === 0 ? ok(undefined) : err(new FileError('unknown', `Could not truncate ${target}`, target));
  }

  async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    const target = this.path(path);
    const result = await this.exec(`sync -f -- ${quote(target)}`, undefined, context);
    return result.ok && result.value.exitCode === 0 ? ok(undefined) : err(new FileError('unknown', `Could not flush ${target}`, target));
  }

  async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    const source = this.path(sourcePath);
    return this.file(source, context, async () => { await this.sandbox.files.rename(source, this.path(destinationPath),
      requestOptions(context)); });
  }

  private info(entry: Awaited<ReturnType<E2BHandle['files']['getInfo']>>): FileInfo {
    return { name: entry.name, path: entry.path, kind: kind(entry.type), size: entry.size,
      mtimeMs: entry.modifiedTime?.getTime() ?? 0 };
  }

  async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    const target = this.path(path);
    return this.file(target, context, async () => this.info(await this.sandbox.files.getInfo(target,
      requestOptions(context))));
  }

  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    const target = this.path(path);
    return this.file(target, context, async () => (await this.sandbox.files.list(target,
      requestOptions(context))).map((entry) => this.info(entry)));
  }

  async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    const target = this.path(path);
    const chunks: string[] = [];
    const result = await this.exec(`realpath -m -- ${quote(target)}`, { onOutput: (text) => chunks.push(text) }, context);
    return result.ok && result.value.exitCode === 0 ? ok(chunks.join('').trim()) : err(new FileError('unknown', `Could not resolve ${target}`, target));
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    const target = this.path(path);
    return this.file(target, context, () => this.sandbox.files.exists(target, requestOptions(context)));
  }

  async createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    const target = this.path(path);
    return this.file(target, context, async () => {
      if (options?.recursive === false && !(await this.sandbox.files.exists(posix.dirname(target),
        requestOptions(context)))) throw new FileError('not_found', 'Parent directory does not exist', target);
      await this.sandbox.files.makeDir(target, requestOptions(context));
    });
  }

  async remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    const target = this.path(path);
    return this.file(target, context, async () => {
      if (options?.force && !(await this.sandbox.files.exists(target, requestOptions(context)))) return;
      if (!options?.recursive) {
        const info = await this.sandbox.files.getInfo(target, requestOptions(context));
        if (info.type === FileType.DIR && (await this.sandbox.files.list(target,
          requestOptions(context))).length > 0) throw new FileError('invalid', 'Directory is not empty', target);
      }
      await this.sandbox.files.remove(target, requestOptions(context));
    });
  }

  async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    const path = `/tmp/${prefix ?? 'code-factory-'}${randomUUID()}`;
    const created = await this.createDir(path, { recursive: true }, context);
    return created.ok ? ok(path) : created;
  }

  async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
    const path = `/tmp/${options?.prefix ?? 'code-factory-'}${randomUUID()}${options?.suffix ?? ''}`;
    const created = await this.writeFile(path, '', context);
    return created.ok ? ok(path) : created;
  }

  async exec(command: string, options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    if (context.abortSignal?.aborted) return err(new ExecutionError('aborted', 'Command aborted'));
    const chunks: string[] = [];
    const onOutput = (value: string) => {
      chunks.push(value);
      try { options?.onOutput?.(value, context); }
      catch (error) { throw new ExecutionError('callback_error', error instanceof Error ? error.message : String(error)); }
    };
    const saveSpill = async (): Promise<string | undefined> => {
      if (!options?.spill) return undefined;
      const output = chunks.join('');
      if (Buffer.byteLength(output) <= options.spill.afterBytes && output.split('\n').length - 1 <= options.spill.afterLines) {
        return undefined;
      }
      const path = `/tmp/code-factory-output-${randomUUID()}.log`;
      await this.sandbox.files.write(path, output);
      return path;
    };
    let exitCode: number;
    try {
      const result = await this.sandbox.commands.run(command, {
        cwd: options?.cwd ? this.path(options.cwd) : this.cwd,
        envs: { ...(options?.inheritEnv === false ? {} : this.commandEnv), ...options?.env },
        ...(options?.timeout === undefined ? { timeoutMs: 0 } : { timeoutMs: Math.ceil(options.timeout * 1000) }),
        ...(context.abortSignal ? { signal: context.abortSignal } : {}),
        onStdout: onOutput,
        onStderr: onOutput,
      });
      exitCode = result.exitCode;
    } catch (error) {
      if (error instanceof CommandExitError) {
        if (chunks.length === 0) {
          if (error.stdout) onOutput(error.stdout);
          if (error.stderr) onOutput(error.stderr);
        }
        exitCode = error.exitCode;
      } else {
        const failure = executionError(error);
        try {
          const spillPath = await saveSpill();
          if (spillPath) failure.spillPath = spillPath;
        } catch { /* Preserve the execution failure. */ }
        return err(failure);
      }
    }
    try {
      const spillPath = await saveSpill();
      return ok({ exitCode, ...(spillPath ? { spillPath } : {}) });
    } catch (error) {
      return err(executionError(error));
    }
  }

  async cleanup(_context: Context): Promise<void> { /* SDK calls own their resources. */ }
}
