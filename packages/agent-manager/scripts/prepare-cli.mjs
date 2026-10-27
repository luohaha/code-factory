import { chmodSync, readFileSync, statSync } from 'node:fs';

const packageRoot = new URL('../', import.meta.url);
const { bin } = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8'));

// TypeScript recreates these files without executable bits. Restore them after
// each build so existing npm links continue to work without another npm link.
for (const entrypoint of Object.values(bin)) {
  const path = new URL(entrypoint, packageRoot);
  chmodSync(path, statSync(path).mode | 0o111);
}
