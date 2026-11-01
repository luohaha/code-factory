#!/usr/bin/env node
import { runManagerCli } from './cli/code-factory-manager-cli.js';

process.exitCode = await runManagerCli(process.argv.slice(2));
