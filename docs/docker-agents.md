# Docker resource limits for local Agents

When creating a Requirement, choose **Resource isolation → Docker** and set an image, CPU cores, and memory in MiB. This is available for Codex headless, Claude Code headless, and Native Agent in the Default or a named local workspace. Existing Requirements keep host execution until Docker is selected. E2B cannot be combined with Docker.

Each RD or Reviewer Run gets a separate container with `--cpus`, `--memory`, and `--memory-swap` equal to the memory limit (no additional swap). Manager stays on the host. Native Agent's model client, Harness, coding tools, and control-plane tools all run inside its container. Limits apply to each Run and its child processes; simultaneous Runs have separate limits.

## Prepare the runtime

Use a local Linux Docker Engine, or Docker Desktop 4.34+ on macOS with **Settings → Resources → Network → Enable host networking** enabled. Host networking keeps the Manager API, localhost model gateways, proxies, and development servers reachable. Check `docker info` for CPU/memory controller support. Docker Desktop's VM resource allocation is an additional upper bound.

Build the bundled image from this source checkout:

```bash
cd packages/agent-manager
npx tsc -p tsconfig.json
docker build -f docker/Dockerfile -t code-factory-agent:local .
```

For an installed npm package, run `docker build -f docker/Dockerfile -t code-factory-agent:local .` from the installed `@luoyixin/code-factory` package directory. Its published files include `dist` and the Dockerfile. Source builds use the package lock; installed-package builds resolve the published dependency ranges. Rebuild after upgrading Code Factory so the Native worker matches Manager. The default image includes Node.js 22, Codex, Claude Code, `gh`, Git, Bash, OpenSSH, Python, and ripgrep. Build arguments `CODEX_VERSION` and `CLAUDE_CODE_VERSION` can pin CLI versions. Add project-specific Linux tools in a derived image and select its tag in the form. Images must already exist locally; a Run does not automatically pull or build one.

## Shared paths and authentication

- The launching user's **entire home directory is mounted read/write at the same absolute path**, and `HOME` is preserved. The selected workspace, temporary handoff directory, attachment storage, Native database directory, and configured external configuration/certificate paths are also mounted when necessary. Files are written with the host UID/GID. There is no disk quota.
- Process environment values are forwarded using `--env NAME`; credential values are not placed in Docker command arguments or application logs. Linux image tools precede host tools on `PATH`. Host-specific Node loader settings are omitted.
- Codex file authentication, sessions, instructions, Skills, and configuration remain in the shared `CODEX_HOME`. On macOS, Manager can also read the normal Codex Keychain entry, mount a private temporary auth file over `auth.json`, and save refreshed credentials back to that entry when the Run ends. Existing auth files are preserved; temporary credentials and an unused mountpoint are removed. Keychain access must be permitted for the launching process.
- Existing `GH_TOKEN` / `GITHUB_TOKEN` values take precedence. Otherwise Manager resolves the current `github.com` token with the host's `gh auth token`, including Keychain-backed login, and forwards it as `GH_TOKEN`. HTTPS Git uses `gh auth git-credential` in the container so a macOS-only Git credential helper does not break GitHub pushes. Other Git hosts retain their configured helpers.
- Claude's environment API keys and file configuration are shared. On macOS, Manager can read the standard Claude Code Keychain entry and forward its access token as `CLAUDE_CODE_OAUTH_TOKEN` for that Run. For custom Keychain services or long-lived token provisioning, set a supported API key or `CLAUDE_CODE_OAUTH_TOKEN` in the Manager environment. Subscription tokens must remain valid for the Run; the bridge does not refresh them on the host.
- Native API profiles use the same owner-only `native-agent-auth.sqlite` through the shared data-directory mount. Profile changes are read on subsequent Runs.
- An existing SSH agent socket is mounted on Linux. On macOS, the Docker Desktop SSH agent socket is used when `SSH_AUTH_SOCK` is set. SSH configuration and key files stay in the shared home.

Docker runs Linux executables. Mounting a macOS home cannot make macOS binaries, Keychain-only custom helpers, or host-only MCP servers executable inside Linux. Such tools need a Linux installation or a reachable service endpoint. Network behavior depends on working host-network support; remote Docker engines and Windows hosts are not supported. These are platform requirements, so Docker cannot make every host installation transparent by mounting `~/` alone.

## Sessions, stopping, and failures

Headless providers retain their native session IDs. Native Docker RD conversations use `native-docker-<requirement-id>.sqlite` next to the normal Native database, preventing the host Harness from claiming Docker work. Later Docker Runs resume that conversation. Native Reviewers use a fresh conversation. Switching Native Agent between host and Docker clears its native session ID and starts a new conversation with the Requirement's visible history; changing only Docker limits or image retains its conversation.

Steering uses the same ordered message stream and waits for the worker's acceptance before advancing the Run input boundary. Stop Run and timeouts terminate the attached process and await forced container removal, including detached tools. Container creation, missing images, Docker errors, and cleanup errors fail the Run; execution never silently falls back to the host. A Manager crash can leave a container behind: inspect `docker ps -a --filter name=code-factory-` and remove an obsolete container with `docker rm -f <name>` after confirming its Run is no longer active.

This option controls CPU and memory consumption. Shared home files, credentials, and host networking remain accessible to the Agent.

After building the image, run the real-container acceptance check (cgroup v2 required):

```bash
cd packages/agent-manager
CODE_FACTORY_DOCKER_TEST_IMAGE=code-factory-agent:local npx tsx --test test/docker.integration.test.ts
```

It verifies actual cgroup quotas, home writes, UID, localhost connectivity, installed CLIs, and a Native Run using a saved profile against a local fake model endpoint. Ordinary `npm test` skips this check unless the image variable is set.

Docker behavior references: [resource constraints](https://docs.docker.com/engine/containers/resource_constraints/), [host networking and Docker Desktop setup](https://docs.docker.com/engine/network/drivers/host/).
