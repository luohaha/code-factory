import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CodeFactoryCliInvocation {
  command: string;
  args: string[];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function cmdQuote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** Installs a private launcher so RD child processes can always resolve code-factory-cli through PATH. */
export function installCodeFactoryCliLauncher(
  workspaceDataDirectory: string,
  invocation: CodeFactoryCliInvocation,
): string {
  const binDirectory = join(workspaceDataDirectory, 'bin');
  mkdirSync(binDirectory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const launcher = join(binDirectory, 'code-factory-cli.cmd');
    const command = [invocation.command, ...invocation.args].map(cmdQuote).join(' ');
    writeFileSync(launcher, `@echo off\r\n${command} %*\r\n`, { encoding: 'utf8', mode: 0o700 });
    return binDirectory;
  }
  const launcher = join(binDirectory, 'code-factory-cli');
  const command = [invocation.command, ...invocation.args].map(shellQuote).join(' ');
  writeFileSync(launcher, `#!/bin/sh\nexec ${command} "$@"\n`, { encoding: 'utf8', mode: 0o700 });
  chmodSync(launcher, 0o700);
  return binDirectory;
}
