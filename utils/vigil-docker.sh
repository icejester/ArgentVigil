#!/usr/bin/env bash
# Brings up "Test AV" — ArgentVigil's containerized deploy shape
# (api-split-implementation-plan.md Story 1.3's docker-compose.yml) run
# against a snapshot of prod's data (see utils/refresh-test-db.sh), on its
# own ports (6977 api / 6978 web) so it can run alongside vigil.sh's prod
# (8000/5173) with zero manual port juggling and zero risk of writing into
# prod's real runtime/argentvigil.db. Checks whether Docker's daemon is
# reachable; if not, starts Colima (this machine's docker context — see
# `docker context ls`) with the user's usual sizing, then runs `docker
# compose up -d --build` and prints the URL to open.
#
# Usage: vigil-docker.sh <up|down|status|logs> [service]
#   up      - ensure Docker is reachable (start Colima if needed), build+start
#             api+web, print the URL to test with your own eyes.
#   down    - compose down (containers only — does not stop Colima,
#             since that VM is a personal dev-environment resource, not
#             something this script owns starting/stopping beyond "up").
#   status  - compose ps.
#   logs    - compose logs -f [service] (Ctrl-C to stop following).
#
# Colima sizing is hardcoded to this repo's own documented dev settings
# (4 CPU / 8GB / 60GB disk) — edit the colima start line below if that ever
# changes; this script does not try to auto-detect "the right" size.

set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
# "Test AV" — deliberately not 8000/5173 (vigil.sh's prod ports), so both
# can run simultaneously with zero manual port juggling.
WEB_PORT=6978

log() { echo "[vigil-docker] $*"; }

# Prefer the `docker compose` plugin subcommand; fall back to the standalone
# `docker-compose` v2 binary (this machine has that via Homebrew, but no
# Docker Desktop app bundle — the plugin symlink under ~/.docker/cli-plugins
# points at Docker.app and dangles without it, so `docker compose` 404s even
# though a perfectly good compose binary is on PATH).
compose() {
  if docker compose version > /dev/null 2>&1; then
    docker compose "$@"
  else
    docker-compose "$@"
  fi
}

# ── Docker/Colima readiness ─────────────────────────────────────────────────

docker_ready() {
  docker info > /dev/null 2>&1
}

ensure_docker() {
  if docker_ready; then
    log "Docker daemon reachable."
    return 0
  fi

  if ! command -v colima > /dev/null 2>&1; then
    log "!!! Docker daemon not reachable and colima isn't installed."
    log "    Install colima (brew install colima) or start whatever Docker"
    log "    backend you use, then re-run this script."
    exit 1
  fi

  log "Docker daemon not reachable — starting colima (4 CPU / 8GB / 60GB disk)..."
  colima start --cpu 4 --memory 8 --disk 60

  if ! docker_ready; then
    log "!!! colima started but the Docker daemon still isn't reachable — check 'colima status'."
    exit 1
  fi
  log "Docker daemon reachable via colima."
}

# ── compose actions ──────────────────────────────────────────────────────────

do_up() {
  ensure_docker
  log "building + starting api + web (docker compose up -d --build)..."
  (cd "$REPO" && compose up -d --build)
  log ""
  log "Open this URL and check the app with your own eyes:"
  log "  http://localhost:$WEB_PORT"
  log ""
  log "Worth checking specifically: a Stack Tracker item's uploaded photo"
  log "renders correctly (proves the /stack_images nginx proxy works)."
  log ""
  log "Logs: utils/vigil-docker.sh logs [api|web]"
  log "Stop: utils/vigil-docker.sh down"
}

do_down() {
  if ! docker_ready; then
    log "Docker daemon not reachable — nothing to bring down."
    exit 0
  fi
  (cd "$REPO" && compose down)
}

do_status() {
  if ! docker_ready; then
    log "Docker daemon not reachable."
    exit 0
  fi
  (cd "$REPO" && compose ps)
}

do_logs() {
  if ! docker_ready; then
    log "Docker daemon not reachable."
    exit 1
  fi
  (cd "$REPO" && compose logs -f "$@")
}

# ── dispatch ─────────────────────────────────────────────────────────────────

usage() {
  echo "Usage: $0 <up|down|status|logs> [service]"
  exit 1
}

ACTION="${1:-}"
[ -n "$ACTION" ] || usage
shift || true

case "$ACTION" in
  up) do_up ;;
  down) do_down ;;
  status) do_status ;;
  logs) do_logs "$@" ;;
  *) usage ;;
esac
