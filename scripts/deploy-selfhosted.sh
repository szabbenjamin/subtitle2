#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_USER="${TARGET_USER:-winben}"
TARGET_HOME="${TARGET_HOME:-/home/$TARGET_USER}"
BACKEND_DEPLOY_ROOT="${BACKEND_DEPLOY_ROOT:-$TARGET_HOME/subtitle2}"
FRONTEND_WEB_ROOT="${FRONTEND_WEB_ROOT:-/var/www/html}"
PM2_APP_NAME="${PM2_APP_NAME:-subtitle2}"
FRONTEND_BUILD_DIR="${FRONTEND_BUILD_DIR:-}"
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

if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
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

run_user_shell() {
  run_as_target_user bash -lc "
    export HOME='$TARGET_HOME'
    export NVM_DIR=\"\$HOME/.nvm\"
    if [[ ! -s \"\$NVM_DIR/nvm.sh\" ]]; then
      echo 'HIBA: nvm nincs telepítve a cél usernél (\$NVM_DIR/nvm.sh hiányzik).'
      exit 1
    fi
    source \"\$NVM_DIR/nvm.sh\"
    nvm use 24 >/dev/null
    NODE_MAJOR=\"\$(node -v | sed -E 's/^v([0-9]+).*/\\1/')\"
    if [[ \"\$NODE_MAJOR\" != \"24\" ]]; then
      echo \"HIBA: Kötelező Node 24, aktuális: \$(node -v)\"
      exit 1
    fi
    $*
  "
}

resolve_frontend_build_dir() {
  if [[ -n "$FRONTEND_BUILD_DIR" && -d "$FRONTEND_BUILD_DIR" ]]; then
    return 0
  fi

  local preferred="${PROJECT_ROOT}/frontend/dist/frontend/browser"
  if [[ -d "$preferred" ]]; then
    FRONTEND_BUILD_DIR="$preferred"
    return 0
  fi

  local detected
  detected="$(find "${PROJECT_ROOT}/frontend/dist" -maxdepth 3 -type d -name browser 2>/dev/null | head -n 1 || true)"
  if [[ -n "$detected" ]]; then
    FRONTEND_BUILD_DIR="$detected"
    return 0
  fi

  detected="$(find "${PROJECT_ROOT}/frontend/dist" -maxdepth 2 -mindepth 1 -type d 2>/dev/null | head -n 1 || true)"
  if [[ -n "$detected" ]]; then
    FRONTEND_BUILD_DIR="$detected"
    return 0
  fi

  return 1
}

mkdir -p "$BACKEND_DEPLOY_ROOT" "$BACKEND_DIR" "$BACKEND_DIR/data" "$BACKEND_DIR/uploads" "$FRONTEND_WEB_ROOT" 2>/dev/null || {
  if [[ -n "$SUDO" ]]; then
    $SUDO mkdir -p "$BACKEND_DEPLOY_ROOT" "$BACKEND_DIR" "$BACKEND_DIR/data" "$BACKEND_DIR/uploads" "$FRONTEND_WEB_ROOT"
  else
    echo "HIBA: Nincs jogosultság a deploy célkönyvtárakhoz, és passwordless sudo sem elérhető."
    echo "Futtasd egyszer: bash scripts/install-selfhosted.sh"
    exit 1
  fi
}

if ! run_user_shell "command -v pm2 >/dev/null 2>&1"; then
  if run_user_shell "command -v npm >/dev/null 2>&1"; then
    echo "pm2 nem található PATH-ban, globális telepítés indul..."
    run_user_shell "npm i -g pm2"
  fi
fi

if ! run_user_shell "command -v pm2 >/dev/null 2>&1"; then
  echo "HIBA: pm2 nincs telepítve vagy nincs PATH-ban."
  echo "Futtasd egyszer: bash scripts/install-selfhosted.sh"
  exit 1
fi

if ! resolve_frontend_build_dir; then
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
  if ! rsync -av --delete \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude 'backend/data' \
    --exclude 'backend/uploads' \
    "$PROJECT_ROOT/" "$BACKEND_DEPLOY_ROOT/"; then
    if [[ -n "$SUDO" ]]; then
      $SUDO rsync -av --delete \
        --exclude '.git' \
        --exclude 'node_modules' \
        --exclude 'backend/data' \
        --exclude 'backend/uploads' \
        "$PROJECT_ROOT/" "$BACKEND_DEPLOY_ROOT/"
    else
      echo "HIBA: Backend rsync sikertelen jogosultsági probléma miatt."
      exit 23
    fi
  fi
fi

# Frontend static build deploy a webszerver document rootba.
if ! rsync -av --delete \
  --exclude '.well-known' \
  "$FRONTEND_BUILD_DIR/" "$FRONTEND_WEB_ROOT/"; then
  if [[ -n "$SUDO" ]]; then
    $SUDO rsync -av --delete \
      --exclude '.well-known' \
      "$FRONTEND_BUILD_DIR/" "$FRONTEND_WEB_ROOT/"
  else
    echo "HIBA: Frontend rsync sikertelen jogosultsági probléma miatt."
    echo "Adj írásjogot a runner usernek a $FRONTEND_WEB_ROOT könyvtárra, vagy engedélyezz passwordless sudo-t."
    exit 23
  fi
fi

# Megőrzött fájlok visszaállítása.
if [[ -f "$TMP_DIR/.env" ]]; then
  cp "$TMP_DIR/.env" "$BACKEND_DEPLOY_ROOT/backend/.env"
fi
if [[ -f "$TMP_DIR/data/subtitle2.sqlite" ]]; then
  mkdir -p "$BACKEND_DEPLOY_ROOT/backend/data"
  cp "$TMP_DIR/data/subtitle2.sqlite" "$BACKEND_DEPLOY_ROOT/backend/data/subtitle2.sqlite"
fi

cd "$BACKEND_DIR"
run_user_shell "cd '$BACKEND_DIR' && npm ci --omit=dev"

if [[ ! -f "$BACKEND_DIR/dist/main.js" ]]; then
  echo "HIBA: A backend build hiányzik (dist/main.js)."
  echo "Ellenőrizd, hogy a CI futtatta-e a 'npm run build' lépést backend mappában."
  exit 1
fi

NODE_BIN="$(run_user_shell 'command -v node')"
if run_user_shell "pm2 describe '$PM2_APP_NAME' >/dev/null 2>&1"; then
  run_user_shell "pm2 restart '$PM2_APP_NAME' --update-env"
else
  run_user_shell "pm2 start '$BACKEND_DIR/dist/main.js' \
    --name "$PM2_APP_NAME" \
    --cwd '$BACKEND_DIR' \
    --interpreter '$NODE_BIN'"
fi
run_user_shell "pm2 save"

rm -rf "$TMP_DIR"
