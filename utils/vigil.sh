#!/usr/bin/env bash
# Process manager for ArgentVigil's backend/frontend as background daemons —
# unlike dev.sh (foreground, Ctrl-C to stop, --reload), this detaches both
# processes, tracks them by PID file, and redirects logs to
# runtime/vigil/logs/.
#
# Usage: vigil.sh <start|stop|restart|status> [backend|frontend|all]
#        vigil.sh test [pytest args...]
#   component defaults to "all" if omitted.
#
# Examples:
#   vigil.sh start            # start backend + frontend
#   vigil.sh stop backend     # stop backend only
#   vigil.sh restart          # restart both
#   vigil.sh status           # show what's running
#   vigil.sh test             # run the full test suite (see CLAUDE.md ## Tests)
#   vigil.sh test -k leverage # pass-through pytest args (files, -k, -x, ...)

set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$REPO/.venv"
# runtime/vigil/{logs,pids}/ — vigil.sh's OWN process-management state
# (which native process is running, where its stdout goes), not
# environment/app data. Deliberately not under runtime/data/ alongside
# {prod,test,backup}/ — there's exactly one vigil.sh instance on this
# machine regardless of which data dir a given backend run points at, so
# these aren't environment-scoped the way argentvigil.db/stack.db are.
# Renamed 2026-09-16 (were bare runtime/logs, runtime/pids) after the user
# flagged that sitting at the runtime/ root, right next to data/, made
# them look like they should be part of the prod/test split when they're
# not — containers don't write here at all (confirmed live: the
# containerized api logs to stdout, captured by `docker compose logs`,
# and has no logs/pids concept of its own).
LOG_DIR="$REPO/runtime/vigil/logs"
PID_DIR="$REPO/runtime/vigil/pids"

BACKEND_PORT=8000
FRONTEND_PORT=5173
# Prod's data lives under runtime/data/prod/ (argentvigil.db, stack.db,
# stack_images/), not bare runtime/ — see backend/db.py's AV_RUNTIME_DIR
# override (2026-09-16 prod/test/backup data split, at the user's explicit
# request). runtime/data/test/ backs the containerized vigil-docker.sh
# stack instead; runtime/data/backup/ is a manual-copy destination only,
# nothing reads from it automatically.
PROD_RUNTIME_DIR="$REPO/runtime/data/prod"

mkdir -p "$LOG_DIR" "$PID_DIR"

# ── helpers ──────────────────────────────────────────────────────────────────

log() { echo "[vigil] $*"; }

pid_file() { echo "$PID_DIR/$1.pid"; }
log_file() { echo "$LOG_DIR/$1.log"; }

# Prints the PID of a running, tracked instance of $1 ("backend"/"frontend"),
# or nothing if not running. Cleans up a stale PID file if the process is gone.
running_pid() {
  local name="$1" pf pid
  pf="$(pid_file "$name")"
  [ -f "$pf" ] || return 0
  pid="$(cat "$pf" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "$pid"
  else
    rm -f "$pf"
  fi
}

# Whatever's LISTENing on a port, tracked or not (catches stray processes
# started outside this script, e.g. via dev.sh or a manual uvicorn/vite run).
port_pids() {
  lsof -ti ":$1" -sTCP:LISTEN 2>/dev/null || true
}

is_running() {
  local name="$1" port="$2"
  [ -n "$(running_pid "$name")" ] || [ -n "$(port_pids "$port")" ]
}

wait_for_backend() {
  log "waiting for backend to be ready..."
  local tries=0
  until curl -sf "http://localhost:$BACKEND_PORT/api/silver/db/history" > /dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -ge 60 ]; then
      log "!!! backend did not become ready after 30s — check $(log_file backend)"
      return 1
    fi
    sleep 0.5
  done
  log "backend ready."
}

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

# ── start ────────────────────────────────────────────────────────────────────

start_backend() {
  if is_running backend "$BACKEND_PORT"; then
    log "backend already running (pid $(running_pid backend), port $BACKEND_PORT) — skipping start."
    return 0
  fi

  ensure_venv

  log "starting backend on :$BACKEND_PORT (log: $(log_file backend), data: $PROD_RUNTIME_DIR)"
  (
    cd "$REPO" && \
    export AV_RUNTIME_DIR="$PROD_RUNTIME_DIR" && \
    exec uvicorn backend.main:app --port "$BACKEND_PORT" \
      >> "$(log_file backend)" 2>&1
  ) &
  disown
  echo $! > "$(pid_file backend)"
  wait_for_backend
}

start_frontend() {
  if is_running frontend "$FRONTEND_PORT"; then
    log "frontend already running (pid $(running_pid frontend), port $FRONTEND_PORT) — skipping start."
    return 0
  fi

  if [ ! -d "$REPO/frontend/node_modules" ]; then
    log "installing frontend dependencies..."
    (cd "$REPO/frontend" && npm install)
  fi

  log "starting frontend on :$FRONTEND_PORT (log: $(log_file frontend))"
  (
    cd "$REPO/frontend" && \
    exec npm run dev -- --port "$FRONTEND_PORT" \
      >> "$(log_file frontend)" 2>&1
  ) &
  disown
  echo $! > "$(pid_file frontend)"
}

# ── stop ─────────────────────────────────────────────────────────────────────

stop_component() {
  local name="$1" port="$2" pid pids

  pid="$(running_pid "$name")"
  if [ -n "$pid" ]; then
    log "stopping $name (pid $pid)..."
    kill "$pid" 2>/dev/null
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
    rm -f "$(pid_file "$name")"
  fi

  # Also sweep anything squatting on the port that this script didn't start
  # itself (e.g. left over from dev.sh or a manual run) — loudly, same
  # convention as dev.sh's kill_port.
  pids="$(port_pids "$port")"
  if [ -n "$pids" ]; then
    log "!!! port $port still occupied — killing stray process(es): $pids"
    echo "$pids" | xargs kill -9 2>/dev/null
  fi

  if [ -z "$pid" ] && [ -z "$pids" ]; then
    log "$name is not running."
  else
    log "$name stopped."
  fi
}

stop_backend() { stop_component backend "$BACKEND_PORT"; }
stop_frontend() { stop_component frontend "$FRONTEND_PORT"; }

# ── status ───────────────────────────────────────────────────────────────────

status_component() {
  local name="$1" port="$2" pid pids
  pid="$(running_pid "$name")"
  pids="$(port_pids "$port")"
  if [ -n "$pid" ]; then
    log "$name: running (pid $pid, port $port, log $(log_file "$name"))"
  elif [ -n "$pids" ]; then
    log "$name: running untracked (pid(s) $pids on port $port — not started by vigil.sh)"
  else
    log "$name: stopped"
  fi
}

# ── test ─────────────────────────────────────────────────────────────────────

# Runs the pytest suite (see CLAUDE.md's ## Tests) — no daemon involved, so
# component words don't apply; extra args pass straight through to pytest.
# "backend"/"all" are accepted as no-ops for start/stop muscle memory (the
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
  echo "Usage: $0 <start|stop|restart|status> [backend|frontend|all]"
  echo "       $0 test [pytest args...]"
  exit 1
}

ACTION="${1:-}"

if [ "$ACTION" = "test" ]; then
  shift
  run_tests "$@"
fi

COMPONENT="${2:-all}"

case "$ACTION" in
  start|stop|restart|status) ;;
  *) usage ;;
esac

case "$COMPONENT" in
  backend|frontend|all) ;;
  *) usage ;;
esac

do_start() {
  case "$COMPONENT" in
    backend) start_backend ;;
    frontend) start_frontend ;;
    all) start_backend && start_frontend ;;
  esac
}

do_stop() {
  case "$COMPONENT" in
    backend) stop_backend ;;
    frontend) stop_frontend ;;
    all) stop_frontend; stop_backend ;;
  esac
}

do_status() {
  case "$COMPONENT" in
    backend) status_component backend "$BACKEND_PORT" ;;
    frontend) status_component frontend "$FRONTEND_PORT" ;;
    all)
      status_component backend "$BACKEND_PORT"
      status_component frontend "$FRONTEND_PORT"
      ;;
  esac
}

case "$ACTION" in
  start) do_start ;;
  stop) do_stop ;;
  restart) do_stop; do_start ;;
  status) do_status ;;
esac
