#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';

const version = process.argv[2]?.replace(/^v/, '');
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

if (!version || !semverPattern.test(version)) {
  process.stderr.write('Usage: node scripts/set-version.mjs <semver>\n');
  process.exit(1);
}

const files = [
  { url: new URL('../packages/agent-manager/package.json', import.meta.url), lock: false },
  { url: new URL('../packages/agent-manager/package-lock.json', import.meta.url), lock: true },
  { url: new URL('../apps/web/package.json', import.meta.url), lock: false },
  { url: new URL('../apps/web/package-lock.json', import.meta.url), lock: true },
];

for (const file of files) {
  const contents = JSON.parse(await readFile(file.url, 'utf8'));
  contents.version = version;
  if (file.lock) {
    const rootPackage = contents.packages?.[''];
    if (!rootPackage) throw new Error(`${file.url.pathname} has no root package entry`);
    rootPackage.version = version;
  }
  await writeFile(file.url, `${JSON.stringify(contents, null, 2)}\n`);
}

process.stdout.write(`Set Code Factory version to ${version}. Add a matching CHANGELOG.md entry before release.\n`);
