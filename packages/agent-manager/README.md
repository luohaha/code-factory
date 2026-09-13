# @code-factory/agent-manager

Code Factory is a local control plane for requirement-driven development with Codex or Claude Code. This package contains the Agent Manager CLI, its HTTP/SSE service, the RD control-plane CLI, and the bundled Web dashboard.

## Run

Prerequisites are Node.js 22.13 or newer, an authenticated `codex` or `claude` CLI, and an authenticated GitHub CLI.

```bash
cd /path/to/the/repository/to-manage
npx --package @code-factory/agent-manager code-factory-agent-manager start --open
```

The startup directory becomes the managed workspace. The dashboard listens on `http://127.0.0.1:4310` by default.

```bash
npx --package @code-factory/agent-manager code-factory-agent-manager --version
npx --package @code-factory/agent-manager code-factory-agent-manager start --port 8080
npx --package @code-factory/agent-manager code-factory-agent-manager status
npx --package @code-factory/agent-manager code-factory-agent-manager stop
```

Headless agents inherit the filesystem, network, and command permissions of the user who starts Agent Manager. Run it only in a trusted workspace and expose its port only to trusted users and networks.

See the [project README](https://github.com/luohaha/code-factory#readme) for configuration, architecture, development, and security details.
