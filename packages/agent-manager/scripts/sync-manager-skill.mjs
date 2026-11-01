import { cpSync } from 'node:fs';

// Keep the dependency-free CLI and its skill together in source and in npm.
cpSync(
  new URL('../../../skills/code-factory-manager-cli/', import.meta.url),
  new URL('../dist/skills/code-factory-manager-cli/', import.meta.url),
  { recursive: true },
);
