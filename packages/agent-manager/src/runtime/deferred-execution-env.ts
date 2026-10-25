import type { Context } from '@earendil-works/chord';
import { awaitWithContext } from '@earendil-works/chord/context';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';

/** Building a Harness environment must not wake a sandbox just to render a prompt or run a host tool. */
export class DeferredExecutionEnv implements ExecutionEnv {
  #pending: Promise<ExecutionEnv> | undefined;
  #resolved: ExecutionEnv | undefined;

  constructor(readonly id: string, private directory: string,
    private readonly open: (context: Context) => Promise<ExecutionEnv>) {}

  get cwd(): string { return this.#resolved?.cwd ?? this.directory; }
  set cwd(value: string) {
    this.directory = value;
    if (this.#resolved) this.#resolved.cwd = value;
  }

  reset(): void { this.#pending = undefined; this.#resolved = undefined; }

  private async get(context: Context): Promise<ExecutionEnv> {
    context.abortSignal?.throwIfAborted();
    let pending = this.#pending;
    if (!pending) {
      pending = this.open(context).then((env) => {
        context.abortSignal?.throwIfAborted();
        if (this.#pending === pending) this.#resolved = env;
        return env;
      });
      this.#pending = pending;
    }
    try {
      const env = await awaitWithContext(pending, context);
      context.abortSignal?.throwIfAborted();
      return env;
    } catch (error) {
      if (this.#pending === pending) this.reset();
      throw error;
    }
  }

  absolutePath = async (...args: Parameters<ExecutionEnv['absolutePath']>) => (await this.get(args[1])).absolutePath(...args);
  joinPath = async (...args: Parameters<ExecutionEnv['joinPath']>) => (await this.get(args[1])).joinPath(...args);
  readTextFile = async (...args: Parameters<ExecutionEnv['readTextFile']>) => (await this.get(args[1])).readTextFile(...args);
  openTextLineReader = async (...args: Parameters<ExecutionEnv['openTextLineReader']>) => (await this.get(args[1])).openTextLineReader(...args);
  readTextLines = async (...args: Parameters<ExecutionEnv['readTextLines']>) => (await this.get(args[2])).readTextLines(...args);
  readBinaryFile = async (...args: Parameters<ExecutionEnv['readBinaryFile']>) => (await this.get(args[1])).readBinaryFile(...args);
  writeFile = async (...args: Parameters<ExecutionEnv['writeFile']>) => (await this.get(args[2])).writeFile(...args);
  appendFile = async (...args: Parameters<ExecutionEnv['appendFile']>) => (await this.get(args[2])).appendFile(...args);
  truncateFile = async (...args: Parameters<ExecutionEnv['truncateFile']>) => (await this.get(args[2])).truncateFile(...args);
  flushFile = async (...args: Parameters<ExecutionEnv['flushFile']>) => (await this.get(args[1])).flushFile(...args);
  renameFile = async (...args: Parameters<ExecutionEnv['renameFile']>) => (await this.get(args[2])).renameFile(...args);
  fileInfo = async (...args: Parameters<ExecutionEnv['fileInfo']>) => (await this.get(args[1])).fileInfo(...args);
  listDir = async (...args: Parameters<ExecutionEnv['listDir']>) => (await this.get(args[1])).listDir(...args);
  canonicalPath = async (...args: Parameters<ExecutionEnv['canonicalPath']>) => (await this.get(args[1])).canonicalPath(...args);
  exists = async (...args: Parameters<ExecutionEnv['exists']>) => (await this.get(args[1])).exists(...args);
  createDir = async (...args: Parameters<ExecutionEnv['createDir']>) => (await this.get(args[2])).createDir(...args);
  remove = async (...args: Parameters<ExecutionEnv['remove']>) => (await this.get(args[2])).remove(...args);
  createTempDir = async (...args: Parameters<ExecutionEnv['createTempDir']>) => (await this.get(args[1])).createTempDir(...args);
  createTempFile = async (...args: Parameters<ExecutionEnv['createTempFile']>) => (await this.get(args[1])).createTempFile(...args);
  exec = async (...args: Parameters<ExecutionEnv['exec']>) => (await this.get(args[2])).exec(...args);
  cleanup = async (...args: Parameters<ExecutionEnv['cleanup']>): Promise<void> => { await this.#resolved?.cleanup(...args); };
}
