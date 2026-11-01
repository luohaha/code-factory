import { cpSync } from 'node:fs';

// Include the npx usage skill in the published package.
cpSync(
  new URL('../../../skills/code-factory-manager-cli/', import.meta.url),
  new URL('../dist/skills/code-factory-manager-cli/', import.meta.url),
  { recursive: true },
);
