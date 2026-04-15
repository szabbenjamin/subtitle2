#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

TARGET_USER="${TARGET_USER:-winben}"
TARGET_HOME="${TARGET_HOME:-/home/$TARGET_USER}"
RUNNER_BASE_DIR="${RUNNER_BASE_DIR:-$TARGET_HOME/actions-runner}"
RUNNER_LABELS="${RUNNER_LABELS:-self-hosted,linux,winben}"
ENV_FILE_PATH_RAW="${ENV_FILE_PATH:-$PROJECT_ROOT/.env.docker}"

if id "$TARGET_USER" >/dev/null 2>&1; then
  TARGET_USER_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
  if [[ -n "$TARGET_USER_HOME" ]]; then
    TARGET_HOME="$TARGET_USER_HOME"
  fi
fi

if [[ "$ENV_FILE_PATH_RAW" == /* ]]; then
  ENV_FILE_PATH="$ENV_FILE_PATH_RAW"
else
  ENV_FILE_PATH="$(realpath -m "$PROJECT_ROOT/$ENV_FILE_PATH_RAW")"
fi

if [[ "$(id -u)" -eq 0 ]]; then
  ROOT_PREFIX=()
elif command -v sudo >/dev/null 2>&1; then
  ROOT_PREFIX=(sudo)
else
  echo "HIBA: root vagy sudo jogosultság szükséges a telepítéshez."
  exit 1
fi

run_root() {
  "${ROOT_PREFIX[@]}" "$@"
}

run_as_target_user() {
  if [[ "$(id -un)" == "$TARGET_USER" ]]; then
    "$@"
    return
  fi

  if command -v sudo >/dev/null 2>&1; then
    sudo -H -u "$TARGET_USER" env HOME="$TARGET_HOME" USER="$TARGET_USER" LOGNAME="$TARGET_USER" "$@"
    return
  fi

  echo "HIBA: Nem lehet a target userrel futtatni parancsot (sudo nem elérhető)."
  exit 1
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

strip_quotes() {
  local value="$1"
  if [[ "$value" =~ ^\".*\"$ ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" =~ ^\'.*\'$ ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

read_env_value() {
  local key="$1"
  local fallback="$2"

  if [[ ! -f "$ENV_FILE_PATH" ]]; then
    printf '%s' "$fallback"
    return
  fi

  local line
  line="$(grep -E "^${key}=" "$ENV_FILE_PATH" | tail -n 1 || true)"
  if [[ -z "$line" ]]; then
    printf '%s' "$fallback"
    return
  fi

  local value="${line#*=}"
  value="${value%$'\r'}"
  value="$(trim "$value")"
  value="$(strip_quotes "$value")"

  if [[ -z "$value" ]]; then
    printf '%s' "$fallback"
  else
    printf '%s' "$value"
  fi
}

to_abs_path() {
  local path_value="$1"
  if [[ "$path_value" == /* ]]; then
    printf '%s' "$path_value"
  else
    printf '%s' "$(realpath -m "$PROJECT_ROOT/$path_value")"
  fi
}

install_base_packages() {
  echo "[1/5] Rendszercsomagok telepítése..."
  # Korabbi hibas Docker repo bejegyzesek torlese (pl. ubuntu repo Debianra).
  run_root rm -f /etc/apt/sources.list.d/docker.list /etc/apt/sources.list.d/docker-ce.list
  run_root apt-get update -y
  run_root apt-get install -y ca-certificates curl gnupg lsb-release git rsync
}

install_docker_engine() {
  echo "[2/5] Docker Engine + Compose plugin telepítése..."

  local os_id codename repo_flavor repo_codename
  os_id="$(. /etc/os-release && printf '%s' "${ID:-}")"
  codename="$(. /etc/os-release && printf '%s' "${VERSION_CODENAME:-}")"
  repo_codename="${DOCKER_REPO_CODENAME:-$codename}"

  case "$os_id" in
    ubuntu)
      repo_flavor="ubuntu"
      ;;
    debian)
      repo_flavor="debian"
      if [[ "$repo_codename" == "trixie" || "$repo_codename" == "sid" || "$repo_codename" == "testing" ]]; then
        repo_codename="${DOCKER_DEBIAN_CODENAME_FALLBACK:-bookworm}"
        echo "Info: Debian '$codename' esetén Docker repo fallback codename: $repo_codename"
      fi
      ;;
    *)
      echo "HIBA: nem tamogatott disztribucio Docker telepiteshez: ID=$os_id"
      echo "Támogatott: debian, ubuntu"
      exit 1
      ;;
  esac

  if [[ -z "$repo_codename" ]]; then
    echo "HIBA: nem sikerult kiolvasni a disztribucio codename erteket."
    echo "Add meg kezzel: export DOCKER_REPO_CODENAME=<codename>"
    exit 1
  fi

  run_root install -m 0755 -d /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
    curl -fsSL "https://download.docker.com/linux/${repo_flavor}/gpg" | run_root gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  fi
  run_root chmod a+r /etc/apt/keyrings/docker.gpg

  local arch
  arch="$(dpkg --print-architecture)"

  echo "deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${repo_flavor} ${repo_codename} stable" \
    | run_root tee /etc/apt/sources.list.d/docker.list >/dev/null

  run_root apt-get update -y
  run_root apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  run_root systemctl enable --now docker

  docker --version
  docker compose version
}

configure_docker_user() {
  echo "[3/5] Docker jogosultság beállítása userre..."

  if ! id "$TARGET_USER" >/dev/null 2>&1; then
    echo "HIBA: target user nem található: $TARGET_USER"
    exit 1
  fi

  run_root usermod -aG docker "$TARGET_USER"
  echo "A(z) $TARGET_USER user hozzáadva a docker csoporthoz."
}

prepare_bind_dirs() {
  echo "[4/5] Docker bind mount mappák előkészítése..."

  local mysql_data_dir backend_uploads_dir backend_data_dir whisper_cache_dir
  mysql_data_dir="$(to_abs_path "$(read_env_value MYSQL_DATA_DIR ./docker-data/mysql)")"
  backend_uploads_dir="$(to_abs_path "$(read_env_value BACKEND_UPLOADS_DIR ./docker-data/uploads)")"
  backend_data_dir="$(to_abs_path "$(read_env_value BACKEND_DATA_DIR ./docker-data/data)")"
  whisper_cache_dir="$(to_abs_path "$(read_env_value WHISPER_CACHE_DIR ./docker-data/whisper-cache)")"

  run_root mkdir -p "$mysql_data_dir" "$backend_uploads_dir" "$backend_data_dir" "$whisper_cache_dir"
  run_root chown -R "$TARGET_USER":"$TARGET_USER" "$mysql_data_dir" "$backend_uploads_dir" "$backend_data_dir" "$whisper_cache_dir"

  echo "MYSQL_DATA_DIR=$mysql_data_dir"
  echo "BACKEND_UPLOADS_DIR=$backend_uploads_dir"
  echo "BACKEND_DATA_DIR=$backend_data_dir"
  echo "WHISPER_CACHE_DIR=$whisper_cache_dir"
}

configure_runner_optional() {
  echo "[5/5] Opcionális GitHub Actions runner konfiguráció..."

  if [[ -z "${RUNNER_URL:-}" || -z "${RUNNER_TOKEN:-}" ]]; then
    echo "RUNNER_URL vagy RUNNER_TOKEN nincs megadva, runner konfiguráció kihagyva."
    echo "Ha kell: export RUNNER_URL='https://github.com/<owner>/<repo>'"
    echo "        export RUNNER_TOKEN='<runner-registration-token>'"
    return
  fi

  run_root mkdir -p "$RUNNER_BASE_DIR"
  run_root chown -R "$TARGET_USER":"$TARGET_USER" "$RUNNER_BASE_DIR"

  run_as_target_user bash -lc '
    set -euo pipefail
    cd "'"$RUNNER_BASE_DIR"'"

    if [[ ! -f "./config.sh" ]]; then
      curl -fsSL -o actions-runner-linux-x64.tar.gz \
        "https://github.com/actions/runner/releases/download/v2.325.0/actions-runner-linux-x64-2.325.0.tar.gz"
      tar xzf ./actions-runner-linux-x64.tar.gz
      rm -f ./actions-runner-linux-x64.tar.gz
    fi

    if [[ ! -f ".runner" ]]; then
      ./config.sh \
        --url "'"${RUNNER_URL}"'" \
        --token "'"${RUNNER_TOKEN}"'" \
        --name "'"${RUNNER_NAME:-$(hostname)-$TARGET_USER}"'" \
        --labels "'"$RUNNER_LABELS"'" \
        --unattended \
        --replace
    fi
  '

  run_root bash -lc "cd '$RUNNER_BASE_DIR' && ./svc.sh install '$TARGET_USER'"
  run_root bash -lc "cd '$RUNNER_BASE_DIR' && ./svc.sh start"
  run_root bash -lc "cd '$RUNNER_BASE_DIR' && ./svc.sh status || true"
}

main() {
  install_base_packages
  install_docker_engine
  configure_docker_user
  prepare_bind_dirs
  configure_runner_optional

  echo
  echo "Kész. Következő lépések:"
  echo "1) Töltsd ki a .env.docker fájlt (vagy CI-ben ENV_DOCKER secretként add meg)."
  echo "2) A docker csoport tagság miatt jelentkezz ki/be a $TARGET_USER userrel, vagy indíts új shellt."
  echo "3) Helyben indítás: docker compose up --build -d"
  echo "4) CI deploy script: bash scripts/deploy-selfhosted.sh"
}

main "$@"
