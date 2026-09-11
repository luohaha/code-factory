import assert from 'node:assert/strict';
import test from 'node:test';

import { formatStartupBanner } from '../src/startup-banner.ts';

test('startup banner always exposes workspace paths and service URLs', () => {
  assert.equal(formatStartupBanner({
    workspaceRoot: '/workspace/starrocks',
    databasePath: '/data/factory.sqlite',
    logFilePath: '/data/logs/agent-manager.log',
    dashboardUrl: 'http://127.0.0.1:4310/',
    apiUrl: 'http://127.0.0.1:4310/api',
    pullRequestReconcileIntervalSeconds: 30,
  }), [
    'Code Factory Agent Manager started',
    'Workspace: /workspace/starrocks',
    'Database:  /data/factory.sqlite',
    'Logs:      /data/logs/agent-manager.log',
    'Dashboard: http://127.0.0.1:4310/',
    'API:       http://127.0.0.1:4310/api',
    'PR reconciler: every 30s',
    'Warning: headless agents run with the current user\'s full filesystem and network permissions.',
  ].join('\n'));
});

test('startup banner reports disabled reconciliation and an injected logger', () => {
  const banner = formatStartupBanner({
    workspaceRoot: '/workspace/repo',
    databasePath: ':memory:',
    logFilePath: null,
    dashboardUrl: 'http://127.0.0.1:9000/',
    apiUrl: 'http://127.0.0.1:9000/api',
    pullRequestReconcileIntervalSeconds: 0,
  });

  assert.match(banner, /^Code Factory Agent Manager started/m);
  assert.match(banner, /^Logs: {6}custom logger$/m);
  assert.match(banner, /^PR reconciler: disabled$/m);
});
