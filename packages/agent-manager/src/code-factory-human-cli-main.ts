#!/usr/bin/env node
import { runHumanCli } from './cli/code-factory-human-cli.js';

process.exitCode = await runHumanCli(process.argv.slice(2));
