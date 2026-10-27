import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

interface Invocation {
  command: string;
  args: string[];
  cwd: string;
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'code-factory-dev-script-')));
  const repository = join(root, 'source checkout');
  const manager = join(repository, 'packages', 'agent-manager');
  const web = join(repository, 'apps', 'web');
  const workspace = join(root, 'managed workspace');
  const commands = join(root, 'commands');
  const log = join(root, 'commands.jsonl');
  const script = join(repository, 'scripts', 'dev.sh');
  for (const directory of [manager, web, workspace, commands, join(repository, 'scripts')]) {
    mkdirSync(directory, { recursive: true });
  }
  copyFileSync(new URL('../../../scripts/dev.sh', import.meta.url), script);
  writeFileSync(log, '');

  const fakeCommand = `#!${process.execPath}
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.DEV_SCRIPT_LOG, JSON.stringify({ command, args, cwd: process.cwd() }) + '\\n');
if (process.env.DEV_SCRIPT_FAIL === command + ':' + args.join(' ')) process.exit(42);
if (command === 'npm' && args[0] === 'ci') mkdirSync('node_modules', { recursive: true });
if (command === 'npm' && args[0] === 'run' && args[1] === 'build') {
  mkdirSync('dist', { recursive: true });
  writeFileSync(join('dist', 'cli.js'), '');
}
if (command === 'node') process.exit(Number(process.env.DEV_SCRIPT_NODE_EXIT ?? 0));
`;
  writeFileSync(join(commands, 'package.json'), '{"type":"module"}');
  for (const command of ['npm', 'node']) {
    const path = join(commands, command);
    writeFileSync(path, fakeCommand);
    chmodSync(path, 0o755);
  }

  return {
    manager, web, workspace,
    cli: join(manager, 'dist', 'cli.js'),
    build() {
      mkdirSync(join(manager, 'dist'), { recursive: true });
      writeFileSync(join(manager, 'dist', 'cli.js'), '');
    },
    run(args: string[], environment: NodeJS.ProcessEnv = {}) {
      return spawnSync('/bin/sh', [script, ...args], {
        cwd: workspace,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${commands}${delimiter}${process.env.PATH ?? ''}`, DEV_SCRIPT_LOG: log, ...environment },
      });
    },
    invocations(): Invocation[] {
      return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as Invocation);
    },
    close() { rmSync(root, { recursive: true, force: true }); },
  };
}

test('dev script installs missing dependencies, builds, links, and reloads the caller workspace', { skip: process.platform === 'win32' }, () => {
  const context = fixture();
  try {
    const options = ['--port', '4311', '--config', 'config with spaces.json'];
    const result = context.run(options);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(context.invocations(), [
      { command: 'npm', args: ['ci'], cwd: context.manager },
      { command: 'npm', args: ['ci'], cwd: context.web },
      { command: 'npm', args: ['run', 'build'], cwd: context.manager },
      { command: 'npm', args: ['link', '--ignore-scripts', '--no-audit', '--no-fund'], cwd: context.manager },
      { command: 'node', args: [context.cli, 'restart', ...options], cwd: context.workspace },
    ]);
  } finally {
    context.close();
  }
});

test('dev script lifecycle commands use the checkout CLI and selected workspace without rebuilding', { skip: process.platform === 'win32' }, () => {
  const context = fixture();
  try {
    context.build();
    const start = context.run(['start', '--workspace', context.manager, '--', '--port', '4311']);
    assert.equal(start.status, 0, start.stderr);
    const status = context.run(['status'], { DEV_SCRIPT_NODE_EXIT: '3' });
    assert.equal(status.status, 3, status.stderr);
    const stop = context.run(['stop']);
    assert.equal(stop.status, 0, stop.stderr);
    const restart = context.run(['restart']);
    assert.equal(restart.status, 0, restart.stderr);
    assert.deepEqual(context.invocations(), [
      { command: 'node', args: [context.cli, 'start', '--daemon', '--port', '4311'], cwd: context.manager },
      { command: 'node', args: [context.cli, 'status'], cwd: context.workspace },
      { command: 'node', args: [context.cli, 'stop'], cwd: context.workspace },
      { command: 'node', args: [context.cli, 'restart'], cwd: context.workspace },
    ]);
  } finally {
    context.close();
  }
});

test('dev script build reuses dependencies and stops before linking or restarting on failure', { skip: process.platform === 'win32' }, () => {
  const context = fixture();
  try {
    for (const directory of [context.manager, context.web]) mkdirSync(join(directory, 'node_modules'));
    const result = context.run(['up'], { DEV_SCRIPT_FAIL: 'npm:run build' });
    assert.equal(result.status, 42, result.stderr);
    assert.deepEqual(context.invocations(), [
      { command: 'npm', args: ['run', 'build'], cwd: context.manager },
    ]);
  } finally {
    context.close();
  }
});

test('dev script rejects missing builds and invalid arguments before running commands', { skip: process.platform === 'win32' }, () => {
  const context = fixture();
  try {
    for (const args of [['start'], ['link']]) {
      const result = context.run(args);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /not built/);
    }
    for (const args of [['--workspace'], ['unknown'], ['stop', '--port', '4311']]) {
      assert.equal(context.run(args).status, 2);
    }
    assert.equal(context.run(['--help']).status, 0);
    assert.deepEqual(context.invocations(), []);
  } finally {
    context.close();
  }
});
