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
import { CODE_FACTORY_VERSION } from '../src/version.ts';

interface CapturedRequest {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

function testRuntime(requests: CapturedRequest[], output: string[], errors: string[]): CodeFactoryCliRuntime {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string'
      ? JSON.parse(init.body) as Record<string, unknown>
      : {};
    requests.push({ url, method, body });
    return new Response(JSON.stringify(method === 'GET'
      ? { items: [{ id: 'tmr-123', description: 'Check compiler status', status: 'active' }] }
      : { ok: true }), {
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
  assert.match(output.join(''), /timer register/);
  assert.match(output.join(''), /timer show/);
  assert.match(output.join(''), /requirement propose/);
  assert.match(output.join(''), /requirement related/);
  assert.match(output.join(''), /requirement conversation/);
  assert.match(output.join(''), /requirement message/);
  assert.doesNotMatch(output.join(''), /^\s*requirement messages\s/m);
  assert.match(output.join(''), /CODE_FACTORY_REQUIREMENT_ID/);
});

test('code-factory-cli reports the package version without requiring Agent context', async () => {
  const output: string[] = [];
  const exitCode = await runCodeFactoryCli(['--version'], {
    environment: {},
    writeOut: (value) => output.push(value),
    writeError: () => undefined,
  });

  assert.equal(exitCode, 0);
  assert.equal(output.join(''), `${CODE_FACTORY_VERSION}\n`);
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
  assert.equal(requests[0]?.method, 'POST');
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

test('code-factory-cli lists related Requirements and messages a related RD Agent', async () => {
  const requests: CapturedRequest[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  const runtime = testRuntime(requests, output, errors);

  const relatedExitCode = await runCodeFactoryCli(['requirement', 'related'], runtime);
  const messageExitCode = await runCodeFactoryCli([
    'requirement', 'message',
    '--requirement-id', 'req_parent',
    '--message', 'The shared contract now uses field version 2.',
  ], runtime);

  assert.equal(relatedExitCode, 0);
  assert.equal(messageExitCode, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, [{
    url: 'http://127.0.0.1:4310/api/agent/requirements/req_cli/related?sourceSessionId=ses_cli',
    method: 'GET',
    body: {},
  }, {
    url: 'http://127.0.0.1:4310/api/agent/requirements/req_cli/related/req_parent/messages',
    method: 'POST',
    body: {
      sourceSessionId: 'ses_cli',
      message: 'The shared contract now uses field version 2.',
    },
  }]);
});

test('code-factory-cli reads complete, head, tail, and paginated Requirement conversations', async () => {
  const requests: CapturedRequest[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  const runtime = testRuntime(requests, output, errors);

  assert.equal(await runCodeFactoryCli(['requirement', 'conversation'], runtime), 0);
  assert.equal(await runCodeFactoryCli([
    'requirement', 'conversation', '--requirement-id', 'req_parent', '--head', '5',
  ], runtime), 0);
  assert.equal(await runCodeFactoryCli(['requirement', 'conversation', '--tail', '7'], runtime), 0);
  assert.equal(await runCodeFactoryCli([
    'requirement', 'conversation', '--page', '3', '--page-size', '25',
  ], runtime), 0);

  assert.deepEqual(errors, []);
  assert.deepEqual(requests.map(({ url, method }) => ({ url, method })), [{
    url: 'http://127.0.0.1:4310/api/requirements/req_cli/messages',
    method: 'GET',
  }, {
    url: 'http://127.0.0.1:4310/api/requirements/req_parent/messages?head=5',
    method: 'GET',
  }, {
    url: 'http://127.0.0.1:4310/api/requirements/req_cli/messages?tail=7',
    method: 'GET',
  }, {
    url: 'http://127.0.0.1:4310/api/requirements/req_cli/messages?page=3&pageSize=25',
    method: 'GET',
  }]);
});

test('code-factory-cli rejects conflicting Requirement conversation selections', async () => {
  const requests: CapturedRequest[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  const exitCode = await runCodeFactoryCli([
    'requirement', 'conversation', '--head', '5', '--page', '2',
  ], testRuntime(requests, output, errors));

  assert.equal(exitCode, 2);
  assert.deepEqual(requests, []);
  assert.match(errors.join(''), /mutually exclusive/);
  assert.match(errors.join(''), /Usage: code-factory-cli requirement conversation/);
});

test('code-factory-cli registers, shows, and cancels RD wake-up timers', async () => {
  const requests: CapturedRequest[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  const runtime = testRuntime(requests, output, errors);

  const registerExitCode = await runCodeFactoryCli([
    'timer', 'register', '--description', 'Check compiler status', '--after-seconds', '3600', '--repeat',
  ], runtime);
  const showExitCode = await runCodeFactoryCli(['timer', 'show'], runtime);
  const cancelExitCode = await runCodeFactoryCli([
    'timer', 'cancel', '--id', 'tmr-123',
  ], runtime);

  assert.equal(registerExitCode, 0);
  assert.equal(showExitCode, 0);
  assert.equal(cancelExitCode, 0);
  assert.deepEqual(errors, []);
  assert.match(output.join(''), /"id":"tmr-123"/);
  assert.match(output.join(''), /"description":"Check compiler status"/);
  assert.deepEqual(requests, [{
    url: 'http://127.0.0.1:4310/api/requirements/req_cli/timers',
    method: 'POST',
    body: { description: 'Check compiler status', schedule: 'recurring', intervalSeconds: 3_600 },
  }, {
    url: 'http://127.0.0.1:4310/api/requirements/req_cli/timers',
    method: 'GET',
    body: {},
  }, {
    url: 'http://127.0.0.1:4310/api/requirements/req_cli/timers/tmr-123',
    method: 'DELETE',
    body: {},
  }]);
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

test('code-factory-cli requires a timer description without sending a request', async () => {
  const requests: CapturedRequest[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  const exitCode = await runCodeFactoryCli([
    'timer', 'register', '--after-seconds', '3600',
  ], testRuntime(requests, output, errors));

  assert.equal(exitCode, 2);
  assert.deepEqual(requests, []);
  assert.match(errors.join(''), /--description is required/);
  assert.match(errors.join(''), /Usage: code-factory-cli timer register/);
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
