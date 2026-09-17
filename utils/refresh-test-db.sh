#!/usr/bin/env bash
# Snapshots prod's real data (argentvigil.db, stack.db, stack_images/)
# into a named environment's HOST_RUNTIME_DIR (environments/<name>.env —
# see environments/README.md), so a disposable containerized environment
# always tests against real, recent data without ever writing into prod
# itself.
#
# "For now, a copy of now is fine" — this is an on-demand snapshot, run by
# hand whenever you want an environment's data refreshed; no automatic
# cadence.
#
# Usage: refresh-test-db.sh <env>
#   <env>             - which environments/<name>.env to refresh (e.g. "test").
#   SRC_RUNTIME_DIR   - prod's data dir (default: runtime/data/prod)
#
# Safety:
#   - Refuses to run against an environment whose REFRESH_POLICY is
#     "protected" (environments/<name>.env) — that environment's data isn't
#     meant to be clobbered from prod, regardless of whether its collector
#     is currently live or frozen (see UPDATE_MODE, a separate axis — an
#     environment can be frozen+protected, e.g. a pinned reference dataset
#     nothing may overwrite). Only REFRESH_POLICY=snapshot environments are
#     valid targets.
#   - Refuses to run while that environment's containers are up (they'd
#     have the destination's files open — copying onto an open SQLite file
#     mid-write is exactly the corruption risk the prod/test split exists
#     to avoid). Run `vigil.sh down <env>` first if this refuses.

set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENV_DIR="$REPO/environments"

log() { echo "[refresh-test-db] $*"; }

compose() {
  if docker compose version > /dev/null 2>&1; then
    docker compose "$@"
  else
    docker-compose "$@"
  fi
}

# ── resolve target environment ───────────────────────────────────────────────

NAME="${1:-}"
if [ -z "$NAME" ]; then
  log "!!! usage: $0 <env>"
  log "    Available environments:"
  for f in "$ENV_DIR"/*.env; do
    [ -e "$f" ] && log "      - $(basename "$f" .env)"
  done
  exit 1
fi

ENV_FILE="$ENV_DIR/$NAME.env"
if [ ! -f "$ENV_FILE" ]; then
  log "!!! no environments/$NAME.env found. See environments/README.md."
  exit 1
fi

REFRESH_POLICY="$(grep -E '^REFRESH_POLICY=' "$ENV_FILE" | tail -1 | cut -d= -f2)"
if [ "$REFRESH_POLICY" != "snapshot" ]; then
  log "!!! environments/$NAME.env has REFRESH_POLICY=${REFRESH_POLICY:-<unset>}, not 'snapshot'."
  log "    This environment's data is protected — refusing to overwrite it from"
  log "    prod. Only REFRESH_POLICY=snapshot environments can be refreshed this way."
  exit 1
fi

ENV_HOST_RUNTIME_DIR="$(grep -E '^HOST_RUNTIME_DIR=' "$ENV_FILE" | tail -1 | cut -d= -f2)"
if [ -z "$ENV_HOST_RUNTIME_DIR" ]; then
  log "!!! environments/$NAME.env has no HOST_RUNTIME_DIR set."
  exit 1
fi
# HOST_RUNTIME_DIR in the .env file is relative to the repo root (same
# convention docker-compose.yml itself assumes for this variable).
DST="$REPO/${ENV_HOST_RUNTIME_DIR#./}"
SRC="${SRC_RUNTIME_DIR:-$REPO/runtime/data/prod}"

# ── safety check: target environment's containers must be down ─────────────

PROJECT="av-$NAME"
if docker info > /dev/null 2>&1; then
  running="$(cd "$REPO" && compose --env-file "$ENV_FILE" -p "$PROJECT" --profile live ps -q 2>/dev/null || true)"
  if [ -n "$running" ]; then
    log "!!! environment '$NAME' containers are up — refusing to overwrite $DST"
    log "    while api has those files open. Run 'utils/vigil.sh down $NAME' first."
    exit 1
  fi
fi

if [ ! -f "$SRC/argentvigil.db" ]; then
  log "!!! $SRC/argentvigil.db not found — is SRC_RUNTIME_DIR right?"
  exit 1
fi

# ── snapshot ─────────────────────────────────────────────────────────────────

mkdir -p "$DST"

log "refreshing environment '$NAME' ($DST) from $SRC..."

log "copying argentvigil.db..."
cp "$SRC/argentvigil.db" "$DST/argentvigil.db"

if [ -f "$SRC/stack.db" ]; then
  log "copying stack.db..."
  cp "$SRC/stack.db" "$DST/stack.db"
else
  log "stack.db not found in $SRC — skipping (test DB will have no Stack Tracker data)."
fi

if [ -d "$SRC/stack_images" ]; then
  log "copying stack_images/..."
  rm -rf "$DST/stack_images"
  cp -R "$SRC/stack_images" "$DST/stack_images"
else
  log "stack_images/ not found in $SRC — skipping."
fi

log "done. $DST now holds a snapshot of $SRC as of $(date)."
log "Bring the environment up with: utils/vigil.sh up $NAME"
