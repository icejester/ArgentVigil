#!/usr/bin/env bash
# Snapshots prod's real data (argentvigil.db, stack.db, stack_images/)
# into the directory docker-compose.yml's `api` service bind-mounts, so
# the containerized stack (utils/vigil-docker.sh) always tests against
# real, recent data without ever writing into prod itself.
#
# "For now, a copy of now is fine" — this is an on-demand snapshot, run by
# hand whenever you want the test DB refreshed; no automatic cadence.
#
# Usage: refresh-test-db.sh
#   SRC_RUNTIME_DIR   - prod's data dir (default: runtime/data/prod)
#   DST_RUNTIME_DIR   - test snapshot dir (default: runtime/data/test) —
#                       must match docker-compose.yml's HOST_RUNTIME_DIR
#                       if you override either one.
#
# Safety: refuses to run while vigil-docker.sh's containers are up (they'd
# have the destination's files open — copying onto an open SQLite file
# mid-write is exactly the corruption risk this whole split exists to
# avoid). Run `vigil-docker.sh down` first if this refuses.

set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${SRC_RUNTIME_DIR:-$REPO/runtime/data/prod}"
DST="${DST_RUNTIME_DIR:-$REPO/runtime/data/test}"

log() { echo "[refresh-test-db] $*"; }

compose() {
  if docker compose version > /dev/null 2>&1; then
    docker compose "$@"
  else
    docker-compose "$@"
  fi
}

# ── safety check ─────────────────────────────────────────────────────────────

if docker info > /dev/null 2>&1; then
  running="$(cd "$REPO" && compose ps -q 2>/dev/null || true)"
  if [ -n "$running" ]; then
    log "!!! vigil-docker.sh's containers are up — refusing to overwrite $DST"
    log "    while api has those files open. Run 'utils/vigil-docker.sh down' first."
    exit 1
  fi
fi

if [ ! -f "$SRC/argentvigil.db" ]; then
  log "!!! $SRC/argentvigil.db not found — is SRC_RUNTIME_DIR right?"
  exit 1
fi

# ── snapshot ─────────────────────────────────────────────────────────────────

mkdir -p "$DST"

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
log "Bring the test stack up with: utils/vigil-docker.sh up"
