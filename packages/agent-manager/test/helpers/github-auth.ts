import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { TestContext } from 'node:test';

/** Exercise the real CLI invocation without reading the developer's GitHub credentials. */
export function fakeGitHubAuth(t: TestContext, token: string | null,
  environment: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-gh-auth-'));
  const calls = join(directory, 'calls');
  writeFileSync(join(directory, 'gh'), [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    token === null ? "process.stderr.write('login failed: secret-diagnostic'); process.exit(1);"
      : `process.stdout.write(${JSON.stringify(token)});`,
  ].join('\n'), { mode: 0o755 });
  const patch: Record<string, string | undefined> = {
    GH_TOKEN: undefined, GITHUB_TOKEN: undefined,
    PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`, ...environment,
  };
  const saved = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return { calls: () => existsSync(calls) ? readFileSync(calls, 'utf8') : '' };
}
