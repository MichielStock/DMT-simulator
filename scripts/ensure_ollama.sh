#!/usr/bin/env bash
# Idempotent: make sure the user-space Ollama (>= 0.5, JSON-schema format) answers on 127.0.0.1:11435.
set -euo pipefail
HOST="127.0.0.1:11435"
VERSION="v0.40.2"
DIR="$HOME/.local/opt/ollama"
BIN="$DIR/bin/ollama"
DATA="$HOME/.local/share/hyperspace"
LOG="$DATA/logs/ollama.log"
mkdir -p "$DATA/logs" "$DATA/ollama"

if curl -fsS --max-time 3 "http://$HOST/api/version" >/dev/null 2>&1; then
  echo "ollama already answering on $HOST"; exit 0
fi

if [ ! -x "$BIN" ]; then
  echo "installing Ollama $VERSION into $DIR"
  mkdir -p "$DIR" "$DATA/dl"
  URL="https://github.com/ollama/ollama/releases/download/$VERSION/ollama-linux-amd64.tar.zst"
  curl -fL --retry 3 -o "$DATA/dl/ollama.tar.zst" "$URL"
  tar --zstd -xf "$DATA/dl/ollama.tar.zst" -C "$DIR"
  rm -f "$DATA/dl/ollama.tar.zst"
  [ -x "$BIN" ] || { echo "ollama binary missing after extraction" >&2; exit 1; }
fi

OLLAMA_HOST=$HOST OLLAMA_MODELS="$DATA/ollama" OLLAMA_KEEP_ALIVE=0 \
  nohup "$BIN" serve >>"$LOG" 2>&1 &
for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 "http://$HOST/api/version" >/dev/null 2>&1; then
    echo "ollama started on $HOST"; exit 0
  fi
  sleep 1
done
echo "ollama did not answer within 60 s; see $LOG" >&2
exit 1
