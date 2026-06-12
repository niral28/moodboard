# Moodboard Chrome Extension

New-tab moodboard canvas + scout tab driver for the local FastAPI/Ollama backend.

## Ollama CORS — do you need `OLLAMA_ORIGINS`?

**No, not with this architecture.**

The extension never calls `localhost:11434` directly. All LLM traffic goes:

```
Extension (new tab / service worker) → FastAPI :8000 → Ollama :11434
```

Ollama CORS (`OLLAMA_ORIGINS=chrome-extension://*`) only matters if JavaScript in the extension fetches the Ollama API. Our Python backend uses `requests` / the OpenAI SDK server-side, which is not subject to browser CORS.

What the extension *does* need is `host_permissions` for `http://localhost:8000/*` (already in `manifest.json`). The backend already allows all origins on CORS (`allow_origins=["*"]`), so `chrome-extension://…` → `:8000` is fine.

If you later move LLM calls into the extension (no Python backend), then you would need:

```bash
OLLAMA_ORIGINS=chrome-extension://* ollama serve
# or, tighter: OLLAMA_ORIGINS=chrome-extension://<your-extension-id>
```

## Prerequisites

1. **Ollama** running with a tool-capable model:
   ```bash
   ollama pull qwen3.5:9b
   ollama serve
   ```
2. **Backend** on port 8000:
   ```bash
   ./scripts/start-moodboard.sh
   ```
   Or manually:
   ```bash
   cd backend
   BROWSER_BACKEND=extension .venv/bin/uvicorn main:app --reload --port 8000
   ```

## Recommended `.env` (backend)

```env
LLM_PROVIDER=ollama
LLM_MODEL=qwen3.5:9b
OLLAMA_BASE_URL=http://localhost:11434/v1
BROWSER_BACKEND=extension
MARKDOWN_FETCH=1

# Vision (ingest images, curate multimodal, scout screenshots) via Cursor SDK:
LLM_VISION_PROVIDER=cursor
LLM_VISION_MODEL=composer-2.5
CURSOR_API_KEY=...          # Cursor Dashboard → Integrations → API Keys
```

Ollama handles reasoning/tool-calling; Cursor `composer-2.5` handles image analysis only. No Ollama CORS changes needed — see [Ollama CORS](#ollama-cors--do-you-need-ollama_origins) above.

## Build & load

```bash
cd extension
npm install
npm run build
```

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select `extension/dist`

Open a new tab — the moodboard canvas appears.

## Features

- **New tab canvas** — full spatial board (Cmd+T)
- **Find Inspiration** — curate → orchestrate → scout via local Ollama
- **Scout tabs** — visible tabs in the "Moodboard scouts" group
- **Right-click → Add to Moodboard** on any page
- **Clear scouts** — closes the scout tab group
- **Options** — configure backend URL, test `/extension/status`

## Playwright fallback

Set `BROWSER_BACKEND=playwright` in backend `.env` to use CDP/Playwright instead of the extension for browser tools (legacy path).

## Dev with HMR

```bash
cd extension
npm run dev
```

Load `extension/dist` in Chrome; Vite rebuilds on save.
