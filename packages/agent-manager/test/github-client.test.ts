import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

for (const [state, isDraft, status] of [
  ['OPEN', true, 'draft'], ['CLOSED', true, 'closed'], ['MERGED', false, 'merged'], ['OPEN', false, 'open'],
] as const) {
  test(`GhCliGitHubClient fetches activity only for a current open PR (${status})`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'code-factory-gh-status-'));
    const executable = join(directory, 'gh');
    const callsFile = join(directory, 'calls.jsonl');
    const activity = { id: '1', author: { login: 'reviewer' }, body: 'Feedback', createdAt: '2026-09-21T01:00:00Z' };
    const lifecycle = {
      state, isDraft, title: pullRequest.title, url: pullRequest.url, baseRefName: 'main',
      headRefName: pullRequest.headBranch, headRefOid: pullRequest.headSha, updatedAt: pullRequest.updatedAt,
    };
    const activityDetails = {
      ...lifecycle,
      mergeable: 'CONFLICTING', comments: [activity], reviews: [{ ...activity, id: '2' }],
      statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }],
    };
    writeFileSync(executable, [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      `fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\\n');`,
      `const lifecycle = ${JSON.stringify(lifecycle)};`,
      `const activity = ${JSON.stringify(activityDetails)};`,
      `const inlineComments = ${JSON.stringify([[{ ...activity, id: 3, created_at: activity.createdAt }]])};`,
      "const result = args[0] === 'api' ? inlineComments : args.at(-1).includes('statusCheckRollup') ? activity : lifecycle;",
      'process.stdout.write(JSON.stringify(result));',
    ].join('\n'), { mode: 0o700 });
    try {
      const client = new GhCliGitHubClient(directory, { executable });
      // Stored state may lag GitHub in either direction.
      const result = await client.inspectPullRequest({ ...pullRequest, status: status === 'open' ? 'draft' : 'open' });
      assert.equal(result.status, status);
      const calls = readFileSync(callsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
      assert.equal(calls.length, status === 'open' ? 3 : 1);
      assert.equal(calls[0]?.at(-1), 'state,isDraft,title,url,baseRefName,headRefName,headRefOid,updatedAt');
      if (status === 'open') {
        assert.equal(result.mergeable, 'CONFLICTING');
        assert.deepEqual(result.reviewActivity.map((item) => item.kind), ['comment', 'review', 'review_comment']);
        assert.equal(result.checks[0]?.conclusion, 'FAILURE');
        assert.ok(calls.some((args) => args[0] === 'api' && args.includes('--paginate') && args.includes('--slurp')));
      } else {
        assert.equal(result.mergeable, 'UNKNOWN');
        assert.deepEqual(result.reviewActivity, []);
        assert.deepEqual(result.checks, []);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const [state, isDraft, status] of [
  ['OPEN', false, 'open'], ['OPEN', true, 'draft'], ['CLOSED', false, 'closed'], ['MERGED', false, 'merged'],
] as const) {
  test(`activity reads use their own head and lifecycle metadata when the PR changes to ${status}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'code-factory-gh-race-'));
    const executable = join(directory, 'gh');
    const before = {
      state: 'OPEN', isDraft: false, title: 'Before push', url: pullRequest.url,
      baseRefName: 'main', headRefName: pullRequest.headBranch, headRefOid: 'head-a', updatedAt: pullRequest.updatedAt,
    };
    const after = {
      ...before, state, isDraft, title: 'After push', headRefOid: 'head-b', baseRefName: 'release',
      updatedAt: '2026-09-21T00:01:00.000Z',
      mergeable: status === 'open' ? 'CONFLICTING' : null,
      comments: [{ id: 'new-comment', author: { login: 'reviewer' }, createdAt: '2026-09-21T00:01:00Z' }],
      reviews: [], statusCheckRollup: [{ name: 'test-b', status: 'COMPLETED', conclusion: 'FAILURE' }],
    };
    writeFileSync(executable, [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      "if (args[0] === 'api') { process.stdout.write('[]'); process.exit(0); }",
      `const result = fs.existsSync(${JSON.stringify(join(directory, 'read-once'))}) ? ${JSON.stringify(after)} : ${JSON.stringify(before)};`,
      `fs.writeFileSync(${JSON.stringify(join(directory, 'read-once'))}, '');`,
      'const fields = args.at(-1).split(",");',
      'process.stdout.write(JSON.stringify(Object.fromEntries(fields.map(field => [field, result[field]]))));',
    ].join('\n'), { mode: 0o700 });
    try {
      const result = await new GhCliGitHubClient(directory, { executable }).inspectPullRequest(pullRequest);
      assert.equal(result.status, status);
      assert.equal(result.headSha, 'head-b');
      assert.equal(result.title, 'After push');
      assert.equal(result.baseBranch, 'release');
      assert.equal(result.updatedAt, after.updatedAt);
      if (status === 'open') {
        assert.equal(result.checks[0]?.name, 'test-b');
        assert.equal(result.reviewActivity[0]?.id, 'new-comment');
        assert.equal(result.mergeable, 'CONFLICTING');
      } else {
        assert.deepEqual(result.checks, []);
        assert.deepEqual(result.reviewActivity, []);
        assert.equal(result.mergeable, 'UNKNOWN');
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('GhCliGitHubClient kills a hung gh subprocess at its timeout', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-gh-timeout-'));
  const executable = join(directory, 'gh');
  const pidFile = join(directory, 'pids');
  const hangTarget = join(directory, 'hung-gh-marker');
  writeFileSync(hangTarget, '');
  writeFileSync(executable, [
    '#!/bin/sh',
    'if [ "$1" = "api" ]; then printf "[]"; exit 0; fi',
    `printf '%s\\n' "$$" >> '${pidFile.replaceAll("'", "'\\''")}'`,
    `exec tail -f '${hangTarget.replaceAll("'", "'\\''")}'`,
  ].join('\n'), { mode: 0o700 });

  try {
    const client = new GhCliGitHubClient(directory, { executable, timeoutMs: 2_000 });
    const startedAt = Date.now();
    await assert.rejects(client.inspectPullRequest(pullRequest), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'TimeoutError');
      assert.match(error.message, /^gh (?:pr view|api) timed out after 2000ms$/);
      return true;
    });
    assert.ok(Date.now() - startedAt < 5_000, 'the hung command should reject promptly');

    assert.ok(existsSync(pidFile), 'the fake gh command should reach its hung state before the timeout');
    const pids = readPids(pidFile);
    assert.equal(pids.length, 1);
    await waitFor(() => pids.every((pid) => !markedProcessIsRunning(pid, hangTarget)));
    assert.ok(pids.every((pid) => !markedProcessIsRunning(pid, hangTarget)), 'the hung gh subprocess should not be running');
  } finally {
    for (const pid of existsSync(pidFile) ? readPids(pidFile) : []) {
      if (markedProcessIsRunning(pid, hangTarget)) process.kill(pid, 'SIGKILL');
    }
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

function markedProcessIsRunning(pid: number, marker: string): boolean {
  try {
    const output = execFileSync('ps', ['-o', 'stat=', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    const match = output.match(/^(\S+)\s+(.*)$/s);
    if (!match) return false;
    const [, state, command] = match;
    return !state!.startsWith('Z') && command!.includes(marker);
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Condition was not met within ${timeoutMs}ms`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
