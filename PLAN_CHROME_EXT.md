# Chrome Extension — Implementation Plan

Goal for the day: end-to-end MVP. Backend dispatches scout URLs → extension opens them visibly in a tab group → content script extracts metadata → results appear on the canvas. Replaces `/stage`'s Playwright path with extension-driven staging in the user's real Chrome.

## Decide these *before* writing any code (≤30 min)

These are blockers — every later task depends on them.

1. **Canvas location.** Three options:
   - **Side panel only** (simplest, narrow ~400px, struggles with spatial canvas)
   - **Keep existing web canvas at localhost:5173, side panel for status only** ← recommended for MVP. Reuses everything you have. The extension just becomes a status surface + tab driver.
   - **Override new-tab page** (full canvas, but bigger refactor)
2. **Extension ↔ backend transport.** Reuse SSE (`/events` already exists) for backend → extension push; use POST for extension → backend writes. Simple, already wired.
3. **State.** Backend remains source of truth for cards / scouts. Extension is mostly stateless (just owns the tab group it manages).
4. **Fallback.** Keep `/stage` Playwright path under a feature flag (`STAGE_BACKEND=extension|playwright`) so the demo still works if the extension isn't installed.

## Architecture (target end-of-day state)

```
┌─────────────────────────────────────────────┐
│  Web canvas (localhost:5173)                │
│  ↑ existing React app, unchanged for now    │
└─────────────────────────────────────────────┘
              ↑
              │ HTTP + SSE (/events)
              ↓
┌─────────────────────────────────────────────┐
│  Backend (FastAPI)                          │
│  - Emits 'stage_request' events on SSE      │
│  - Receives 'stage_result' POSTs            │
│  - /stage routes to extension OR Playwright │
└─────────────────────────────────────────────┘
              ↑
              │ SSE + fetch
              ↓
┌─────────────────────────────────────────────┐
│  Chrome Extension                           │
│  ┌──────────────────────────────────────┐   │
│  │ Service worker                       │   │
│  │  - SSE client to /events             │   │
│  │  - tabGroups: create / add / cleanup │   │
│  │  - POSTs results back                │   │
│  └──────────────────────────────────────┘   │
│  ┌──────────────────────────────────────┐   │
│  │ Content script                       │   │
│  │  - extracts OG / product metadata    │   │
│  │  - captures thumbnail                │   │
│  └──────────────────────────────────────┘   │
│  ┌──────────────────────────────────────┐   │
│  │ Side panel                           │   │
│  │  - shows active scouts + status      │   │
│  │  - "Clear group" button              │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

---

## Phase 1 — Foundation (sequential, ~90 min)

Everything later depends on this. Don't try to parallelize this phase.

- [ ] **1.1 Scaffold extension directory** under `extension/`. Files: `manifest.json`, `src/background.ts`, `src/content.ts`, `src/sidepanel.html`, `src/sidepanel.ts`. Add Vite + `@crxjs/vite-plugin` for hot reload — much faster iteration than raw MV3.
- [ ] **1.2 Manifest v3 essentials.** Permissions: `tabs`, `tabGroups`, `scripting`, `sidePanel`, `storage`, `activeTab`. Host permissions: start with `<all_urls>` for dev; tighten before publishing. Declare `background.service_worker`, `side_panel.default_path`, `content_scripts.matches: ["<all_urls>"]`.
- [ ] **1.3 Load extension unpacked.** Open `chrome://extensions`, dev mode on, load from dist. Confirm side panel opens via the puzzle-icon → "Open side panel."
- [ ] **1.4 Backend: define event payload shape.** Add a new SSE event type `stage_request` with fields `{ id, url, source_card_id }`. Add a POST endpoint `/stage_result` accepting `{ stage_request_id, title, image_url, price, screenshot_data_url, status }`. Don't change `/stage`'s public API yet — wrap behavior behind a `STAGE_BACKEND` env var.

**Output of phase 1:** Empty extension that loads. Backend emits a fake `stage_request` you can see in the SSE stream. You're ready to parallelize.

---

## Phase 2 — Parallel streams (~3–4h)

Four independent tracks. If you have a Claude Code session per track (or just tackle in any order), they don't block each other.

### Stream A — Service worker: SSE + tab group lifecycle
- [ ] A.1 Connect to backend SSE on SW startup. Reconnect with backoff on disconnect. (SW lifecycle gotcha: SW dies after 30s idle. Use `chrome.alarms` to wake periodically and re-establish.)
- [ ] A.2 On `stage_request` event: ensure a tab group named "Loom scouts" exists (create if not, reuse if so). Cache the group ID in `chrome.storage.session`.
- [ ] A.3 Open the URL with `chrome.tabs.create({ url, active: false })`, then `chrome.tabs.group({ tabIds: [tabId], groupId })`. Collapse the group by default so the user's tab strip stays calm.
- [ ] A.4 Listen for `chrome.tabs.onUpdated` with `status === 'complete'` on grouped tabs → kick off content extraction (Stream B).
- [ ] A.5 Cleanup: implement `clearScoutGroup()` that closes all tabs in the group and ungroups. Wire to a side-panel button + an SSE `clear_scouts` event.

### Stream B — Content script: page extraction
- [ ] B.1 Content script reads OG tags first (`og:title`, `og:image`, `og:price:amount`, `product:price:amount`). Fast, reliable for ~70% of sites.
- [ ] B.2 Fallbacks: `<title>`, the first reasonable `<img>` above the fold (heuristic: width > 200px AND not in nav/footer), JSON-LD `Product` schema if present.
- [ ] B.3 Send extracted data to SW via `chrome.runtime.sendMessage`; SW POSTs to `/stage_result`.
- [ ] B.4 Thumbnail: ask SW to call `chrome.tabs.captureVisibleTab` *only* when the tab is briefly activated. Alternative for MVP: skip capture, use OG image. (Capture has the active-tab problem — defer the polish.)
- [ ] B.5 Graceful failure: if no data found, POST `{ status: 'extraction_failed' }` so the canvas can mark the card.

### Stream C — Side panel UI (status only for MVP)
- [ ] C.1 Bare HTML + a small Preact / vanilla JS list. No need for React in this surface yet — keep it fast.
- [ ] C.2 Subscribe to the same SSE stream (or listen to SW messages) and render: `[scout id] — [status: navigating | extracted | failed] — [url]`.
- [ ] C.3 Buttons: "Clear scouts group," "Expand group," "Collapse group." All call `chrome.tabGroups.update`.
- [ ] C.4 Stretch: live thumbnail per scout as it lands.

### Stream D — Backend wiring
- [ ] D.1 Add `STAGE_BACKEND` env var. When `extension`, `/stage` emits an SSE `stage_request` and returns `{ stage_id }` immediately (don't block).
- [ ] D.2 New `/stage_result` endpoint: stores result, emits SSE `stage_complete` so the web canvas can update the corresponding card.
- [ ] D.3 Modify the existing pipeline (in `agents.py`) so scouted candidates become `stage_request`s automatically — or keep manual "Stage this candidate" button for now and only auto-stage in v1.1.
- [ ] D.4 Frontend: when a `stage_complete` arrives over SSE in `App.tsx`, update the corresponding card with the extracted thumbnail / price.

---

## Phase 3 — Integration (~1.5h)

Now everything exists; wire it together and exercise a real flow.

- [ ] **3.1** With backend in extension mode + extension installed + web canvas open: drop a jeans photo, tick pipeline, observe scout tabs appearing in the tab group, watch the canvas populate.
- [ ] **3.2** Test multi-tab: 6 scouts → 6 tabs grouped, all extracted within ~10s.
- [ ] **3.3** Test bot detection: include one tab to a known bot-protective site (Nike, SSENSE) in your candidate set. Confirm it loads fully (this is the whole point of going visible).
- [ ] **3.4** Test cleanup: click "Clear scouts" → all tabs close cleanly, no orphans. Reload extension → no stale tab groups.

---

## Phase 4 — Polish + known issues (whatever time remains)

- [ ] Multi-session: name groups `Loom-<board_id>` so two boards don't share. Defer if not running simultaneous boards.
- [ ] SW keepalive: long-running scout flows can outlive the 30s idle. Use `chrome.alarms.create('keepalive', { periodInMinutes: 0.4 })` to ping the SW. Cheap, ugly, works.
- [ ] Permissions UX: write a one-line description per permission for the eventual store listing. Skip for dev.
- [ ] Error toasts in side panel when SSE drops or backend is offline.

---

## What I'd cut if running short

Cut in this order:
1. Thumbnail capture (B.4) — use OG image only
2. Side panel buttons beyond "Clear scouts" (C.3)
3. Auto-stage from pipeline (D.3) — keep manual click for now
4. Multi-session naming (Phase 4) — single-session is fine for hackathon

Don't cut: the tab-group create/cleanup loop (A.2, A.5). Orphan groups will haunt you.

---

## Parallelization map

If two engineers (or two Claude sessions) work in parallel, the obvious split is:

- **Engineer 1:** Phase 1, then Streams A + B (SW + content script — they're tightly coupled)
- **Engineer 2:** After Phase 1, Streams C + D (side panel + backend wiring)

They meet at Phase 3.

If solo: do Phase 1, then A → B → D → C in that order. The reason: A and B unblock the rest; D adapts the backend to what A produces; C is purely UI and least risky to do last.

---

## What this plan does *not* cover (deferred)

- Real canvas inside the extension (still using web app at localhost:5173)
- History / bookmarks / context menu ingestion (next milestone)
- Local-model option (deferred indefinitely)
- Cross-browser (Edge/Brave inherit; Firefox/Safari are separate efforts)
- Chrome Web Store submission (only matters when ready to distribute)
- Multi-user / collaboration (architectural fork; out of scope)

---

## Sanity checks before you start tomorrow

- [ ] Vite + `@crxjs/vite-plugin` versions support MV3 cleanly (check release notes — this ecosystem moves)
- [ ] Backend SSE keeps connections alive long enough for the SW (heartbeat every <30s already exists in `agents.py`?)
- [ ] You're testing in a Chrome profile you're OK loading dev extensions into — not your daily-driver profile if you'd rather isolate

Good luck. Mostly: the tab-group-as-workspace pattern is the right call, Claude validates it, bot detection makes it the *only* viable call for fashion. The plan above is one solid day if streams A/B don't surprise you. Two days if they do.
