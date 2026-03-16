#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_ROOT="${DEPLOY_ROOT:-/var/www/subtitle2}"
PM2_APP_NAME="${PM2_APP_NAME:-subtitle2-backend}"

mkdir -p "$DEPLOY_ROOT"
mkdir -p "$DEPLOY_ROOT/backend"
mkdir -p "$DEPLOY_ROOT/backend/data"
mkdir -p "$DEPLOY_ROOT/backend/uploads"

if ! command -v pm2 >/dev/null 2>&1; then
  echo "HIBA: pm2 nincs telepítve vagy nincs PATH-ban."
  exit 1
fi

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

cd "$DEPLOY_ROOT/backend"
npm ci --omit=dev

if [[ ! -f "$DEPLOY_ROOT/backend/dist/main.js" ]]; then
  echo "HIBA: A backend build hiányzik (dist/main.js)."
  echo "Ellenőrizd, hogy a CI futtatta-e a 'npm run build' lépést backend mappában."
  exit 1
fi

NODE_BIN="$(command -v node)"
if pm2 describe "$PM2_APP_NAME" >/dev/null 2>&1; then
  pm2 restart "$PM2_APP_NAME" --update-env
else
  pm2 start "$DEPLOY_ROOT/backend/dist/main.js" \
    --name "$PM2_APP_NAME" \
    --cwd "$DEPLOY_ROOT/backend" \
    --interpreter "$NODE_BIN"
fi
pm2 save

rm -rf "$TMP_DIR"
