# Development Guide

Code Factory contains two independently installed Node.js packages and has no root package scripts:

- `packages/agent-manager/` contains the TypeScript Agent Manager, both CLIs, and the npm package definition;
- `apps/web/` contains the React dashboard bundled into the published package during the Agent Manager build.

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
npm run lint
npx tsc --noEmit
npm run build
~~~

Before a release, follow the additional audit, version, changelog, and package-content checks in the [release guide](releasing.md).
