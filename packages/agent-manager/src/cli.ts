#!/usr/bin/env node
import { spawn } from 'node:child_process';

import { AgentManager } from './agent-manager.js';
import { createLogger, isLogLevel } from './logger.js';
import { createAgentManagerServer, listen } from './server.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(): never {
  createLogger({ context: { component: 'agent-manager' } }).error('Invalid command line arguments', {
    usage: 'code-factory-agent-manager start [--host 127.0.0.1] [--port 4310] [--db PATH] [--allow-origin ORIGIN] [--pr-reconcile-interval SECONDS] [--log-level debug|info|warn|error|silent] [--open]',
  });
  process.exit(1);
}

if (process.argv[2] !== 'start') usage();

const portValue = option('--port');
const port = portValue === undefined ? 4310 : Number(portValue);
if (!Number.isInteger(port) || port < 1 || port > 65_535) usage();
const reconcileIntervalValue = option('--pr-reconcile-interval');
const reconcileIntervalSeconds = reconcileIntervalValue === undefined ? 30 : Number(reconcileIntervalValue);
if (!Number.isInteger(reconcileIntervalSeconds) || reconcileIntervalSeconds < 0) usage();

const databasePath = option('--db');
const allowedOrigin = option('--allow-origin') ?? 'http://localhost:3000';
const logLevelOption = option('--log-level');
if (process.argv.includes('--log-level') && logLevelOption === undefined) usage();
const logLevel = logLevelOption ?? process.env.CODE_FACTORY_LOG_LEVEL ?? 'info';
if (!isLogLevel(logLevel)) usage();
const logger = createLogger({ level: logLevel, context: { component: 'agent-manager' } });
const manager = new AgentManager({ ...(databasePath ? { databasePath } : {}), logger });
const server = createAgentManagerServer(manager, {
  host: option('--host') ?? '127.0.0.1',
  port,
  allowedOrigin,
  logger,
});
const address = await listen(server, { host: option('--host') ?? '127.0.0.1', port });
if (reconcileIntervalSeconds > 0) manager.startPullRequestReconciler(reconcileIntervalSeconds * 1_000);
const displayHost = address.host === '0.0.0.0' || address.host === '::' ? '127.0.0.1' : address.host;
const dashboardUrl = `http://${displayHost}:${address.port}/`;

logger.info('Code Factory Agent Manager started', {
  workspaceRoot: manager.workspaceRoot,
  databasePath: manager.databasePath,
  dashboardUrl,
  apiUrl: `${dashboardUrl}api`,
  pullRequestReconcileIntervalSeconds: reconcileIntervalSeconds,
});
logger.warn('Headless agents run with the current user\'s full filesystem and network permissions');

if (process.argv.includes('--open')) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', dashboardUrl] : [dashboardUrl];
  const browser = spawn(command, args, { detached: true, stdio: 'ignore', shell: false });
  browser.once('error', (error) => logger.error('Could not open dashboard', { dashboardUrl, error }));
  browser.unref();
}

const shutdown = () => {
  logger.info('Agent Manager shutting down');
  server.close(() => {
    manager.close();
    process.exit(0);
  });
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
