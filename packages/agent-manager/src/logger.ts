import { mkdirSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';

import * as winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export type LogContext = Readonly<Record<string, unknown>>;

export interface Logger {
  readonly level: LogLevel;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(context: LogContext): Logger;
  close?(): Promise<void> | void;
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
  datePattern?: string;
  maxSize?: string | number;
  maxFiles?: string | number;
}

export const DEFAULT_LOG_DATE_PATTERN = 'YYYY-MM-DD';
export const DEFAULT_LOG_MAX_SIZE = '20m';
export const DEFAULT_LOG_MAX_FILES = '14d';

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
  const extension = extname(filePath);
  const fileName = basename(filePath);
  const stem = basename(filePath, extension);
  const transport = new DailyRotateFile({
    dirname: dirname(filePath),
    filename: `${stem}-%DATE%${extension}`,
    datePattern: options.datePattern ?? DEFAULT_LOG_DATE_PATTERN,
    maxSize: options.maxSize ?? DEFAULT_LOG_MAX_SIZE,
    maxFiles: options.maxFiles ?? DEFAULT_LOG_MAX_FILES,
    createSymlink: true,
    symlinkName: fileName,
    auditFile: resolve(dirname(filePath), `.${stem}-audit.json`),
    options: { flags: 'a', mode: 0o600 },
  });
  // The transport requires an error listener and logging cannot fall back to the screen.
  transport.on('error', () => undefined);

  const now = options.now ?? (() => new Date());
  const lineFormat = winston.format((info) => {
    const { level, message, ...context } = info;
    info[Symbol.for('message')] = safeStringify({
      timestamp: now().toISOString(),
      level,
      message,
      ...cleanContext(context),
    });
    return info;
  });
  const level = options.level ?? 'info';
  const winstonLogger = winston.createLogger({
    level: level === 'silent' ? 'info' : level,
    silent: level === 'silent',
    format: lineFormat(),
    transports: [transport],
    exitOnError: false,
  });
  winstonLogger.on('error', () => undefined);
  let closePromise: Promise<void> | null = null;
  const close = () => {
    closePromise ??= new Promise<void>((resolveClose) => {
      transport.logStream.once('finish', resolveClose);
      winstonLogger.end();
    });
    return closePromise;
  };
  return wrapWinstonLogger(winstonLogger, level, cleanContext(options.context ?? {}), close);
}

export const silentLogger: Logger = createLogger({
  level: 'silent',
  stdout: { write: () => undefined },
  stderr: { write: () => undefined },
});

function cleanContext(context: LogContext): Record<string, unknown> {
  return Object.fromEntries(Object.entries(context).filter(([key]) => !reservedFields.has(key)));
}

function wrapWinstonLogger(
  target: winston.Logger,
  level: LogLevel,
  baseContext: Record<string, unknown>,
  closeTarget?: () => Promise<void>,
): Logger {
  const log = (entryLevel: Exclude<LogLevel, 'silent'>, message: string, context?: LogContext): void => {
    if (priorities[entryLevel] < priorities[level]) return;
    try {
      target.log({
        ...baseContext,
        ...cleanContext(context ?? {}),
        level: entryLevel,
        message,
      });
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
    child: (context) => wrapWinstonLogger(
      target,
      level,
      { ...baseContext, ...cleanContext(context) },
      undefined,
    ),
    ...(closeTarget ? { close: closeTarget } : {}),
  };
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
