#!/usr/bin/env node
import { spawn } from 'node:child_process';

import { AgentManager } from './agent-manager.js';
import { createAgentManagerServer, listen } from './server.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(): never {
  console.error('Usage: code-factory-agent-manager start [--host 127.0.0.1] [--port 4310] [--db PATH] [--allow-origin ORIGIN] [--open]');
  process.exit(1);
}

if (process.argv[2] !== 'start') usage();

const portValue = option('--port');
const port = portValue === undefined ? 4310 : Number(portValue);
if (!Number.isInteger(port) || port < 1 || port > 65_535) usage();

const databasePath = option('--db');
const allowedOrigin = option('--allow-origin') ?? 'http://localhost:3000';
const manager = new AgentManager({ ...(databasePath ? { databasePath } : {}) });
const server = createAgentManagerServer(manager, {
  host: option('--host') ?? '127.0.0.1',
  port,
  allowedOrigin,
});
const address = await listen(server, { host: option('--host') ?? '127.0.0.1', port });
const displayHost = address.host === '0.0.0.0' || address.host === '::' ? '127.0.0.1' : address.host;
const dashboardUrl = `http://${displayHost}:${address.port}/`;

console.log(`Code Factory Agent Manager`);
console.log(`Workspace: ${manager.workspaceRoot}`);
console.log(`Database:  ${manager.databasePath}`);
console.log(`Dashboard: ${dashboardUrl}`);
console.log(`API:       ${dashboardUrl}api`);
console.log('Warning: headless agents run with the current user\'s full filesystem and network permissions.');

if (process.argv.includes('--open')) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', dashboardUrl] : [dashboardUrl];
  const browser = spawn(command, args, { detached: true, stdio: 'ignore', shell: false });
  browser.unref();
}

const shutdown = () => {
  server.close(() => {
    manager.close();
    process.exit(0);
  });
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
