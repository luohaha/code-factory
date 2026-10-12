#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const temporaryRoot = mkdtempSync(join(tmpdir(), 'code-factory-package-smoke-'));
const installRoot = join(temporaryRoot, 'install');
const workspaceRoot = join(temporaryRoot, 'workspace');
const tarball = join(temporaryRoot, `luoyixin-code-factory-${version}.tgz`);
let manager;

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', timeout: 180_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(url, output) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (manager.exitCode !== null || manager.signalCode !== null) {
      throw new Error(`Installed Agent Manager exited early:\n${output.join('')}`);
    }
    try {
      const response = await fetch(`${url}api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return response;
    } catch {
      // The process may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Installed Agent Manager did not become healthy:\n${output.join('')}`);
}

try {
  mkdirSync(installRoot);
  mkdirSync(workspaceRoot);
  run('git', ['init', '--quiet'], workspaceRoot);
  run('npm', ['pack', '--pack-destination', temporaryRoot], packageRoot);
  assert.ok(existsSync(tarball), `Package tarball is missing: ${tarball}`);
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', installRoot, tarball], temporaryRoot);

  const port = await availablePort();
  const output = [];
  manager = spawn(process.execPath, [
    join(installRoot, 'node_modules', '@luoyixin', 'code-factory', 'dist', 'cli.js'),
    'start', '--host', '127.0.0.1', '--port', String(port),
    '--pr-reconcile-interval', '0', '--log-level', 'silent',
  ], { cwd: workspaceRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  manager.stdout.on('data', (chunk) => output.push(chunk.toString()));
  manager.stderr.on('data', (chunk) => output.push(chunk.toString()));
  manager.on('error', (error) => output.push(String(error)));

  const url = `http://127.0.0.1:${port}/`;
  const health = await waitForHealth(url, output);
  assert.equal((await health.json()).version, version);
  const dashboard = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const html = await dashboard.text();
  assert.equal(dashboard.status, 200, `GET / returned ${dashboard.status}: ${html}`);
  assert.match(dashboard.headers.get('content-type') ?? '', /^text\/html/);
  assert.match(html, /<html\b/i);
  console.log(`Installed package HTTP smoke passed: ${version}, GET /api/health and GET /`);
} finally {
  if (manager && manager.exitCode === null && manager.signalCode === null) {
    manager.kill('SIGTERM');
    await new Promise((resolve) => {
      const timeout = setTimeout(() => { manager.kill('SIGKILL'); resolve(); }, 5_000);
      manager.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
}
