FROM node:24-bookworm-slim

WORKDIR /app/backend

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
  ffmpeg \
  lsof \
  python3 \
  python3-venv \
  python3-pip \
  ca-certificates \
  curl \
  && rm -rf /var/lib/apt/lists/*

COPY backend/package*.json ./
RUN npm ci

ARG HIGHLIGHT_AI_MODEL=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2

ENV WHISPER_VENV_PATH=/opt/whisper/.venv
ENV XDG_CACHE_HOME=/opt/whisper/cache
ENV HF_HOME=/opt/whisper/cache/hf
ENV TRANSFORMERS_CACHE=/opt/whisper/cache/hf
ENV SENTENCE_TRANSFORMERS_HOME=/opt/whisper/cache/sentence-transformers
ENV HIGHLIGHT_AI_MODEL=$HIGHLIGHT_AI_MODEL
RUN python3 -m venv "$WHISPER_VENV_PATH" \
  && "$WHISPER_VENV_PATH/bin/pip" install --upgrade pip setuptools wheel \
  && "$WHISPER_VENV_PATH/bin/pip" install --no-cache-dir \
    --index-url https://download.pytorch.org/whl/cpu \
    torch==2.5.1+cpu \
  && "$WHISPER_VENV_PATH/bin/pip" install --no-cache-dir \
    openai-whisper \
    yt-dlp \
    fastembed \
    numpy

ENV PRELOADED_CACHE_DIR=/opt/whisper/preloaded-cache
RUN mkdir -p "$PRELOADED_CACHE_DIR" \
  && XDG_CACHE_HOME="$PRELOADED_CACHE_DIR" \
    HF_HOME="$PRELOADED_CACHE_DIR/hf" \
    TRANSFORMERS_CACHE="$PRELOADED_CACHE_DIR/hf" \
    SENTENCE_TRANSFORMERS_HOME="$PRELOADED_CACHE_DIR/sentence-transformers" \
    HIGHLIGHT_AI_MODEL="$HIGHLIGHT_AI_MODEL" \
    "$WHISPER_VENV_PATH/bin/python" - <<'PY'
import os
import whisper
from fastembed import TextEmbedding

download_root = os.path.join(os.environ["XDG_CACHE_HOME"], "whisper")
whisper.load_model("turbo", download_root=download_root)

model_name = os.environ.get("HIGHLIGHT_AI_MODEL", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
embedder = TextEmbedding(model_name=model_name)
_ = next(embedder.embed(["model warmup"]))
print("Preloaded whisper and highlight AI model caches.")
PY

COPY backend ./
RUN chmod +x /app/backend/docker/backend-entrypoint.sh
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

ENTRYPOINT ["./docker/backend-entrypoint.sh"]
CMD ["node", "dist/main.js"]
