#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

TARGET_USER="${TARGET_USER:-$(id -un)}"
ENV_FILE_PATH_RAW="${ENV_FILE_PATH:-$PROJECT_ROOT/.env.docker}"
DOCKER_PROJECT_NAME="${DOCKER_PROJECT_NAME:-subtitle2}"
DOCKER_COMPOSE_FILES_RAW="${DOCKER_COMPOSE_FILES:-docker-compose.yml}"
DOCKER_PULL_BEFORE_UP="${DOCKER_PULL_BEFORE_UP:-false}"

if [[ "$ENV_FILE_PATH_RAW" == /* ]]; then
  ENV_FILE_PATH="$ENV_FILE_PATH_RAW"
else
  ENV_FILE_PATH="$(realpath -m "$PROJECT_ROOT/$ENV_FILE_PATH_RAW")"
fi

if [[ ! -f "$ENV_FILE_PATH" ]]; then
  echo "HIBA: Env fájl nem található: $ENV_FILE_PATH"
  echo "Állítsd be az ENV_FILE_PATH változót, vagy hozd létre a .env.docker fájlt."
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "HIBA: docker nincs telepítve vagy nincs PATH-ban."
  echo "Futtasd egyszer: bash scripts/install-selfhosted.sh"
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE_BIN=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_BIN=(docker-compose)
else
  echo "HIBA: docker compose plugin nem érhető el (se 'docker compose', se 'docker-compose')."
  echo "Futtasd egyszer: bash scripts/install-selfhosted.sh"
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "HIBA: Docker daemon nem elérhető az aktuális userrel ($(id -un))."
  echo "Ellenőrizd, hogy fut-e a docker service, és hogy a user tagja-e a docker csoportnak."
  exit 1
fi

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

mkdir_safe() {
  local dir="$1"
  if mkdir -p "$dir" >/dev/null 2>&1; then
    return
  fi

  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    sudo mkdir -p "$dir"
    sudo chown -R "$TARGET_USER":"$TARGET_USER" "$dir" || true
    return
  fi

  echo "HIBA: Nem sikerült létrehozni a könyvtárat: $dir"
  echo "Adj írásjogot a runner usernek, vagy engedélyezz passwordless sudo-t."
  exit 1
}

MYSQL_DATA_DIR="$(to_abs_path "$(read_env_value MYSQL_DATA_DIR ./docker-data/mysql)")"
BACKEND_UPLOADS_DIR="$(to_abs_path "$(read_env_value BACKEND_UPLOADS_DIR ./docker-data/uploads)")"
BACKEND_DATA_DIR="$(to_abs_path "$(read_env_value BACKEND_DATA_DIR ./docker-data/data)")"
WHISPER_CACHE_DIR="$(to_abs_path "$(read_env_value WHISPER_CACHE_DIR ./docker-data/whisper-cache)")"

mkdir_safe "$MYSQL_DATA_DIR"
mkdir_safe "$BACKEND_UPLOADS_DIR"
mkdir_safe "$BACKEND_DATA_DIR"
mkdir_safe "$WHISPER_CACHE_DIR"

compose_file_tokens="${DOCKER_COMPOSE_FILES_RAW//,/ }"
read -r -a compose_files <<< "$compose_file_tokens"
if [[ ${#compose_files[@]} -eq 0 ]]; then
  compose_files=(docker-compose.yml)
fi

compose_args=()
for compose_file in "${compose_files[@]}"; do
  compose_file_trimmed="$(trim "$compose_file")"
  if [[ -z "$compose_file_trimmed" ]]; then
    continue
  fi

  if [[ "$compose_file_trimmed" == /* ]]; then
    compose_file_path="$compose_file_trimmed"
  else
    compose_file_path="$(realpath -m "$PROJECT_ROOT/$compose_file_trimmed")"
  fi

  if [[ ! -f "$compose_file_path" ]]; then
    echo "HIBA: Compose fájl nem található: $compose_file_path"
    exit 1
  fi

  compose_args+=( -f "$compose_file_path" )
done

if [[ ${#compose_args[@]} -eq 0 ]]; then
  echo "HIBA: Nincs érvényes compose fájl a DOCKER_COMPOSE_FILES változóban."
  exit 1
fi

echo "Docker deploy indul"
echo "- project: $DOCKER_PROJECT_NAME"
echo "- env: $ENV_FILE_PATH"
echo "- compose: ${compose_files[*]}"
echo "- mysql data: $MYSQL_DATA_DIR"
echo "- uploads: $BACKEND_UPLOADS_DIR"
echo "- backend data: $BACKEND_DATA_DIR"
echo "- whisper cache: $WHISPER_CACHE_DIR"

compose_base=("${COMPOSE_BIN[@]}" --project-name "$DOCKER_PROJECT_NAME" --env-file "$ENV_FILE_PATH" "${compose_args[@]}")

(
  cd "$PROJECT_ROOT"
  "${compose_base[@]}" config -q

  if [[ "${DOCKER_PULL_BEFORE_UP,,}" == "true" ]]; then
    "${compose_base[@]}" pull || true
  fi

  "${compose_base[@]}" up --build -d --remove-orphans
  "${compose_base[@]}" ps
)

echo "Docker deploy kész."
