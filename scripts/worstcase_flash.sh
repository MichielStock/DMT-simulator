#!/usr/bin/env bash
# PROTECTED worst-case photosensitivity check (BUILD.md 4.1, 16.2 "Safety" → "Worst case"):
# tests/e2e/worstcase-flash.spec.ts — every layer forced at v = 9, breakthrough dose, sensitivity 2.0,
# difficult passage + entity + message forced, 60 s each at REAL time in headed Chrome with the GPU
# (DISPLAY, default :1), plus a 0 → 10 → 0 sweep; tools/flashcheck.py must report zero violations.
#
#   scripts/worstcase_flash.sh
#   WORSTCASE_LAYERS=chrysanthemum WORSTCASE_SECONDS=20 scripts/worstcase_flash.sh   (quick agent check)
#
# Server handling as scripts/gallery.sh (E2E_BASE_URL, else its own back end + Vite dev server on
# WORSTCASE_API_PORT 8771 / WORSTCASE_VITE_PORT 5174, stopped on exit).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
API_PORT="${WORSTCASE_API_PORT:-8771}"
VITE_PORT="${WORSTCASE_VITE_PORT:-5174}"
SESS="${HYPERSPACE_SESSIONS_DIR:-verification/tmp/worstcase/sessions}"
export DISPLAY="${DISPLAY:-:1}"
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && { kill -- "-$p" 2>/dev/null || kill "$p" 2>/dev/null; }; done; }
trap cleanup EXIT

up() { curl -sf -o /dev/null --max-time 2 "$1"; }
wait_up() { for _ in $(seq 1 120); do up "$1" && return 0; sleep 0.5; done; echo "timeout waiting for $1" >&2; return 1; }

if [ -z "${E2E_BASE_URL:-}" ]; then
  mkdir -p "$SESS" verification/tmp/worstcase
  if ! up "http://127.0.0.1:$API_PORT/api/status"; then
    HYPERSPACE_SESSIONS_DIR="$SESS" HYPERSPACE_FORCE_TEMPLATES=1 HYPERSPACE_NO_IMAGES=1 \
      setsid uv run uvicorn backend.app:app --host 127.0.0.1 --port "$API_PORT" > verification/tmp/worstcase/backend.log 2>&1 &
    PIDS+=($!)
    wait_up "http://127.0.0.1:$API_PORT/api/status" || exit 1
  fi
  if ! up "http://127.0.0.1:$VITE_PORT/"; then
    (cd frontend && HYPERSPACE_API="http://127.0.0.1:$API_PORT" exec setsid npx vite --port "$VITE_PORT" --strictPort) \
      > verification/tmp/worstcase/vite.log 2>&1 &
    PIDS+=($!)
    wait_up "http://127.0.0.1:$VITE_PORT/" || exit 1
  fi
  export E2E_BASE_URL="http://127.0.0.1:$VITE_PORT"
fi
echo "worst case: $E2E_BASE_URL, layers ${WORSTCASE_LAYERS:-all}, ${WORSTCASE_SECONDS:-60} s each, DISPLAY=$DISPLAY"
cd frontend && npx playwright test ../tests/e2e/worstcase-flash.spec.ts --reporter=line
