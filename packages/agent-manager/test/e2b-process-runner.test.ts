import assert from 'node:assert/strict';
import test from 'node:test';

import type { CommandHandle } from 'e2b';

import { CodexAdapter } from '../src/adapters/codex.js';
import type { E2BHandle } from '../src/e2b-execution-env.js';
import { E2BProcessRunner } from '../src/e2b-process-runner.js';

test('E2B Reviewer runs the provider CLI in the selected remote workspace and streams stdin', async () => {
  const observed: { command?: string; cwd?: string; input?: string; envs?: Record<string, string> } = {};
  const sandbox = { sandboxId: 'remote-1', commands: {
    async run(command: string, options: { cwd: string; envs: Record<string, string>;
      onStdout: (chunk: string) => void; background: boolean; stdin: boolean }) {
      observed.command = command;
      observed.cwd = options.cwd;
      observed.envs = options.envs;
      assert.equal(options.background, true);
      assert.equal(options.stdin, true);
      return {
        sendStdin: async (input: string) => { observed.input = input; },
        closeStdin: async () => undefined,
        kill: async () => true,
        wait: async () => {
          options.onStdout('{"type":"item.completed","item":{"type":"agent_message","text":"Reviewed');
          options.onStdout(' from remote"}}\n');
          return { exitCode: 0 };
        },
      } as CommandHandle;
    },
  } } as E2BHandle;
  const adapter = new CodexAdapter();
  const invocation = adapter.buildReviewInvocation({ prompt: 'Review PR 1', developerInstructions: 'Review only' });
  const events: string[] = [];
  const outcome = await new E2BProcessRunner(sandbox, { GH_TOKEN: 'test-token' }).run({
    invocation, adapter, workspaceRoot: '/home/user/repo', timeoutMs: 30_000, maxOutputBytes: 65_536,
    onEvent: (event) => { if (event.message) events.push(event.message); },
  });
  assert.equal(observed.cwd, '/home/user/repo');
  assert.equal(observed.input, 'Review PR 1');
  assert.equal(observed.envs?.GH_TOKEN, 'test-token');
  assert.match(observed.command ?? '', /^'codex' 'exec'/);
  assert.equal(outcome.status, 'succeeded');
  assert.deepEqual(events, ['Reviewed from remote']);
});
