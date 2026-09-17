#!/usr/bin/env bash
# ArgentVigil's primary process-management entrypoint. Brings up any
# registered containerized environment (environments/*.env — see
# environments/README.md) using ArgentVigil's docker-compose.yml
# (api-split-implementation-plan.md Story 1.3, generalized to N named
# environments) — including "prod" itself, now that prod runs
# containerized. Each environment gets its own compose project name
# (av-<name>) and its own container names (av-<name>-api etc., set
# directly in docker-compose.yml), so any number of them can run
# simultaneously with zero manual port juggling, as long as each
# environments/<name>.env picks free ports (see that file's README — no
# automated collision check yet). Also owns `test` (the pytest suite),
# which has nothing to do with Docker but lives here now so there's one
# script, one entrypoint, for everything.
#
# Formerly `vigil-docker.sh`, renamed to `vigil.sh` once prod itself moved
# to this containerized workflow. The OLD `vigil.sh` (bare host processes,
# no Docker — uvicorn + Vite dev server directly) is now `vigil-native.sh`,
# kept only as a fallback/faster local inner loop — see that script's own
# header. `vigil-native.sh` and this script's `prod` environment must never
# run against runtime/data/prod/ at the same time (see `refuse_if_vigil_
# native_running` below and environments/prod.env's own comment).
#
# Checks whether Docker's daemon is reachable; if not, starts Colima (this
# machine's docker context — see `docker context ls`) with the user's
# usual sizing, then runs `docker compose up -d --build` and prints the
# URL to open.
#
# Usage: vigil.sh <up|down|status|logs> <env> [service]
#        vigil.sh test [pytest args...]
#   up      <env>            - ensure Docker is reachable (start Colima if
#                              needed), build+start that environment's
#                              api+collector+web, print the URL to test.
#   down    <env>             - compose down for that environment's project
#                              only (containers only — does not stop
#                              Colima, since that VM is a personal dev-
#                              environment resource, not something this
#                              script owns starting/stopping beyond "up").
#   status  [env]             - compose ps for one environment, or every
#                              av-* project currently up if <env> omitted.
#   logs    <env> [service]   - compose logs -f [service] (Ctrl-C to stop).
#   test    [pytest args...]  - run the full test suite (see CLAUDE.md
#                              ## Tests) — no Docker involved, pytest always
#                              runs on the host; not environment-scoped.
#
# Colima sizing is hardcoded to this repo's own documented dev settings
# (4 CPU / 8GB / 60GB disk) — edit the colima start line below if that ever
# changes; this script does not try to auto-detect "the right" size.

set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENV_DIR="$REPO/environments"
VENV="$REPO/.venv"

log() { echo "[vigil] $*"; }

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

# ── environment resolution ───────────────────────────────────────────────────

# Resolves $1 to environments/<name>.env, exits loudly if it doesn't exist
# rather than silently falling back to any particular environment — a typo'd
# name should never boot the wrong stack. Sets ENV_FILE/PROJECT/AV_ENV_NAME/
# WEB_PORT/UPDATE_MODE/COMPOSE_PROFILE_ARGS for the caller.
resolve_env() {
  local name="${1:-}"
  if [ -z "$name" ]; then
    log "!!! missing <env> argument."
    log "    Available environments:"
    for f in "$ENV_DIR"/*.env; do
      [ -e "$f" ] && log "      - $(basename "$f" .env)"
    done
    exit 1
  fi

  ENV_FILE="$ENV_DIR/$name.env"
  if [ ! -f "$ENV_FILE" ]; then
    log "!!! no environments/$name.env found."
    log "    Available environments:"
    for f in "$ENV_DIR"/*.env; do
      [ -e "$f" ] && log "      - $(basename "$f" .env)"
    done
    log "    See environments/README.md to add a new one."
    exit 1
  fi

  AV_ENV_NAME="$name"
  PROJECT="av-$name"
  # Only need WEB_PORT here (for the printed URL) — everything else this
  # script cares about is passed straight through to compose via --env-file.
  WEB_PORT="$(grep -E '^WEB_PORT=' "$ENV_FILE" | tail -1 | cut -d= -f2)"
  WEB_PORT="${WEB_PORT:-6978}"

  # UPDATE_MODE (live | frozen — environments/README.md) drives whether the
  # `collector` service's compose profile gets included. Anything other
  # than exactly "live" is treated as frozen (no collector) — a missing or
  # misspelled value fails safe toward "don't fetch upstream," not the
  # reverse.
  UPDATE_MODE="$(grep -E '^UPDATE_MODE=' "$ENV_FILE" | tail -1 | cut -d= -f2)"
  UPDATE_MODE="${UPDATE_MODE:-frozen}"
  if [ "$UPDATE_MODE" = "live" ]; then
    COMPOSE_PROFILE_ARGS=(--profile live)
  else
    COMPOSE_PROFILE_ARGS=()
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

# Guards against the exact two-writer hazard prod.env's own comment
# documents: vigil-native.sh's bare-process backend and this environment's
# compose project must never run against runtime/data/prod at the same
# time. Checks vigil-native.sh's own PID file (runtime/vigil/pids/
# backend.pid) the same way that script does — a live PID there means its
# backend is actually running right now, not just that it ran at some point.
refuse_if_vigil_native_running() {
  local pid_file="$REPO/runtime/vigil/pids/backend.pid"
  if [ -f "$pid_file" ]; then
    local pid
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      log "!!! vigil-native.sh's backend is currently running (pid $pid) against runtime/data/prod."
      log "    Bringing up the 'prod' compose environment at the same time would have"
      log "    two processes writing the same SQLite files simultaneously — the exact"
      log "    hazard documented in environments/prod.env. Run 'utils/vigil-native.sh stop"
      log "    backend' first."
      exit 1
    fi
  fi
}

do_up() {
  resolve_env "$1"
  if [ "$AV_ENV_NAME" = "prod" ]; then
    refuse_if_vigil_native_running
  fi
  ensure_docker
  log "environment: $AV_ENV_NAME (project: $PROJECT, update mode: $UPDATE_MODE)"
  if [ "$UPDATE_MODE" = "live" ]; then
    log "building + starting api + collector + web (docker compose up -d --build)..."
  else
    log "building + starting api + web ONLY (UPDATE_MODE=frozen — no collector," \
        "no upstream fetches; see environments/README.md)..."
  fi
  # ${arr[@]+"${arr[@]}"} rather than a bare "${arr[@]}": under `set -u`,
  # bash 3.2 (macOS's stock /bin/bash) treats expanding an EMPTY array as an
  # unbound-variable error, unlike bash 4+ — this guard expands to nothing
  # on an empty array on both versions instead of erroring on 3.2.
  (cd "$REPO" && compose --env-file "$ENV_FILE" -p "$PROJECT" ${COMPOSE_PROFILE_ARGS[@]+"${COMPOSE_PROFILE_ARGS[@]}"} up -d --build)
  log ""
  log "Open this URL and check the app with your own eyes:"
  log "  http://localhost:$WEB_PORT"
  log ""
  log "Worth checking specifically: a Stack Tracker item's uploaded photo"
  log "renders correctly (proves the /stack_images nginx proxy works)."
  log ""
  log "Logs: utils/vigil.sh logs $AV_ENV_NAME [api|collector|web]"
  log "Stop: utils/vigil.sh down $AV_ENV_NAME"
}

do_down() {
  resolve_env "$1"
  if ! docker_ready; then
    log "Docker daemon not reachable — nothing to bring down."
    exit 0
  fi
  # --profile live always passed here regardless of the environment file's
  # CURRENT UPDATE_MODE — if it was live when brought up and switched to
  # frozen since, compose still needs to know the collector service exists
  # in order to stop/remove it. Passing the flag is harmless when no such
  # container exists.
  (cd "$REPO" && compose --env-file "$ENV_FILE" -p "$PROJECT" --profile live down)
}

do_status() {
  if ! docker_ready; then
    log "Docker daemon not reachable."
    exit 0
  fi
  local name="${1:-}"
  if [ -n "$name" ]; then
    resolve_env "$name"
    (cd "$REPO" && compose --env-file "$ENV_FILE" -p "$PROJECT" ps)
  else
    log "all av-* projects currently up:"
    docker compose ls --filter "name=av-" 2>/dev/null || docker-compose ls --filter "name=av-"
  fi
}

do_logs() {
  resolve_env "$1"
  shift || true
  if ! docker_ready; then
    log "Docker daemon not reachable."
    exit 1
  fi
  (cd "$REPO" && compose --env-file "$ENV_FILE" -p "$PROJECT" --profile live logs -f "$@")
}

# ── test ─────────────────────────────────────────────────────────────────────
# Lifted from the old vigil.sh (now vigil-native.sh) unchanged — pytest
# always runs directly on the host regardless of which script starts the
# app, no Docker/container involved at all.

# Creates .venv and installs requirements.txt if either is missing.
# Probes for both a runtime dep (fastapi) and a test dep (pytest) so a venv
# predating the requirements merge (when test tooling lived in a separate
# requirements-dev.txt) gets topped up instead of silently lacking pytest.
ensure_venv() {
  if [ ! -f "$VENV/bin/activate" ]; then
    log "creating .venv..."
    python3 -m venv "$VENV"
  fi
  # shellcheck disable=SC1091
  source "$VENV/bin/activate"
  if ! python -c "import fastapi, pytest" 2>/dev/null; then
    log "installing python dependencies..."
    pip install -q -r "$REPO/requirements.txt"
  fi
}

# Runs the pytest suite (see CLAUDE.md's ## Tests) — no daemon/environment
# involved, so <env> doesn't apply; extra args pass straight through to
# pytest. "backend"/"all" are accepted as no-ops for muscle memory (the
# whole suite is backend); "frontend" gets an honest notice instead of a
# confusing pytest usage error.
run_tests() {
  case "${1:-}" in
    backend|all) shift ;;
    frontend)
      log "no frontend tests exist (deliberate — see CLAUDE.md ## Tests); the suite is backend-only."
      exit 0
      ;;
  esac
  ensure_venv
  # Real bug found live 2026-09-16: importing backend.stack_db (transitively,
  # via backend.main) with AV_RUNTIME_DIR unset recreates runtime/stack_images/
  # (and would recreate runtime/stack.db on first write) at import time,
  # regardless of what any test fixture later monkeypatches — module-level
  # os.makedirs side effects run before pytest ever gets a chance to
  # intervene. tests/conftest.py's tmp_db/tmp_stack_db fixtures correctly
  # redirect DB_PATH for actual test I/O, but they can't undo an import-time
  # os.makedirs that already fired against the real runtime/ tree. Pointing
  # AV_RUNTIME_DIR at a disposable dir before pytest even starts means that
  # side effect, if it fires, lands somewhere harmless instead of littering
  # prod's real runtime/ directory.
  export AV_RUNTIME_DIR="$REPO/runtime/.pytest-import-scratch"
  cd "$REPO" && exec python -m pytest -q "$@"
}

# ── dispatch ─────────────────────────────────────────────────────────────────

usage() {
  echo "Usage: $0 <up|down|status|logs> <env> [service]"
  echo "       $0 test [pytest args...]"
  echo "  <env> is any environments/<name>.env in this repo (see environments/README.md)."
  echo "  'status' with no <env> lists every av-* project currently running."
  exit 1
}

ACTION="${1:-}"
[ -n "$ACTION" ] || usage
shift || true

case "$ACTION" in
  up) do_up "$@" ;;
  down) do_down "$@" ;;
  status) do_status "$@" ;;
  logs) do_logs "$@" ;;
  test) run_tests "$@" ;;
  *) usage ;;
esac
