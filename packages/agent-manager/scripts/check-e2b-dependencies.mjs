#!/usr/bin/env node
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Resolve from the tested package, including when it is installed from a tarball.
const packageRoot = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(join(packageRoot, 'package.json'));
const e2bRequire = createRequire(require.resolve('e2b'));
const globRequire = createRequire(e2bRequire.resolve('glob'));
const globPackagePath = e2bRequire.resolve('glob/package.json');
const globPackage = e2bRequire('glob/package.json');
assert.equal(require('e2b/package.json').version, '2.61.0');
assert.equal(globPackage.version, '14.0.3');
assert.equal(globRequire('minimatch/package.json').version, '11.0.3');
const { Minimatch } = globRequire('minimatch');
const amplified = new Minimatch('**/../a/b/'.repeat(12) + 'target.txt', {
  optimizationLevel: 2, braceExpandMax: 64,
});
assert(amplified.set.length <= 64, 'globparts preprocessing must respect the expansion limit');
assert.equal(amplified.match('target.txt'), false);

// Exercise the ESM entry that E2B dynamically imports, rather than a host copy.
const { glob } = await import(pathToFileURL(join(dirname(globPackagePath), globPackage.module)).href);
const { Template } = await import(pathToFileURL(require.resolve('e2b')).href);
const directory = fs.mkdtempSync(join(tmpdir(), 'code-factory-e2b-dependencies-'));
try {
  for (const path of ['src/nested', 'src/ignored']) fs.mkdirSync(join(directory, path), { recursive: true });
  for (const path of ['src/.hidden.txt', 'src/file.txt', 'src/nested/entry.js', 'src/ignored/drop.txt', 'src/ignored/keep.txt']) {
    fs.writeFileSync(join(directory, path), path);
  }
  fs.writeFileSync(join(directory, '.dockerignore'), 'src/ignored\n!src/ignored/keep.txt\n');
  const files = await glob('src/**/*.{txt,js}', { cwd: directory, dot: true, withFileTypes: true });
  assert.deepEqual(files.map((entry) => entry.relativePosix()).sort(), [
    'src/.hidden.txt', 'src/file.txt', 'src/ignored/drop.txt', 'src/ignored/keep.txt', 'src/nested/entry.js',
  ]);
  assert(files.every((entry) => entry.isFile() && fs.existsSync(entry.fullpath())));

  // Public SDK template hashing exercises recursive traversal, Path objects,
  // dotfiles and the .dockerignore matcher without creating a remote sandbox.
  const template = Template({ fileContextPath: directory }).fromImage('node:22').copy('src', '/app');
  const hash = async () => {
    const data = JSON.parse(await Template.toJSON(template, true));
    assert.match(data.steps[0].filesHash, /^[a-f0-9]{64}$/);
    return data.steps[0].filesHash;
  };
  const initial = await hash();
  fs.writeFileSync(join(directory, 'src/ignored/drop.txt'), 'ignored change');
  assert.equal(await hash(), initial);
  fs.writeFileSync(join(directory, 'src/ignored/keep.txt'), 're-included change');
  const included = await hash();
  assert.notEqual(included, initial);
  fs.writeFileSync(join(directory, 'src/.hidden.txt'), 'dotfile change');
  assert.notEqual(await hash(), included);

  for (const timeout of [false, true]) {
    const controller = new AbortController();
    let reads = 0;
    let readsAfterReject = 0;
    let rejected = false;
    const traversal = glob('**/*', {
      cwd: directory, signal: controller.signal,
      fs: {
        ...fs,
        readdir(path, options, callback) {
          reads++;
          if (rejected) readsAfterReject++;
          if (timeout && reads === 1) {
            // Start the deadline only once traversal begins, so a busy test
            // runner cannot expire it before any filesystem work is issued.
            const deadline = AbortSignal.timeout(1);
            deadline.addEventListener('abort', () => controller.abort(deadline.reason), { once: true });
          }
          fs.readdir(path, options, (error, entries) => {
            // Return an in-flight directory listing after cancellation, as in
            // the advisory. The walker must not schedule any child reads.
            if (timeout) setTimeout(() => callback(error, entries), 20);
            else { controller.abort(new Error('probe-abort')); callback(error, entries); }
          });
        },
      },
    });
    await assert.rejects(traversal, timeout ? { name: 'TimeoutError' } : /probe-abort/);
    rejected = true;
    await delay(100);
    assert.equal(reads, 1);
    assert.equal(readsAfterReject, 0);
  }
  console.log('E2B dependency checks passed: SDK hashing, glob matching, amplification limit, cancellation and timeout; glob 14.0.3 / minimatch 11.0.3');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
