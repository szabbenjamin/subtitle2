#!/usr/bin/env bash
set -euo pipefail

PRELOADED_CACHE_DIR="${PRELOADED_CACHE_DIR:-/opt/whisper/preloaded-cache}"
TARGET_CACHE_DIR="${XDG_CACHE_HOME:-/opt/whisper/cache}"

if [ -d "$PRELOADED_CACHE_DIR" ]; then
  mkdir -p "$TARGET_CACHE_DIR"
  if [ -z "$(ls -A "$TARGET_CACHE_DIR" 2>/dev/null)" ]; then
    echo "[Entrypoint] Cache mappa ures, model cache seed indul: $PRELOADED_CACHE_DIR -> $TARGET_CACHE_DIR"
    cp -a "$PRELOADED_CACHE_DIR/." "$TARGET_CACHE_DIR/"
  fi
fi

exec "$@"
