# E2B glob/minimatch dependency remediation

Requirement: `req_323edcaa-e764-4dad-a1d0-0017e85c5f5e`. Registry and advisory assessment: 2026-11-01.

## Findings and selected resolution

The v0.2.10 Agent Manager lockfile resolved `e2b@2.61.0 → glob@13.0.6 → minimatch@10.2.6`. Production `npm audit` reported three moderate findings: the two vulnerable packages and the affected E2B parent. The dashboard production audit was clean. The existing high-severity release threshold did not block these findings.

- [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) affects glob 9.0.0 through 14.0.1; 14.0.2 fixes traversal continuing after an AbortSignal cancellation.
- [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) affects minimatch below 11.0.1. Pattern preprocessing at optimization level 2 can amplify globparts and then perform quadratic comparisons.

The latest published E2B, 2.62.0, still declares `glob: ^13.0.6`. Upgrading E2B alone therefore does not fix either finding. Do not apply npm's proposed downgrade to E2B 2.0.3.

Keep the already integrated E2B SDK at exactly 2.61.0 and apply a single scoped override, `e2b → glob: 14.0.3`. Its supported dependency graph supplies minimatch 11.0.3 and path-scurry 3.0.0. Do not override minimatch alone underneath glob 13: minimatch 11 removes APIs consumed by the older glob implementation. There are no unrelated dependency upgrades.

## Delivering the fix through npm

An override alone fixes a source checkout but does not fix the published application: [npm only applies overrides from the installing project's root manifest](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#overrides). The application's package-lock is not shipped. A disposable npm 11.4.2 experiment also re-resolved the out-of-range glob to 13.0.6 when installing an overridden shrinkwrap package.

`bundleDependencies: ["e2b"]` includes the resolved E2B subtree in the application tarball, preserving the patched versions when installed by a consumer without overrides. Other application dependencies remain ordinary registry dependencies. npm includes the bundled packages' license/notice files. The lockfile retains registry URLs and integrity hashes, and clean `npm ci` is still required before release.

This increases the tarball size and snapshots E2B's transitive dependencies until the next application release. npm's dependency-tree display (`npm ls`) can report glob as `invalid` against E2B's original `^13.0.6` declaration; this is the intentional major-version override, not a failed installation. Verify actual resolution and behavior with `node scripts/check-e2b-dependencies.mjs` and the installed-package smoke, rather than treating a successful source audit as sufficient.

When updating this bundled subtree, temporarily remove `bundleDependencies`, update the dependencies/override and lockfile, then restore the bundle setting and regenerate the lockfile before `npm ci`. npm may otherwise retain the previously bundled versions. Review the resulting dependency diff and rerun all checks below.

## Compatibility and regression checks

The [glob 14 changelog](https://github.com/isaacs/node-glob/blob/main/changelog.md) and [minimatch 11 changelog](https://github.com/isaacs/minimatch/blob/main/changelog.md) describe changes to matcher internals and some Bash/Windows/ignore edge cases. glob 14 also moves to path-scurry 3. All three support the application's Node >=22.19.0 baseline. E2B uses the public async `glob()` API with Path objects, dotfiles, a cwd, and custom ignore callbacks for local template file discovery/hashing. It does not use the removed minimatch APIs directly.

Native E2B commands, files, lifecycle operations and cancellation use Sandbox SDK APIs, not local template globbing. This change preserves their SDK version and application implementation. The normal suite exercises these paths with deterministic fake SDK clients; no paid remote sandbox or live provider credentials are needed for this dependency change.

`scripts/check-e2b-dependencies.mjs` resolves from the package under test and checks:

- Actual E2B/glob/minimatch versions, including after tarball installation.
- glob's ESM entry, globstar/brace matching, dotfiles and Path results.
- Public E2B `Template.toJSON(..., true)` hashing, recursive directory discovery, `.dockerignore` exclusion and re-inclusion, and included dotfile changes.
- AbortController cancellation and AbortSignal timeout with an in-flight directory listing: no child traversal or directory reads after rejection.
- minimatch optimization level 2 respecting a configured expansion bound for a repeated `**/..` pattern.

The backend suite runs this check in a bounded subprocess. `release:smoke` repeats it against the installed tarball and audits that installation at the moderate threshold before checking HTTP health and dashboard HTML. The general `release:audit` blocking threshold remains high.

Validation commands:

```bash
npm ci --prefix apps/web
npm ci --prefix packages/agent-manager
npm --prefix packages/agent-manager run release:audit
npm --prefix packages/agent-manager test
npm --prefix packages/agent-manager run typecheck
npm --prefix packages/agent-manager run release:check
```

Validation on 2026-11-01: clean installs succeeded; both production audits returned zero vulnerabilities. All 328 backend tests and type checking passed on Node 24.4.0. The full `release:check` also passed on the minimum supported Node 22.19.0 with npm 10.9.3, including all 328 tests, version/license checks, type checking, the production dashboard build, tarball installation, installed dependency regression checks, a zero-finding production audit, and HTTP smoke for `GET /api/health` and `GET /`. The tarball was approximately 5.0 MB compressed / 22.3 MB unpacked, with 24 bundled dependencies. No generated build output was committed.

## Upstream follow-up condition

Remove the override and E2B bundle together once a compatible E2B release declares a patched glob range (at least 14.0.2) with patched minimatch (at least 11.0.1), and both clean source and tarball installations pass audits and these checks without overrides. Until then, assess E2B updates explicitly rather than automatically widening its version range. Windows-specific matching and live E2B network behavior are not covered by the local checks.
