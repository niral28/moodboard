# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A spatial moodboard with a multi-agent backend. Users drop text/links/emails/images onto a canvas; a pipeline of Gemini-backed agents curates clusters, dispatches scouts to fill style gaps, and can stage candidate URLs in a real Chrome window via Playwright.

## Commands

### Backend (`backend/`)
- Run dev server: `cd backend && uvicorn main:app --reload --host 0.0.0.0 --port 8000` (or `python main.py`).
- Install deps: `pip install -r requirements.txt` (a `.venv/` already exists at `backend/.venv`).
- Playwright browsers: `playwright install chromium` (required for the `/stage` agent to actually launch Chrome; otherwise it falls back to a stub).
- Required env var: `GEMINI_API_KEY`. If unset, every agent silently returns hard-coded mock responses — useful for offline work, but real LLM behavior will not be exercised.

### Frontend (`frontend/`)
- Dev: `npm run dev` (Vite, default port 5173).
- Build: `npm run build` (runs `tsc -b` then `vite build`).
- Lint: `npm run lint`.
- The frontend expects the backend at `http://localhost:8000` (hardcoded as `API_BASE` in `src/App.tsx`).

### Known dependency drift
`frontend/src/App.tsx` imports `@dnd-kit/core`, `lucide-react`, and uses Tailwind classes, but `package.json` only declares `react`/`react-dom` and dev tooling. `tailwind.config.js` and `postcss.config.js` exist but Tailwind itself isn't in `package.json` either. Expect `npm install` to leave the app non-functional until these are added (`@dnd-kit/core`, `lucide-react`, `tailwindcss`, `postcss`, `autoprefixer`).

## Architecture

### Agent pipeline (backend/agents.py)
Five agents, all calling `gemini-2.5-flash` with `response_mime_type="application/json"` and a Pydantic `response_schema` (models in `backend/models.py`). Every agent has a mock branch that runs when `GEMINI_API_KEY` is unset and a fallback branch on exception — both return shape-valid data so the frontend never breaks.

1. **Ingest** (`run_ingest`) — `POST /ingest`. Accepts JSON or multipart (for image bytes / `.eml` files). Classifies into `text` | `link` | `image` | `email`, with email-specific fields (`sender`, `subject`, `date`, `body_summary`) populated only for email cards. Backend always overwrites the model-returned `id` with a fresh UUID.
2. **Curate** (`run_curate`) — `POST /curate`. Takes all cards, returns `clusters`, a narrative `taste_profile`, and 3–5 `gaps`.
3. **Orchestrate** (`run_orchestrate`) — `POST /orchestrate`. Turns curation output into `ScoutDispatch` objects with priority and search hints.
4. **Scout** (`run_scout_single`) — `POST /scout` accepts a *list* of `ScoutRequest`s and fans out via `asyncio.gather`; each scout returns 3 `Candidate`s, all flattened in the response.
5. **Stage** (`run_playwright_stage`) — `POST /stage`. Sync Playwright code run through `loop.run_in_executor`. Launches `chromium.launch_persistent_context` against `$HOME/chrome-debug-profile2` with `headless=False`, navigates, screenshots to `./screenshots/`, and **intentionally does not close the browser** so the user can complete a purchase in the staged tab.

The pipeline is driven from the frontend's "Tick Pipeline" button (`handleTickPipeline` in `App.tsx`): Curate → Orchestrate → Scout, sequentially.

### Activity log / SSE
`agents.append_log(agent, message, level)` is the single instrumentation point. Each call appends to an in-process list (`event_logs`) and pushes to `event_queue` (an `asyncio.Queue`). The `GET /events` endpoint (`sse-starlette`) first replays history then streams live entries with periodic heartbeats. The frontend subscribes via `EventSource` in `App.tsx` and dedupes by `(message, timestamp)`. This is in-memory only — restarting the backend wipes logs and breaks any reconnecting client until new events arrive.

### Frontend state model (frontend/src/App.tsx)
Single top-level `App` component holds all state: `cards`, `suggestions`, `tasteProfile`, `gaps`, `logs`. Cards, suggestions, taste, and gaps are persisted to `localStorage` on every change; on first load with no saved cards, four hardcoded Kyoto demo cards are seeded. `handleResetBoard` clears localStorage and reloads.

Card positions are tracked via `@dnd-kit/core`'s `DndContext`; `handleDragEnd` clamps `x`/`y` into `[10, 800]`.

### Schema contract
`backend/models.py` is the source of truth for the API. The frontend re-declares matching types informally inside `components/Card.tsx`, `components/Sidebar.tsx`, etc. — there is no generated client. Any field change in `models.py` must be mirrored by hand in the frontend.
