import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sourceUrl = new URL('../../../apps/web/dist/', import.meta.url);
const source = fileURLToPath(sourceUrl);
const target = fileURLToPath(new URL('../dashboard/', import.meta.url));

if (!existsSync(new URL('server/index.js', sourceUrl))) {
  throw new Error(`Dashboard build is missing at ${source}. Run the Web build first.`);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });

// Some Vinext builds leave a static cloudflare:workers import in the worker
// entry. The published dashboard runs inside Node, where that URL scheme
// cannot be imported. Only add the shim when the import is present.
const workerEntry = fileURLToPath(new URL('server/index.js', new URL('../dashboard/', import.meta.url)));
const workerSource = readFileSync(workerEntry, 'utf8');
const workersImport = /from\s*(["'])cloudflare:workers\1/g;
const matches = [...workerSource.matchAll(workersImport)];
if (matches.length > 1) {
  throw new Error(`Expected at most one cloudflare:workers import in the dashboard worker, found ${matches.length}`);
}
if (matches.length === 1) {
  writeFileSync(workerEntry, workerSource.replace(workersImport, 'from"./node-cloudflare-workers.js"'));
  writeFileSync(fileURLToPath(new URL('server/node-cloudflare-workers.js', new URL('../dashboard/', import.meta.url))),
    'export const tracing = undefined;\n');
}

console.log(`Dashboard bundled from ${source}`);
