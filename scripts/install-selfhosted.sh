#!/usr/bin/env bash
set -euo pipefail

# Self-hosted telepítő script backend+frontend deploy környezethez.
# Cél:
# - Node 24 + npm
# - pm2 + rsync
# - backend deploy root: /var/www/winben
# - frontend web root: /var/www/html
# - opcionális GitHub Actions runner konfiguráció

BACKEND_DEPLOY_ROOT="${BACKEND_DEPLOY_ROOT:-/var/www/winben}"
FRONTEND_WEB_ROOT="${FRONTEND_WEB_ROOT:-/var/www/html}"
PM2_APP_NAME="${PM2_APP_NAME:-winben}"
RUNNER_BASE_DIR="${RUNNER_BASE_DIR:-$HOME/actions-runner}"
RUNNER_LABELS="${RUNNER_LABELS:-self-hosted,linux,winben}"

if command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
else
  SUDO=""
fi

install_system_packages() {
  echo "[1/6] Rendszercsomagok telepítése..."
  $SUDO apt-get update -y
  $SUDO apt-get install -y curl ca-certificates tar rsync build-essential
}

install_nvm_node24() {
  echo "[2/6] nvm + Node 24 ellenőrzés/telepítés..."
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

  if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi

  # shellcheck disable=SC1090
  source "$NVM_DIR/nvm.sh"
  nvm install 24
  nvm use 24

  if ! grep -q 'NVM_DIR' "$HOME/.bashrc"; then
    cat >> "$HOME/.bashrc" <<'BASHRC_EOF'
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
BASHRC_EOF
  fi

  echo "Node verzió: $(node -v)"
  echo "npm verzió: $(npm -v)"
}

install_pm2() {
  echo "[3/6] pm2 telepítése..."
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1090
  source "$NVM_DIR/nvm.sh"
  nvm use 24 >/dev/null
  npm i -g pm2
  pm2 --version
}

prepare_deploy_dirs() {
  echo "[4/6] Deploy könyvtárak előkészítése..."
  $SUDO mkdir -p "$BACKEND_DEPLOY_ROOT/backend/data"
  $SUDO mkdir -p "$BACKEND_DEPLOY_ROOT/backend/uploads"
  $SUDO mkdir -p "$FRONTEND_WEB_ROOT"

  $SUDO chown -R "$USER":"$USER" "$BACKEND_DEPLOY_ROOT"
  $SUDO chown -R "$USER":"$USER" "$FRONTEND_WEB_ROOT"

  echo "Backend deploy root: $BACKEND_DEPLOY_ROOT"
  echo "Frontend web root: $FRONTEND_WEB_ROOT"
}

configure_pm2_startup() {
  echo "[5/6] PM2 startup konfiguráció..."
  pm2 startup systemd -u "$USER" --hp "$HOME" >/tmp/pm2-startup.txt || true

  if grep -q "sudo" /tmp/pm2-startup.txt; then
    STARTUP_CMD="$(grep -Eo 'sudo .*pm2 startup.*' /tmp/pm2-startup.txt | head -n1 || true)"
    if [[ -n "$STARTUP_CMD" ]]; then
      eval "$STARTUP_CMD"
    fi
  fi

  pm2 save || true
  echo "PM2 app név ajánlottan: $PM2_APP_NAME"
}

configure_runner_optional() {
  echo "[6/6] Opcionális GitHub Actions runner konfiguráció..."

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

  $SUDO ./svc.sh install "$USER"
  $SUDO ./svc.sh start
  echo "Runner service státusz:"
  $SUDO ./svc.sh status || true
}

main() {
  install_system_packages
  install_nvm_node24
  install_pm2
  prepare_deploy_dirs
  configure_pm2_startup
  configure_runner_optional

  echo
  echo "Kész. Következő lépések:"
  echo "1) Állítsd be a backend .env fájlt: $BACKEND_DEPLOY_ROOT/backend/.env"
  echo "2) Ellenőrizd, hogy a workflow env-jei passzolnak:"
  echo "   BACKEND_DEPLOY_ROOT=$BACKEND_DEPLOY_ROOT"
  echo "   FRONTEND_WEB_ROOT=$FRONTEND_WEB_ROOT"
  echo "   PM2_APP_NAME=$PM2_APP_NAME"
}

main "$@"
