#!/usr/bin/env bash
# Starts both the FastAPI backend and the Vite dev server.
# Usage: ./dev.sh

set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$REPO/.venv"

# ── venv bootstrap ──────────────────────────────────────────────────────────
if [ ! -f "$VENV/bin/activate" ]; then
  echo "[dev] Creating .venv..."
  python3 -m venv "$VENV"
fi

source "$VENV/bin/activate"

if ! python -c "import fastapi" 2>/dev/null; then
  echo "[dev] Installing Python dependencies..."
  pip install -q -r "$REPO/requirements.txt"
fi

# ── frontend deps ────────────────────────────────────────────────────────────
if [ ! -d "$REPO/frontend/node_modules" ]; then
  echo "[dev] Installing frontend dependencies..."
  (cd "$REPO/frontend" && npm install)
fi

# ── already-running guardrail ───────────────────────────────────────────────
# Re-running this script while a prior instance is still up silently spawns a
# second uvicorn/vite pair competing for the same ports. Dev environment, so
# we just kill whatever's squatting on our ports — but LOUDLY, with PID/command
# printed, so a killed process is obvious and traceable rather than a silent
# surprise.
kill_port() {
  local port="$1"
  local pids
  pids="$(lsof -ti ":$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "[dev] !!! port $port is already in use — killing existing process(es):"
    lsof -i ":$port" -sTCP:LISTEN
    echo "$pids" | xargs kill -9
    echo "[dev] !!! killed PID(s): $pids on port $port"
    sleep 0.5
  fi
}

kill_port 8000
kill_port 5173

# ── launch ───────────────────────────────────────────────────────────────────
echo "[dev] Starting FastAPI on :8000 and Vite on :5173"
echo "[dev] Press Ctrl-C to stop both."

trap 'kill 0' INT TERM

(cd "$REPO" && uvicorn backend.main:app --reload --port 8000) &

# Wait for FastAPI to be ready before starting Vite so the proxy doesn't
# fire during the startup/backfill window and flood the log with timeouts.
echo "[dev] Waiting for FastAPI to be ready..."
until curl -sf http://localhost:8000/api/silver/db/history > /dev/null 2>&1; do
  sleep 0.5
done
echo "[dev] FastAPI ready."

(cd "$REPO/frontend" && npm run dev) &

wait
