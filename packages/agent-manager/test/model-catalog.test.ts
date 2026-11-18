import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { AgentModelCatalogSnapshot, AgentModelDiscoveryUnavailableReason } from '../src/core/types.ts';
import { createLogger } from '../src/infrastructure/logger.ts';
import {
  AGENT_MODEL_REFRESH_INTERVAL_MS,
  ClaudeCodeModelDiscoverer,
  CodexModelDiscoverer,
  ModelCatalog,
  type AgentModelDiscoverer,
} from '../src/runtime/model-catalog.ts';

const logger = createLogger({ level: 'silent' });

test('Claude refresh explains alias-only catalogs and replaces remote models on every refresh', async () => {
  const scenarios: Array<{ environment: NodeJS.ProcessEnv; reason?: AgentModelDiscoveryUnavailableReason }> = [
    { environment: {}, reason: 'api_key_missing' },
    { environment: { ANTHROPIC_AUTH_TOKEN: 'fixture-token' }, reason: 'api_key_missing' },
    { environment: { ANTHROPIC_BASE_URL: 'https://gateway.example.test', ANTHROPIC_API_KEY: 'fixture-key' }, reason: 'gateway_discovery_disabled' },
    { environment: { ANTHROPIC_API_KEY: 'fixture-key' } },
    { environment: { ANTHROPIC_BASE_URL: 'https://gateway.example.test', ANTHROPIC_AUTH_TOKEN: 'fixture-token', CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1' } },
  ];
  for (const scenario of scenarios) {
    let calls = 0;
    const catalog = new ModelCatalog({ logger, discoverers: [new ClaudeCodeModelDiscoverer({
      environment: scenario.environment,
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ data: [{ id: `claude-model-${calls}` }] }));
      },
    })] });
    try {
      await catalog.getModels();
      await catalog.refresh();
      const provider = (await catalog.getModels()).providers[0];
      assert.ok(provider);
      assert.equal(provider?.discoveryUnavailableReason, scenario.reason);
      assert.equal(provider?.stale, false);
      assert.ok(provider.models.some((model) => model.id === 'sonnet'));
      assert.equal(calls, scenario.reason ? 0 : 2);
      if (!scenario.reason) {
        assert.ok(provider.models.some((model) => model.id === 'claude-model-2'));
        assert.ok(!provider.models.some((model) => model.id === 'claude-model-1'));
      }
    } finally {
      catalog.stop();
    }
  }
});

test('discovery availability changes publish an updated catalog even with identical models and timestamps', async () => {
  let reason: AgentModelDiscoveryUnavailableReason | null = null;
  const updates: AgentModelCatalogSnapshot[] = [];
  const catalog = new ModelCatalog({ logger, now: () => new Date('2026-11-18T00:00:00Z'),
    onUpdated: (snapshot) => updates.push(snapshot), discoverers: [{
      provider: 'claude-code',
      get discoveryUnavailableReason() { return reason; },
      async discover() { return [{ id: 'sonnet', displayName: 'Sonnet', description: null }]; },
    }],
  });
  try {
    await catalog.getModels();
    reason = 'api_key_missing';
    await catalog.refresh();
    assert.equal(updates.length, 2);
    assert.equal(updates.at(-1)?.providers[0]?.discoveryUnavailableReason, 'api_key_missing');
    reason = null;
    await catalog.refresh();
    assert.equal(updates.length, 3);
    assert.equal(Object.hasOwn(updates.at(-1)!.providers[0]!, 'discoveryUnavailableReason'), false);
  } finally {
    catalog.stop();
  }
});

test('concurrent manual refreshes and reads share in-flight discovery', async () => {
  let calls = 0;
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => { complete = resolve; });
  const catalog = new ModelCatalog({ logger, discoverers: [{
    provider: 'codex',
    async discover() {
      calls += 1;
      await pending;
      return [{ id: 'new-model', displayName: 'New model', description: null }];
    },
  }] });
  try {
    const first = catalog.refresh();
    const second = catalog.refresh();
    const read = catalog.getModels();
    assert.equal(calls, 1);
    complete();
    await Promise.all([first, second]);
    assert.equal((await read).providers[0]?.models[0]?.id, 'new-model');
    assert.equal(calls, 1);
  } finally {
    complete();
    catalog.stop();
  }
});

test('Codex discovery refreshes the CLI cache before reading every model/list page', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-codex-models-'));
  const scriptPath = join(directory, 'fake-codex.cjs');
  const cachePath = join(directory, 'models.json');
  writeFileSync(cachePath, JSON.stringify({ id: 'old-model', displayName: 'Old model' }));
  writeFileSync(scriptPath, `
const fs = require('node:fs');
const readline = require('node:readline');
const cachePath = ${JSON.stringify(cachePath)};
if (process.argv[2] === '--refresh') {
  // A slow refresh must finish before app-server captures its picker snapshot.
  setTimeout(() => {
    fs.writeFileSync(cachePath, JSON.stringify({ id: 'gpt-6.2-sol', displayName: 'GPT-6.2 Sol' }));
    process.stdout.write(JSON.stringify({ models: [] }));
  }, 25);
} else {
const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
const lines = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === 1) send({ id: 1, result: { userAgent: 'fake' } });
  if (message.method === 'model/list' && !message.params.cursor) {
    send({ id: message.id, result: { data: [
      { id: 'model-a', model: 'model-a', displayName: 'Model A', description: 'First' },
      { unexpected: true }
    ], nextCursor: 'page-2' } });
  }
  if (message.method === 'model/list' && message.params.cursor === 'page-2') {
    send({ id: message.id, result: { data: [
      { ...cached, model: cached.id, description: '' }
    ], nextCursor: null } });
  }
});
}
`);

  try {
    const discoverer = new CodexModelDiscoverer({
      workspaceRoot: process.cwd(),
      command: process.execPath,
      args: [scriptPath],
      refreshArgs: [scriptPath, '--refresh'],
      timeoutMs: 5_000,
    });
    assert.deepEqual(await discoverer.discover(), [
      { id: 'model-a', displayName: 'Model A', description: 'First' },
      { id: 'gpt-6.2-sol', displayName: 'GPT-6.2 Sol', description: null },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Codex discovery keeps model/list compatibility when the refresh command is unsupported', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-codex-legacy-'));
  const scriptPath = join(directory, 'fake-codex.cjs');
  writeFileSync(scriptPath, `
if (process.argv[2] === '--refresh') {
  process.stderr.write("error: unrecognized subcommand 'models'\\n");
  process.exit(2);
}
const lines = require('node:readline').createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === 1) send({ id: 1, result: {} });
  if (message.method === 'model/list') send({ id: message.id, result: {
    data: [{ model: 'legacy-model', displayName: 'Legacy model' }], nextCursor: null,
  } });
});
`);
  try {
    const discoverer = new CodexModelDiscoverer({ workspaceRoot: directory,
      command: process.execPath, args: [scriptPath], refreshArgs: [scriptPath, '--refresh'] });
    assert.deepEqual(await discoverer.discover(), [{ id: 'legacy-model', displayName: 'Legacy model', description: null }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Codex discovery rejects failed, cancelled, and oversized refreshes without accepting cached models', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-codex-failed-refresh-'));
  const scriptPath = join(directory, 'fake-codex.cjs');
  const listedPath = join(directory, 'listed');
  writeFileSync(scriptPath, `
if (process.argv[2] === '--refresh') {
  process.stderr.write('remote refresh failed: private diagnostic');
  process.exit(1);
}
require('node:fs').writeFileSync(${JSON.stringify(listedPath)}, 'listed');
`);
  try {
    const discoverer = new CodexModelDiscoverer({ workspaceRoot: directory,
      command: process.execPath, args: [scriptPath], refreshArgs: [scriptPath, '--refresh'] });
    await assert.rejects(discoverer.discover(), { message: 'Codex model catalog refresh failed' });
    assert.equal(existsSync(listedPath), false);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(discoverer.discover(controller.signal), { message: 'Codex model discovery was cancelled' });
    assert.equal(existsSync(listedPath), false);
    writeFileSync(scriptPath, `
if (process.argv[2] === '--refresh') process.stdout.write('x'.repeat(8 * 1024 * 1024 + 1));
else require('node:fs').writeFileSync(${JSON.stringify(listedPath)}, 'listed');
`);
    await assert.rejects(discoverer.discover(), { message: 'Codex model catalog refresh output exceeded the size limit' });
    assert.equal(existsSync(listedPath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Codex discovery times out a stalled refresh without starting model/list', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-codex-refresh-timeout-'));
  const scriptPath = join(directory, 'fake-codex.cjs');
  const listedPath = join(directory, 'listed');
  writeFileSync(scriptPath, `
if (process.argv[2] === '--refresh') setInterval(() => {}, 1000);
else require('node:fs').writeFileSync(${JSON.stringify(listedPath)}, 'listed');
`);
  try {
    const discoverer = new CodexModelDiscoverer({ workspaceRoot: directory, timeoutMs: 200,
      command: process.execPath, args: [scriptPath], refreshArgs: [scriptPath, '--refresh'] });
    await assert.rejects(discoverer.discover(), { message: 'Codex model discovery timed out after 200ms' });
    assert.equal(existsSync(listedPath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Claude Code model discovery combines rolling aliases, configured models, and API models', async () => {
  let requestedUrl = '';
  let requestHeaders = new Headers();
  const discoverer = new ClaudeCodeModelDiscoverer({
    environment: {
      ANTHROPIC_API_KEY: 'test-key',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'company-opus',
    },
    fetch: async (input, init) => {
      requestedUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({
        data: [
          { id: 'claude-api-model', display_name: 'Claude API Model' },
          { id: 'unrelated-api-model', display_name: 'Not a Claude model' },
          { id: '' },
        ],
      }), { status: 200 });
    },
  });

  const models = await discoverer.discover();
  assert.equal(requestedUrl, 'https://api.anthropic.com/v1/models?limit=1000');
  assert.equal(requestHeaders.get('x-api-key'), 'test-key');
  assert.ok(models.some((model) => model.id === 'opus'));
  assert.ok(models.some((model) => model.id === 'company-opus'));
  assert.ok(models.some((model) => model.id === 'claude-api-model' && model.displayName === 'Claude API Model'));
  assert.ok(!models.some((model) => model.id === 'unrelated-api-model'));
});

test('Claude gateway discovery prefers bearer auth and forwards custom headers', async () => {
  let requestedUrl = '';
  let requestHeaders = new Headers();
  const discoverer = new ClaudeCodeModelDiscoverer({
    environment: {
      ANTHROPIC_BASE_URL: 'https://gateway.example.test/',
      ANTHROPIC_AUTH_TOKEN: 'gateway-token',
      ANTHROPIC_API_KEY: 'fallback-api-key',
      ANTHROPIC_CUSTOM_HEADERS: 'X-Tenant: tenant-a\nX-Model-Route: production',
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    },
    fetch: async (input, init) => {
      requestedUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({
        data: [{ id: 'claude-gateway-model', display_name: 'Gateway Claude' }],
      }), { status: 200 });
    },
  });

  const models = await discoverer.discover();
  assert.equal(requestedUrl, 'https://gateway.example.test/v1/models?limit=1000');
  assert.equal(requestHeaders.get('authorization'), 'Bearer gateway-token');
  assert.equal(requestHeaders.get('x-api-key'), null);
  assert.equal(requestHeaders.get('x-tenant'), 'tenant-a');
  assert.equal(requestHeaders.get('x-model-route'), 'production');
  assert.ok(models.some((model) => model.id === 'claude-gateway-model'));
});

test('Claude gateway discovery falls back to API-key authentication', async () => {
  let requestHeaders = new Headers();
  const discoverer = new ClaudeCodeModelDiscoverer({
    environment: {
      ANTHROPIC_BASE_URL: 'https://gateway.example.test',
      ANTHROPIC_API_KEY: 'gateway-api-key',
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    },
    fetch: async (_input, init) => {
      requestHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    },
  });

  await discoverer.discover();
  assert.equal(requestHeaders.get('authorization'), null);
  assert.equal(requestHeaders.get('x-api-key'), 'gateway-api-key');
});

test('model catalog refreshes once per day and retains the last successful provider result', async () => {
  let now = new Date('2026-09-12T00:00:00.000Z');
  let calls = 0;
  let fail = false;
  let result = [{ id: 'model-a', displayName: 'Model A', description: null }];
  const discoverer: AgentModelDiscoverer = {
    provider: 'codex',
    fallbackModels: [{ id: 'fallback', displayName: 'Fallback', description: null }],
    async discover() {
      calls += 1;
      if (fail) throw new Error('offline');
      return result;
    },
  };
  const catalog = new ModelCatalog({ discoverers: [discoverer], logger, now: () => now });

  const first = await catalog.getModels();
  assert.equal(first.refreshIntervalSeconds, 86_400);
  assert.deepEqual(first.providers[0]?.models.map((model) => model.id), ['model-a']);
  assert.equal(first.providers[0]?.stale, false);
  assert.equal(calls, 1);

  now = new Date(now.getTime() + AGENT_MODEL_REFRESH_INTERVAL_MS - 1);
  await catalog.getModels();
  assert.equal(calls, 1);

  fail = true;
  await catalog.refresh();
  const stale = await catalog.getModels();
  assert.deepEqual(stale.providers[0]?.models.map((model) => model.id), ['model-a']);
  assert.equal(stale.providers[0]?.stale, true);

  fail = false;
  result = [{ id: 'model-b', displayName: 'Model B', description: null }];
  await catalog.refresh();
  const recovered = await catalog.getModels();
  assert.deepEqual(recovered.providers[0]?.models.map((model) => model.id), ['model-b']);
  assert.equal(recovered.providers[0]?.stale, false);
  catalog.stop();
});
