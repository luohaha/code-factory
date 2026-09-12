#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { AgentManager } from './agent-manager.js';
import {
  defaultConfigurationPath,
  loadAgentManagerConfiguration,
  validateAgentManagerConfiguration,
} from './configuration.js';
import { isLogLevel } from './logger.js';
import { createAgentManagerServer, listen } from './server.js';
import { formatStartupBanner } from './startup-banner.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(): never {
  process.stderr.write('Usage: code-factory-agent-manager start [--config PATH] [--host 127.0.0.1] [--port 4310] [--db PATH] [--allow-origin ORIGIN] [--pr-reconcile-interval SECONDS] [--log-level debug|info|warn|error|silent] [--log-file PATH] [--log-max-size SIZE] [--log-max-files COUNT_OR_DAYS] [--open]\n');
  process.exit(1);
}

if (process.argv[2] !== 'start') usage();
for (const name of ['--config', '--host', '--port', '--db', '--allow-origin', '--pr-reconcile-interval', '--log-level', '--log-file', '--log-max-size', '--log-max-files']) {
  if (process.argv.includes(name) && option(name) === undefined) usage();
}

const workspaceRoot = realpathSync(process.cwd());
const configurationFilePath = resolve(option('--config') ?? defaultConfigurationPath(workspaceRoot));
const fileConfiguration = loadAgentManagerConfiguration(configurationFilePath);
const logLevelOption = option('--log-level');
const logLevel = logLevelOption ?? process.env.CODE_FACTORY_LOG_LEVEL ?? fileConfiguration.logLevel;
if (!isLogLevel(logLevel)) usage();
const logFilePathOption = option('--log-file');
const configuredLogFilePath = logFilePathOption ?? process.env.CODE_FACTORY_LOG_FILE ?? fileConfiguration.logFilePath;
const logMaxSizeOption = option('--log-max-size');
const logMaxSize = logMaxSizeOption ?? process.env.CODE_FACTORY_LOG_MAX_SIZE ?? fileConfiguration.logMaxSize;
const logMaxFilesOption = option('--log-max-files');
const logMaxFiles = logMaxFilesOption ?? process.env.CODE_FACTORY_LOG_MAX_FILES ?? fileConfiguration.logMaxFiles;
const port = option('--port') === undefined ? fileConfiguration.port : Number(option('--port'));
const reconcileIntervalSeconds = option('--pr-reconcile-interval') === undefined
  ? fileConfiguration.pullRequestReconcileIntervalSeconds
  : Number(option('--pr-reconcile-interval'));
const databasePathValue = option('--db') ?? fileConfiguration.databasePath;
const logFilePath = configuredLogFilePath ? resolve(workspaceRoot, configuredLogFilePath) : undefined;
const databasePath = databasePathValue ? resolve(workspaceRoot, databasePathValue) : undefined;
const configuration = validateAgentManagerConfiguration({
  ...fileConfiguration,
  host: option('--host') ?? fileConfiguration.host,
  port,
  allowedOrigin: option('--allow-origin') ?? fileConfiguration.allowedOrigin,
  openDashboard: process.argv.includes('--open') || fileConfiguration.openDashboard,
  databasePath: databasePath ?? null,
  pullRequestReconcileIntervalSeconds: reconcileIntervalSeconds,
  logLevel,
  logFilePath: logFilePath ?? null,
  logMaxSize,
  logMaxFiles,
});
const manager = new AgentManager({
  workspaceRoot,
  configuration,
  configurationFilePath,
  ...(databasePath ? { databasePath } : {}),
  logLevel,
  ...(logFilePath ? { logFilePath } : {}),
  ...(logMaxSize ? { logMaxSize } : {}),
  ...(logMaxFiles ? { logMaxFiles } : {}),
});
const logger = manager.logger;
const server = createAgentManagerServer(manager, {
  host: configuration.host,
  port: configuration.port,
  ...(configuration.allowedOrigin ? { allowedOrigin: configuration.allowedOrigin } : {}),
  logger,
});
const address = await listen(server, { host: configuration.host, port: configuration.port });
manager.startConfiguredServices();
const displayHost = address.host === '0.0.0.0' || address.host === '::' ? '127.0.0.1' : address.host;
const dashboardUrl = `http://${displayHost}:${address.port}/`;
const apiUrl = `${dashboardUrl}api`;

process.stdout.write(`${formatStartupBanner({
  workspaceRoot: manager.workspaceRoot,
  configurationFilePath,
  databasePath: manager.databasePath,
  logFilePath: manager.logFilePath,
  dashboardUrl,
  apiUrl,
  pullRequestReconcileIntervalSeconds: reconcileIntervalSeconds,
})}\n`);

logger.info('Code Factory Agent Manager started', {
  workspaceRoot: manager.workspaceRoot,
  configurationFilePath,
  databasePath: manager.databasePath,
  dashboardUrl,
  apiUrl,
  logFilePath: manager.logFilePath,
  pullRequestReconcileIntervalSeconds: reconcileIntervalSeconds,
});
logger.warn('Headless agents run with the current user\'s full filesystem and network permissions');

if (configuration.openDashboard) {
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
