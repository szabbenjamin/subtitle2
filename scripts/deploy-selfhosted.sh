#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_ROOT="${DEPLOY_ROOT:-/var/www/subtitle2}"

mkdir -p "$DEPLOY_ROOT"
mkdir -p "$DEPLOY_ROOT/backend"

# Megőrzendő lokális fájlok mentése deploy előtt.
TMP_DIR="$(mktemp -d)"
if [[ -f "$DEPLOY_ROOT/backend/.env" ]]; then
  cp "$DEPLOY_ROOT/backend/.env" "$TMP_DIR/.env"
fi
if [[ -f "$DEPLOY_ROOT/backend/data/subtitle2.sqlite" ]]; then
  mkdir -p "$TMP_DIR/data"
  cp "$DEPLOY_ROOT/backend/data/subtitle2.sqlite" "$TMP_DIR/data/subtitle2.sqlite"
fi

rsync -av --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'backend/data' \
  --exclude 'backend/uploads' \
  "$PROJECT_ROOT/" "$DEPLOY_ROOT/"

# Megőrzött fájlok visszaállítása.
if [[ -f "$TMP_DIR/.env" ]]; then
  cp "$TMP_DIR/.env" "$DEPLOY_ROOT/backend/.env"
fi
if [[ -f "$TMP_DIR/data/subtitle2.sqlite" ]]; then
  mkdir -p "$DEPLOY_ROOT/backend/data"
  cp "$TMP_DIR/data/subtitle2.sqlite" "$DEPLOY_ROOT/backend/data/subtitle2.sqlite"
fi

rm -rf "$TMP_DIR"
