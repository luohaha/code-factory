#!/usr/bin/env node
import { runCodeFactoryCli } from './cli/code-factory-cli.js';

process.exitCode = await runCodeFactoryCli(process.argv.slice(2));
