#!/usr/bin/env bash
set -euo pipefail

# Self-hosted telepítő script backend+frontend deploy környezethez.
# Cél:
# - Node 24 + npm
# - pm2 + rsync
# - Whisper (python venv + openai-whisper)
# - backend deploy root: /home/winben/subtitle2
# - frontend web root: /var/www/html
# - opcionális GitHub Actions runner konfiguráció

TARGET_USER="${TARGET_USER:-winben}"
TARGET_HOME="${TARGET_HOME:-/home/$TARGET_USER}"
BACKEND_DEPLOY_ROOT="${BACKEND_DEPLOY_ROOT:-}"
FRONTEND_WEB_ROOT="${FRONTEND_WEB_ROOT:-/var/www/html}"
PM2_APP_NAME="${PM2_APP_NAME:-subtitle2}"
RUNNER_BASE_DIR="${RUNNER_BASE_DIR:-}"
RUNNER_LABELS="${RUNNER_LABELS:-self-hosted,linux,winben}"
WHISPER_DIR="${WHISPER_DIR:-$TARGET_HOME/whisper}"
WHISPER_VENV_PATH="${WHISPER_VENV_PATH:-$WHISPER_DIR/.venv}"
WHISPER_COMMAND="${WHISPER_COMMAND:-$WHISPER_VENV_PATH/bin/whisper}"

if id "$TARGET_USER" >/dev/null 2>&1; then
  TARGET_USER_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
  if [[ -n "$TARGET_USER_HOME" ]]; then
    TARGET_HOME="$TARGET_USER_HOME"
  fi
fi

BACKEND_DEPLOY_ROOT="${BACKEND_DEPLOY_ROOT:-$TARGET_HOME/subtitle2}"
RUNNER_BASE_DIR="${RUNNER_BASE_DIR:-$TARGET_HOME/actions-runner}"
BACKEND_DIR="$BACKEND_DEPLOY_ROOT/backend"

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

install_system_packages() {
  echo "[1/7] Rendszercsomagok telepítése..."
  $SUDO apt-get update -y
  $SUDO apt-get install -y curl ca-certificates tar rsync build-essential python3 python3-venv python3-pip ffmpeg
}

install_nvm_node24() {
  echo "[2/7] nvm + Node 24 ellenőrzés/telepítés..."
  run_as_target_user bash -lc '
  export NVM_DIR="$HOME/.nvm"

  if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi

  # shellcheck disable=SC1090
  source "$NVM_DIR/nvm.sh"
  nvm install 24
  nvm use 24

  if ! grep -q "NVM_DIR" "$HOME/.bashrc"; then
    cat >> "$HOME/.bashrc" <<'"'"'BASHRC_EOF'"'"'
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
BASHRC_EOF
  fi

  echo "Node verzió: $(node -v)"
  echo "npm verzió: $(npm -v)"
  '
}

install_pm2() {
  echo "[3/7] pm2 telepítése..."
  run_as_target_user bash -lc '
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1090
  source "$NVM_DIR/nvm.sh"
  nvm use 24 >/dev/null
  npm i -g pm2
  pm2 --version
  '
}

prepare_deploy_dirs() {
  echo "[4/7] Deploy könyvtárak előkészítése..."
  $SUDO mkdir -p "$BACKEND_DIR/data"
  $SUDO mkdir -p "$BACKEND_DIR/uploads"
  $SUDO mkdir -p "$FRONTEND_WEB_ROOT"

  $SUDO chown -R "$TARGET_USER":"$TARGET_USER" "$BACKEND_DEPLOY_ROOT"
  $SUDO chown -R "$TARGET_USER":"$TARGET_USER" "$FRONTEND_WEB_ROOT"

  echo "Backend deploy root: $BACKEND_DEPLOY_ROOT"
  echo "Backend dir: $BACKEND_DIR"
  echo "Frontend web root: $FRONTEND_WEB_ROOT"
}

configure_pm2_startup() {
  echo "[5/7] PM2 startup konfiguráció..."
  run_as_target_user bash -lc '
  pm2 startup systemd -u "'"$TARGET_USER"'" --hp "'"$TARGET_HOME"'" >/tmp/pm2-startup.txt || true

  if grep -q "sudo" /tmp/pm2-startup.txt; then
    STARTUP_CMD="$(grep -Eo "sudo .*pm2 startup.*" /tmp/pm2-startup.txt | head -n1 || true)"
    if [[ -n "$STARTUP_CMD" ]]; then
      eval "$STARTUP_CMD"
    fi
  fi

  pm2 save || true
  '
  echo "PM2 app név ajánlottan: $PM2_APP_NAME"
}

configure_runner_optional() {
  echo "[6/7] Opcionális GitHub Actions runner konfiguráció..."

  if [[ -z "${RUNNER_URL:-}" || -z "${RUNNER_TOKEN:-}" ]]; then
    echo "RUNNER_URL vagy RUNNER_TOKEN nincs megadva, runner konfiguráció kihagyva."
    echo "Ha kell: export RUNNER_URL='https://github.com/<owner>/<repo>'"
    echo "        export RUNNER_TOKEN='<runner-registration-token>'"
    return
  fi

  mkdir -p "$RUNNER_BASE_DIR"
  cd "$RUNNER_BASE_DIR"

  if [[ ! -f "./config.sh" ]]; then
    curl -fsSL -o actions-runner-linux-x64.tar.gz \
      "https://github.com/actions/runner/releases/download/v2.325.0/actions-runner-linux-x64-2.325.0.tar.gz"
    tar xzf ./actions-runner-linux-x64.tar.gz
    rm -f ./actions-runner-linux-x64.tar.gz
  fi

  if [[ -f ".runner" ]]; then
    echo "Runner már konfigurálva, service újraindítás..."
  else
    ./config.sh \
      --url "$RUNNER_URL" \
      --token "$RUNNER_TOKEN" \
      --name "${RUNNER_NAME:-$(hostname)-winben}" \
      --labels "$RUNNER_LABELS" \
      --unattended \
      --replace
  fi

  $SUDO ./svc.sh install "$TARGET_USER"
  $SUDO ./svc.sh start
  echo "Runner service státusz:"
  $SUDO ./svc.sh status || true
}

install_whisper() {
  echo "[7/7] Whisper telepítése..."
  run_as_target_user bash -lc '
  set -euo pipefail

  mkdir -p "'"$WHISPER_DIR"'"
  cd "'"$WHISPER_DIR"'"

  if [[ ! -d "'"$WHISPER_VENV_PATH"'" ]]; then
    python3 -m venv "'"$WHISPER_VENV_PATH"'"
  fi

  source "'"$WHISPER_VENV_PATH"'/bin/activate"
  pip install --upgrade pip setuptools wheel
  pip install --upgrade openai-whisper

  "'"$WHISPER_COMMAND"'" --help >/dev/null
  echo "Whisper telepítve: '"$WHISPER_COMMAND"'"
  '
}

main() {
  install_system_packages
  install_nvm_node24
  install_pm2
  prepare_deploy_dirs
  configure_pm2_startup
  configure_runner_optional
  install_whisper

  echo
  echo "Kész. Következő lépések:"
  echo "1) Állítsd be a backend .env fájlt: $BACKEND_DIR/.env"
  echo "2) Ellenőrizd, hogy a workflow env-jei passzolnak:"
  echo "   BACKEND_DEPLOY_ROOT=$BACKEND_DEPLOY_ROOT"
  echo "   FRONTEND_WEB_ROOT=$FRONTEND_WEB_ROOT"
  echo "   PM2_APP_NAME=$PM2_APP_NAME"
  echo "   TARGET_USER=$TARGET_USER"
  echo "3) Backend .env-ben állítsd be a whisper parancsot:"
  echo "   WHISPER_COMMAND=$WHISPER_COMMAND"
}

main "$@"
