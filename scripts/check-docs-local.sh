#!/usr/bin/env bash
#
# Build the docs site, serve the production build, and run this working tree's
# afdocs against it. Used by .github/workflows/agent-docs.yml, and runnable by
# hand with `npm run docs:check` (extra CLI flags are passed through).
#
# Checks that depend on Apache config in docs/public/.htaccess are skipped
# here, because `vitepress preview` knows nothing about it. See
# docs/agent-docs.local.yml for which ones and why; the live-site workflow
# covers them.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

if [ ! -f dist/index.js ]; then
  echo "error: dist/ is missing. Run 'npm run build' first." >&2
  exit 1
fi

if [ ! -x docs/node_modules/.bin/vitepress ]; then
  echo "error: docs dependencies are missing. Run 'npm ci --prefix docs' first." >&2
  exit 1
fi

npm run docs:build

# Plain mktemp with no template: BSD and GNU disagree about what -t accepts.
LOG="$(mktemp)"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$LOG"
}
trap cleanup EXIT

# Start the server with exec in a subshell so that $! is the server process
# itself rather than an npm wrapper, which is what lets cleanup stop it.
(cd docs && exec ./node_modules/.bin/vitepress preview --port "${PORT:-4173}") >"$LOG" 2>&1 &
SERVER_PID=$!

# Read the served URL out of the log rather than assuming the port: vitepress
# falls back to the next free one when the requested port is taken.
URL=""
for _ in $(seq 1 60); do
  # grep exits non-zero until the server logs its URL, which pipefail would
  # otherwise turn into an early exit.
  URL="$(grep -oE 'http://[^ ]+' "$LOG" | head -1 | sed 's:/*$::' || true)"
  [ -n "$URL" ] && break
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "error: preview server exited before it was ready:" >&2
    cat "$LOG" >&2
    exit 1
  fi
  sleep 1
done

if [ -z "$URL" ]; then
  echo "error: preview server did not report a URL within 60s:" >&2
  cat "$LOG" >&2
  exit 1
fi

echo "Serving the built docs site at $URL"
node "$ROOT/bin/afdocs.mjs" check "$URL" --config docs/agent-docs.local.yml "$@"
