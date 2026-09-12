import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createLogger } from '../src/logger.ts';
import {
  AGENT_MODEL_REFRESH_INTERVAL_MS,
  ClaudeCodeModelDiscoverer,
  CodexModelDiscoverer,
  ModelCatalog,
  type AgentModelDiscoverer,
} from '../src/model-catalog.ts';

const logger = createLogger({ level: 'silent' });

test('Codex model discovery reads every model/list page from the app server', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-codex-models-'));
  const scriptPath = join(directory, 'fake-codex.cjs');
  writeFileSync(scriptPath, `
const readline = require('node:readline');
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
      { id: 'model-b', model: 'model-b', displayName: 'Model B', description: '' }
    ], nextCursor: null } });
  }
});
`);

  try {
    const discoverer = new CodexModelDiscoverer({
      workspaceRoot: process.cwd(),
      command: process.execPath,
      args: [scriptPath],
      timeoutMs: 5_000,
    });
    assert.deepEqual(await discoverer.discover(), [
      { id: 'model-a', displayName: 'Model A', description: 'First' },
      { id: 'model-b', displayName: 'Model B', description: null },
    ]);
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
