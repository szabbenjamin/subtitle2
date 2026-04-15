#!/usr/bin/env bash
set -euo pipefail

# Highlight + Whisper runtime telepítő Ubuntu 24.04 szerverhez.
# Cél:
# - ffmpeg/ffprobe + yt-dlp
# - python venv + openai-whisper
# - opcionális gyors ellenőrzés a telepített parancsokra

TARGET_USER="${TARGET_USER:-$(id -un)}"
TARGET_HOME="${TARGET_HOME:-/home/$TARGET_USER}"
WHISPER_DIR="${WHISPER_DIR:-$TARGET_HOME/whisper}"
WHISPER_VENV_PATH="${WHISPER_VENV_PATH:-$WHISPER_DIR/.venv}"
WHISPER_COMMAND="${WHISPER_COMMAND:-$WHISPER_VENV_PATH/bin/whisper}"

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
  echo "[1/3] Rendszercsomagok telepítése..."
  $SUDO apt-get update -y
  $SUDO apt-get install -y ffmpeg yt-dlp python3 python3-venv python3-pip
}

install_whisper_venv() {
  echo "[2/3] Whisper telepítése virtualenv-be..."
  run_as_target_user bash -lc "
set -euo pipefail
mkdir -p '$WHISPER_DIR'
if [[ ! -d '$WHISPER_VENV_PATH' ]]; then
  python3 -m venv '$WHISPER_VENV_PATH'
fi
source '$WHISPER_VENV_PATH/bin/activate'
pip install --upgrade pip setuptools wheel
pip install --upgrade openai-whisper fastembed yt-dlp
"
}

verify_runtime() {
  echo "[3/3] Ellenőrzés..."
  ffmpeg -version >/dev/null
  ffprobe -version >/dev/null
  yt-dlp --version >/dev/null
  run_as_target_user bash -lc "
set -euo pipefail
'$WHISPER_COMMAND' --help >/dev/null
'$WHISPER_VENV_PATH/bin/yt-dlp' --version >/dev/null
python3 - <<'PY'
from fastembed import TextEmbedding

_ = TextEmbedding(model_name='sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2')
print('fastembed ok')
PY
"

  echo ""
  echo "Kész. Állítsd be backend .env-ben:"
  echo "WHISPER_COMMAND=$WHISPER_COMMAND"
  echo "HIGHLIGHT_AI_PYTHON_COMMAND=$WHISPER_VENV_PATH/bin/python"
  echo "HIGHLIGHT_AI_MODEL=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
  echo "YTDLP_COMMAND=$WHISPER_VENV_PATH/bin/yt-dlp"
  echo ""
  echo "Ellenőrizd, hogy a worker ezt a parancsot látja-e futáskor."
}

main() {
  install_system_packages
  install_whisper_venv
  verify_runtime
}

main "$@"
