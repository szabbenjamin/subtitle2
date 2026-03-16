#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND_DEPLOY_ROOT="${BACKEND_DEPLOY_ROOT:-/var/www/winben}"
FRONTEND_WEB_ROOT="${FRONTEND_WEB_ROOT:-/var/www/html}"
PM2_APP_NAME="${PM2_APP_NAME:-winben}"
FRONTEND_BUILD_DIR="${PROJECT_ROOT}/frontend/dist/frontend/browser"

mkdir -p "$BACKEND_DEPLOY_ROOT"
mkdir -p "$BACKEND_DEPLOY_ROOT/backend"
mkdir -p "$BACKEND_DEPLOY_ROOT/backend/data"
mkdir -p "$BACKEND_DEPLOY_ROOT/backend/uploads"
mkdir -p "$FRONTEND_WEB_ROOT"

if ! command -v pm2 >/dev/null 2>&1; then
  echo "HIBA: pm2 nincs telepítve vagy nincs PATH-ban."
  exit 1
fi

if [[ ! -d "$FRONTEND_BUILD_DIR" ]]; then
  echo "HIBA: frontend build könyvtár hiányzik: $FRONTEND_BUILD_DIR"
  echo "Ellenőrizd, hogy a CI futtatta-e a frontend 'npm run build' lépést."
  exit 1
fi

# Megőrzendő lokális fájlok mentése deploy előtt.
TMP_DIR="$(mktemp -d)"
if [[ -f "$BACKEND_DEPLOY_ROOT/backend/.env" ]]; then
  cp "$BACKEND_DEPLOY_ROOT/backend/.env" "$TMP_DIR/.env"
fi
if [[ -f "$BACKEND_DEPLOY_ROOT/backend/data/subtitle2.sqlite" ]]; then
  mkdir -p "$TMP_DIR/data"
  cp "$BACKEND_DEPLOY_ROOT/backend/data/subtitle2.sqlite" "$TMP_DIR/data/subtitle2.sqlite"
fi

# Backend forrás deploy.
rsync -av --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'backend/data' \
  --exclude 'backend/uploads' \
  "$PROJECT_ROOT/" "$BACKEND_DEPLOY_ROOT/"

# Frontend static build deploy a webszerver document rootba.
rsync -av --delete \
  --exclude '.well-known' \
  "$FRONTEND_BUILD_DIR/" "$FRONTEND_WEB_ROOT/"

# Megőrzött fájlok visszaállítása.
if [[ -f "$TMP_DIR/.env" ]]; then
  cp "$TMP_DIR/.env" "$BACKEND_DEPLOY_ROOT/backend/.env"
fi
if [[ -f "$TMP_DIR/data/subtitle2.sqlite" ]]; then
  mkdir -p "$BACKEND_DEPLOY_ROOT/backend/data"
  cp "$TMP_DIR/data/subtitle2.sqlite" "$BACKEND_DEPLOY_ROOT/backend/data/subtitle2.sqlite"
fi

cd "$BACKEND_DEPLOY_ROOT/backend"
npm ci --omit=dev

if [[ ! -f "$BACKEND_DEPLOY_ROOT/backend/dist/main.js" ]]; then
  echo "HIBA: A backend build hiányzik (dist/main.js)."
  echo "Ellenőrizd, hogy a CI futtatta-e a 'npm run build' lépést backend mappában."
  exit 1
fi

NODE_BIN="$(command -v node)"
if pm2 describe "$PM2_APP_NAME" >/dev/null 2>&1; then
  pm2 restart "$PM2_APP_NAME" --update-env
else
  pm2 start "$BACKEND_DEPLOY_ROOT/backend/dist/main.js" \
    --name "$PM2_APP_NAME" \
    --cwd "$BACKEND_DEPLOY_ROOT/backend" \
    --interpreter "$NODE_BIN"
fi
pm2 save

rm -rf "$TMP_DIR"
