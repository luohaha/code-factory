import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

test('CLI links remain executable after build output is recreated', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'code-factory-cli-permissions-'));
  const metadata = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const { bin } = JSON.parse(metadata) as { bin: Record<string, string> };

  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'package.json'), metadata);
    const script = join(root, 'scripts', 'prepare-cli.mjs');
    copyFileSync(new URL('../scripts/prepare-cli.mjs', import.meta.url), script);

    for (const [name, entrypoint] of Object.entries(bin)) {
      symlinkSync(join(root, entrypoint), join(root, 'bin', name));
    }

    for (let build = 0; build < 2; build += 1) {
      rmSync(join(root, 'dist'), { recursive: true, force: true });
      for (const entrypoint of Object.values(bin)) {
        const path = join(root, entrypoint);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, '#!/usr/bin/env node\nprocess.stdout.write("CLI works\\n");\n');
        chmodSync(path, 0o644);
      }
      const library = join(root, 'dist', 'index.js');
      writeFileSync(library, 'export {};\n');
      chmodSync(library, 0o644);

      const prepared = spawnSync(process.execPath, [script], { cwd: tmpdir(), encoding: 'utf8' });
      assert.equal(prepared.status, 0, prepared.stderr);
      assert.equal(statSync(library).mode & 0o777, 0o644);

      for (const name of Object.keys(bin)) {
        const result = spawnSync(join(root, 'bin', name), [], { encoding: 'utf8' });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, 'CLI works\n');
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
