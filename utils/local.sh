#!/usr/bin/env bash
# Read-only local diagnostics — everything here talks only to localhost or
# the local runtime/argentvigil.db, never a real upstream. Exists so ad hoc
# checks (API reads, DB queries) go through one script instead of one-off
# curl/sqlite3 invocations, so permissions.allow only needs one rule
# (`Bash(bash utils/local.sh:*)`) that covers every subcommand added here,
# now and later — no new subcommand needs a new allowlist entry.
#
# Usage: local.sh <get|db|status> ...
#
# Examples:
#   local.sh get /api/cot/db                     # curl -s localhost:8000<path>, pretty-printed
#   local.sh get /api/health/db
#   local.sh db "SELECT date FROM inventory_aggregate ORDER BY date DESC LIMIT 5;"
#   local.sh status                               # vigil-native.sh status, for convenience

# NOTE: BACKEND_PORT/DB below assume vigil-native.sh's bare-process prod
# (port 8000, runtime/argentvigil.db / pre-prod/test/backup-split paths).
# Now that prod runs containerized by default (environments/prod.env —
# port 9001, runtime/data/prod/argentvigil.db), these are stale for that
# case — override via BACKEND_PORT=9001/DB=runtime/data/prod/argentvigil.db
# env vars, or point them at whichever environment you're actually
# diagnosing, until this script is updated to take an <env> argument the
# way vigil.sh itself does.
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DB="${DB:-$REPO/runtime/argentvigil.db}"
BACKEND_PORT="${BACKEND_PORT:-8000}"

ACTION="${1:-}"
shift || true

case "$ACTION" in
  get)
    path="${1:?usage: local.sh get /api/...}"
    curl -s "http://localhost:${BACKEND_PORT}${path}" | python3 -m json.tool
    ;;
  db)
    query="${1:?usage: local.sh db \"SELECT ...\"}"
    sqlite3 -readonly "$DB" "$query"
    ;;
  status)
    bash "$REPO/utils/vigil-native.sh" status
    ;;
  *)
    echo "usage: local.sh <get PATH|db QUERY|status>" >&2
    exit 1
    ;;
esac
