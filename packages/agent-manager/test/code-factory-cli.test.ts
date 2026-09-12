import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  CODE_FACTORY_API_URL,
  CODE_FACTORY_REQUIREMENT_ID,
  CODE_FACTORY_SESSION_ID,
  type CodeFactoryCliRuntime,
  runCodeFactoryCli,
} from '../src/code-factory-cli.ts';
import { installCodeFactoryCliLauncher } from '../src/code-factory-cli-launcher.ts';

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

function testRuntime(requests: CapturedRequest[], output: string[], errors: string[]): CodeFactoryCliRuntime {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
    assert.equal(init?.method, 'POST');
    assert.equal(typeof init?.body, 'string');
    requests.push({ url, body: JSON.parse(init.body as string) as Record<string, unknown> });
    return new Response(JSON.stringify({ ok: true }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    environment: {
      [CODE_FACTORY_API_URL]: 'http://127.0.0.1:4310/api/',
      [CODE_FACTORY_REQUIREMENT_ID]: 'req_cli',
      [CODE_FACTORY_SESSION_ID]: 'ses_cli',
    },
    fetch,
    writeOut: (value) => output.push(value),
    writeError: (value) => errors.push(value),
  };
}

test('code-factory-cli help discovers the supported RD commands', async () => {
  const output: string[] = [];
  const exitCode = await runCodeFactoryCli(['--help'], {
    writeOut: (value) => output.push(value),
    writeError: () => undefined,
  });

  assert.equal(exitCode, 0);
  assert.match(output.join(''), /pr register/);
  assert.match(output.join(''), /requirement propose/);
  assert.match(output.join(''), /CODE_FACTORY_REQUIREMENT_ID/);
});

test('code-factory-cli registers a PR using injected Requirement context', async () => {
  const requests: CapturedRequest[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  const exitCode = await runCodeFactoryCli([
    'pr', 'register',
    '--repository', 'acme/widgets',
    '--number', '184',
    '--url', 'https://github.com/acme/widgets/pull/184',
    '--title', 'Improve compaction',
    '--base-branch', 'main',
    '--head-branch', 'feature/compaction',
    '--head-sha', 'abc123',
    '--status', 'open',
  ], testRuntime(requests, output, errors));

  assert.equal(exitCode, 0);
  assert.deepEqual(errors, []);
  assert.equal(requests[0]?.url, 'http://127.0.0.1:4310/api/agent/pull-requests');
  assert.deepEqual(requests[0]?.body, {
    requirementId: 'req_cli',
    repository: 'acme/widgets',
    number: 184,
    url: 'https://github.com/acme/widgets/pull/184',
    title: 'Improve compaction',
    baseBranch: 'main',
    headBranch: 'feature/compaction',
    headSha: 'abc123',
    status: 'open',
  });
  assert.equal(output.join(''), '{"ok":true}\n');
});

test('code-factory-cli proposes a Requirement using injected Session context', async () => {
  const requests: CapturedRequest[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  const exitCode = await runCodeFactoryCli([
    'requirement', 'propose',
    '--title', 'Add a benchmark',
    '--description', 'Track throughput separately',
    '--provider', 'codex',
    '--reasoning-effort', 'high',
  ], testRuntime(requests, output, errors));

  assert.equal(exitCode, 0);
  assert.deepEqual(errors, []);
  assert.equal(requests[0]?.url, 'http://127.0.0.1:4310/api/agent/requirements');
  assert.deepEqual(requests[0]?.body, {
    sourceSessionId: 'ses_cli',
    parentRequirementId: 'req_cli',
    title: 'Add a benchmark',
    description: 'Track throughput separately',
    provider: 'codex',
    reasoningEffort: 'high',
  });
});

test('code-factory-cli rejects invalid command input without sending a request', async () => {
  const requests: CapturedRequest[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  const exitCode = await runCodeFactoryCli([
    'pr', 'register', '--number', 'not-a-number',
  ], testRuntime(requests, output, errors));

  assert.equal(exitCode, 2);
  assert.deepEqual(requests, []);
  assert.match(errors.join(''), /--number must be a positive integer/);
  assert.match(errors.join(''), /Usage: code-factory-cli pr register/);
});

test('private launcher makes code-factory-cli resolvable through PATH', {
  skip: process.platform === 'win32',
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-cli-'));
  try {
    const binDirectory = installCodeFactoryCliLauncher(directory, {
      command: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', 'fixed'],
    });
    const result = spawnSync('code-factory-cli', ['alpha', 'beta'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ''}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '["fixed","alpha","beta"]');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
