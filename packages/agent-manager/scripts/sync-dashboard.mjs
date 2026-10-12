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

// Vinext's optional Workers tracing currently leaves a static
// cloudflare:workers import in the worker entry. The published dashboard runs
// inside Node, where that URL scheme cannot be imported. Only the packaged
// copy needs this shim; the original build remains usable by Wrangler.
const workerEntry = fileURLToPath(new URL('server/index.js', new URL('../dashboard/', import.meta.url)));
const workerSource = readFileSync(workerEntry, 'utf8');
const workersImport = /from\s*(["'])cloudflare:workers\1/g;
const matches = [...workerSource.matchAll(workersImport)];
if (matches.length !== 1) {
  throw new Error(`Expected one cloudflare:workers import in the dashboard worker, found ${matches.length}`);
}
writeFileSync(workerEntry, workerSource.replace(workersImport, 'from"./node-cloudflare-workers.js"'));
writeFileSync(fileURLToPath(new URL('server/node-cloudflare-workers.js', new URL('../dashboard/', import.meta.url))),
  'export const tracing = undefined;\n');

console.log(`Dashboard bundled from ${source}`);
