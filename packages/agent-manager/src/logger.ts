import { appendFileSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export type LogContext = Readonly<Record<string, unknown>>;

export interface Logger {
  readonly level: LogLevel;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(context: LogContext): Logger;
}

export interface LogWriter {
  write(value: string): unknown;
}

export interface LoggerOptions {
  level?: LogLevel;
  context?: LogContext;
  stdout?: LogWriter;
  stderr?: LogWriter;
  now?: () => Date;
}

export interface FileLoggerOptions extends Omit<LoggerOptions, 'stdout' | 'stderr'> {
  filePath: string;
}

const priorities: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: Number.POSITIVE_INFINITY,
};

const reservedFields = new Set(['timestamp', 'level', 'message']);

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && Object.hasOwn(priorities, value);
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  if (!isLogLevel(level)) throw new TypeError(`Unsupported log level: ${String(level)}`);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const now = options.now ?? (() => new Date());
  const baseContext = cleanContext(options.context ?? {});

  const log = (entryLevel: Exclude<LogLevel, 'silent'>, message: string, context?: LogContext): void => {
    if (priorities[entryLevel] < priorities[level]) return;
    try {
      const record = {
        timestamp: now().toISOString(),
        level: entryLevel,
        message,
        ...baseContext,
        ...cleanContext(context ?? {}),
      };
      const line = `${safeStringify(record)}\n`;
      (entryLevel === 'warn' || entryLevel === 'error' ? stderr : stdout).write(line);
    } catch {
      // Diagnostic output must never interrupt Agent Manager work.
    }
  };

  return {
    level,
    debug: (message, context) => log('debug', message, context),
    info: (message, context) => log('info', message, context),
    warn: (message, context) => log('warn', message, context),
    error: (message, context) => log('error', message, context),
    child: (context) => createLogger({
      level,
      context: { ...baseContext, ...cleanContext(context) },
      stdout,
      stderr,
      now,
    }),
  };
}

export function createFileLogger(options: FileLoggerOptions): Logger {
  const filePath = resolve(options.filePath);
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  closeSync(openSync(filePath, 'a', 0o600));
  const writer: LogWriter = {
    write: (value) => appendFileSync(filePath, value, { encoding: 'utf8', mode: 0o600 }),
  };
  return createLogger({
    ...(options.level ? { level: options.level } : {}),
    ...(options.context ? { context: options.context } : {}),
    ...(options.now ? { now: options.now } : {}),
    stdout: writer,
    stderr: writer,
  });
}

export const silentLogger: Logger = createLogger({
  level: 'silent',
  stdout: { write: () => undefined },
  stderr: { write: () => undefined },
});

function cleanContext(context: LogContext): Record<string, unknown> {
  return Object.fromEntries(Object.entries(context).filter(([key]) => !reservedFields.has(key)));
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, current: unknown) => {
    if (typeof current === 'bigint') return current.toString();
    if (current && typeof current === 'object') {
      if (seen.has(current)) return '[Circular]';
      seen.add(current);
    }
    if (current instanceof Error) {
      return {
        name: current.name,
        message: current.message,
        ...(current.stack ? { stack: current.stack } : {}),
        ...(current.cause === undefined ? {} : { cause: current.cause }),
      };
    }
    return current;
  });
}
