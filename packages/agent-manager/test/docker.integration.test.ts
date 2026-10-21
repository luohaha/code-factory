import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { AgentAdapter } from '../src/adapters/types.ts';
import { NativeAgentService } from '../src/native-agent.ts';
import { NativeProfileStore, nativeAuthDatabasePath, profileModel } from '../src/native-auth.ts';
import { HeadlessProcessRunner } from '../src/process-runner.ts';

const image = process.env.CODE_FACTORY_DOCKER_TEST_IMAGE;

test('real Docker enforces cgroup limits, shares home/UID, reaches host localhost and runs Native with saved credentials',
  { skip: !image, timeout: 60_000 }, async () => {
    const directory = await mkdtemp(join(homedir(), '.code-factory-docker-test-'));
    const server = createServer((request, response) => {
      if (request.url === '/probe') { response.end('host-network-ok'); return; }
      assert.equal(request.headers.authorization, 'Bearer local-test-profile');
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"id":"test","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Native container works"},"finish_reason":null}]}\n\n');
      response.write('data: {"id":"test","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
      response.end('data: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const docker = { image: image!, cpus: 0.5, memoryMb: 512 };
    const adapter: AgentAdapter = { provider: 'codex', parseLine: () => null,
      buildRdInvocation: () => { throw new Error('unused'); }, buildReviewInvocation: () => { throw new Error('unused'); } };
    let output = '';
    const service = new NativeAgentService(join(directory, 'native.sqlite'));
    try {
      const outcome = await new HeadlessProcessRunner().run({ docker, workspaceRoot: directory, adapter,
        environment: { GH_TOKEN: 'local-test-token' }, timeoutMs: 20_000, maxOutputBytes: 1024 * 1024,
        onOutput: (line) => { output = line; }, invocation: { command: 'node', input: '', args: ['--input-type=module', '-e', `
          import { readFileSync, writeFileSync } from 'node:fs';
          import { execFileSync } from 'node:child_process';
          import { userInfo } from 'node:os';
          const memory = readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
          const cpu = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(' ').map(Number);
          for (const command of ['gh', 'codex', 'claude']) execFileSync(command, ['--version']);
          execFileSync('ssh', ['-G', '-F', '/dev/null', 'github.com'], { stdio: ['ignore', 'pipe', 'pipe'] });
          const network = await (await fetch(${JSON.stringify(`${base}/probe`)})).text();
          writeFileSync('shared-output', 'home-write-ok');
          console.log(JSON.stringify({ memory, cpu, network, home: process.env.HOME, uid: process.getuid(), cwd: process.cwd(), username: userInfo().username, userHome: userInfo().homedir, groups: process.getgroups() }));
        `] } });
      assert.equal(outcome.status, 'succeeded', outcome.error ?? '');
      const result = JSON.parse(output) as { memory: string; cpu: number[]; network: string; home: string; uid: number; cwd: string; username: string; userHome: string; groups: number[] };
      assert.equal(Number(result.memory), 512 * 1024 * 1024);
      assert.equal(result.cpu[0]! / result.cpu[1]!, 0.5);
      assert.equal(result.network, 'host-network-ok');
      assert.equal(result.home, homedir());
      assert.equal(result.uid, process.getuid?.());
      assert.equal(result.username, userInfo().username);
      assert.equal(result.userHome, homedir());
      for (const group of process.getgroups?.() ?? []) assert(result.groups.includes(group));
      assert.equal(result.cwd, directory);
      assert.equal(await readFile(join(directory, 'shared-output'), 'utf8'), 'home-write-ok');
      const profiles = new NativeProfileStore(nativeAuthDatabasePath(join(directory, 'native.sqlite')));
      const profile = profiles.save({ format: 'openai', baseUrl: `${base}/v1`, apiKey: 'local-test-profile', modelName: 'test-model' });
      profiles.close();
      const native = await service.run({ requirementId: 'req_integration', sessionId: 'ses_integration', nativeSessionId: null,
        docker, prompt: 'Say hello', model: profileModel(profile.id), reasoningEffort: null, cwd: directory,
        environment: { GH_TOKEN: 'local-test-token' }, instructions: 'Test agent', signal: new AbortController().signal,
        timeoutMs: 20_000, onEvent: () => undefined, onNativeSession: () => undefined });
      assert.equal(native.status, 'succeeded', native.error ?? '');
      assert.equal(native.finalMessage, 'Native container works');
    } finally { await service.close(); server.close(); await rm(directory, { recursive: true, force: true }); }
  });
