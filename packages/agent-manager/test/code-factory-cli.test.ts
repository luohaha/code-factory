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
    assert.ok(init?.signal, 'all control-plane requests have a timeout signal');
    if (method === 'GET' || method === 'DELETE') assert.equal(init?.body, undefined);
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
    runGitHub: async () => { throw new Error('Unexpected gh call'); },
    readTextFile: async () => { throw new Error('Unexpected file read'); },
    requestTimeoutMs: 30_000,
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
  assert.match(output.join(''), /requirement update/);
  assert.match(output.join(''), /requirement related/);
  assert.match(output.join(''), /requirement message/);
  assert.match(output.join(''), /CODE_FACTORY_REQUIREMENT_ID/);

  const requirementOutput: string[] = [];
  const requirementExitCode = await runCodeFactoryCli(['requirement', 'propose', '--help'], {
    writeOut: (value) => requirementOutput.push(value),
    writeError: () => undefined,
  });
  assert.equal(requirementExitCode, 0);
  assert.match(requirementOutput.join(''), /--start/);

  const updateOutput: string[] = [];
  const updateExitCode = await runCodeFactoryCli(['requirement', 'update', '--help'], {
    writeOut: (value) => updateOutput.push(value),
    writeError: () => undefined,
  });
  assert.equal(updateExitCode, 0);
  assert.match(updateOutput.join(''), /--requirement-id/);
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

test('code-factory-cli can start a proposed Requirement immediately', async () => {
  const requests: CapturedRequest[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  const exitCode = await runCodeFactoryCli([
    'requirement', 'propose',
    '--title', 'Investigate follow-up',
    '--description', 'Start this work without waiting for a human',
    '--start',
  ], testRuntime(requests, output, errors));

  assert.equal(exitCode, 0);
  assert.deepEqual(errors, []);
  assert.equal(requests[0]?.url, 'http://127.0.0.1:4310/api/agent/requirements');
  assert.deepEqual(requests[0]?.body, {
    sourceSessionId: 'ses_cli',
    parentRequirementId: 'req_cli',
    title: 'Investigate follow-up',
    description: 'Start this work without waiting for a human',
    start: true,
  });
});

test('code-factory-cli updates a proposed TODO Requirement using injected context', async () => {
  const requests: CapturedRequest[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  const exitCode = await runCodeFactoryCli([
    'requirement', 'update',
    '--requirement-id', 'req_child/value',
    '--title', 'Corrected benchmark',
    '--description', 'Measure latency as well as throughput',
  ], testRuntime(requests, output, errors));

  assert.equal(exitCode, 0);
  assert.deepEqual(errors, []);
  assert.equal(requests[0]?.url, 'http://127.0.0.1:4310/api/agent/requirements/req_child%2Fvalue');
  assert.equal(requests[0]?.method, 'PATCH');
  assert.deepEqual(requests[0]?.body, {
    sourceRequirementId: 'req_cli',
    sourceSessionId: 'ses_cli',
    title: 'Corrected benchmark',
    description: 'Measure latency as well as throughput',
  });
});

test('code-factory-cli requires a proposed Requirement update field', async () => {
  const requests: CapturedRequest[] = [];
  const errors: string[] = [];
  assert.equal(await runCodeFactoryCli([
    'requirement', 'update', '--requirement-id', 'req_child',
  ], testRuntime(requests, [], errors)), 2);
  assert.deepEqual(requests, []);
  assert.match(errors.join(''), /Provide --title, --description, or --description-file/);
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

const githubDetails = {
  number: 184, url: 'https://github.com/acme/widgets/pull/184', title: 'Current title',
  baseRefName: 'main', headRefName: 'feature/compaction', headRefOid: 'current-sha',
  state: 'OPEN', isDraft: false,
};

test('PR URL registration reads GitHub metadata and handles all lifecycle snapshots', async (t) => {
  for (const [state, isDraft, status] of [
    ['OPEN', false, 'open'], ['OPEN', true, 'draft'], ['CLOSED', true, 'closed'], ['MERGED', false, 'merged'],
  ] as const) {
    await t.test(status, async () => {
      const requests: CapturedRequest[] = [];
      const runtime = testRuntime(requests, [], []);
      runtime.runGitHub = async (args) => {
        assert.deepEqual(args, ['pr', 'view', '184', '--repo', 'acme/widgets', '--json',
          'number,url,title,baseRefName,headRefName,headRefOid,state,isDraft']);
        return JSON.stringify({ ...githubDetails, state, isDraft });
      };
      assert.equal(await runCodeFactoryCli(['pr', 'register', '--from-github', githubDetails.url], runtime), 0);
      assert.deepEqual(requests[0]?.body, {
        requirementId: 'req_cli', repository: 'acme/widgets', number: 184,
        url: githubDetails.url, title: 'Current title', baseBranch: 'main',
        headBranch: 'feature/compaction', headSha: 'current-sha', status,
      });
    });
  }
});

test('PR URL registration preserves a GitHub Enterprise host', async () => {
  const requests: CapturedRequest[] = [];
  const runtime = testRuntime(requests, [], []);
  const url = 'https://github.example.com/acme/widgets/pull/184';
  runtime.runGitHub = async (args) => {
    assert.equal(args[4], 'github.example.com/acme/widgets');
    return JSON.stringify({ ...githubDetails, url });
  };
  assert.equal(await runCodeFactoryCli(['pr', 'register', '--from-github', url], runtime), 0);
  assert.equal(requests[0]?.body.repository, 'github.example.com/acme/widgets');
});

test('invalid or ambiguous PR inputs never invoke gh or write to the API', async () => {
  for (const args of [
    ['--from-github', githubDetails.url, '--status', 'open'],
    ['--from-github', '--malicious'],
    ['--from-github', 'https://github.com/acme/widgets/issues/184'],
    ['--from-github', 'https://github.com/acme/widgets/pull/9007199254740992'],
    ['--from-github', 'https://user:password@github.com/acme/widgets/pull/184'],
    ['--from-github', `${githubDetails.url}?query=yes`],
    ['--number', '9007199254740992'],
  ]) {
    const requests: CapturedRequest[] = [];
    const errors: string[] = [];
    const runtime = testRuntime(requests, [], errors);
    assert.equal(await runCodeFactoryCli(['pr', 'register', ...args], runtime), 2, errors.join(''));
    assert.deepEqual(requests, []);
    assert.doesNotMatch(errors.join(''), /Unexpected gh call/);
  }
});

test('invalid GitHub output and gh failures do not register a PR', async () => {
  for (const result of [
    'not json', 'null', '[]',
    JSON.stringify({ ...githubDetails, number: 185 }),
    JSON.stringify({ ...githubDetails, url: 'https://github.com/other/repo/pull/184' }),
    JSON.stringify({ ...githubDetails, headRefOid: '' }),
    JSON.stringify({ ...githubDetails, state: 'UNKNOWN' }),
    JSON.stringify({ ...githubDetails, isDraft: undefined }),
    new Error('gh authentication failed'),
  ]) {
    const requests: CapturedRequest[] = [];
    const runtime = testRuntime(requests, [], []);
    runtime.runGitHub = async () => {
      if (result instanceof Error) throw result;
      return result;
    };
    assert.equal(await runCodeFactoryCli(['pr', 'register', '--from-github', githubDetails.url], runtime), 1);
    assert.deepEqual(requests, []);
  }
});

test('CLI validates injected context before reading GitHub', async () => {
  for (const environment of [
    {},
    { [CODE_FACTORY_API_URL]: 'file:///tmp/api', [CODE_FACTORY_REQUIREMENT_ID]: 'req_cli' },
    { [CODE_FACTORY_API_URL]: 'http://localhost/api?x=y', [CODE_FACTORY_REQUIREMENT_ID]: 'req_cli' },
    { [CODE_FACTORY_API_URL]: 'http://localhost/api' },
  ]) {
    const requests: CapturedRequest[] = [];
    const runtime = testRuntime(requests, [], []);
    runtime.environment = environment;
    assert.equal(await runCodeFactoryCli(['pr', 'register', '--from-github', githubDetails.url], runtime), 2);
    assert.deepEqual(requests, []);
  }
});

test('requirement description can be read from a UTF-8 file without shell interpretation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-description-'));
  try {
    const { writeFile, readFile } = await import('node:fs/promises');
    const path = join(directory, 'description with spaces.md');
    const description = '中文需求\n\nKeep `literal` and $(literal) intact.';
    await writeFile(path, description);
    const requests: CapturedRequest[] = [];
    const runtime = testRuntime(requests, [], []);
    runtime.readTextFile = (file) => readFile(file, 'utf8');
    assert.equal(await runCodeFactoryCli([
      'requirement', 'propose', '--title', 'Follow-up', '--description-file', path,
    ], runtime), 0);
    assert.equal(requests[0]?.body.description, description);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('ambiguous, empty, and unreadable description files do not create proposals', async () => {
  for (const [description, inline, expected] of [['text', true, 2], ['  ', false, 2], [null, false, 1]] as const) {
    const requests: CapturedRequest[] = [];
    const runtime = testRuntime(requests, [], []);
    runtime.readTextFile = async () => {
      if (description === null) throw new Error('ENOENT');
      return description;
    };
    assert.equal(await runCodeFactoryCli([
      'requirement', 'propose', '--title', 'Follow-up', '--description-file', 'file.md',
      ...(inline ? ['--description', 'inline'] : []),
    ], runtime), expected);
    assert.deepEqual(requests, []);
  }
});

test('API failures and malformed success responses exit nonzero without retrying writes', async () => {
  for (const response of [
    new Response('{"error":"Unknown requirement"}', { status: 404 }),
    new Response('Unavailable', { status: 503 }),
    new Response('<html>Not the API</html>'),
    new Response(''),
    new Response('null'),
    new Response('true'),
    new Response('[]'),
    new Error('fetch failed'),
  ]) {
    const output: string[] = [];
    const errors: string[] = [];
    const runtime = testRuntime([], output, errors);
    let calls = 0;
    runtime.fetch = async (_input, init) => {
      calls += 1;
      assert.ok(init?.signal);
      if (response instanceof Error) throw response;
      return response;
    };
    assert.equal(await runCodeFactoryCli(['requirement', 'propose', '--title', 'Next', '--description', 'Task'], runtime), 1);
    assert.equal(calls, 1);
    assert.deepEqual(output, []);
    assert.match(errors.join(''), /Error:/);
  }
});

test('request timeout aborts a pending write and explains the ambiguous outcome', async () => {
  const errors: string[] = [];
  const runtime = testRuntime([], [], errors);
  runtime.requestTimeoutMs = 10;
  let calls = 0;
  runtime.fetch = async (_input, init) => {
    calls += 1;
    return await new Promise<Response>((_resolve, reject) => {
      // Keep the event loop alive; AbortSignal.timeout itself is unref'ed.
      const timer = setTimeout(() => reject(new Error('Abort never arrived')), 1000);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(init.signal?.reason);
      }, { once: true });
    });
  };
  assert.equal(await runCodeFactoryCli(['requirement', 'propose', '--title', 'Next', '--description', 'Task'], runtime), 1);
  assert.equal(calls, 1);
  assert.match(errors.join(''), /timed out.*write may have succeeded.*before retrying/);
});

test('read failures omit ambiguous-write guidance while timer cancellation retains it', async () => {
  for (const args of [
    ['timer', 'show'],
    ['requirement', 'related'],
    ['timer', 'cancel', '--id', 'tmr-123'],
  ]) {
    for (const failure of ['timeout', 'invalid-json', 'invalid-object']) {
      const errors: string[] = [];
      const runtime = testRuntime([], [], errors);
      let calls = 0;
      runtime.fetch = async (_input, init) => {
        calls += 1;
        assert.ok(init?.signal);
        assert.equal(init?.body, undefined);
        if (failure === 'timeout') throw new DOMException('Timed out', 'TimeoutError');
        return new Response(failure === 'invalid-json' ? '<html>Error</html>' : 'null');
      };
      assert.equal(await runCodeFactoryCli(args, runtime), 1);
      assert.equal(calls, 1);
      if (args[1] === 'cancel') assert.match(errors.join(''), /write may have succeeded/);
      else assert.doesNotMatch(errors.join(''), /write may have succeeded/);
    }
  }
});

test('PR URL registration stores a lowercase key from the GitHub response', async () => {
  for (const host of ['github.com', 'GitHub.Example.com']) {
    const requests: CapturedRequest[] = [];
    const runtime = testRuntime(requests, [], []);
    runtime.runGitHub = async () => JSON.stringify({
      ...githubDetails, url: `https://${host}/Acme/Widgets/pull/184`,
    });
    for (const repo of ['ACME/widgets', 'acme/WIDGETS']) {
      assert.equal(await runCodeFactoryCli([
        'pr', 'register', '--from-github', `https://${host}/${repo}/pull/184`,
      ], runtime), 0);
    }
    const expected = host === 'github.com' ? 'acme/widgets' : 'github.example.com/acme/widgets';
    assert.deepEqual(requests.map((request) => request.body.repository), [expected, expected]);
  }
});
