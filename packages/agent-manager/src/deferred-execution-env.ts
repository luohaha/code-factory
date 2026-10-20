import type { ExecutionEnv } from '@earendil-works/pi-durable/env';

/** Building a Harness environment must not wake a sandbox just to render a prompt or run a host tool. */
export class DeferredExecutionEnv implements ExecutionEnv {
  #pending: Promise<ExecutionEnv> | undefined;
  #resolved: ExecutionEnv | undefined;

  constructor(readonly id: string, private directory: string,
    private readonly open: () => Promise<ExecutionEnv>) {}

  get cwd(): string { return this.#resolved?.cwd ?? this.directory; }
  set cwd(value: string) {
    this.directory = value;
    if (this.#resolved) this.#resolved.cwd = value;
  }

  reset(): void { this.#pending = undefined; this.#resolved = undefined; }

  private async get(): Promise<ExecutionEnv> {
    this.#pending ??= this.open().then((env) => { this.#resolved = env; return env; })
      .catch((error: unknown) => { this.#pending = undefined; throw error; });
    return this.#pending;
  }

  absolutePath = async (...args: Parameters<ExecutionEnv['absolutePath']>) => (await this.get()).absolutePath(...args);
  joinPath = async (...args: Parameters<ExecutionEnv['joinPath']>) => (await this.get()).joinPath(...args);
  readTextFile = async (...args: Parameters<ExecutionEnv['readTextFile']>) => (await this.get()).readTextFile(...args);
  openTextLineReader = async (...args: Parameters<ExecutionEnv['openTextLineReader']>) => (await this.get()).openTextLineReader(...args);
  readTextLines = async (...args: Parameters<ExecutionEnv['readTextLines']>) => (await this.get()).readTextLines(...args);
  readBinaryFile = async (...args: Parameters<ExecutionEnv['readBinaryFile']>) => (await this.get()).readBinaryFile(...args);
  writeFile = async (...args: Parameters<ExecutionEnv['writeFile']>) => (await this.get()).writeFile(...args);
  appendFile = async (...args: Parameters<ExecutionEnv['appendFile']>) => (await this.get()).appendFile(...args);
  truncateFile = async (...args: Parameters<ExecutionEnv['truncateFile']>) => (await this.get()).truncateFile(...args);
  flushFile = async (...args: Parameters<ExecutionEnv['flushFile']>) => (await this.get()).flushFile(...args);
  renameFile = async (...args: Parameters<ExecutionEnv['renameFile']>) => (await this.get()).renameFile(...args);
  fileInfo = async (...args: Parameters<ExecutionEnv['fileInfo']>) => (await this.get()).fileInfo(...args);
  listDir = async (...args: Parameters<ExecutionEnv['listDir']>) => (await this.get()).listDir(...args);
  canonicalPath = async (...args: Parameters<ExecutionEnv['canonicalPath']>) => (await this.get()).canonicalPath(...args);
  exists = async (...args: Parameters<ExecutionEnv['exists']>) => (await this.get()).exists(...args);
  createDir = async (...args: Parameters<ExecutionEnv['createDir']>) => (await this.get()).createDir(...args);
  remove = async (...args: Parameters<ExecutionEnv['remove']>) => (await this.get()).remove(...args);
  createTempDir = async (...args: Parameters<ExecutionEnv['createTempDir']>) => (await this.get()).createTempDir(...args);
  createTempFile = async (...args: Parameters<ExecutionEnv['createTempFile']>) => (await this.get()).createTempFile(...args);
  exec = async (...args: Parameters<ExecutionEnv['exec']>) => (await this.get()).exec(...args);
  cleanup = async (...args: Parameters<ExecutionEnv['cleanup']>): Promise<void> => { await this.#resolved?.cleanup(...args); };
}
