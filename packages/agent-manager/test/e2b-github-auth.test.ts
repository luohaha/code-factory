import assert from 'node:assert/strict';
import test from 'node:test';

import { e2bGitHubEnvironment } from '../src/e2b-github-auth.js';
import { fakeGitHubAuth } from './helpers/github-auth.js';

test('E2B GitHub authentication prefers explicit tokens over the local gh login', async (t) => {
  const gh = fakeGitHubAuth(t, 'local-token', { GH_TOKEN: 'gh-token', GITHUB_TOKEN: 'github-token' });
  assert.deepEqual(await e2bGitHubEnvironment(true), { GH_TOKEN: 'gh-token' });
  delete process.env.GH_TOKEN;
  assert.deepEqual(await e2bGitHubEnvironment(true), { GH_TOKEN: 'github-token' });
  process.env.GH_TOKEN = '';
  assert.deepEqual(await e2bGitHubEnvironment(true), { GH_TOKEN: 'github-token' });
  assert.equal(gh.calls(), '');
});

test('E2B GitHub authentication uses the host github.com account independent of GH_HOST', async (t) => {
  const gh = fakeGitHubAuth(t, 'local-token\n', { GH_HOST: 'git.example' });
  assert.deepEqual(await e2bGitHubEnvironment(true), { GH_TOKEN: 'local-token' });
  assert.equal(gh.calls(), '["auth","token","--hostname","github.com"]\n');
  assert.equal(process.env.GH_TOKEN, undefined);
});

test('E2B GitHub authentication leaves sandbox authentication available when local gh fails or returns no token', async (t) => {
  for (const token of [null, '\n']) {
    await t.test(String(token), async (t) => {
      fakeGitHubAuth(t, token);
      assert.deepEqual(await e2bGitHubEnvironment(true), {});
    });
  }
});

test('E2B GitHub authentication does not read or forward host credentials when disabled', async (t) => {
  const gh = fakeGitHubAuth(t, 'local-token', { GH_TOKEN: 'gh-token', GITHUB_TOKEN: 'github-token' });
  assert.deepEqual(await e2bGitHubEnvironment(false), {});
  assert.equal(gh.calls(), '');
});
