import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_AGENT_MANAGER_CONFIGURATION,
  MAX_PULL_REQUEST_RECONCILE_INTERVAL_SECONDS,
  MAX_REQUIREMENT_RETENTION_DAYS,
  loadAgentManagerConfiguration,
  validateAgentManagerConfigurationPatch,
  writeAgentManagerConfiguration,
} from '../src/configuration.ts';

test('configuration file is created with workspace defaults and restrictive permissions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-config-'));
  const path = join(directory, 'nested', 'config.json');
  try {
    assert.deepEqual(loadAgentManagerConfiguration(path), DEFAULT_AGENT_MANAGER_CONFIGURATION);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), DEFAULT_AGENT_MANAGER_CONFIGURATION);
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('configuration file fills omitted defaults and rejects unknown or invalid fields', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-config-'));
  const path = join(directory, 'config.json');
  try {
    writeFileSync(path, JSON.stringify({ port: 8080, logLevel: 'debug', allowedOrigin: null }));
    assert.deepEqual(loadAgentManagerConfiguration(path), {
      ...DEFAULT_AGENT_MANAGER_CONFIGURATION,
      port: 8080,
      logLevel: 'debug',
      allowedOrigin: null,
    });
    assert.throws(() => validateAgentManagerConfigurationPatch({ port: 0 }), /port/);
    assert.throws(() => validateAgentManagerConfigurationPatch({
      pullRequestReconcileIntervalSeconds: -1,
    }), /pullRequestReconcileIntervalSeconds/);
    assert.deepEqual(validateAgentManagerConfigurationPatch({
      pullRequestReconcileIntervalSeconds: MAX_PULL_REQUEST_RECONCILE_INTERVAL_SECONDS,
    }), { pullRequestReconcileIntervalSeconds: MAX_PULL_REQUEST_RECONCILE_INTERVAL_SECONDS });
    assert.throws(() => validateAgentManagerConfigurationPatch({
      pullRequestReconcileIntervalSeconds: MAX_PULL_REQUEST_RECONCILE_INTERVAL_SECONDS + 1,
    }), /pullRequestReconcileIntervalSeconds/);
    assert.deepEqual(validateAgentManagerConfigurationPatch({
      cancelledRequirementRetentionDays: 0,
      doneRequirementRetentionDays: MAX_REQUIREMENT_RETENTION_DAYS,
    }), {
      cancelledRequirementRetentionDays: 0,
      doneRequirementRetentionDays: MAX_REQUIREMENT_RETENTION_DAYS,
    });
    assert.throws(() => validateAgentManagerConfigurationPatch({
      cancelledRequirementRetentionDays: -1,
    }), /cancelledRequirementRetentionDays/);
    assert.throws(() => validateAgentManagerConfigurationPatch({
      doneRequirementRetentionDays: MAX_REQUIREMENT_RETENTION_DAYS + 1,
    }), /doneRequirementRetentionDays/);
    assert.throws(() => validateAgentManagerConfigurationPatch({ logMaxSize: 'large' }), /logMaxSize/);
    assert.throws(() => validateAgentManagerConfigurationPatch({ logMaxFiles: 1.5 }), /logMaxFiles/);
    assert.throws(() => validateAgentManagerConfigurationPatch({ unexpected: true }), /Unknown configuration field/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('configuration writes replace the complete validated document', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-config-'));
  const path = join(directory, 'config.json');
  try {
    const configuration = {
      ...DEFAULT_AGENT_MANAGER_CONFIGURATION,
      pullRequestReconcileIntervalSeconds: 0,
      logMaxFiles: 7,
    };
    writeAgentManagerConfiguration(path, configuration);
    assert.deepEqual(loadAgentManagerConfiguration(path), configuration);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
