#!/usr/bin/env bash
# Run the markdown-content-parity check against one site from parity-sites.txt.
#
# Usage:
#   ./working-notes/run-parity-baseline.sh <slug> <url> [outdir]
#
# Or all sites at once:
#   grep -v '^#' working-notes/parity-sites.txt | grep -v '^\s*$' \
#     | xargs -P 5 -L 1 ./working-notes/run-parity-baseline.sh
#
# Writes <outdir>/<slug>.json (JSON results) and <outdir>/<slug>.log (stderr).
# <outdir> defaults to parity-results/ at the repo root, which is gitignored.
# Run it once before and once after a change, or instrument the build to run
# both extractors on the same fetched content (see session 11 in
# parity-check-notes.md), rather than re-running against live sites repeatedly.
set -u
slug="$1"
url="$2"
repo="$(cd "$(dirname "$0")/.." && pwd)"
outdir="${3:-$repo/parity-results}"
mkdir -p "$outdir"
cd "$repo" || exit 1
./bin/afdocs.mjs check "$url" \
  --checks markdown-url-support,content-negotiation,markdown-content-parity \
  --format json \
  --sampling deterministic \
  --max-links 50 \
  > "$outdir/$slug.json" 2> "$outdir/$slug.log"
echo "exit=$? slug=$slug"
