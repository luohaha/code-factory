import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { CODE_FACTORY_VERSION } from '../src/version.ts';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

test('Agent Manager CLI reports the package version', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--version'], {
    cwd: packageRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${CODE_FACTORY_VERSION}\n`);
  assert.equal(result.stderr, '');
});
