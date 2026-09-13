#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const [repositoryLicense, packageLicense, packageMetadata] = await Promise.all([
  readFile(new URL('../LICENSE', import.meta.url), 'utf8'),
  readFile(new URL('../packages/agent-manager/LICENSE', import.meta.url), 'utf8'),
  readFile(new URL('../packages/agent-manager/package.json', import.meta.url), 'utf8').then(JSON.parse),
]);

const errors = [];
if (packageMetadata.license !== 'Apache-2.0') {
  errors.push(`package.json license is ${String(packageMetadata.license)}; expected Apache-2.0`);
}
if (!repositoryLicense.startsWith('                                 Apache License\n')) {
  errors.push('root LICENSE does not contain the canonical Apache License heading');
}
if (!repositoryLicense.includes('                           Version 2.0, January 2004\n')) {
  errors.push('root LICENSE does not identify Apache License Version 2.0');
}
if (packageLicense !== repositoryLicense) {
  errors.push('packages/agent-manager/LICENSE is not identical to the root LICENSE');
}

if (errors.length > 0) {
  process.stderr.write(`License check failed:\n- ${errors.join('\n- ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Apache-2.0 license metadata and distribution files are synchronized.\n');
}
