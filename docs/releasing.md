# Releasing Code Factory

Code Factory follows [Semantic Versioning](https://semver.org/). Until `1.0.0`, a minor release may include breaking changes. Stable release tags use the exact form `vMAJOR.MINOR.PATCH`; the first planned release is `v0.1.0`.

## Version sources

`packages/agent-manager/package.json` is the canonical product and published-package version. `scripts/set-version.mjs` updates it together with the private dashboard manifest and both npm lockfiles. `scripts/check-version.mjs` rejects invalid SemVer, an unexpected published package name, mismatched files, a mismatched release tag, or a missing changelog entry.

At runtime, Agent Manager reads its installed `package.json`. The same value is exposed by:

- `code-factory-agent-manager --version` (also `-v` or `version`);
- `code-factory-cli --version` (also `-v`);
- the Agent Manager startup banner;
- the `version` field from `GET /api/health`.

Prepare a version from the repository root:

```bash
node scripts/set-version.mjs 0.1.0
node scripts/check-version.mjs 0.1.0
```

Then update `CHANGELOG.md`. Do not create a release tag while its entry is still marked `Unreleased`.

## One-time setup before the first public release

The repository is code-ready for a tag-driven release, but a maintainer must finish these ownership and policy decisions:

1. Confirm that the `luoyixin` npm account remains controlled by the project. The intended public package name is `@luoyixin/code-factory`.
2. Keep the GitHub repository public. npm provenance is not available for a package built from a private repository, and the supplied workflow intentionally publishes with `--provenance`.
3. Create a granular npm token with direct publish permission for `@luoyixin/code-factory` or the `@luoyixin` scope and save it as the GitHub Actions repository secret `NPM_TOKEN`. After the first package version exists, prefer configuring npm trusted publishing for `luohaha/code-factory` and the exact workflow filename `release.yml`, then remove the long-lived publish token from the workflow and repository secrets.
4. Protect the GitHub repository and the npm account appropriately: require review and the `CI / verify` check on `main`, enable npm two-factor authentication, and limit who can create release tags or change Actions secrets.
5. Review the security model and public documentation. Remove private data from Git history and package contents before making the repository or package public. The repository and npm package are licensed under Apache-2.0; review bundled third-party attribution and `NOTICE` obligations before distribution.
6. Resolve all high-severity production dependency findings. The release workflow runs `npm audit --omit=dev --audit-level=high` for both packages and will block publication while such findings remain.

## Release checklist

1. Start from an up-to-date release branch based on `origin/main`. Freeze the intended changes and resolve all blocking review, CI, and production dependency audit findings.
2. Set the version with `node scripts/set-version.mjs <version>`, finish that version's `CHANGELOG.md` entry, and replace `Unreleased` with the release date.
3. Install from the lockfiles and run the release gate:

   ```bash
   npm ci --prefix apps/web
   npm ci --prefix packages/agent-manager
   npm --prefix packages/agent-manager run release:audit
   npm --prefix packages/agent-manager run release:check
   ```

   `release:audit` blocks high-severity production dependency findings. `release:check` verifies synchronized versions and Apache-2.0 license files, runs backend tests and type checking, builds the dashboard and Agent Manager, and runs `npm pack --dry-run` so the publishable file list can be inspected. `prepublishOnly` and `prepack` enforce the same core build and test checks when publishing; the tag workflow also enforces the audit.

4. Merge the release preparation pull request. From the resulting `main` commit, create and push the signed or annotated tag:

   ```bash
   git switch main
   git pull --ff-only origin main
   git tag -a v0.1.0 -m "Code Factory 0.1.0"
   git push origin v0.1.0
   ```

5. Watch the GitHub `Release` workflow. A matching stable tag verifies its version, publishes `@luoyixin/code-factory` to npm with provenance, and creates GitHub release notes only after npm publishing succeeds.
6. Verify the npm package and GitHub release, then smoke-test in a disposable repository:

   ```bash
   npx --yes --package @luoyixin/code-factory@0.1.0 code-factory-agent-manager --version
   npx --yes --package @luoyixin/code-factory@0.1.0 code-factory-agent-manager start --port 4310
   ```

   Confirm that the dashboard loads, `GET /api/health` reports `0.1.0`, a Requirement can start its selected agent, and daemon `start`, `status`, and `stop` work on every supported operating system.

## Failure and rollback

- Before npm publishing succeeds, fix the issue, move or recreate the tag only with explicit maintainer coordination, and rerun the workflow.
- npm versions are immutable. If `0.1.0` has been published with a defect, do not delete and reuse the version. Deprecate it if necessary, fix forward as `0.1.1`, and document the issue in both npm and GitHub release notes.
- If npm publishing succeeds but GitHub release creation fails, create the GitHub release for the existing tag manually; do not attempt to publish `0.1.0` again.
