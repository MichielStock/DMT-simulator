#!/usr/bin/env bash
# Render galleries (BUILD.md 16.2): capture → tools/gallery_checks.py → tools/gallery_sheet.py (docs/gallery.html).
#
#   scripts/gallery.sh                     all layers
#   GALLERY_LAYERS=room scripts/gallery.sh only these layers (checks.json keeps the other layers' rows)
#
# Server: E2E_BASE_URL if set (e.g. ./run.sh --serve-only on 8765, or a Vite dev server); otherwise this
# script starts its own stack if needed — back end with HYPERSPACE_FORCE_TEMPLATES=1 HYPERSPACE_NO_IMAGES=1 on
# GALLERY_API_PORT (8771) and a Vite dev server on GALLERY_VITE_PORT (5174), sessions under
# verification/tmp/gallery/sessions — and stops what it started on exit. Exit status: the checks' status
# (non-zero if any frame fails or the capture failed).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
API_PORT="${GALLERY_API_PORT:-8771}"
VITE_PORT="${GALLERY_VITE_PORT:-5174}"
SESS="${HYPERSPACE_SESSIONS_DIR:-verification/tmp/gallery/sessions}"
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && { kill -- "-$p" 2>/dev/null || kill "$p" 2>/dev/null; }; done; }
trap cleanup EXIT

up() { curl -sf -o /dev/null --max-time 2 "$1"; }
wait_up() { for _ in $(seq 1 120); do up "$1" && return 0; sleep 0.5; done; echo "timeout waiting for $1" >&2; return 1; }

if [ -z "${E2E_BASE_URL:-}" ]; then
  mkdir -p "$SESS" verification/tmp/gallery
  if ! up "http://127.0.0.1:$API_PORT/api/status"; then
    HYPERSPACE_SESSIONS_DIR="$SESS" HYPERSPACE_FORCE_TEMPLATES=1 HYPERSPACE_NO_IMAGES=1 \
      setsid uv run uvicorn backend.app:app --host 127.0.0.1 --port "$API_PORT" > verification/tmp/gallery/backend.log 2>&1 &
    PIDS+=($!)
    wait_up "http://127.0.0.1:$API_PORT/api/status" || exit 1
  fi
  if ! up "http://127.0.0.1:$VITE_PORT/"; then
    (cd frontend && HYPERSPACE_API="http://127.0.0.1:$API_PORT" exec setsid npx vite --port "$VITE_PORT" --strictPort) \
      > verification/tmp/gallery/vite.log 2>&1 &
    PIDS+=($!)
    wait_up "http://127.0.0.1:$VITE_PORT/" || exit 1
  fi
  export E2E_BASE_URL="http://127.0.0.1:$VITE_PORT"
  export HYPERSPACE_SESSIONS_DIR="$SESS"
fi
echo "gallery: capturing against $E2E_BASE_URL (layers: ${GALLERY_LAYERS:-all})"

(cd frontend && GALLERY_SKIP_CHECKS=1 npx playwright test ../tests/e2e/gallery.spec.ts --reporter=line)
CAP=$?
LAYER_ARG=()
[ -n "${GALLERY_LAYERS:-}" ] && LAYER_ARG=(--layers "$GALLERY_LAYERS")
uv run python tools/gallery_checks.py verification/gallery "${LAYER_ARG[@]}"
CHK=$?
uv run python tools/gallery_sheet.py
echo "gallery: capture exit $CAP, checks exit $CHK; contact sheet docs/gallery.html"
[ $CAP -ne 0 ] && exit $CAP
exit $CHK
