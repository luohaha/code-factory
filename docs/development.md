# Development Guide

Code Factory contains two independently installed Node.js packages and has no root package scripts:

- `packages/agent-manager/` contains the TypeScript Agent Manager, both CLIs, and the npm package definition;
- `apps/web/` contains the React dashboard bundled into the published package during the Agent Manager build.

## Agent Manager source layout

`packages/agent-manager/src/` groups modules by responsibility:

| Directory | Contents |
| --- | --- |
| `core/` | Agent Manager orchestration and shared domain types |
| `runtime/` | Native Agent, E2B execution and file transfer, provider credentials, model discovery, process runner, and `adapters/` for Codex and Claude Code |
| `storage/` | Store interface, SQLite implementation, schema, and search indexing helpers |
| `triggers/` | Agent trigger contract and timers |
| `triggers/github/` | GitHub client, PR reconciliation and triggers, and repository identity |
| `jev/` | Jev wake and inter-agent message decisions |
| `http/` | HTTP/SSE API and bundled dashboard serving |
| `cli/` | CLI command implementations, RD CLI launcher, daemon, and startup banner |
| `infrastructure/` | Workspace configuration, logging, package version, and workspace lock |

The top-level `index.ts` preserves the public package exports. `cli.ts` and `code-factory-cli-main.ts` remain the published executable entrypoints, so commands still use `dist/cli.js` and `dist/code-factory-cli-main.js`. Relative module imports retain explicit `.js` suffixes. The build removes the previous `dist/` output before compiling so moved or deleted modules cannot linger in the package.

## Install dependencies manually

Install each package from the repository root. Use `npm ci` when reproducing the checked-in lockfiles:

~~~bash
npm ci --prefix apps/web
npm ci --prefix packages/agent-manager
~~~

When intentionally changing dependencies, run `npm install` in the corresponding package directory so only its lockfile is updated.

## Build and run a source checkout

Build Agent Manager and its bundled dashboard:

~~~bash
npm --prefix packages/agent-manager run build
~~~

Then start the built CLI from the repository you want Code Factory to manage:

~~~bash
cd /path/to/your-project
node /path/to/code-factory/packages/agent-manager/dist/cli.js start --open
~~~

The startup directory, rather than the Code Factory source checkout, becomes the managed workspace.

## Install a local development package

To exercise the same package layout that npm users receive, build a tarball:

~~~bash
cd /path/to/code-factory/packages/agent-manager
npm pack
~~~

`npm pack` prints the generated filename. Install that exact tarball globally, then run the CLI from a managed repository. For example, version `0.1.0` produces `luoyixin-code-factory-0.1.0.tgz`:

~~~bash
npm install --global ./luoyixin-code-factory-0.1.0.tgz

cd /path/to/your-project
code-factory-agent-manager start --open
~~~

For faster iteration after a build, link the package instead:

~~~bash
cd /path/to/code-factory/packages/agent-manager
npm run build
npm link

cd /path/to/your-project
code-factory-agent-manager start --open
~~~

Remove the global development link when finished:

~~~bash
npm unlink --global @luoyixin/code-factory
~~~

## Verification

Run Agent Manager checks:

~~~bash
cd packages/agent-manager
npm test
npm run typecheck
npm run build
~~~

Run dashboard checks:

~~~bash
cd apps/web
npm test
npm run lint
npx tsc --noEmit
npm run build
~~~

Run the dashboard browser regression tests with Chromium:

~~~bash
cd apps/web
npx playwright install chromium
npm run test:browser
~~~

The browser tests start and stop an isolated Vite server and mock Agent Manager responses, so they do not read or change a running workspace. Test files run sequentially because their servers share the project's local Wrangler state. To use an installed Google Chrome instead of downloading Chromium, run `PLAYWRIGHT_CHANNEL=chrome npm run test:browser`.

CI pins the GitHub Actions runner to `ubuntu-24.04`. The locked Playwright `1.58.2` explicitly [supports Ubuntu 24.04](https://github.com/microsoft/playwright/blob/v1.58.2/packages/playwright-core/src/server/utils/hostPlatform.ts) and provides its [Chromium system dependencies](https://github.com/microsoft/playwright/blob/v1.58.2/packages/playwright-core/src/server/registry/nativeDeps.ts). Using `ubuntu-latest` selected Ubuntu 26.04, where that Playwright version rejects Chromium installation. Pinning the supported image restores compatibility without changing dependencies or the minimum supported Node.js version (`22.19.0`). CI continues to run `npx playwright install --with-deps chromium`, `npm run test:browser`, and Agent Manager's `npm run release:check`. Before changing the runner image or Playwright version, verify all three on the proposed image.

Before a release, follow the additional audit, version, changelog, and package-content checks in the [release guide](releasing.md).

## Dashboard development dependency audit

The dashboard's October 2026 dependency refresh reduced `npm audit` from 21 findings (3 critical, 15 high, 3 moderate) to 10 high findings. `npm audit --omit=dev` reports zero production findings. The refresh updates Vinext, the Cloudflare Vite plugin, Wrangler, workers types, oxfmt, and shadcn; it also refreshes compatible transitive packages. Vite itself has no finding in the audit. The remaining 10 entries all trace to the same [unpatched `braces` stack exhaustion advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm); npm counts each affected package in the dependency chain. The paths are `vinext` → `vite-plugin-commonjs` → `vite-plugin-dynamic-import` → `fast-glob` → `micromatch` → `braces`, and `shadcn` → `fast-glob` / `ts-morph` / `@shadcn/registry` → `micromatch` → `braces`. The dashboard imports `shadcn/tailwind.css`, so removing the CLI package is not a drop-in fix. Recheck these paths when `braces`, `fast-glob`, Vinext, or shadcn publish a compatible fix; do not use npm's suggested downgrades to older Vinext or shadcn releases.

The dashboard overrides `sharp` to `0.35.5` and `fflate` to `0.7.5` because current Miniflare and Satori releases still select vulnerable patch versions. Both overrides stay within their existing release lines. Remove each override once its parent selects a patched version, then rerun `npm ci`, the dashboard checks above, and `npm audit`.
