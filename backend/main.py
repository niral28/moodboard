import os
import json
import uuid
import logging
import asyncio
from typing import List, Optional
from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, Request, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse

from models import (
    Card, IngestRequest, Cluster, CurateRequest, CurateResponse,
    ScoutDispatch, OrchestrateRequest, OrchestrateResponse,
    Candidate, ScoutRequest, ScoutResponse, StageRequest, StageResponse,
    FeedbackRequest, FeedbackResponse,
    BrowserResultRequest, ExtensionHelloRequest,
)
from browser_cdp import CHROME_PROFILE_PATH, SCOUT_CDP_ENDPOINT, cdp_launch_hint, probe_cdp
from browser_bridge import (
    browser_backend,
    extension_connected,
    get_pending_browser_actions,
    mark_extension_connected,
    resolve_browser_action,
    use_extension_browser,
)
from agents import (
    run_ingest, run_curate, run_orchestrate, run_scout_single,
    run_playwright_stage, run_extension_stage,
    event_logs, subscribe_sse, unsubscribe_sse, append_log, append_journal,
    llm,
)
from llm_provider import search_provider

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("moodboard.main")

app = FastAPI(title="Moodboard Multi-Agent Backend", version="1.0.0")

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # In a production environment, restrict this to specific origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
async def startup_event():
    append_log("orchestrate", "Moodboard multi-agent backend starting up.", "info")
    mode = browser_backend()
    append_log("orchestrate", f"Browser backend mode: {mode}", "info")
    append_log("orchestrate", f"Search provider: {search_provider()}", "info")
    if mode == "playwright":
        cdp = probe_cdp(SCOUT_CDP_ENDPOINT)
        if cdp["reachable"]:
            append_log(
                "orchestrate",
                f"Chrome CDP ready at {SCOUT_CDP_ENDPOINT} ({cdp.get('browser', 'unknown')}).",
                "success",
            )
        else:
            append_log("orchestrate", f"Chrome CDP not reachable at {SCOUT_CDP_ENDPOINT}.", "warning")
            append_log("orchestrate", cdp_launch_hint(), "info")
    else:
        append_log("orchestrate", "Waiting for Chrome extension to connect via SSE.", "info")
    append_log("orchestrate", "Ready to ingest visual assets, curate layout, and stage carts.", "info")

# --- 1. Ping Check Endpoint ---
@app.get("/ping")
async def ping():
    return {"status": "pong"}


@app.get("/browser/status")
async def browser_status():
    """Probe Chrome CDP — useful when scout tabs aren't opening."""
    status = probe_cdp(SCOUT_CDP_ENDPOINT)
    status["chrome_profile"] = CHROME_PROFILE_PATH
    status["browser_mode"] = browser_backend()
    return status


@app.get("/extension/status")
async def extension_status():
    """Health check for the Chrome extension new-tab page."""
    ollama_ok = False
    model = llm.model if llm.available else None
    try:
        import requests
        base = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434/v1").rstrip("/")
        host = base.replace("/v1", "")
        r = requests.get(f"{host}/api/tags", timeout=2)
        ollama_ok = r.status_code == 200
    except Exception:
        pass
    return {
        "backend": "ok",
        "browser_mode": browser_backend(),
        "extension_connected": extension_connected(),
        "model": model,
        "ollama": {"reachable": ollama_ok, "model": model},
        "llm_provider": llm.provider_name if llm.available else None,
        "vision_provider": llm._vision.provider_name if llm.vision_available else None,
        "vision_model": llm._vision.model if llm.vision_available else None,
        "search_provider": search_provider(),
    }


@app.post("/extension/hello")
async def extension_hello(req: ExtensionHelloRequest):
    was_connected = extension_connected()
    mark_extension_connected()
    if not was_connected:
        append_log("orchestrate", f"Chrome extension connected (v{req.version or 'unknown'}).", "success")
    return {"ok": True}


@app.get("/extension/pending-actions")
async def extension_pending_actions():
    """Poll fallback for MV3 service workers that miss SSE browser_action events."""
    mark_extension_connected()
    return {"actions": get_pending_browser_actions()}


@app.post("/browser/result")
async def browser_result(req: BrowserResultRequest):
    """Extension posts results for pending scout browser actions."""
    mark_extension_connected()
    ok = resolve_browser_action(req.action_id, req.result, req.error)
    if not ok:
        return {"ok": False, "error": "unknown or expired action_id"}
    return {"ok": True}

# --- 2. SSE Log Event Stream ---
@app.get("/events")
async def events(request: Request):
    """
    Server-Sent Events endpoint that streams live logs to the Activity Log panel.
    First yields history, then streams incoming events live.
    """
    async def log_generator():
        queue = subscribe_sse()
        try:
            # 1. Stream all past logs first so the interface shows history on reconnect
            for log in event_logs:
                yield {
                    "event": "message",
                    "id": str(uuid.uuid4()),
                    "data": json.dumps(log)
                }

            # 2. Wait and stream new logs from this client's queue
            while True:
                if await request.is_disconnected():
                    logger.info("SSE Client disconnected.")
                    break

                try:
                    log = await asyncio.wait_for(queue.get(), timeout=2.0)
                    yield {
                        "event": "message",
                        "id": str(uuid.uuid4()),
                        "data": json.dumps(log)
                    }
                except asyncio.TimeoutError:
                    yield {
                        "event": "heartbeat",
                        "data": ""
                    }
                except Exception as e:
                    logger.error(f"Error in SSE stream: {e}")
        finally:
            unsubscribe_sse(queue)

    return EventSourceResponse(log_generator())

# --- 3. Ingest Endpoint ---
@app.post("/ingest", response_model=Card)
async def ingest(request: Request):
    """
    Ingest endpoint supporting both JSON payloads and multipart Form file uploads.
    Handles standard text/URLs and raw image bytes multimodal parsing.
    """
    content_type = request.headers.get("content-type", "")
    
    if "application/json" in content_type:
        body = await request.json()
        content = body.get("content", "")
        hint = body.get("hint")
        card = await run_ingest(content=content, hint=hint)
        return card
    else:
        # Form Data or Multipart
        form = await request.form()
        content = form.get("content", "")
        hint = form.get("hint")
        file = form.get("file")
        
        image_bytes = None
        mime_type = None
        
        if file and hasattr(file, "file"):
            image_bytes = await file.read()
            mime_type = file.content_type
            
        if not content and file:
            content = file.filename
            
        card = await run_ingest(
            content=str(content), 
            hint=str(hint) if hint else None, 
            image_bytes=image_bytes, 
            mime_type=mime_type
        )
        return card

# --- 4. Curate Endpoint ---
@app.post("/curate", response_model=CurateResponse)
async def curate(req: CurateRequest):
    """
    Curates the board, creating clusters, a taste profile, and gaps.
    """
    response = await run_curate(req.cards)
    return response

# --- 5. Orchestrate Endpoint ---
@app.post("/orchestrate", response_model=OrchestrateResponse)
async def orchestrate(req: OrchestrateRequest):
    """
    Orchestrates search dispatches from curated taste profile and clusters.
    """
    response = await run_orchestrate(req.clusters, req.taste_profile, req.gaps)
    return response

# --- 6. Scout Endpoint ---
@app.post("/scout", response_model=List[Candidate])
async def scout(requests: List[ScoutRequest]):
    """
    Concurrent Scout Agent fanning-out via asyncio.gather.
    Executes a search recommendation search for each cluster dispatch.
    """
    append_log("scout", f"Received batch scout request for {len(requests)} clusters. Launching asyncio fan-out...", "info")
    
    tasks = []
    for req in requests:
        dispatch = ScoutDispatch(cluster_id=req.cluster_id, priority="high", search_hints=req.search_hints)
        tasks.append(run_scout_single(
            dispatch,
            req.taste_profile,
            req.cluster_label,
            req.user_currency or "USD",
            cluster_cards=req.cluster_cards or [],
        ))
        
    results = await asyncio.gather(*tasks)
    
    # Flatten candidates
    all_candidates = []
    for candidates in results:
        all_candidates.extend(candidates)
        
    append_log("scout", f"Concurrent scouting complete. Retrieved a total of {len(all_candidates)} aesthetic suggestions.", "success")
    return all_candidates

# --- 7. Feedback Endpoint ---
@app.post("/feedback", response_model=FeedbackResponse)
async def feedback(req: FeedbackRequest):
    """Record a user's dismissal of a suggestion (with optional reason)
    into the shared Journal. Curator and Scout consume recent feedback as
    hard constraints on subsequent Ticks."""
    suggestion_ref = req.suggestion_title or req.suggestion_url or "a suggestion"
    body = req.reason.strip() if (req.reason and req.reason.strip()) else f"dismissed without reason: {suggestion_ref}"
    refs = [r for r in [req.cluster_id, req.suggestion_url] if r]
    entry = append_journal("feedback", body, references=refs)
    append_log(
        "orchestrate",
        f"Feedback recorded for '{suggestion_ref}'.",
        "info",
        details=body,
    )
    return FeedbackResponse(ok=True, timestamp=entry["timestamp"])


# --- 8. Stage Endpoint ---
@app.post("/stage", response_model=StageResponse)
async def stage(req: StageRequest):
    """Stage a URL in Chrome — extension tab group (default) or Playwright fallback."""
    if use_extension_browser():
        return await run_extension_stage(req.url)
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, lambda: run_playwright_stage(req.url))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
