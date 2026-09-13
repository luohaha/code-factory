#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const publishedPackageName = '@luoyixin/code-factory';
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
}

const [agentManagerPackage, agentManagerLock, dashboardPackage, dashboardLock, changelog] = await Promise.all([
  readJson('../packages/agent-manager/package.json'),
  readJson('../packages/agent-manager/package-lock.json'),
  readJson('../apps/web/package.json'),
  readJson('../apps/web/package-lock.json'),
  readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8'),
]);

const version = agentManagerPackage.version;
const expectedVersion = process.argv[2]?.replace(/^v/, '');
const versions = [
  ['packages/agent-manager/package.json', version],
  ['packages/agent-manager/package-lock.json', agentManagerLock.version],
  ['packages/agent-manager/package-lock.json root package', agentManagerLock.packages?.['']?.version],
  ['apps/web/package.json', dashboardPackage.version],
  ['apps/web/package-lock.json', dashboardLock.version],
  ['apps/web/package-lock.json root package', dashboardLock.packages?.['']?.version],
];

const errors = [];
if (agentManagerPackage.name !== publishedPackageName) {
  errors.push(`packages/agent-manager/package.json name is ${String(agentManagerPackage.name)}; expected ${publishedPackageName}`);
}
if (agentManagerLock.name !== publishedPackageName) {
  errors.push(`packages/agent-manager/package-lock.json name is ${String(agentManagerLock.name)}; expected ${publishedPackageName}`);
}
if (agentManagerLock.packages?.['']?.name !== publishedPackageName) {
  errors.push(`packages/agent-manager/package-lock.json root package name is ${String(agentManagerLock.packages?.['']?.name)}; expected ${publishedPackageName}`);
}
if (typeof version !== 'string' || !semverPattern.test(version)) {
  errors.push(`packages/agent-manager/package.json has invalid SemVer: ${String(version)}`);
}
for (const [location, candidate] of versions) {
  if (candidate !== version) errors.push(`${location} is ${String(candidate)}; expected ${String(version)}`);
}
if (expectedVersion && expectedVersion !== version) {
  errors.push(`release tag/version is ${expectedVersion}; expected ${String(version)}`);
}
if (typeof version === 'string' && !changelog.includes(`## [${version}]`)) {
  errors.push(`CHANGELOG.md has no entry for ${version}`);
}

if (errors.length > 0) {
  process.stderr.write(`Version check failed in ${repositoryRoot}:\n- ${errors.join('\n- ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Code Factory version ${version} is synchronized.\n`);
}
