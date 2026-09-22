import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { GhCliGitHubClient } from '../src/github-client.ts';
import type { PullRequest } from '../src/types.ts';

const pullRequest: PullRequest = {
  id: 'pr-timeout',
  requirementId: 'req-timeout',
  repository: 'acme/widgets',
  number: 81,
  url: 'https://github.com/acme/widgets/pull/81',
  title: 'Timeout recovery',
  baseBranch: 'main',
  headBranch: 'timeout-recovery',
  headSha: 'abc123',
  status: 'open',
  createdAt: '2026-09-21T00:00:00.000Z',
  updatedAt: '2026-09-21T00:00:00.000Z',
};

test('GhCliGitHubClient kills a hung gh subprocess at its timeout', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-gh-timeout-'));
  const executable = join(directory, 'gh');
  const pidFile = join(directory, 'pids');
  writeFileSync(executable, [
    '#!/bin/sh',
    'if [ "$1" = "api" ]; then printf "[]"; exit 0; fi',
    `printf '%s\\n' "$$" >> '${pidFile.replaceAll("'", "'\\''")}'`,
    'exec sleep 60',
  ].join('\n'), { mode: 0o700 });

  try {
    const client = new GhCliGitHubClient(directory, { executable, timeoutMs: 750 });
    const startedAt = Date.now();
    await assert.rejects(client.inspectPullRequest(pullRequest), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'TimeoutError');
      assert.match(error.message, /^gh (?:pr view|api) timed out after 750ms$/);
      return true;
    });
    assert.ok(Date.now() - startedAt < 3_000, 'the hung command should reject promptly');

    await waitFor(() => existsSync(pidFile) && readPids(pidFile).length === 1);
    const pids = readPids(pidFile);
    await waitFor(() => pids.every((pid) => !processExists(pid)));
    assert.ok(pids.every((pid) => !processExists(pid)), 'all gh subprocesses should be terminated');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('GhCliGitHubClient reports parse failures without copying gh stdout into the error', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-gh-parse-'));
  const executable = join(directory, 'gh');
  writeFileSync(executable, [
    '#!/usr/bin/env node',
    "process.stdout.write('PRIVATE REVIEW BODY WITH malformed JSON');",
  ].join('\n'), { mode: 0o700 });

  try {
    const client = new GhCliGitHubClient(directory, { executable, timeoutMs: 2_000 });
    await assert.rejects(client.inspectPullRequest(pullRequest), (error: unknown) => {
      assert.ok(error instanceof SyntaxError);
      assert.match(error.message, /^gh (?:pr view|api) returned invalid JSON$/);
      assert.doesNotMatch(error.message, /PRIVATE REVIEW BODY/);
      return true;
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('GhCliGitHubClient redacts credentials from gh stderr diagnostics', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-gh-redaction-'));
  const executable = join(directory, 'gh');
  const token = 'ghp_abcdefghijklmnopqrstuvwxyz123456';
  writeFileSync(executable, [
    '#!/usr/bin/env node',
    `process.stderr.write(${JSON.stringify(`HTTP 401 Authorization: Bearer ${token} https://user:password@github.com`)});`,
    'process.exitCode = 1;',
  ].join('\n'), { mode: 0o700 });

  try {
    const client = new GhCliGitHubClient(directory, { executable, timeoutMs: 2_000 });
    await assert.rejects(client.inspectPullRequest(pullRequest), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /\[REDACTED\]/);
      assert.doesNotMatch(error.message, new RegExp(token));
      assert.doesNotMatch(error.message, /user:password/);
      return true;
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function readPids(filePath: string): number[] {
  return readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean).map(Number);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Condition was not met within ${timeoutMs}ms`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
