#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
manager_root="$repository_root/packages/agent-manager"
web_root="$repository_root/apps/web"
workspace_root=$(pwd -P)
action=up

usage() {
  cat <<'EOF'
Usage: scripts/dev.sh [command] [--workspace DIR] [-- CLI_OPTIONS...]

Commands:
  up       Install missing dependencies, build, npm link, and restart the daemon (default)
  build    Install missing dependencies and build Agent Manager and dashboard
  link     Globally link the existing build with npm link
  start    Start the existing build as a daemon
  restart  Restart the existing build, reusing saved options unless replacements are given
  stop     Stop the workspace daemon
  status   Show the workspace daemon status

The managed workspace defaults to the directory from which this script is called.
CLI options such as --port 4311 and --open are forwarded to up/start/restart.
EOF
}

case "${1:-}" in
  up|build|link|start|restart|stop|status)
    action=$1
    shift
    ;;
  -*) ;;
  '') ;;
  *) usage >&2; exit 2 ;;
esac

while [ "$#" -gt 0 ]; do
  case "$1" in
    --workspace)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        printf '%s\n' '--workspace requires a directory.' >&2
        exit 2
      fi
      workspace_root=$2
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    *) break ;;
  esac
done

case "$action" in
  build|link|stop|status)
    if [ "$#" -gt 0 ]; then
      printf '%s does not accept CLI options.\n' "$action" >&2
      exit 2
    fi
    ;;
esac

workspace_root=$(CDPATH= cd -- "$workspace_root" && pwd -P)

build() {
  for package_root in "$manager_root" "$web_root"; do
    if [ ! -d "$package_root/node_modules" ]; then
      (cd "$package_root" && npm ci)
    fi
  done
  (cd "$manager_root" && npm run build)
}

require_build() {
  if [ ! -f "$manager_root/dist/cli.js" ]; then
    printf '%s\n' 'Agent Manager is not built. Run scripts/dev.sh build or scripts/dev.sh up first.' >&2
    exit 1
  fi
}

link() {
  require_build
  (cd "$manager_root" && npm link --ignore-scripts --no-audit --no-fund)
}

case "$action" in
  build) build; exit 0 ;;
  link) link; exit 0 ;;
  up) build; link; action=restart ;;
esac

require_build
cd "$workspace_root"
if [ "$action" = start ]; then
  exec node "$manager_root/dist/cli.js" start --daemon "$@"
fi
exec node "$manager_root/dist/cli.js" "$action" "$@"
