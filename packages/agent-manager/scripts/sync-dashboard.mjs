import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
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

console.log(`Dashboard bundled from ${source}`);
