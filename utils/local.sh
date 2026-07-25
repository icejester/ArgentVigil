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
#   local.sh status                               # vigil.sh status, for convenience

set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DB="$REPO/runtime/argentvigil.db"
BACKEND_PORT=8000

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
    bash "$REPO/utils/vigil.sh" status
    ;;
  *)
    echo "usage: local.sh <get PATH|db QUERY|status>" >&2
    exit 1
    ;;
esac
