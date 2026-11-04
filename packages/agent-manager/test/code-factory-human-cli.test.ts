import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

import { runHumanCli } from '../src/cli/code-factory-human-cli.ts';
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
    return runHumanCli(args, runtime);
  } };
}

test('lists creation-time ranges and dashboard statuses without RD credentials', async () => {
  const rows = [
    { id: 'new', title: '新的需求', createdAt: '2026-10-31T00:00:00Z', status: 'doing' },
    { id: 'boundary', title: 'Seven days', createdAt: '2026-10-25T00:00:00Z', status: 'todo' },
    { id: 'month', title: 'Month', createdAt: '2026-10-02T00:00:00Z', status: 'waiting_confirmation' },
    { id: 'quarter', title: 'Quarter', createdAt: '2026-08-03T00:00:00Z', status: 'done' },
    { id: 'old', title: 'Old', createdAt: '2020-01-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', status: 'done' },
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
  assert.equal(lastUrl, 'http://127.0.0.1:4310/api/requirements');
  assert.equal(await h.run(['requirement', 'list', '--range', 'all', '--status', 'todo,waiting_confirmation', '--json']), 0);
  assert.deepEqual(JSON.parse(h.output.join('')).items.map((r: { id: string }) => r.id), ['boundary', 'month']);
  assert.equal(lastUrl, 'http://127.0.0.1:4310/api/requirements');
  assert.equal(await h.run(['requirement', 'list']), 0);
  assert.match(h.output.join(''), /新的需求/);
  assert.doesNotMatch(h.output.join(''), /Old/);
});

test('search encodes queries, preserves ranked result metadata, and supports readable and empty results', async () => {
  const base = { requirementId: 'req_source', score: 0.9, fullTextScore: 1, vectorScore: 0.8, updatedAt: '2026-11-01' };
  const rows = [
    { ...base, kind: 'message', sourceId: 'msg_hit', title: 'Conversation', excerpt: '中文部署说明' },
    { ...base, kind: 'requirement', sourceId: 'req_source', title: 'Requirement', excerpt: 'Body match' },
    { ...base, kind: 'pull_request', sourceId: 'pr_hit', title: 'Pull request', excerpt: 'PR match' },
  ];
  let requested: URL | undefined;
  const h = harness(async (input, init) => {
    requested = new URL(String(input));
    assert.equal(init?.method, 'GET');
    assert.equal(requested.pathname, '/api/search');
    return Response.json({ items: rows });
  });
  const query = '中文部署 & "a/b"? 100%';
  assert.equal(await h.run(['search', '--query', query, '--limit', '3', '--json']), 0, h.errors.join(''));
  assert.equal(requested?.searchParams.get('q'), query);
  assert.equal(requested?.searchParams.get('limit'), '3');
  assert.deepEqual(JSON.parse(h.output.join('')), { items: rows });
  assert.equal(await h.run(['search', '-q', 'REQ-CCDB1125']), 0);
  assert.equal(requested?.searchParams.get('q'), 'REQ-CCDB1125');
  assert.equal(requested?.searchParams.get('limit'), '50');
  assert.match(h.output.join(''), /message\treq_source\tmsg_hit\tConversation\t中文部署说明/);
  assert.match(h.output.join(''), /pull_request\treq_source\tpr_hit/);
  const prUrl = 'https://github.com/luohaha/code-factory/pull/180';
  assert.equal(await h.run(['search', '-q', prUrl, '--limit', '200', '--json']), 0);
  assert.equal(requested?.searchParams.get('q'), prUrl);
  assert.equal(requested?.searchParams.get('limit'), '200');
  h.runtime.fetch = async () => Response.json({ items: [] });
  assert.equal(await h.run(['search', '-q', 'missing', '--limit', '1', '--json']), 0);
  assert.deepEqual(JSON.parse(h.output.join('')), { items: [] });
});

test('shows full conversation and direct visible relationships', async () => {
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
      { id: 'child', parentRequirementId: 'source', title: 'Child', status: 'todo' },
      { id: 'unrelated', parentRequirementId: 'other' },
    ] });
    return Response.json(path.endsWith('/parent') ? { id: 'parent', title: 'Parent' }
      : { id: 'source', title: 'Title', description: 'Full body\nsecond line', parentRequirementId: 'parent' });
  });
  assert.equal(await h.run(['requirement', 'show', '--id', 'source', '--json']), 0);
  const shown = JSON.parse(h.output.join(''));
  assert.equal(Object.hasOwn(shown, 'hasMore'), false);
  assert.equal(shown.requirement.description, 'Full body\nsecond line');
  assert.deepEqual(shown.messages.map((m: { sequence: number }) => m.sequence), [1, 201]);
  assert.equal(await h.run(['requirement', 'show', '--id', 'source']), 0);
  assert.match(h.output.join(''), /human.*\nFirst instruction\nAttachment: att_1 a.png/);
  assert.equal(await h.run(['requirement', 'related', '--id', 'source', '--json']), 0);
  const related = JSON.parse(h.output.join(''));
  assert.equal(related.parent.id, 'parent');
  assert.deepEqual(related.children.map((r: { id: string }) => r.id), ['child']);
});

test('conversation pages expose metadata and usable cursors in both output formats', async () => {
  let requested: URL | undefined;
  let hasMore: unknown = true;
  let messages = [3, 2].map((sequence) => ({ sequence, author: 'human', body: `Message ${sequence}`, createdAt: '2026-11-02' }));
  const h = harness(async (input) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith('/messages')) return Response.json({ id: 'source', title: 'Title', description: 'Body', status: 'todo' });
    requested = url;
    return Response.json({ items: messages, ...(hasMore === undefined ? {} : { hasMore }) });
  });
  assert.equal(await h.run(['requirement', 'show', '--id', 'source', '--limit', '2', '--json']), 0);
  assert.equal(requested?.searchParams.get('limit'), '2');
  const shown = JSON.parse(h.output.join(''));
  assert.deepEqual(shown.messages.map((message: { sequence: number }) => message.sequence), [2, 3]);
  assert.equal(shown.hasMore, true);
  assert.equal(await h.run(['requirement', 'show', '--id', 'source', '--before', '4', '--json']), 0);
  assert.equal(requested?.searchParams.get('limit'), '100');
  assert.equal(requested?.searchParams.get('before'), '4');
  assert.equal(await h.run(['requirement', 'show', '--id', 'source', '--after', '0']), 0);
  assert.equal(requested?.searchParams.get('after'), '0');
  assert.equal(requested?.searchParams.get('limit'), '100');
  assert.match(h.output.join(''), /hasMore: true\nNext page: --after 3/);
  assert.equal(await h.run(['requirement', 'show', '--id', 'source', '--limit', '200']), 0);
  assert.match(h.output.join(''), /hasMore: true\nNext page: --before 2/);
  hasMore = false;
  messages = [];
  assert.equal(await h.run(['requirement', 'show', '--id', 'source', '--limit', '1', '--json']), 0);
  const empty = JSON.parse(h.output.join(''));
  assert.deepEqual(empty.messages, []);
  assert.equal(empty.hasMore, false);
  for (const invalid of [undefined, 'false']) {
    hasMore = invalid;
    assert.equal(await h.run(['requirement', 'show', '--id', 'source', '--limit', '1']), 1);
    assert.equal(h.output.join(''), '');
    assert.match(h.errors.join(''), /invalid conversation page/);
  }
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
    ['requirement', 'list', '--status', 'cancelled'],
    ['search'], ['search', '--query', '   '], ['search', '-q', 'a'.repeat(501)],
    ['search', '-q', 'a', '--limit', '0'], ['search', '-q', 'a', '--limit', '201'],
    ['search', '-q', 'a', '--limit', '1.5'], ['search', '-q', 'a', '--limit', 'invalid'],
    ['requirement', 'show'], ['requirement', 'start', '--unknown'],
    ['requirement', 'show', '--id', 'req_a', '--limit', '0'],
    ['requirement', 'show', '--id', 'req_a', '--limit', '201'],
    ['requirement', 'show', '--id', 'req_a', '--limit', '1.5'],
    ['requirement', 'show', '--id', 'req_a', '--limit', 'invalid'],
    ['requirement', 'show', '--id', 'req_a', '--before', '0'],
    ['requirement', 'show', '--id', 'req_a', '--before', '-1'],
    ['requirement', 'show', '--id', 'req_a', '--before', '9007199254740992'],
    ['requirement', 'show', '--id', 'req_a', '--before', '1.5'],
    ['requirement', 'show', '--id', 'req_a', '--after', '-1'],
    ['requirement', 'show', '--id', 'req_a', '--after', '9007199254740992'],
    ['requirement', 'show', '--id', 'req_a', '--after', 'invalid'],
    ['requirement', 'show', '--id', 'req_a', '--before', '5', '--after', '0'],
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
  assert.equal(await h.run(['search', '--help']), 0);
  assert.equal(calls, 0);
  const root = mkdtempSync(join(tmpdir(), 'human-cli-text-'));
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
    let timedOut = false;
    h.runtime.fetch = async (_input, init) => {
      calls += 1;
      if (response === 'network') throw new Error('secret raw transport details');
      if (response === 'timeout') return new Promise((_resolve, reject) => {
        // A real fetch keeps a socket alive. The fake needs a referenced handle
        // while AbortSignal.timeout's unreferenced timer waits to fire.
        const guard = setTimeout(() => reject(new Error('Request did not abort')), 1_000);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(guard);
          timedOut = true;
          reject(init.signal?.reason);
        }, { once: true });
      });
      if (response === 'invalid-json') return new Response('<html>proxy error</html>');
      return Response.json({ error: 'State conflict' }, { status: response });
    };
    const code = await runHumanCli(['requirement', 'start', '--id', 'req_a'], { ...h.runtime, requestTimeoutMs: 5 });
    assert.equal(code, 1);
    assert.equal(calls, 1);
    if (response === 'timeout') assert.equal(timedOut, true);
    assert.doesNotMatch(h.errors.join(''), /secret raw/);
  }
});

test('HTTP conversation paging traverses complete history in either direction without gaps or duplicates', async () => {
  const store = new SqliteAgentManagerStore(':memory:');
  const manager = new AgentManager({ workspaceRoot: process.cwd(), store, logger: createLogger({ level: 'silent' }) });
  const requirement = manager.createRequirement({ title: 'Paged history', description: 'Read a long conversation', provider: 'codex' });
  const history = Array.from({ length: 205 }, (_, index) => store.appendMessage({
    id: `msg_page_${index}`, requirementId: requirement.id, sessionId: requirement.session.id,
    author: 'human', body: `Message ${index + 1}`, deliverToRd: false, now: '2026-11-02T00:00:00.000Z',
  }));
  const server = createAgentManagerServer(manager);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const h = harness(fetch);
  const show = async (flags: string[]) => {
    assert.equal(await h.run(['requirement', 'show', '--id', requirement.id, ...flags, '--api-url', api, '--json']), 0, h.errors.join(''));
    return JSON.parse(h.output.join('')) as { messages: Array<{ id: string; sequence: number }>; hasMore?: boolean };
  };
  try {
    const complete = await show([]);
    assert.deepEqual(complete.messages.map((message) => message.id), history.map((message) => message.id));
    assert.equal(Object.hasOwn(complete, 'hasMore'), false);
    const latest = await show(['--limit', '200']);
    assert.equal(latest.messages.length, 200);
    assert.equal(latest.messages[0]?.sequence, 6);
    assert.equal(latest.hasMore, true);
    const first = await show(['--after', '0']);
    assert.equal(first.messages.length, 100);
    assert.equal(first.messages[0]?.sequence, 1);
    assert.equal(first.hasMore, true);
    const older = await show(['--before', '205']);
    assert.equal(older.messages.length, 100);
    assert.equal(older.messages.at(-1)?.sequence, 204);
    assert.equal(older.hasMore, true);
    const empty = await show(['--after', '205', '--limit', '2']);
    assert.deepEqual(empty.messages, []);
    assert.equal(empty.hasMore, false);
    for (const direction of ['before', 'after'] as const) {
      let cursor: number | undefined = direction === 'after' ? 0 : undefined;
      let hasMore = true;
      const gathered: string[] = [];
      for (let round = 0; hasMore && round < 10; round++) {
        const page = await show(['--limit', '64', ...(cursor === undefined ? [] : [`--${direction}`, String(cursor)])]);
        assert.equal(typeof page.hasMore, 'boolean');
        assert.ok(page.messages.length > 0);
        const ids = page.messages.map((message) => message.id);
        if (direction === 'before') gathered.unshift(...ids);
        else gathered.push(...ids);
        hasMore = page.hasMore === true;
        cursor = direction === 'before' ? page.messages[0]!.sequence : page.messages.at(-1)!.sequence;
      }
      assert.equal(hasMore, false);
      assert.deepEqual(gathered, history.map((message) => message.id));
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
  }
});

test('real HTTP operations persist human identity, enforce lifecycle guards, and hide cancelled requirements', async () => {
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
    assert.equal(await cli(['search', '--query', requirement.id]), 0, h.errors.join(''));
    assert.ok(JSON.parse(h.output.join('')).items.some((hit: { kind: string; requirementId: string }) => hit.kind === 'requirement' && hit.requirementId === requirement.id));
    assert.equal(await cli(['search', '-q', 'Human instruction']), 0, h.errors.join(''));
    assert.ok(JSON.parse(h.output.join('')).items.some((hit: { kind: string; requirementId: string }) => hit.kind === 'message' && hit.requirementId === requirement.id));
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
    assert.equal(await cli(['requirement', 'list', '--range', 'all']), 0);
    assert.deepEqual(JSON.parse(h.output.join('')).items.map((r: { id: string }) => r.id), [requirement.id]);
    assert.equal(manager.listRequirements().length, 1);
    assert.equal(await cli(['search', '-q', todo.id]), 0, h.errors.join(''));
    assert.ok(JSON.parse(h.output.join('')).items.every((hit: { requirementId: string }) => hit.requirementId !== todo.id));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
  }
});

test('npm CLI runs independently of the instruction-only skill through an executable symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'human-skill-package-'));
  try {
    const packageRoot = join(root, 'packages', 'agent-manager');
    mkdirSync(join(packageRoot, 'scripts'), { recursive: true });
    cpSync(new URL('../../../skills/code-factory-human-cli', import.meta.url), join(root, 'skills', 'code-factory-human-cli'), { recursive: true });
    for (const script of ['sync-human-skill.mjs', 'prepare-cli.mjs']) {
      cpSync(new URL(`../scripts/${script}`, import.meta.url), join(packageRoot, 'scripts', script));
    }
    const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { bin: Record<string, string> };
    const entrypoint = metadata.bin['code-factory-human-cli']!;
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ type: 'module', bin: { 'code-factory-human-cli': entrypoint } }));
    mkdirSync(join(packageRoot, 'dist', 'cli'), { recursive: true });
    for (const [source, target] of [
      ['cli/code-factory-human-cli.ts', 'dist/cli/code-factory-human-cli.js'],
      ['code-factory-human-cli-main.ts', entrypoint],
    ]) {
      const compiled = ts.transpileModule(readFileSync(new URL(`../src/${source}`, import.meta.url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      });
      writeFileSync(join(packageRoot, target!), compiled.outputText);
    }
    for (const script of ['sync-human-skill.mjs', 'prepare-cli.mjs']) {
      const prepared = spawnSync(process.execPath, [join(packageRoot, 'scripts', script)], { cwd: tmpdir(), encoding: 'utf8' });
      assert.equal(prepared.status, 0, prepared.stderr);
    }
    // Remove source to ensure distribution does not depend on the repository.
    rmSync(join(root, 'skills'), { recursive: true });
    const skill = join(packageRoot, 'dist', 'skills', 'code-factory-human-cli');
    assert.deepEqual(readdirSync(skill), ['SKILL.md']);
    rmSync(skill, { recursive: true });
    const link = join(root, 'code-factory-human-cli');
    symlinkSync(join(packageRoot, entrypoint), link);
    const result = spawnSync(process.platform === 'win32' ? process.execPath : link,
      process.platform === 'win32' ? [link, '--help'] : ['--help'], { cwd: tmpdir(), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /requirement list/);
    assert.match(result.stdout, /search --query/);
    assert.match(result.stdout, /timer cancel/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
