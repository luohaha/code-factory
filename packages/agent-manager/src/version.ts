import { readFileSync } from 'node:fs';

interface PackageMetadata {
  version?: unknown;
}

const packageMetadata: PackageMetadata = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageMetadata;

if (typeof packageMetadata.version !== 'string' || !packageMetadata.version) {
  throw new Error('Agent Manager package.json must contain a version');
}

/** The installed Code Factory release version, sourced from package.json. */
export const CODE_FACTORY_VERSION = packageMetadata.version;
