#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_USER="${TARGET_USER:-winben}"
TARGET_HOME="${TARGET_HOME:-/home/$TARGET_USER}"
BACKEND_DEPLOY_ROOT="${BACKEND_DEPLOY_ROOT:-$TARGET_HOME/subtitle2}"
FRONTEND_WEB_ROOT="${FRONTEND_WEB_ROOT:-/var/www/html}"
PM2_APP_NAME="${PM2_APP_NAME:-subtitle2}"
FRONTEND_BUILD_DIR="${PROJECT_ROOT}/frontend/dist/frontend/browser"
BACKEND_DIR="$BACKEND_DEPLOY_ROOT/backend"
PROJECT_ROOT_REAL="$(realpath "$PROJECT_ROOT")"
BACKEND_DEPLOY_ROOT_REAL="$(realpath -m "$BACKEND_DEPLOY_ROOT")"
IN_PLACE_DEPLOY=false

if [[ "$PROJECT_ROOT_REAL" == "$BACKEND_DEPLOY_ROOT_REAL" ]]; then
  IN_PLACE_DEPLOY=true
fi

if id "$TARGET_USER" >/dev/null 2>&1; then
  TARGET_USER_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
  if [[ -n "$TARGET_USER_HOME" ]]; then
    TARGET_HOME="$TARGET_USER_HOME"
  fi
fi

if command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
else
  SUDO=""
fi

run_as_target_user() {
  if [[ "$(id -un)" == "$TARGET_USER" ]]; then
    "$@"
  else
    $SUDO -H -u "$TARGET_USER" env \
      HOME="$TARGET_HOME" \
      USER="$TARGET_USER" \
      LOGNAME="$TARGET_USER" \
      "$@"
  fi
}

$SUDO mkdir -p "$BACKEND_DEPLOY_ROOT"
$SUDO mkdir -p "$BACKEND_DIR"
$SUDO mkdir -p "$BACKEND_DIR/data"
$SUDO mkdir -p "$BACKEND_DIR/uploads"
$SUDO mkdir -p "$FRONTEND_WEB_ROOT"
$SUDO chown -R "$TARGET_USER":"$TARGET_USER" "$BACKEND_DEPLOY_ROOT"
$SUDO chown -R "$TARGET_USER":"$TARGET_USER" "$FRONTEND_WEB_ROOT"

if ! run_as_target_user bash -lc "command -v pm2 >/dev/null 2>&1"; then
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
if [[ "$IN_PLACE_DEPLOY" == true ]]; then
  echo "In-place deploy mód: BACKEND_DEPLOY_ROOT megegyezik a repository gyökérrel, rsync kihagyva."
else
  $SUDO rsync -av --delete \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude 'backend/data' \
    --exclude 'backend/uploads' \
    "$PROJECT_ROOT/" "$BACKEND_DEPLOY_ROOT/"
fi

# Frontend static build deploy a webszerver document rootba.
$SUDO rsync -av --delete \
  --exclude '.well-known' \
  "$FRONTEND_BUILD_DIR/" "$FRONTEND_WEB_ROOT/"

$SUDO chown -R "$TARGET_USER":"$TARGET_USER" "$BACKEND_DEPLOY_ROOT"
$SUDO chown -R "$TARGET_USER":"$TARGET_USER" "$FRONTEND_WEB_ROOT"

# Megőrzött fájlok visszaállítása.
if [[ -f "$TMP_DIR/.env" ]]; then
  cp "$TMP_DIR/.env" "$BACKEND_DEPLOY_ROOT/backend/.env"
fi
if [[ -f "$TMP_DIR/data/subtitle2.sqlite" ]]; then
  mkdir -p "$BACKEND_DEPLOY_ROOT/backend/data"
  cp "$TMP_DIR/data/subtitle2.sqlite" "$BACKEND_DEPLOY_ROOT/backend/data/subtitle2.sqlite"
fi

cd "$BACKEND_DIR"
run_as_target_user bash -lc "cd '$BACKEND_DIR' && npm ci --omit=dev"

if [[ ! -f "$BACKEND_DIR/dist/main.js" ]]; then
  echo "HIBA: A backend build hiányzik (dist/main.js)."
  echo "Ellenőrizd, hogy a CI futtatta-e a 'npm run build' lépést backend mappában."
  exit 1
fi

NODE_BIN="$(run_as_target_user bash -lc 'command -v node')"
if run_as_target_user bash -lc "pm2 describe '$PM2_APP_NAME' >/dev/null 2>&1"; then
  run_as_target_user bash -lc "pm2 restart '$PM2_APP_NAME' --update-env"
else
  run_as_target_user bash -lc "pm2 start '$BACKEND_DIR/dist/main.js' \
    --name "$PM2_APP_NAME" \
    --cwd '$BACKEND_DIR' \
    --interpreter '$NODE_BIN'"
fi
run_as_target_user bash -lc "pm2 save"

rm -rf "$TMP_DIR"
