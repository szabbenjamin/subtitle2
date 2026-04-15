#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

TARGET_USER="${TARGET_USER:-${SUDO_USER:-$(id -un)}}"
TARGET_HOME="${TARGET_HOME:-/home/$TARGET_USER}"
CREATE_TARGET_USER="${CREATE_TARGET_USER:-true}"

ENV_FILE_PATH_RAW="${ENV_FILE_PATH:-$PROJECT_ROOT/.env.docker}"
ENV_TEMPLATE_PATH="${ENV_TEMPLATE_PATH:-$PROJECT_ROOT/.env.docker.example}"
ENV_DOCKER_CONTENT="${ENV_DOCKER_CONTENT:-}"
ENV_DOCKER_B64="${ENV_DOCKER_B64:-}"

AUTO_DEPLOY="${AUTO_DEPLOY:-false}"
DOCKER_PROJECT_NAME="${DOCKER_PROJECT_NAME:-subtitle2}"
DOCKER_COMPOSE_FILES="${DOCKER_COMPOSE_FILES:-docker-compose.yml}"
DOCKER_PULL_BEFORE_UP="${DOCKER_PULL_BEFORE_UP:-false}"

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
  echo "HIBA: root vagy sudo jogosultsag szukseges."
  exit 1
fi

run_root() {
  "${ROOT_PREFIX[@]}" "$@"
}

assert_file() {
  local path="$1"
  local description="$2"
  if [[ ! -f "$path" ]]; then
    echo "HIBA: hianyzik: $description ($path)"
    exit 1
  fi
}

ensure_target_user() {
  if id "$TARGET_USER" >/dev/null 2>&1; then
    local resolved_home
    resolved_home="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
    if [[ -n "$resolved_home" ]]; then
      TARGET_HOME="$resolved_home"
    fi
    return
  fi

  if [[ "${CREATE_TARGET_USER,,}" != "true" ]]; then
    echo "HIBA: a target user nem letezik: $TARGET_USER"
    echo "Allitsd a CREATE_TARGET_USER=true valtozot, vagy hozz letre kezzel."
    exit 1
  fi

  echo "Target user letrehozasa: $TARGET_USER"
  run_root useradd -m -s /bin/bash "$TARGET_USER"
  TARGET_HOME="/home/$TARGET_USER"
}

ensure_env_file() {
  local env_dir
  env_dir="$(dirname "$ENV_FILE_PATH")"
  run_root mkdir -p "$env_dir"

  if [[ -f "$ENV_FILE_PATH" ]]; then
    echo "Meglevo env file hasznalata: $ENV_FILE_PATH"
  elif [[ -n "$ENV_DOCKER_CONTENT" ]]; then
    echo "ENV_DOCKER_CONTENT alapjan env file generalasa: $ENV_FILE_PATH"
    printf '%s\n' "$ENV_DOCKER_CONTENT" | run_root tee "$ENV_FILE_PATH" >/dev/null
  elif [[ -n "$ENV_DOCKER_B64" ]]; then
    echo "ENV_DOCKER_B64 alapjan env file generalasa: $ENV_FILE_PATH"
    printf '%s' "$ENV_DOCKER_B64" | base64 -d | run_root tee "$ENV_FILE_PATH" >/dev/null
  elif [[ -f "$ENV_TEMPLATE_PATH" ]]; then
    echo "Template masolasa env file-ra: $ENV_TEMPLATE_PATH -> $ENV_FILE_PATH"
    run_root cp "$ENV_TEMPLATE_PATH" "$ENV_FILE_PATH"
  else
    echo "HIBA: nincs .env.docker, es template sem erheto el."
    exit 1
  fi

  run_root chmod 600 "$ENV_FILE_PATH"
  run_root chown "$TARGET_USER":"$TARGET_USER" "$ENV_FILE_PATH"
}

link_project_env() {
  local project_env_link="$PROJECT_ROOT/.env"
  if run_root ln -sfn "$ENV_FILE_PATH" "$project_env_link"; then
    run_root chown -h "$TARGET_USER":"$TARGET_USER" "$project_env_link" || true
  fi
}

run_selfhosted_installer() {
  assert_file "$PROJECT_ROOT/scripts/install-selfhosted.sh" "self-hosted install script"
  TARGET_USER="$TARGET_USER" \
  TARGET_HOME="$TARGET_HOME" \
  ENV_FILE_PATH="$ENV_FILE_PATH" \
  bash "$PROJECT_ROOT/scripts/install-selfhosted.sh"
}

run_deploy_if_needed() {
  if [[ "${AUTO_DEPLOY,,}" != "true" ]]; then
    return
  fi

  assert_file "$PROJECT_ROOT/scripts/deploy-selfhosted.sh" "deploy script"
  echo "AUTO_DEPLOY=true, elso deploy indul..."

  if [[ "${#ROOT_PREFIX[@]}" -gt 0 ]]; then
    run_root env \
      TARGET_USER="$TARGET_USER" \
      ENV_FILE_PATH="$ENV_FILE_PATH" \
      DOCKER_PROJECT_NAME="$DOCKER_PROJECT_NAME" \
      DOCKER_COMPOSE_FILES="$DOCKER_COMPOSE_FILES" \
      DOCKER_PULL_BEFORE_UP="$DOCKER_PULL_BEFORE_UP" \
      bash "$PROJECT_ROOT/scripts/deploy-selfhosted.sh"
    return
  fi

  TARGET_USER="$TARGET_USER" \
  ENV_FILE_PATH="$ENV_FILE_PATH" \
  DOCKER_PROJECT_NAME="$DOCKER_PROJECT_NAME" \
  DOCKER_COMPOSE_FILES="$DOCKER_COMPOSE_FILES" \
  DOCKER_PULL_BEFORE_UP="$DOCKER_PULL_BEFORE_UP" \
  bash "$PROJECT_ROOT/scripts/deploy-selfhosted.sh"
}

print_summary() {
  echo
  echo "Bootstrap kesz."
  echo "- target user: $TARGET_USER"
  echo "- target home: $TARGET_HOME"
  echo "- env file: $ENV_FILE_PATH"
  echo "- auto deploy: $AUTO_DEPLOY"
  echo
  echo "Kovetkezo lepesek:"
  echo "1) Toltsd ki a valos titkokat a .env.docker-ben (ha template-bol lett generalva)."
  echo "2) CI-ben allitsd be az ENV_DOCKER secretet a teljes .env.docker tartalomra."
  echo "3) Ha most nem futott deploy: bash scripts/deploy-selfhosted.sh"
  echo "4) Ellenorzes: docker compose --env-file .env.docker -f docker-compose.yml ps"
}

main() {
  echo "Fresh production bootstrap indul..."
  ensure_target_user
  ensure_env_file
  link_project_env
  run_selfhosted_installer
  run_deploy_if_needed
  print_summary
}

main "$@"
