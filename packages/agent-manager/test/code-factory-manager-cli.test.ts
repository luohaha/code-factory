import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runManagerCli } from '../../../skills/code-factory-manager-cli/scripts/code-factory-manager-cli.mjs';
import { AgentManager } from '../src/core/agent-manager.ts';
import { createAgentManagerServer } from '../src/http/server.ts';
import { createLogger } from '../src/infrastructure/logger.ts';
import { SqliteAgentManagerStore } from '../src/storage/sqlite-store.ts';

function harness(fetcher: typeof fetch = async () => { throw new Error('Unexpected request'); }) {
  const output: string[] = [];
  const errors: string[] = [];
  const runtime = {
    environment: {}, fetch: fetcher, now: () => Date.parse('2026-11-01T00:00:00Z'),
    writeOut: (value: string) => output.push(value), writeError: (value: string) => errors.push(value),
  };
  return { output, errors, runtime, async run(args: string[]) {
    output.length = 0;
    errors.length = 0;
    return runManagerCli(args, runtime);
  } };
}

test('lists creation-time ranges and every status without RD credentials', async () => {
  const rows = [
    { id: 'new', title: '新的需求', createdAt: '2026-10-31T00:00:00Z', status: 'doing' },
    { id: 'boundary', title: 'Seven days', createdAt: '2026-10-25T00:00:00Z', status: 'todo' },
    { id: 'month', title: 'Month', createdAt: '2026-10-02T00:00:00Z', status: 'waiting_confirmation' },
    { id: 'quarter', title: 'Quarter', createdAt: '2026-08-03T00:00:00Z', status: 'done' },
    { id: 'old', title: 'Old', createdAt: '2020-01-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', status: 'cancelled' },
  ];
  let lastUrl = '';
  const h = harness(async (input) => {
    lastUrl = String(input);
    return Response.json({ items: [...rows].reverse() });
  });
  for (const [range, ids] of [
    ['7d', ['new', 'boundary']], ['30d', ['new', 'boundary', 'month']],
    ['90d', ['new', 'boundary', 'month', 'quarter']], ['all', rows.map((row) => row.id)],
  ] as const) {
    assert.equal(await h.run(['requirement', 'list', '--range', range, '--json']), 0, h.errors.join(''));
    assert.deepEqual(JSON.parse(h.output.join('')).items.map((r: { id: string }) => r.id), ids);
  }
  assert.equal(lastUrl, 'http://127.0.0.1:4310/api/requirements?includeCancelled=true');
  assert.equal(await h.run(['requirement', 'list', '--range', 'all', '--status', 'todo,waiting_confirmation', '--json']), 0);
  assert.deepEqual(JSON.parse(h.output.join('')).items.map((r: { id: string }) => r.id), ['boundary', 'month']);
  assert.equal(lastUrl, 'http://127.0.0.1:4310/api/requirements');
  assert.equal(await h.run(['requirement', 'list']), 0);
  assert.match(h.output.join(''), /新的需求/);
  assert.doesNotMatch(h.output.join(''), /Old/);
});

test('shows full conversation and direct relationships including cancelled children', async () => {
  const h = harness(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/messages')) {
      assert.equal(new URL(String(input)).search, '', 'read the complete unpaged history');
      return Response.json({ items: [
      { sequence: 201, author: 'rd_agent', body: 'Last reply', createdAt: '2026-11-01' },
      { sequence: 1, author: 'human', body: 'First instruction', createdAt: '2026-10-01', attachments: [{ id: 'att_1', fileName: 'a.png' }] },
      ] });
    }
    if (path === '/api/requirements') return Response.json({ items: [
      { id: 'child', parentRequirementId: 'source', title: 'Child', status: 'cancelled' },
      { id: 'unrelated', parentRequirementId: 'other' },
    ] });
    return Response.json(path.endsWith('/parent') ? { id: 'parent', title: 'Parent' }
      : { id: 'source', title: 'Title', description: 'Full body\nsecond line', parentRequirementId: 'parent' });
  });
  assert.equal(await h.run(['requirement', 'show', '--id', 'source', '--json']), 0);
  const shown = JSON.parse(h.output.join(''));
  assert.equal(shown.requirement.description, 'Full body\nsecond line');
  assert.deepEqual(shown.messages.map((m: { sequence: number }) => m.sequence), [1, 201]);
  assert.equal(await h.run(['requirement', 'show', '--id', 'source']), 0);
  assert.match(h.output.join(''), /human.*\nFirst instruction\nAttachment: att_1 a.png/);
  assert.equal(await h.run(['requirement', 'related', '--id', 'source', '--json']), 0);
  const related = JSON.parse(h.output.join(''));
  assert.equal(related.parent.id, 'parent');
  assert.deepEqual(related.children.map((r: { id: string }) => r.id), ['child']);
});

test('human mutations and PR/timer queries use the expected API routes and payloads', async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const h = harness(async (input, init) => {
    assert.ok(init?.signal);
    assert.equal(init?.redirect, 'error');
    calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json({ items: [], accepted: true });
  });
  const cases: Array<[string[], string, string, unknown]> = [
    [['requirement', 'reply', '--id', 'req/a', '--message', '你好\nnext'], '/requirements/req%2Fa/reply', 'POST', { message: '你好\nnext' }],
    [['requirement', 'start', '--id', 'req_a'], '/requirements/req_a/start', 'POST', {}],
    [['requirement', 'confirm', '--id', 'req_a'], '/requirements/req_a/confirm', 'POST', {}],
    [['requirement', 'delete', '--id', 'req_a'], '/requirements/req_a', 'DELETE', null],
    [['pr', 'list', '--requirement-id', 'req_a'], '/pull-requests?requirementId=req_a', 'GET', null],
    [['pr', 'review', '--id', 'pr_a', '--provider', 'native-agent', '--model', 'profile:one', '--reasoning-effort', 'high', '--prompt', 'Focus'], '/pull-requests/pr_a/review-requests', 'POST', { provider: 'native-agent', model: 'profile:one', reasoningEffort: 'high', prompt: 'Focus' }],
    [['pr', 'reviews', '--id', 'pr_a'], '/review-requests?pullRequestId=pr_a', 'GET', null],
    [['timer', 'register', '--requirement-id', 'req_a', '--after-seconds', '60', '--description', 'Check'], '/requirements/req_a/timers', 'POST', { description: 'Check', intervalSeconds: 60, schedule: 'once' }],
    [['timer', 'register', '--requirement-id', 'req_a', '--after-seconds', '31536000', '--description', 'Check', '--repeat'], '/requirements/req_a/timers', 'POST', { description: 'Check', intervalSeconds: 31536000, schedule: 'recurring' }],
    [['timer', 'show', '--requirement-id', 'req_a'], '/requirements/req_a/timers', 'GET', null],
    [['timer', 'cancel', '--requirement-id', 'req_a', '--id', 'tmr_a'], '/requirements/req_a/timers/tmr_a', 'DELETE', null],
  ];
  for (const [args, path, method, body] of cases) {
    assert.equal(await h.run([...args, '--api-url', 'https://manager.example/proxy/api/', '--json']), 0, h.errors.join(''));
    assert.deepEqual(calls.at(-1), { url: `https://manager.example/proxy/api${path}`, method, body });
  }
  h.runtime.environment = { CODE_FACTORY_API_URL: 'http://manager.test/api/' };
  assert.equal(await h.run(['pr', 'list', '--json']), 0);
  assert.equal(calls.at(-1)?.url, 'http://manager.test/api/pull-requests');
});

test('validates arguments before requests, supports text files, and never retries failures', async () => {
  let calls = 0;
  const h = harness(async () => { calls += 1; return Response.json({ accepted: true }); });
  for (const args of [
    ['unknown'], ['requirement', 'list', '--range', '1d'], ['requirement', 'list', '--status', 'all,todo'],
    ['requirement', 'show'], ['requirement', 'start', '--unknown'],
    ['requirement', 'reply', '--id', 'req_a', '--message', ''],
    ['requirement', 'reply', '--id', 'req_a', '--message', 'a', '--message-file', 'a.txt'],
    ['pr', 'review', '--id', 'pr_a', '--provider', 'invalid'],
    ['pr', 'review', '--id', 'pr_a', '--provider', 'codex', '--reasoning-effort', 'invalid'],
    ['timer', 'register', '--requirement-id', 'req_a', '--after-seconds', '59', '--description', 'a'],
    ['timer', 'register', '--requirement-id', 'req_a', '--after-seconds', '60.5', '--description', 'a'],
    ['timer', 'register', '--requirement-id', 'req_a', '--after-seconds', '31536001', '--description', 'a'],
    ['timer', 'register', '--requirement-id', 'req_a', '--after-seconds', '60', '--description', 'a'.repeat(501)],
    ['timer', 'cancel', '--id', 'tmr_a'],
    ['pr', 'list', '--api-url', 'https://user:secret@host'], ['pr', 'list', '--api-url', 'file:///tmp/x'],
  ]) assert.equal(await h.run(args), 2, args.join(' '));
  assert.equal(calls, 0);
  assert.equal(await h.run(['requirement', 'show', '--help']), 0);
  const root = mkdtempSync(join(tmpdir(), 'manager-cli-text-'));
  try {
    const file = join(root, 'message.txt');
    writeFileSync(file, 'line 1\n中文 `literal` $(literal)\n');
    h.runtime.fetch = async (_input, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), { message: readFileSync(file, 'utf8') });
      return Response.json({ accepted: true });
    };
    assert.equal(await h.run(['requirement', 'reply', '--id', 'req_a', '--message-file', file]), 0);
    assert.equal(await h.run(['requirement', 'reply', '--id', 'req_a', '--message-file', join(root, 'missing')]), 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
  for (const response of [404, 409, 500, 'network', 'timeout', 'invalid-json']) {
    calls = 0;
    h.runtime.fetch = async (_input, init) => {
      calls += 1;
      if (response === 'network') throw new Error('secret raw transport details');
      if (response === 'timeout') return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
      if (response === 'invalid-json') return new Response('<html>proxy error</html>');
      return Response.json({ error: 'State conflict' }, { status: response });
    };
    const code = await runManagerCli(['requirement', 'start', '--id', 'req_a'], { ...h.runtime, requestTimeoutMs: 5 });
    assert.equal(code, 1);
    assert.equal(calls, 1);
    assert.doesNotMatch(h.errors.join(''), /secret raw/);
  }
});

test('real HTTP operations persist human identity, enforce lifecycle guards, and retain cancelled lists', async () => {
  const store = new SqliteAgentManagerStore(':memory:');
  const manager = new AgentManager({ workspaceRoot: process.cwd(), store, logger: createLogger({ level: 'silent' }),
    runner: { run: async () => ({ status: 'succeeded', exitCode: 0, nativeSessionId: 'native-test', finalMessage: 'Finished', error: null }) } });
  const server = createAgentManagerServer(manager);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const h = harness(fetch);
  const cli = (args: string[]) => h.run([...args, '--api-url', api, '--json']);
  try {
    const requirement = manager.createRequirement({ title: 'Human work', description: 'Body', provider: 'codex' });
    assert.equal(await cli(['requirement', 'reply', '--id', requirement.id, '--message', 'Human instruction']), 0, h.errors.join(''));
    assert.ok(manager.listMessages(requirement.id).some((m) => m.author === 'human' && m.body === 'Human instruction'));
    for (let attempt = 0; manager.getRequirement(requirement.id)?.status === 'doing' && attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(manager.getRequirement(requirement.id)?.status, 'waiting_confirmation');
    assert.equal(await cli(['requirement', 'confirm', '--id', requirement.id]), 0, h.errors.join(''));
    assert.equal(manager.getRequirement(requirement.id)?.status, 'done');
    assert.equal(await cli(['requirement', 'delete', '--id', requirement.id]), 1);
    const todo = manager.createRequirement({ title: 'Discard', description: 'Unused', provider: 'codex' });
    assert.equal(await cli(['requirement', 'confirm', '--id', todo.id]), 1);
    assert.equal(await cli(['timer', 'register', '--requirement-id', todo.id, '--after-seconds', '60', '--description', 'Check']), 0);
    const timer = JSON.parse(h.output.join(''));
    assert.equal(await cli(['timer', 'cancel', '--requirement-id', todo.id, '--id', timer.id]), 0);
    assert.equal(manager.listAgentTimers(todo.id)[0]?.status, 'cancelled');
    assert.equal(await cli(['requirement', 'delete', '--id', todo.id]), 0, h.errors.join(''));
    assert.deepEqual(JSON.parse(h.output.join('')), { ok: true });
    const defaults = await fetch(`${api}/api/requirements`);
    assert.equal((await defaults.json() as { items: unknown[] }).items.length, 1);
    assert.equal(await cli(['requirement', 'list', '--range', 'all', '--status', 'cancelled']), 0);
    assert.equal(JSON.parse(h.output.join('')).items[0].id, todo.id);
    assert.equal(manager.listRequirements({ includeCancelled: true }).length, 2);
    const invalid = await fetch(`${api}/api/requirements?includeCancelled=1`);
    assert.equal(invalid.status, 400);
    const explicitFalse = await fetch(`${api}/api/requirements?includeCancelled=false`);
    assert.equal((await explicitFalse.json() as { items: unknown[] }).items.length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
  }
});

test('npm skill copy is self-contained and its CLI works through an executable symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'manager-skill-package-'));
  try {
    const packageRoot = join(root, 'packages', 'agent-manager');
    mkdirSync(join(packageRoot, 'scripts'), { recursive: true });
    cpSync(new URL('../../../skills/code-factory-manager-cli', import.meta.url), join(root, 'skills', 'code-factory-manager-cli'), { recursive: true });
    for (const script of ['sync-manager-skill.mjs', 'prepare-cli.mjs']) {
      cpSync(new URL(`../scripts/${script}`, import.meta.url), join(packageRoot, 'scripts', script));
    }
    const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { bin: Record<string, string> };
    const entrypoint = metadata.bin['code-factory-manager-cli']!;
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ bin: { 'code-factory-manager-cli': entrypoint } }));
    for (const script of ['sync-manager-skill.mjs', 'prepare-cli.mjs']) {
      const prepared = spawnSync(process.execPath, [join(packageRoot, 'scripts', script)], { cwd: tmpdir(), encoding: 'utf8' });
      assert.equal(prepared.status, 0, prepared.stderr);
    }
    // Remove source to ensure distribution does not depend on the repository.
    rmSync(join(root, 'skills'), { recursive: true });
    const skill = join(packageRoot, 'dist', 'skills', 'code-factory-manager-cli');
    assert.ok(readFileSync(join(skill, 'SKILL.md'), 'utf8').includes('name: code-factory-manager-cli'));
    const link = join(root, 'code-factory-manager-cli');
    symlinkSync(join(packageRoot, entrypoint), link);
    const result = spawnSync(process.platform === 'win32' ? process.execPath : link,
      process.platform === 'win32' ? [link, '--help'] : ['--help'], { cwd: tmpdir(), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /requirement list/);
    assert.match(result.stdout, /timer cancel/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
