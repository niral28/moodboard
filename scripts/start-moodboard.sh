#!/usr/bin/env bash
# Start local Moodboard backend (Ollama + FastAPI).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$ROOT/backend"

echo "Checking Ollama…"
OLLAMA_HOST="${OLLAMA_HOST:-http://127.0.0.1:11434}"
if ! curl -sf --max-time 2 "${OLLAMA_HOST}/api/tags" >/dev/null; then
  echo "Ollama not reachable at ${OLLAMA_HOST}"
  echo "Start it: ollama serve"
  echo "Then pull a model: ollama pull qwen3.5:9b"
  exit 1
fi

echo "Starting FastAPI on :8000 (BROWSER_BACKEND=extension)…"
cd "$BACKEND"
export BROWSER_BACKEND="${BROWSER_BACKEND:-extension}"
exec .venv/bin/python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
