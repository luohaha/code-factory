#!/usr/bin/env node
import { CODE_FACTORY_VERSION } from './version.js';

const command = process.argv[2];

if (command === '--version' || command === '-v' || command === 'version') {
  process.stdout.write(`${CODE_FACTORY_VERSION}\n`);
} else {
  await import('./agent-manager-cli.js');
}
