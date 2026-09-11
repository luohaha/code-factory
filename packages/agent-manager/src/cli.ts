#!/usr/bin/env node
import { spawn } from 'node:child_process';

import { AgentManager } from './agent-manager.js';
import { isLogLevel } from './logger.js';
import { createAgentManagerServer, listen } from './server.js';
import { formatStartupBanner } from './startup-banner.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(): never {
  process.stderr.write('Usage: code-factory-agent-manager start [--host 127.0.0.1] [--port 4310] [--db PATH] [--allow-origin ORIGIN] [--pr-reconcile-interval SECONDS] [--log-level debug|info|warn|error|silent] [--log-file PATH] [--log-max-size SIZE] [--log-max-files COUNT_OR_DAYS] [--open]\n');
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
const logFilePathOption = option('--log-file');
if (process.argv.includes('--log-file') && logFilePathOption === undefined) usage();
const logFilePath = logFilePathOption ?? process.env.CODE_FACTORY_LOG_FILE;
const logMaxSizeOption = option('--log-max-size');
if (process.argv.includes('--log-max-size') && logMaxSizeOption === undefined) usage();
const logMaxSize = logMaxSizeOption ?? process.env.CODE_FACTORY_LOG_MAX_SIZE;
const logMaxFilesOption = option('--log-max-files');
if (process.argv.includes('--log-max-files') && logMaxFilesOption === undefined) usage();
const logMaxFiles = logMaxFilesOption ?? process.env.CODE_FACTORY_LOG_MAX_FILES;
const manager = new AgentManager({
  ...(databasePath ? { databasePath } : {}),
  logLevel,
  ...(logFilePath ? { logFilePath } : {}),
  ...(logMaxSize ? { logMaxSize } : {}),
  ...(logMaxFiles ? { logMaxFiles } : {}),
});
const logger = manager.logger;
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
const apiUrl = `${dashboardUrl}api`;

process.stdout.write(`${formatStartupBanner({
  workspaceRoot: manager.workspaceRoot,
  databasePath: manager.databasePath,
  logFilePath: manager.logFilePath,
  dashboardUrl,
  apiUrl,
  pullRequestReconcileIntervalSeconds: reconcileIntervalSeconds,
})}\n`);

logger.info('Code Factory Agent Manager started', {
  workspaceRoot: manager.workspaceRoot,
  databasePath: manager.databasePath,
  dashboardUrl,
  apiUrl,
  logFilePath: manager.logFilePath,
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
  server.close(async () => {
    await manager.close();
    process.exitCode = 0;
  });
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
