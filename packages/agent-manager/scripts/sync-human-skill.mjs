import { cpSync } from 'node:fs';

// Include the npx usage skill in the published package.
cpSync(
  new URL('../../../skills/code-factory-human-cli/', import.meta.url),
  new URL('../dist/skills/code-factory-human-cli/', import.meta.url),
  { recursive: true },
);
