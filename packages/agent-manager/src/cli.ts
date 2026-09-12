#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentManager } from './agent-manager.js';
import {
  defaultConfigurationPath,
  loadAgentManagerConfiguration,
  validateAgentManagerConfiguration,
} from './configuration.js';
import {
  inspectDaemon,
  runDaemonSupervisor,
  startDaemon,
  stopDaemon,
  type DaemonState,
} from './daemon.js';
import { isLogLevel, type Logger } from './logger.js';
import { createAgentManagerServer, listen } from './server.js';
import { formatStartupBanner } from './startup-banner.js';

const command = process.argv[2];

try {
  if (command === '__daemon') {
    await runDaemonSupervisor(process.argv.slice(3));
  } else if (command === 'start') {
    const args = process.argv.slice(3);
    if (args.includes('--daemon')) await runDaemonStart(args.filter((arg) => arg !== '--daemon'));
    else await runForeground(args);
  } else if (command === 'stop') {
    await runDaemonStop();
  } else if (command === 'status') {
    runDaemonStatus();
  } else if (command === 'restart') {
    await runDaemonRestart(process.argv.slice(3));
  } else if (command === 'daemon') {
    await runDaemonAlias(process.argv[3], process.argv.slice(4));
  } else {
    usage();
  }
} catch (error) {
  process.stderr.write(`Agent Manager: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function runForeground(args: readonly string[]): Promise<void> {
  for (const name of [
    '--config',
    '--host',
    '--port',
    '--db',
    '--allow-origin',
    '--pr-reconcile-interval',
    '--log-level',
    '--log-file',
    '--log-max-size',
    '--log-max-files',
  ]) {
    if (args.includes(name) && option(args, name) === undefined) usage();
  }

  const workspaceRoot = realpathSync(process.cwd());
  const configurationFilePath = resolve(option(args, '--config') ?? defaultConfigurationPath(workspaceRoot));
  const fileConfiguration = loadAgentManagerConfiguration(configurationFilePath);
  const logLevel = option(args, '--log-level') ?? process.env.CODE_FACTORY_LOG_LEVEL ?? fileConfiguration.logLevel;
  if (!isLogLevel(logLevel)) usage();
  const configuredLogFilePath = option(args, '--log-file')
    ?? process.env.CODE_FACTORY_LOG_FILE
    ?? fileConfiguration.logFilePath;
  const logMaxSize = option(args, '--log-max-size')
    ?? process.env.CODE_FACTORY_LOG_MAX_SIZE
    ?? fileConfiguration.logMaxSize;
  const logMaxFiles = option(args, '--log-max-files')
    ?? process.env.CODE_FACTORY_LOG_MAX_FILES
    ?? fileConfiguration.logMaxFiles;
  const port = option(args, '--port') === undefined ? fileConfiguration.port : Number(option(args, '--port'));
  const reconcileIntervalSeconds = option(args, '--pr-reconcile-interval') === undefined
    ? fileConfiguration.pullRequestReconcileIntervalSeconds
    : Number(option(args, '--pr-reconcile-interval'));
  const databasePathValue = option(args, '--db') ?? fileConfiguration.databasePath;
  const logFilePath = configuredLogFilePath ? resolve(workspaceRoot, configuredLogFilePath) : undefined;
  const databasePath = databasePathValue ? resolve(workspaceRoot, databasePathValue) : undefined;
  const configuration = validateAgentManagerConfiguration({
    ...fileConfiguration,
    host: option(args, '--host') ?? fileConfiguration.host,
    port,
    allowedOrigin: option(args, '--allow-origin') ?? fileConfiguration.allowedOrigin,
    openDashboard: args.includes('--open') || fileConfiguration.openDashboard,
    databasePath: databasePath ?? null,
    pullRequestReconcileIntervalSeconds: reconcileIntervalSeconds,
    logLevel,
    logFilePath: logFilePath ?? null,
    logMaxSize,
    logMaxFiles,
  });
  const sourceExecution = import.meta.url.endsWith('.ts');
  const agentCliEntrypoint = fileURLToPath(new URL(
    sourceExecution ? './code-factory-cli-main.ts' : './code-factory-cli-main.js',
    import.meta.url,
  ));
  const manager = new AgentManager({
    workspaceRoot,
    configuration: fileConfiguration,
    effectiveConfiguration: configuration,
    configurationFilePath,
    ...(databasePath ? { databasePath } : {}),
    logLevel,
    ...(logFilePath ? { logFilePath } : {}),
    logMaxSize,
    logMaxFiles,
    agentCliInvocation: {
      command: process.execPath,
      args: [...(sourceExecution ? process.execArgv : []), agentCliEntrypoint],
    },
  });
  const logger = manager.logger;
  const server = createAgentManagerServer(manager, {
    host: configuration.host,
    port: configuration.port,
    ...(configuration.allowedOrigin ? { allowedOrigin: configuration.allowedOrigin } : {}),
    logger,
  });
  let address;
  try {
    address = await listen(server, { host: configuration.host, port: configuration.port });
  } catch (error) {
    await manager.close();
    throw error;
  }
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

  if (process.env.CODE_FACTORY_DAEMON_CHILD === '1' && typeof process.send === 'function') {
    process.send({ type: 'code-factory-agent-manager-ready', dashboardUrl, apiUrl });
  }

  if (configuration.openDashboard && process.env.CODE_FACTORY_DAEMON_CHILD !== '1') {
    openDashboard(dashboardUrl, logger);
  }

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Agent Manager shutting down');
    server.close(async () => {
      await manager.close();
      process.exitCode = 0;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

async function runDaemonStart(args: readonly string[]): Promise<void> {
  const open = args.includes('--open') || configuredOpenDashboard(args);
  const managerArgs = args.filter((arg) => arg !== '--open');
  const result = await startDaemon(managerArgs);
  process.stdout.write(formatDaemonState(
    result.alreadyRunning ? 'Code Factory Agent Manager daemon is already running' : 'Code Factory Agent Manager daemon started',
    result.state,
    result.paths.logFile,
  ));
  if (open && result.state.dashboardUrl) openDashboard(result.state.dashboardUrl);
}

async function runDaemonStop(): Promise<void> {
  const result = await stopDaemon();
  process.stdout.write(`${result.stopped
    ? 'Code Factory Agent Manager daemon stopped'
    : 'Code Factory Agent Manager daemon is not running'}\n`);
}

function runDaemonStatus(): void {
  const inspection = inspectDaemon();
  if (!inspection.running || !inspection.state) {
    process.stdout.write('Code Factory Agent Manager daemon is not running\n');
    process.exitCode = 3;
    return;
  }
  process.stdout.write(formatDaemonState(
    `Code Factory Agent Manager daemon is ${inspection.state.status}`,
    inspection.state,
    inspection.paths.logFile,
  ));
}

async function runDaemonRestart(args: readonly string[]): Promise<void> {
  const inspection = inspectDaemon();
  const explicitArgs = args.filter((arg) => arg !== '--open' && arg !== '--daemon');
  const managerArgs = explicitArgs.length > 0 ? explicitArgs : inspection.state?.managerArgs ?? [];
  const open = args.includes('--open') || configuredOpenDashboard(managerArgs);
  await stopDaemon();
  const result = await startDaemon(managerArgs);
  process.stdout.write(formatDaemonState('Code Factory Agent Manager daemon restarted', result.state, result.paths.logFile));
  if (open && result.state.dashboardUrl) openDashboard(result.state.dashboardUrl);
}

async function runDaemonAlias(action: string | undefined, args: readonly string[]): Promise<void> {
  if (action === 'start') await runDaemonStart(args);
  else if (action === 'stop') await runDaemonStop();
  else if (action === 'status') runDaemonStatus();
  else if (action === 'restart') await runDaemonRestart(args);
  else usage();
}

function formatDaemonState(title: string, state: DaemonState, logFile: string): string {
  return [
    title,
    `Workspace:      ${state.workspaceRoot}`,
    `Supervisor PID: ${state.supervisorPid}`,
    `Manager PID:    ${state.managerPid ?? '-'}`,
    `Dashboard:      ${state.dashboardUrl ?? 'starting'}`,
    `Restarts:       ${state.restartCount}`,
    `Daemon logs:    ${logFile}`,
    '',
  ].join('\n');
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function configuredOpenDashboard(args: readonly string[]): boolean {
  const workspaceRoot = realpathSync(process.cwd());
  const configurationFilePath = resolve(option(args, '--config') ?? defaultConfigurationPath(workspaceRoot));
  return loadAgentManagerConfiguration(configurationFilePath).openDashboard;
}

function openDashboard(dashboardUrl: string, logger?: Logger): void {
  const browserCommand = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const browserArgs = process.platform === 'win32' ? ['/c', 'start', '', dashboardUrl] : [dashboardUrl];
  const browser = spawn(browserCommand, browserArgs, { detached: true, stdio: 'ignore', shell: false });
  browser.once('error', (error) => {
    if (logger) logger.error('Could not open dashboard', { dashboardUrl, error });
    else process.stderr.write(`Could not open dashboard ${dashboardUrl}: ${error.message}\n`);
  });
  browser.unref();
}

function usage(): never {
  process.stderr.write([
    'Usage:',
    '  code-factory-agent-manager start [OPTIONS] [--daemon]',
    '  code-factory-agent-manager stop',
    '  code-factory-agent-manager restart [OPTIONS]',
    '  code-factory-agent-manager status',
    '  code-factory-agent-manager daemon <start|stop|restart|status> [OPTIONS]',
    '',
    'Options: --config PATH --host HOST --port PORT --db PATH --allow-origin ORIGIN',
    '         --pr-reconcile-interval SECONDS --log-level LEVEL --log-file PATH',
    '         --log-max-size SIZE --log-max-files COUNT_OR_DAYS --open',
    '',
  ].join('\n'));
  process.exit(1);
}
