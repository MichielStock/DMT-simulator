#!/usr/bin/env bash
# Hyperspace launcher. ./run.sh [--dev] [--serve-only] [--stop]
set -uo pipefail
cd "$(dirname "$(readlink -f "$0")")"
ROOT="$PWD"
export PATH="$HOME/.local/bin:$PATH"
PORT="${HYPERSPACE_PORT:-8765}"
PIDFILE="$ROOT/verification/server.pid"
DEVPID="$ROOT/verification/vite.pid"
MODE=""; DEV=0
for a in "$@"; do
  case "$a" in
    --dev) DEV=1 ;;
    --serve-only) MODE=serve ;;
    --stop) MODE=stop ;;
    -h|--help) echo "usage: ./run.sh [--dev] [--serve-only] [--stop]"; exit 0 ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done

killpid() {
  local f="$1"
  if [ -f "$f" ]; then
    local p; p=$(cat "$f")
    if kill -0 "$p" 2>/dev/null; then kill "$p" 2>/dev/null; sleep 1; kill -9 "$p" 2>/dev/null || true; echo "stopped pid $p"; fi
    rm -f "$f"
  fi
}
if [ "$MODE" = stop ]; then killpid "$PIDFILE"; killpid "$DEVPID"; exit 0; fi

status_up() { curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1; }

if status_up; then
  echo "Hyperspace is already serving on http://localhost:$PORT"
  if [ "$MODE" = serve ]; then exec tail -f /dev/null; fi
  [ "$DEV" = 0 ] && { command -v xdg-open >/dev/null && xdg-open "http://localhost:$PORT" >/dev/null 2>&1 || true; exit 0; }
fi

# front end build if dist missing or older than src
if [ ! -f frontend/dist/index.html ] || [ -n "$(find frontend/src frontend/index.html frontend/public -newer frontend/dist/index.html -type f 2>/dev/null | head -1)" ]; then
  echo "building front end..."
  (cd frontend && npx vite build) || { echo "front-end build failed" >&2; exit 1; }
fi

bash "$ROOT/scripts/ensure_ollama.sh" || echo "warning: Ollama not available; templates will be used" >&2

export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HYPERSPACE_OLLAMA_HOST="${HYPERSPACE_OLLAMA_HOST:-http://127.0.0.1:11435}"
export PYTORCH_CUDA_ALLOC_CONF="${PYTORCH_CUDA_ALLOC_CONF:-expandable_segments:True}"
mkdir -p verification

start_server() {
  uv run uvicorn backend.app:app --host 127.0.0.1 --port $PORT "$@"
}

wait_status() {
  for _ in $(seq 1 120); do status_up && return 0; sleep 1; done
  return 1
}

if [ "$MODE" = serve ]; then
  echo $$ > "$PIDFILE"   # exec keeps the pid
  exec uv run uvicorn backend.app:app --host 127.0.0.1 --port $PORT
fi

if ! status_up; then
  nohup uv run uvicorn backend.app:app --host 127.0.0.1 --port $PORT > verification/server.log 2>&1 &
  echo $! > "$PIDFILE"
  wait_status || { echo "server did not come up; see verification/server.log" >&2; exit 1; }
fi
URL="http://localhost:$PORT"
if [ "$DEV" = 1 ]; then
  (cd frontend && nohup npx vite --host 127.0.0.1 --port 5173 > "$ROOT/verification/vite.log" 2>&1 & echo $! > "$DEVPID")
  sleep 3
  URL="http://localhost:5173"
fi
echo "Hyperspace running at $URL  (stop with ./run.sh --stop)"
command -v xdg-open >/dev/null && xdg-open "$URL" >/dev/null 2>&1 || true
# stay in the foreground so Ctrl-C stops everything
trap 'killpid "$PIDFILE"; killpid "$DEVPID"; exit 0' INT TERM
while kill -0 "$(cat "$PIDFILE" 2>/dev/null || echo 0)" 2>/dev/null; do sleep 2; done
