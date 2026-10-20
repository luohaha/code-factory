import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { E2BCredentialStore } from '../src/e2b-credentials.js';
import { applyEnvironmentVariablePatch, environmentVariablePatch } from '../src/sandbox-environment.js';

test('environment patches preserve exact values, retain omitted keys, remove null keys, and bound the combined configuration', () => {
  assert.deepEqual(applyEnvironmentVariablePatch({ KEEP: 'keep', REMOVE: 'remove', TOKEN: 'old' },
    { REMOVE: null, TOKEN: '  quoted "value"\n', EMPTY: '' }), { KEEP: 'keep', TOKEN: '  quoted "value"\n', EMPTY: '' });
  for (const value of [null, [], 'secret', { 'BAD=secret': 'value' }, { VALID: 42 }, { VALID: 'secret\0' }]) {
    assert.throws(() => environmentVariablePatch(value), (error: Error) => !error.message.includes('secret'));
  }
  assert.throws(() => applyEnvironmentVariablePatch({}, { LARGE: 'é'.repeat(33_000) }), /64 KiB/);
  const maximum = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`VAR_${index}`, 'value']));
  assert.throws(() => applyEnvironmentVariablePatch(maximum, { EXTRA: '' }), /100 entries/);
  assert.equal(Object.keys(applyEnvironmentVariablePatch(maximum, { VAR_0: null, EXTRA: '' })).length, 100);
  const special = applyEnvironmentVariablePatch({}, environmentVariablePatch(JSON.parse('{"__proto__":"data"}')));
  assert.equal(Object.getPrototypeOf(special), Object.prototype);
  assert.equal(Object.hasOwn(special, '__proto__'), true);
});

test('credential storage migrates existing API keys and keeps environment values in the owner-only sidecar', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-e2b-env-migration-'));
  const path = join(directory, 'credentials.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec('CREATE TABLE e2b_credentials (reference TEXT PRIMARY KEY, api_key TEXT NOT NULL) STRICT');
  legacy.prepare('INSERT INTO e2b_credentials VALUES (?, ?)').run('legacy', 'old-key');
  legacy.close();
  const store = new E2BCredentialStore(path);
  try {
    assert.equal(store.read('legacy'), 'old-key');
    assert.deepEqual(store.readEnvironment('legacy'), {});
    store.save('new', 'new-key', { GH_TOKEN: 'saved-token', CUSTOM: 'exact value' });
    assert.deepEqual(store.readEnvironment('new'), { GH_TOKEN: 'saved-token', CUSTOM: 'exact value' });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    store.delete('new');
    assert.equal(store.read('new'), null);
    assert.deepEqual(store.readEnvironment('new'), {});
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
