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
)
from agents import (
    run_ingest, run_curate, run_orchestrate, run_scout_single, run_playwright_stage,
    event_logs, event_queue, append_log, append_journal,
)

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
    append_log("orchestrate", "Ready to ingest visual assets, curate layout, and stage carts.", "info")

# --- 1. Ping Check Endpoint ---
@app.get("/ping")
async def ping():
    return {"status": "pong"}

# --- 2. SSE Log Event Stream ---
@app.get("/events")
async def events(request: Request):
    """
    Server-Sent Events endpoint that streams live logs to the Activity Log panel.
    First yields history, then streams incoming events live.
    """
    async def log_generator():
        # 1. Stream all past logs first so the interface shows history on reconnect
        for log in event_logs:
            yield {
                "event": "message",
                "id": str(uuid.uuid4()),
                "data": json.dumps(log)
            }
            
        # 2. Wait and stream new logs from the asyncio Queue
        while True:
            if await request.is_disconnected():
                logger.info("SSE Client disconnected.")
                break
                
            try:
                # Wait for new log, wake up occasionally to send heartbeats
                log = await asyncio.wait_for(event_queue.get(), timeout=2.0)
                yield {
                    "event": "message",
                    "id": str(uuid.uuid4()),
                    "data": json.dumps(log)
                }
            except asyncio.TimeoutError:
                # Send empty heartbeat to prevent network timeouts
                yield {
                    "event": "heartbeat",
                    "data": ""
                }
            except Exception as e:
                logger.error(f"Error in SSE stream: {e}")
                
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
    """
    Stages a candidate shopping or trip booking URL in Chrome via Playwright.
    Runs inside a threadpool to prevent blocking the async FastAPI app.
    """
    loop = asyncio.get_running_loop()
    response = await loop.run_in_executor(
        None,
        lambda: run_playwright_stage(req.url)
    )
    return response

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
