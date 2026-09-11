import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentManager } from '../src/agent-manager.ts';
import { createLogger, isLogLevel, type LogWriter } from '../src/logger.ts';
import { SqliteAgentManagerStore } from '../src/sqlite-store.ts';

class MemoryWriter implements LogWriter {
  readonly lines: string[] = [];

  write(value: string): void {
    this.lines.push(value);
  }
}

test('logger emits JSONL at the configured level and routes warnings to stderr', () => {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const logger = createLogger({
    level: 'info',
    context: { component: 'agent-manager' },
    stdout,
    stderr,
    now: () => new Date('2026-09-11T03:00:00.000Z'),
  });

  logger.debug('hidden');
  logger.info('started', { port: 4310, level: 'forged' });
  logger.warn('retrying', { attempt: 2 });

  assert.equal(stdout.lines.length, 1);
  assert.equal(stderr.lines.length, 1);
  assert.deepEqual(JSON.parse(stdout.lines[0]!), {
    timestamp: '2026-09-11T03:00:00.000Z',
    level: 'info',
    message: 'started',
    component: 'agent-manager',
    port: 4310,
  });
  assert.equal(JSON.parse(stderr.lines[0]!).level, 'warn');
});

test('child logger adds context and safely serializes errors and circular values', () => {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const logger = createLogger({ level: 'debug', stdout, stderr })
    .child({ component: 'runner', runId: 'run-1' });
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  logger.error('run failed', { error: new Error('boom'), circular, count: 1n });

  const entry = JSON.parse(stderr.lines[0]!) as Record<string, unknown>;
  assert.equal(entry.component, 'runner');
  assert.equal(entry.runId, 'run-1');
  assert.equal((entry.error as { message: string }).message, 'boom');
  assert.deepEqual(entry.circular, { self: '[Circular]' });
  assert.equal(entry.count, '1');
});

test('Agent Manager publishes lifecycle logs through an injected logger', () => {
  const stdout = new MemoryWriter();
  const logger = createLogger({ level: 'info', stdout, stderr: new MemoryWriter() });
  const manager = new AgentManager({
    workspaceRoot: process.cwd(),
    store: new SqliteAgentManagerStore(':memory:'),
    logger,
  });

  const requirement = manager.createRequirement({
    title: 'Add logs',
    description: 'Print lifecycle events',
    provider: 'codex',
  });
  manager.close();

  const entries = stdout.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(entries.map((entry) => entry.message), [
    'Agent Manager initialized',
    'Requirement created',
    'Agent Manager closed',
  ]);
  assert.equal(entries[1]?.requirementId, requirement.id);
  assert.equal(entries[1]?.sessionId, requirement.session.id);
});

test('log level validation accepts every supported level', () => {
  assert.ok(['debug', 'info', 'warn', 'error', 'silent'].every(isLogLevel));
  assert.equal(isLogLevel('trace'), false);
  assert.equal(isLogLevel(undefined), false);
  assert.throws(
    () => createLogger({ level: 'trace' as 'info' }),
    /Unsupported log level: trace/,
  );
});
