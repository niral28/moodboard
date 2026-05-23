import os
import json
import uuid
import base64
import logging
import asyncio
from datetime import datetime
from typing import List, Optional, Dict, Any, Tuple

from google import genai
from google.genai import types
from pydantic import BaseModel, Field

from models import (
    Card, Cluster, CurateResponse,
    ScoutDispatch, OrchestrateResponse,
    Candidate, ScoutResponse, StageResponse,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("moodboard.agents")

# --- SDK client ---
_api_key = os.environ.get("GEMINI_API_KEY")
client: Optional[genai.Client] = genai.Client(api_key=_api_key) if _api_key else None
if client is None:
    logger.warning("GEMINI_API_KEY not set — agents will return mock data.")

MODEL = "gemini-3.5-flash"
THINKING = types.ThinkingConfig(thinking_budget=-1)  # dynamic; the model decides depth

# --- Activity log / SSE plumbing ---
# event_queue carries both log entries and streamed payloads (e.g. candidates as
# they become viable). Items with kind="candidate" are routed differently by
# the frontend; everything else is treated as a log entry.
event_logs: List[Dict[str, Any]] = []
event_queue: asyncio.Queue = asyncio.Queue()


def push_event(payload: Dict[str, Any]) -> None:
    """Push a non-log event onto the SSE queue. Used to stream individual
    candidates the instant a scout produces them."""
    try:
        loop = asyncio.get_running_loop()
        if loop.is_running():
            loop.call_soon_threadsafe(event_queue.put_nowait, payload)
            return
    except RuntimeError:
        pass
    event_queue.put_nowait(payload)


# Image bytes destined for Gemini multimodal calls are aggressively downsized:
# Gemini's visual reasoning works well at small dimensions, and the token cost
# scales with image area. 384px max-dim + JPEG q70 keeps each image at ~10-30KB.
def _resize_image_bytes(img_bytes: bytes, max_dim: int = 384, quality: int = 70) -> bytes:
    try:
        from PIL import Image
        from io import BytesIO
        img = Image.open(BytesIO(img_bytes))
        if img.mode in ("RGBA", "LA", "P"):
            img = img.convert("RGB")
        img.thumbnail((max_dim, max_dim), Image.Resampling.LANCZOS)
        out = BytesIO()
        img.save(out, format="JPEG", quality=quality, optimize=True)
        return out.getvalue()
    except Exception as e:
        logger.warning(f"Image resize failed ({e}); using original {len(img_bytes)} bytes.")
        return img_bytes


# Hard cap on how many image attachments we send to Curate in one call.
# Boards with more than this fall back to text-only for the overflow.
MAX_CURATE_IMAGES = 16


def _fetch_og_image(url: str, timeout: float = 3.0) -> Optional[str]:
    """Fast HTTP-only og:image fetch. Returns absolute URL or None. Used for static sites
    (most editorial, retail, booking). SPAs (Instagram, X, etc.) need the browser fallback."""
    try:
        import re
        import requests
        from urllib.parse import urljoin

        r = requests.get(
            url,
            timeout=timeout,
            headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
                "Accept": "text/html",
            },
            allow_redirects=True,
        )
        if r.status_code != 200 or "text/html" not in r.headers.get("Content-Type", ""):
            return None
        html = r.text[:300_000]
        patterns = [
            r'<meta[^>]+property=["\']og:image(?::secure_url)?["\'][^>]+content=["\']([^"\']+)["\']',
            r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image(?::secure_url)?["\']',
            r'<meta[^>]+name=["\']twitter:image["\'][^>]+content=["\']([^"\']+)["\']',
            r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']twitter:image["\']',
        ]
        for pat in patterns:
            m = re.search(pat, html, re.IGNORECASE)
            if m:
                return urljoin(url, m.group(1))
        return None
    except Exception as e:
        logger.warning(f"og:image fetch failed for {url}: {e}")
        return None


# Headless Chromium fallback for pages without og:image (Instagram, X, SPAs).
# Captures a real screenshot of the rendered page. Concurrency-limited so we
# never spawn more than a few Chromium instances in parallel.
_BROWSER_FETCH_SEMA = asyncio.Semaphore(3)


async def _screenshot_page_via_browser(url: str, timeout_ms: int = 30000) -> Optional[str]:
    """Returns a data:image/jpeg URL of the rendered viewport, or None on failure.
    Requires `playwright install chromium` to be done once in this venv."""
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        return None

    async with _BROWSER_FETCH_SEMA:
        try:
            async with async_playwright() as p:
                try:
                    browser = await p.chromium.launch(headless=True)
                except Exception as e:
                    logger.warning(
                        f"Headless Chromium unavailable ({e}). "
                        "Run: backend/.venv/bin/playwright install chromium"
                    )
                    return None
                try:
                    ctx = await browser.new_context(
                        user_agent=(
                            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
                        ),
                        viewport={"width": 1280, "height": 800},
                    )
                    page = await ctx.new_page()
                    try:
                        await page.goto(url, timeout=timeout_ms, wait_until="domcontentloaded")
                        # Give SPAs a beat to paint above-the-fold content.
                        await page.wait_for_timeout(1500)
                        png_bytes = await page.screenshot(type="jpeg", quality=75, full_page=False)
                        b64 = base64.b64encode(png_bytes).decode("ascii")
                        return f"data:image/jpeg;base64,{b64}"
                    finally:
                        await ctx.close()
                finally:
                    await browser.close()
        except Exception as e:
            logger.warning(f"Screenshot fetch failed for {url}: {e}")
            return None


async def _resolve_cover_image(url: str) -> Optional[str]:
    """Two-tier preview resolver: fast og:image scrape → headless screenshot fallback."""
    if not url or not url.startswith("http"):
        return None
    loop = asyncio.get_running_loop()
    og = await loop.run_in_executor(None, _fetch_og_image, url)
    if og:
        return og
    return await _screenshot_page_via_browser(url)


def append_log(
    agent: str,
    message: str,
    level: str = "info",
    details: Optional[str] = None,
    cluster_id: Optional[str] = None,
    phase: Optional[str] = None,  # "start" | "end" — drives per-cluster activity highlighting in the UI
):
    timestamp = datetime.now().strftime("%H:%M:%S")
    entry: Dict[str, Any] = {"agent": agent, "message": message, "level": level, "timestamp": timestamp}
    if details:
        entry["details"] = details
    if cluster_id:
        entry["cluster_id"] = cluster_id
    if phase:
        entry["phase"] = phase
    event_logs.append(entry)
    try:
        loop = asyncio.get_running_loop()
        if loop.is_running():
            loop.call_soon_threadsafe(event_queue.put_nowait, entry)
    except RuntimeError:
        event_queue.put_nowait(entry)
    except Exception as e:
        logger.error(f"queue error: {e}")
    logger.info(f"[{agent.upper()}] {message}")


async def _generate_structured(
    prompt: str,
    schema: type[BaseModel],
    parts: Optional[List[Any]] = None,
) -> Dict[str, Any]:
    contents: List[Any] = list(parts) if parts else []
    contents.append(prompt)
    response = await client.aio.models.generate_content(
        model=MODEL,
        contents=contents,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=schema,
            thinking_config=THINKING,
        ),
    )
    return json.loads(response.text)


# ======================= INGEST =======================
INGEST_PROMPT = """\
Role: Multimodal ingest analyst for a creative moodboard.

Input is heterogeneous: free text, a URL, raw image bytes, an email message, or any mix. Produce one Card describing the artifact.

Choose `type` from the content's actual nature, not its surface form:
- 'email' for correspondence (headers, salutations, signatures, conversational tone)
- 'link' for content referenced by a URL
- 'image' when the dominant payload is visual
- 'text' otherwise

A `hint` argument, when present, is a soft override — apply it only if the content is genuinely ambiguous.

For email cards, populate sender, subject, date, and body_summary from the message itself. For visual cards, decompose `visual_features` along color palette, lighting, texture, material, geometry, and composition. For every card, derive `entities` that downstream search agents could actually act on — specific brands, materials, color names, locations, themes. Avoid generic tags ("image", "note", "idea").

Aim for a title under 8 words and a summary of 1–2 sentences. Set `id` to "temp_id"; the backend will assign a UUID.
"""


async def run_ingest(
    content: str,
    hint: Optional[str] = None,
    image_bytes: Optional[bytes] = None,
    mime_type: Optional[str] = None,
) -> Card:
    append_log("ingest", f"Ingest start — hint={hint or 'none'}, image={'yes' if image_bytes else 'no'}.", "info")

    if client is None:
        append_log("ingest", "No API key — returning mock card.", "warning")
        await asyncio.sleep(0.5)
        return Card(
            id=str(uuid.uuid4()),
            type="text",
            title="Mock Note",
            summary=content[:120] if content else "Placeholder card.",
            entities=["mock"],
            x=120.0, y=120.0,
        )

    parts: List[Any] = []
    if image_bytes:
        original_size = len(image_bytes)
        resized = _resize_image_bytes(image_bytes)
        if resized is not image_bytes:
            append_log("ingest", f"Resized image for Gemini: {original_size//1024}KB → {len(resized)//1024}KB.", "info")
        parts.append(types.Part.from_bytes(data=resized, mime_type="image/jpeg"))

    user_block = f"User input:\n{content}\n\nHint: {hint or 'none'}"
    prompt = f"{INGEST_PROMPT}\n\n{user_block}"

    try:
        append_log("ingest", "Calling Gemini 3.5 Flash (thinking enabled)…", "info")
        data = await _generate_structured(prompt, Card, parts=parts)
        data["id"] = str(uuid.uuid4())
        card = Card(**data)

        # For link cards, try to fetch a preview image (og:image, falling back to
        # a real headless-Chromium screenshot for SPAs without static metadata).
        if card.type == "link" and card.url and not card.cover_image:
            cover = await _resolve_cover_image(card.url)
            if cover:
                card.cover_image = cover
                source = "og:image" if cover.startswith("http") else "page screenshot"
                preview_detail = cover if cover.startswith("http") else "[base64 jpeg attached to card]"
                append_log("ingest", f"Captured preview ({source}) for '{card.title}'.", "info", details=preview_detail)

        append_log("ingest", f"Card created: '{card.title}' (type={card.type}).", "success")
        return card
    except Exception as e:
        append_log("ingest", f"Ingest failed: {e}", "error")
        return Card(
            id=str(uuid.uuid4()), type="text",
            title="Ingestion Error", summary=str(e), entities=["error"],
            x=100.0, y=100.0,
        )


# ======================= CURATE =======================
CURATE_PROMPT = """\
Role: Creative director synthesizing a moodboard.

You receive every card on the user's canvas — heterogeneous, possibly contradictory, possibly sparse. When image cards are present, their actual pixel data is attached above the JSON; look at the images directly, not just the text descriptions, when deciding how they group and what they say about the user.

Identify the dominant aesthetic, narrative, or planning intent. Cluster cards by what *unites* them at a deeper level than card type — shared mood, material palette, geographic locus, conceptual thread, or stage of a plan. A single card may anchor a cluster on its own if it represents a distinct strand. Label each cluster with a phrase a designer would instantly recognize; flat category names ("Travel", "Notes", "Ideas") are not useful.

Articulate `taste_profile` as a paragraph the user would recognize as describing them — the underlying sensibility and direction, not a list of items. If the USER FEEDBACK section below contains anything, it represents real constraints the user has expressed by dismissing prior suggestions — fold those into the taste profile explicitly (especially price ceilings, materials they reject, aesthetics they dislike). Treat feedback as hard signal, not optional.

Identify `gaps` as 3–5 concrete additions whose absence is conspicuous given the rest of the board. Gaps must be specific enough that a search agent can act on them directly — name materials, places, price tiers, or formats where the existing cards make those constraints explicit, and avoid recommending categories the user has already rejected via feedback.
"""


def _extract_image_parts(cards: List[Card]) -> Tuple[List[Any], List[Card]]:
    """Pull data:image/* covers off image cards, downsize them for Gemini, and
    return the multimodal Parts + a sanitized card list (with the bulky data
    URL replaced by a reference). Caps the number of attached images to
    MAX_CURATE_IMAGES — overflow falls back to text-only for those cards."""
    parts: List[Any] = []
    sanitized: List[Card] = []
    images_attached = 0

    for c in cards:
        # cover_image is the canonical preview; for legacy demo cards it may be in url.
        cover = c.cover_image or (c.url if c.type == "image" else None) or ""
        if c.type == "image" and cover.startswith("data:image/") and images_attached < MAX_CURATE_IMAGES:
            try:
                _, b64 = cover.split(",", 1)
                raw = base64.b64decode(b64)
                resized = _resize_image_bytes(raw)
                parts.append(types.Part.from_bytes(data=resized, mime_type="image/jpeg"))
                parts.append(f"^^^ Image above is card id={c.id}, title='{c.title}'")
                clone = c.model_copy(update={
                    "cover_image": f"(image attached as card {c.id})",
                    "url": c.url if not (c.url or "").startswith("data:image/") else None,
                })
                sanitized.append(clone)
                images_attached += 1
                continue
            except Exception as e:
                logger.warning(f"Failed to decode image card {c.id}: {e}")
        # Strip any heavyweight data URLs so the prompt JSON stays small even
        # for the cards we couldn't attach as images.
        if (c.cover_image or "").startswith("data:"):
            sanitized.append(c.model_copy(update={"cover_image": "(image data omitted)"}))
        else:
            sanitized.append(c)
    return parts, sanitized


async def run_curate(cards: List[Card]) -> CurateResponse:
    append_log("curate", f"Curate start — {len(cards)} cards on board.", "info")

    if not cards:
        append_log("curate", "Empty canvas — nothing to curate.", "warning")
        return CurateResponse(clusters=[], taste_profile="Empty canvas.", gaps=[])

    if client is None:
        append_log("curate", "No API key — returning mock curation.", "warning")
        await asyncio.sleep(0.5)
        return CurateResponse(
            clusters=[Cluster(id="mock_cl", label="Unsorted", card_ids=[c.id for c in cards])],
            taste_profile="Mock taste profile.",
            gaps=["Mock gap 1", "Mock gap 2"],
        )

    image_parts, sanitized_cards = _extract_image_parts(cards)
    if image_parts:
        n_images = sum(1 for p in image_parts if not isinstance(p, str))
        append_log("curate", f"Attaching {n_images} image(s) for direct visual analysis.", "info")

    cards_json = [c.model_dump() for c in sanitized_cards]
    feedback_block = "\n".join(f"- \"{e['content']}\"" for e in recent_feedback(10)) or "(none yet)"
    prompt = (
        f"{CURATE_PROMPT}\n\n"
        f"USER FEEDBACK (recent dismissal reasons — treat as hard constraints):\n{feedback_block}\n\n"
        f"Board cards (JSON, image cards' pixel data attached above):\n{json.dumps(cards_json, indent=2)}"
    )

    try:
        append_log("curate", "Calling Gemini 3.5 Flash for clustering + taste synthesis…", "info")
        data = await _generate_structured(prompt, CurateResponse, parts=image_parts or None)
        res = CurateResponse(**data)
        append_log("curate", f"Curated into {len(res.clusters)} clusters, {len(res.gaps)} gaps.", "success")
        return res
    except Exception as e:
        append_log("curate", f"Curate failed: {e}", "error")
        return CurateResponse(
            clusters=[Cluster(id="fallback", label="Unsorted Collection", card_ids=[c.id for c in cards])],
            taste_profile="Curation unavailable.",
            gaps=[],
        )


# ======================= ORCHESTRATE =======================
ORCHESTRATE_PROMPT = """\
Role: Research coordinator routing scout agents.

You receive the curator's clusters, taste profile, and identified gaps. Produce one dispatch per cluster that would benefit from enrichment (or per gap, when a gap doesn't map cleanly to a cluster).

Assign `priority` by leverage:
- 'high' when filling it unblocks a decision the user is clearly trying to make
- 'medium' when it meaningfully extends an existing thread
- 'low' for decorative enrichment

Write 2–4 `search_hints` per dispatch as queries a human researcher could paste into a search engine. Include the specific qualifiers the curation supplies — materials, brand names, geographic locations, price tiers, date windows. Avoid generic queries like "design ideas" or "travel tips"; the scout will fail to ground them.
"""


async def run_orchestrate(clusters: List[Cluster], taste_profile: str, gaps: List[str]) -> OrchestrateResponse:
    append_log("orchestrate", f"Orchestrate start — {len(clusters)} clusters, {len(gaps)} gaps.", "info")

    if not clusters:
        append_log("orchestrate", "No clusters — no dispatches.", "warning")
        return OrchestrateResponse(scout_dispatches=[])

    if client is None:
        append_log("orchestrate", "No API key — returning mock dispatches.", "warning")
        await asyncio.sleep(0.5)
        return OrchestrateResponse(scout_dispatches=[
            ScoutDispatch(cluster_id=c.id, priority="medium", search_hints=[f"explore {c.label}"])
            for c in clusters
        ])

    payload = {
        "clusters": [c.model_dump() for c in clusters],
        "taste_profile": taste_profile,
        "gaps": gaps,
    }
    prompt = f"{ORCHESTRATE_PROMPT}\n\nCuration state:\n{json.dumps(payload, indent=2)}"

    try:
        append_log("orchestrate", "Calling Gemini 3.5 Flash for dispatch planning…", "info")
        data = await _generate_structured(prompt, OrchestrateResponse)
        res = OrchestrateResponse(**data)
        append_log("orchestrate", f"Planned {len(res.scout_dispatches)} scout dispatches.", "success")
        return res
    except Exception as e:
        append_log("orchestrate", f"Orchestrate failed: {e}", "error")
        return OrchestrateResponse(scout_dispatches=[
            ScoutDispatch(cluster_id=c.id, priority="medium", search_hints=["aesthetic inspirations"])
            for c in clusters
        ])


# ======================= SCOUT =======================
# ============================================================================
# SCOUT v2 — ReAct loop with function-calling tools driving real Chrome
# ============================================================================
#
# Each scout runs up to MAX_SCOUT_STEPS iterations. At every step:
#   1. Flash sees: cluster, taste profile, journal feedback, observations so far
#   2. Flash picks one tool via native function calling
#   3. Backend executes the tool against a real Playwright Page
#   4. Result is appended to observations
#   5. Loop until Flash calls `done` or MAX_SCOUT_STEPS reached
#
# All steps stream to the SSE activity log so the demo can watch the agent think.

MAX_SCOUT_STEPS = 20
CHROME_PROFILE_PATH = os.environ.get(
    "CHROME_PROFILE_PATH",
    os.path.expandvars("$HOME/chrome-debug-profile2"),
)
SCOUT_CDP_ENDPOINT = os.environ.get("CHROME_CDP_URL", "http://localhost:9222")


# --- Journal (process-wide, in-memory) -----------------------------------------
# Used to share notes and feedback across scouts and across Tick invocations.
JOURNAL: List[Dict[str, Any]] = []


def append_journal(kind: str, content: str, references: Optional[List[str]] = None) -> Dict[str, Any]:
    entry = {
        "kind": kind,                       # "note" | "feedback"
        "content": content,
        "timestamp": datetime.now().isoformat(),
        "references": references or [],
    }
    JOURNAL.append(entry)
    return entry


def recent_feedback(limit: int = 10) -> List[Dict[str, Any]]:
    return [e for e in JOURNAL if e.get("kind") == "feedback"][-limit:]


def recent_notes(limit: int = 20) -> List[Dict[str, Any]]:
    return [e for e in JOURNAL if e.get("kind") == "note"][-limit:]


# --- Shared async Playwright browser context ----------------------------------
# Lazy-init on first scout tool that needs a tab. CDP-attach is preferred (uses
# the user's visible Chrome — the demo's whole point). Falls back to a headed
# launch with a dedicated profile if CDP isn't reachable.

_pw_instance: Any = None
_browser: Any = None
_browser_context: Any = None
_browser_lock = asyncio.Lock()


async def _get_browser_context() -> Optional[Any]:
    global _pw_instance, _browser, _browser_context
    async with _browser_lock:
        if _browser_context is not None:
            try:
                # Best-effort liveness check; ignore on transient errors.
                _ = _browser_context.pages
                return _browser_context
            except Exception:
                _browser_context = None

        try:
            from playwright.async_api import async_playwright
        except ImportError:
            append_log("scout", "Playwright not installed — browser tools disabled.", "error")
            return None

        if _pw_instance is None:
            _pw_instance = await async_playwright().start()

        # Preferred: attach to user's existing Chrome (visible to the demo audience).
        try:
            _browser = await _pw_instance.chromium.connect_over_cdp(SCOUT_CDP_ENDPOINT)
            _browser_context = _browser.contexts[0] if _browser.contexts else await _browser.new_context()
            append_log("scout", f"Attached to Chrome via CDP at {SCOUT_CDP_ENDPOINT}.", "info")
            return _browser_context
        except Exception as e:
            logger.warning(f"CDP attach failed ({e}); falling back to dedicated headed Chromium.")

        # Fallback: launch persistent context against the dedicated profile dir.
        try:
            os.makedirs(CHROME_PROFILE_PATH, exist_ok=True)
            _browser_context = await _pw_instance.chromium.launch_persistent_context(
                user_data_dir=CHROME_PROFILE_PATH,
                headless=False,
                args=["--no-sandbox", "--disable-setuid-sandbox"],
            )
            _browser = None  # persistent_context doesn't expose a separate Browser
            append_log("scout", f"Launched headed Chromium with profile at {CHROME_PROFILE_PATH}.", "info")
            return _browser_context
        except Exception as e:
            append_log("scout", f"Could not start browser: {e}", "error")
            return None


# --- Tool declarations for Gemini function calling -----------------------------
SCOUT_TOOLS = types.Tool(function_declarations=[
    types.FunctionDeclaration(
        name="search_web",
        description=(
            "Search the web for a query. Returns top results [{title, snippet, url}]. "
            "Use to discover candidate sources before opening tabs. "
            "Queries should be specific and qualifier-rich (include materials, brands, "
            "price tiers, locations from the cluster or feedback)."
        ),
        parameters=types.Schema(
            type="OBJECT",
            properties={"query": types.Schema(type="STRING")},
            required=["query"],
        ),
    ),
    types.FunctionDeclaration(
        name="open_link",
        description=(
            "Open a link from your search results in a real Chrome tab. Use this to "
            "verify a candidate by reading the actual page rather than relying on a "
            "search snippet. Returns the page title and the first ~3000 chars of "
            "visible text. The opened tab becomes the active tab for follow-up "
            "scroll_and_capture and extract_products calls."
        ),
        parameters=types.Schema(
            type="OBJECT",
            properties={"url": types.Schema(type="STRING")},
            required=["url"],
        ),
    ),
    types.FunctionDeclaration(
        name="click",
        description=(
            "Click an element on the active tab by its visible text. Use to dismiss "
            "popups ('Accept', 'No thanks', 'Close'), follow on-site links, or activate "
            "filters. open_link already attempts to auto-dismiss common popups — only "
            "call click if the page still has overlays in the way, or you need to "
            "navigate within the site."
        ),
        parameters=types.Schema(
            type="OBJECT",
            properties={
                "text": types.Schema(type="STRING", description="Visible text of the target — exact or substring."),
            },
            required=["text"],
        ),
    ),
    types.FunctionDeclaration(
        name="scroll_and_capture",
        description=(
            "Scroll the active tab in a direction and return newly visible text. "
            "Use after open_tab when relevant content is below the fold."
        ),
        parameters=types.Schema(
            type="OBJECT",
            properties={
                "direction": types.Schema(type="STRING", enum=["down", "up"]),
                "amount_px": types.Schema(type="INTEGER"),
            },
            required=["direction", "amount_px"],
        ),
    ),
    types.FunctionDeclaration(
        name="extract_products",
        description=(
            "Run a structured-extraction pass on the active tab. Returns a list of "
            "products [{title, price, image_url, product_url}]. Use when the active "
            "tab lists multiple items and you want a clean comparable set."
        ),
        parameters=types.Schema(type="OBJECT", properties={}),
    ),
    types.FunctionDeclaration(
        name="note",
        description=(
            "Record a durable observation to the shared Journal — visible to other "
            "scouts and to future Ticks. Use for insights worth remembering beyond "
            "this scout's loop."
        ),
        parameters=types.Schema(
            type="OBJECT",
            properties={"content": types.Schema(type="STRING")},
            required=["content"],
        ),
    ),
    types.FunctionDeclaration(
        name="add_candidate",
        description=(
            "Commit one verified candidate to the user's sidebar IMMEDIATELY. "
            "The user watches candidates appear in real time as you call this, "
            "so do not batch them — call add_candidate the moment you've verified "
            "a lead via open_link/extract_products, then keep researching the next. "
            "Aim for 3-5 calls total over the course of your loop. "
            "Provide title, url (a real destination, not a search redirector), "
            "match_reason; include price in the user's currency and image_url "
            "when known from the page you visited."
        ),
        parameters=types.Schema(
            type="OBJECT",
            properties={
                "title": types.Schema(type="STRING"),
                "url": types.Schema(type="STRING"),
                "price": types.Schema(type="STRING"),
                "image_url": types.Schema(type="STRING"),
                "emoji": types.Schema(type="STRING", description="A single emoji representing this candidate visually (e.g. '🪵' for a wooden bench, '🍵' for a tea ceremony). Used as a fallback when image_url is missing."),
                "match_reason": types.Schema(type="STRING"),
            },
            required=["title", "url", "match_reason"],
        ),
    ),
    types.FunctionDeclaration(
        name="done",
        description=(
            "Terminate this scout. Call after you've added 3-5 candidates via "
            "add_candidate and have nothing more worth committing. Takes no arguments."
        ),
        parameters=types.Schema(type="OBJECT", properties={}),
    ),
])


SCOUT_SYSTEM = """\
You are a research scout for Moodboard. You receive one cluster of cards the user has saved, plus the user's overall taste profile and any feedback they've left on past suggestions. Your job: find 3-5 items the user would want to add to that cluster.

You have these tools:
- search_web(query): grounded web search — returns titles, URLs, snippets
- open_link(url): opens one of those URLs as a real Chrome tab; returns the live page text. Auto-dismisses common cookie/newsletter popups.
- click(text): clicks an element on the active tab by its visible text. Use for residual popups ("Accept", "No thanks", "Close"), pagination, or on-site filters.
- scroll_and_capture(direction, amount_px): scrolls the active tab
- extract_products(): structured extraction on the active tab
- note(content): writes to a Journal shared across scouts and Ticks
- add_candidate(title, url, price, image_url, match_reason): COMMIT ONE candidate to the user's sidebar right now. Call this as soon as you've verified each pick — the user sees them appear live.
- done(): terminate this scout when you've committed 3-5 candidates and have nothing more worth adding.

How to work (commit candidates incrementally, do NOT batch them):
1. Run search_web once with a specific, qualifier-rich query.
2. Read the returned links. Pick the 1-3 most promising URLs based on title and domain. If the results suggest a better angle, run one more refined search_web — don't loop searching aimlessly.
3. Call open_link on a promising lead to visit the page. Search snippets are too thin to commit — you must read the actual page.
4. If the page text reads like a cookie banner, signup wall, or modal copy ("By continuing you agree to...", "Subscribe for 10% off", "We use cookies") rather than actual content, the auto-dismissal missed something — call click("Accept all") / click("No thanks") / click("Close") / click("×") to clear it, then read again.
5. Use scroll_and_capture or extract_products to gather concrete details (price, materials, availability).
6. As soon as that single page produces a verified candidate, call add_candidate with it. The card appears in the sidebar immediately. Do NOT wait until you have all of them.
7. Move on to the next lead: open_link, verify, add_candidate. Repeat until you have 3-5 commits.
8. Call done() to terminate.

Hard rules:
- You MUST call open_link at least once before any add_candidate. Snippets are reconnaissance, not evidence. The audience expects to see tabs opening.
- Each add_candidate must use a real destination URL — never a `vertexaisearch.cloud.google.com` redirector. open_link resolves those for you.
- If the user has left feedback, treat it as a HARD CONSTRAINT. Surface that you're applying it in your reasoning.
- Prices must be in the user's preferred currency.

Be efficient — aim for 4-8 tool calls total, max 10. Stop searching once your leads are concrete; commit candidates as you verify them; call done() when you have enough.
"""


# --- Per-scout context --------------------------------------------------------
class ScoutContext:
    def __init__(
        self,
        scout_id: str,
        cluster_id: str,
        cluster_label: str,
        cluster_cards: List[Dict[str, Any]],
        taste_profile: str,
        user_currency: str,
    ):
        self.scout_id = scout_id
        self.cluster_id = cluster_id
        self.cluster_label = cluster_label
        self.cluster_cards = cluster_cards
        self.taste_profile = taste_profile
        self.user_currency = user_currency
        self.page: Any = None  # lazy: assigned on first browser-tool call
        self.observations: List[Dict[str, Any]] = []
        self.last_extracted_products: List[Dict[str, Any]] = []  # available context for add_candidate
        self.committed_candidates: List[Candidate] = []  # streamed to sidebar as add_candidate is called


def _summarize_for_log(result: Any, limit: int = 200) -> str:
    s = json.dumps(result, default=str) if not isinstance(result, str) else result
    return s if len(s) <= limit else s[:limit] + "…" +"\n[If interesting, open link to read full page and interact to get more leads.]"


def _build_step_prompt(ctx: ScoutContext) -> str:
    fb_lines = "\n".join(f"- \"{e['content']}\"" for e in recent_feedback(8)) or "(none)"
    notes_lines = "\n".join(f"- {e['content']}" for e in recent_notes(10)) or "(none)"
    cards_lines = "\n".join(
        f"- {c.get('title') or '(untitled)'} — {c.get('summary') or ''}" for c in ctx.cluster_cards[:12]
    ) or "(none)"

    obs_lines: List[str] = []
    for i, o in enumerate(ctx.observations, start=1):
        args_str = json.dumps(o.get("args") or {}, default=str)
        if len(args_str) > 160:
            args_str = args_str[:160] + "…"
        result = o.get("result") or {}
        insight = result.get("insight") if isinstance(result, dict) else None
        if insight:
            # Render the structured insight rather than raw page text — much
            # higher signal-per-token, and easier for the loop to reason over.
            lead = "LEAD" if insight.get("is_viable_lead") else "no lead"
            cand_bits = []
            if insight.get("candidate_title"):
                cand_bits.append(f"title='{insight['candidate_title']}'")
            if insight.get("candidate_price"):
                cand_bits.append(f"price={insight['candidate_price']}")
            if insight.get("candidate_url"):
                cand_bits.append(f"url={insight['candidate_url']}")
            cand_str = (" | " + ", ".join(cand_bits)) if cand_bits else ""
            obs_lines.append(
                f"Step {i}: {o['action']}({args_str})\n"
                f"  → [{lead}{cand_str}] {insight.get('summary','')}\n"
                f"  → next_action_hint: {insight.get('next_action_hint','?')}"
            )
        else:
            result_str = _summarize_for_log(result, limit=320)
            obs_lines.append(f"Step {i}: {o['action']}({args_str})\n  → {result_str}")
    obs_block = "\n".join(obs_lines) or "(none yet — this is step 1)"

    obs_count = len(ctx.observations)
    committed = len(ctx.committed_candidates)
    open_count = sum(1 for o in ctx.observations if o["action"] in ("open_link", "open_tab"))
    search_count = sum(1 for o in ctx.observations if o["action"] == "search_web")
    research_only = open_count + search_count

    # Anti-loop nudge: if the scout has done a lot of search+open without
    # committing anything, force it to either commit a lead from its
    # observations or terminate.
    nudge_block = ""
    if committed == 0 and research_only >= 4:
        nudge_block = (
            f"\n[ANTI-LOOP NUDGE]\n"
            f"You have called search_web {search_count} time(s) and open_link {open_count} time(s) "
            f"WITHOUT committing a single candidate. STOP RESEARCHING. Re-read the [OBSERVATIONS SO FAR] "
            f"above — the perception insights point at the strongest lead among them. Call add_candidate "
            f"with that lead NOW using whatever details you've already gathered. If literally none of the "
            f"observations contain a viable lead, call done() — better to return fewer candidates than to loop.\n"
        )
    elif obs_count > 0 and obs_count % 5 == 0:
        nudge_block = (
            f"\n[STATUS CHECK @ STEP {obs_count}]\n"
            f"Candidates committed so far: {committed}.\n"
            f"CAN ANY CANDIDATE BE COMMITTED NOW? If a recent open_link or "
            f"extract_products surfaced a viable lead, call add_candidate with it "
            f"immediately. Do not keep researching while you have unconverted "
            f"verified leads. If you have 3+ commits, call done().\n"
        )

    return f"""\
[SCOUT_ID] {ctx.scout_id}
[USER CURRENCY] {ctx.user_currency}
[COMMITTED CANDIDATES] {committed}

[CLUSTER] {ctx.cluster_label}
Cards in this cluster:
{cards_lines}

[TASTE PROFILE]
{ctx.taste_profile}

[USER FEEDBACK — HARD CONSTRAINTS]
{fb_lines}

[JOURNAL NOTES]
{notes_lines}

[OBSERVATIONS SO FAR]
{obs_block}
{nudge_block}
Decide your next action. If you have 3-5 high-confidence candidates committed, call done(). If you have a verified lead ready to commit, call add_candidate. Otherwise call one of the research tools.
"""


VERTEX_REDIRECTOR_HOST = "vertexaisearch.cloud.google.com"


def _is_vertex_redirector(url: str) -> bool:
    return bool(url) and VERTEX_REDIRECTOR_HOST in url


def _resolve_vertex_redirect(url: str) -> str:
    """Follow Vertex's grounding redirector to its real destination. Returns
    the original URL on any failure."""
    if not _is_vertex_redirector(url):
        return url
    try:
        import requests
        r = requests.head(
            url,
            allow_redirects=True,
            timeout=4,
            headers={"User-Agent": "Mozilla/5.0 Moodboard/1.0"},
        )
        final = r.url or url
        return final if not _is_vertex_redirector(final) else url
    except Exception:
        return url


async def _resolve_vertex_urls_parallel(urls: List[str]) -> List[str]:
    loop = asyncio.get_running_loop()
    return await asyncio.gather(
        *(loop.run_in_executor(None, _resolve_vertex_redirect, u) for u in urls)
    )


# --- Tool implementations -----------------------------------------------------
async def _tool_search_web(query: str) -> Dict[str, Any]:
    """Internal grounded search via Gemini Flash. Returns up to 8 results.
    Vertex grounding-redirector URLs are resolved to their real destinations
    so the scout never tries to open invalid links."""
    if client is None:
        return {"error": "no API key"}
    try:
        resp = await client.aio.models.generate_content(
            model=MODEL,
            contents=(
                f"Web search request: {query}\n\n"
                "Use your search tool and return the top 5-8 results as bullet points: "
                "'TITLE — URL — one-line snippet'. No commentary."
            ),
            config=types.GenerateContentConfig(
                tools=[types.Tool(google_search=types.GoogleSearch())],
            ),
        )
        raw_results: List[Dict[str, str]] = []
        # Prefer grounding metadata (real URLs) when available
        for cand in (resp.candidates or []):
            gm = getattr(cand, "grounding_metadata", None)
            if gm and getattr(gm, "grounding_chunks", None):
                for gc in gm.grounding_chunks:
                    web = getattr(gc, "web", None)
                    if web and getattr(web, "uri", None):
                        raw_results.append({
                            "title": getattr(web, "title", "") or "",
                            "url": web.uri,
                            "snippet": "",
                        })
        # If no grounding metadata, parse text bullets best-effort
        if not raw_results:
            text = (resp.text or "").strip()
            for line in text.splitlines():
                line = line.strip().lstrip("•-*").strip()
                if " — " in line and "http" in line:
                    parts = [p.strip() for p in line.split(" — ", 2)]
                    if len(parts) >= 2:
                        raw_results.append({
                            "title": parts[0],
                            "url": parts[1],
                            "snippet": parts[2] if len(parts) > 2 else "",
                        })

        # Resolve any Vertex redirector URLs to their real destinations, in parallel.
        urls = [r["url"] for r in raw_results]
        resolved = await _resolve_vertex_urls_parallel(urls)
        cleaned: List[Dict[str, str]] = []
        seen_urls = set()
        for r, real_url in zip(raw_results, resolved):
            # Skip any URL we couldn't resolve out of the redirector — those are dead ends.
            if _is_vertex_redirector(real_url):
                continue
            if real_url in seen_urls:
                continue
            seen_urls.add(real_url)
            cleaned.append({"title": r["title"], "url": real_url, "snippet": r.get("snippet", "")})

        return {"results": cleaned[:8]}
    except Exception as e:
        return {"error": str(e)}


# Best-effort dismissal of cookie banners, GDPR consent, newsletter modals, etc.
# Tried after every open_link so the scout sees the real page content, not the popup.
_POPUP_DISMISS_SELECTORS = [
    # Cookie / GDPR consent
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("Accept Cookies")',
    'button:has-text("Accept cookies")',
    'button:has-text("I accept")',
    'button:has-text("Got it")',
    'button:has-text("OK")',
    'button:has-text("Allow all")',
    'button:has-text("Agree")',
    '[id*="cookie" i] button:has-text("Accept")',
    '[class*="cookie" i] button:has-text("Accept")',
    '[id*="consent" i] button:has-text("Accept")',
    # Newsletter / signup modals
    'button:has-text("No thanks")',
    'button:has-text("No, thanks")',
    'button:has-text("Maybe later")',
    'button:has-text("Not now")',
    # Generic close affordances
    'button[aria-label*="close" i]',
    'button[aria-label*="dismiss" i]',
    '[role="dialog"] button:has-text("Close")',
    '[role="dialog"] [aria-label*="close" i]',
]


async def _auto_dismiss_popups(page, attempts: int = 5) -> int:
    """Returns the number of popups dismissed. Soft-fails on every individual click."""
    dismissed = 0
    for _ in range(attempts):
        progressed = False
        for sel in _POPUP_DISMISS_SELECTORS:
            try:
                loc = page.locator(sel).first
                if await loc.is_visible(timeout=150):
                    await loc.click(timeout=500)
                    dismissed += 1
                    progressed = True
                    await page.wait_for_timeout(180)
            except Exception:
                pass
        if not progressed:
            break
    return dismissed


async def _tool_open_tab(ctx: ScoutContext, url: str) -> Dict[str, Any]:
    # Refuse to navigate to Vertex's grounding redirector — try to resolve first.
    if _is_vertex_redirector(url):
        loop = asyncio.get_running_loop()
        resolved = await loop.run_in_executor(None, _resolve_vertex_redirect, url)
        if _is_vertex_redirector(resolved):
            return {"error": "URL is a Vertex search redirector with no real destination; pick a different result."}
        url = resolved

    bctx = await _get_browser_context()
    if bctx is None:
        return {"error": "browser unavailable"}
    try:
        if ctx.page is None or ctx.page.is_closed():
            ctx.page = await bctx.new_page()
        await ctx.page.goto(url, timeout=30000, wait_until="domcontentloaded")
        await ctx.page.wait_for_timeout(10000)
        # Try to clear cookie banners / newsletter modals before reading the page.
        dismissed = await _auto_dismiss_popups(ctx.page)
        title = await ctx.page.title()
        text = await ctx.page.evaluate("() => document.body && document.body.innerText || ''")
        return {
            "title": title or "",
            "url": ctx.page.url,
            "popups_dismissed": dismissed,
            "cleaned_text": (text or "")[:3000],
        }
    except Exception as e:
        return {"error": str(e), "url": url}


async def _tool_click(ctx: ScoutContext, text: str) -> Dict[str, Any]:
    """Click an element by visible text. Useful for residual popups, on-site
    navigation, filter toggles. Returns the page text after the click settles."""
    if ctx.page is None or ctx.page.is_closed():
        return {"error": "no active tab; call open_link first"}
    if not text or not text.strip():
        return {"error": "empty text"}
    candidates = [
        # Exact button match first (highest precision)
        f'button:has-text("{text}")',
        f'[role="button"]:has-text("{text}")',
        # Anchor / link
        f'a:has-text("{text}")',
        # Any element with this text — fallback
        f':text-is("{text}")',
        f':text("{text}")',
    ]
    last_err = None
    for sel in candidates:
        try:
            loc = ctx.page.locator(sel).first
            if await loc.is_visible(timeout=600):
                await loc.click(timeout=2000)
                await ctx.page.wait_for_timeout(700)
                # If the click triggered navigation, refresh URL/title.
                new_text = await ctx.page.evaluate("() => document.body && document.body.innerText || ''")
                return {
                    "clicked": text,
                    "selector_used": sel,
                    "url": ctx.page.url,
                    "page_text_after": (new_text or "")[:2500],
                }
        except Exception as e:
            last_err = str(e)
            continue
    return {"error": f"no clickable element found matching '{text}'", "last_attempt_error": last_err}


async def _tool_scroll(ctx: ScoutContext, direction: str, amount_px: int) -> Dict[str, Any]:
    if ctx.page is None or ctx.page.is_closed():
        return {"error": "no active tab; call open_tab first"}
    try:
        delta = amount_px if direction == "down" else -amount_px
        prev_text = await ctx.page.evaluate("() => document.body && document.body.innerText || ''")
        await ctx.page.evaluate(f"() => window.scrollBy(0, {delta})")
        await ctx.page.wait_for_timeout(1000)
        new_text = await ctx.page.evaluate("() => document.body && document.body.innerText || ''")
        # Naive diff: return text length and the substring after the previous tail
        added = new_text[len(prev_text):] if new_text.startswith(prev_text) else new_text
        return {"new_text": added[:2500] or new_text[-2500:]}
    except Exception as e:
        return {"error": str(e)}


class ExtractedProduct(BaseModel):
    title: str
    price: Optional[str] = None
    image_url: Optional[str] = None
    product_url: Optional[str] = None


class ExtractedProducts(BaseModel):
    products: List[ExtractedProduct]


# Perception sub-agent: turns raw browser output (page text, product list) into
# a structured "what did we learn here, and what should we do next" summary.
class ObservationInsight(BaseModel):
    is_viable_lead: bool = Field(description="Does this observation contain at least one candidate worth committing for the user's cluster?")
    candidate_title: Optional[str] = Field(None, description="The candidate's title as it appears on the page, if one was found.")
    candidate_url: Optional[str] = Field(None, description="Canonical URL of the candidate, if found.")
    candidate_price: Optional[str] = Field(None, description="Price in the user's preferred currency, if found on the page.")
    candidate_image_url: Optional[str] = Field(None, description="Representative image URL from the page, if any.")
    candidate_match_reason: Optional[str] = Field(None, description="One concise sentence explaining the fit (cluster theme + taste profile). Required if is_viable_lead is true.")
    summary: str = Field(description="One-to-two sentence digest of what this page actually said — products, themes, prices, key info.")
    next_action_hint: str = Field(description="One of: 'add_candidate' (commit the above), 'scroll' (relevant content likely below the fold), 'click_close' (popup blocking content), 'open_different' (page not useful, try another lead), 'done' (enough committed).")


async def _summarize_observation(
    ctx: ScoutContext,
    source_tool: str,
    raw_result: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    """Run a focused Flash call to turn raw browser output into a structured
    insight the parent ReAct loop can actually reason about. Returns the dict
    form of ObservationInsight, or None on failure."""
    if client is None:
        return None
    # Project the raw result to a compact text view of just what the model needs to judge
    if source_tool == "extract_products":
        products = raw_result.get("products") or []
        page_url = raw_result.get("page_url") or ""
        page_view = f"Page URL: {page_url}\nExtracted products ({len(products)}):\n" + json.dumps(products[:20], indent=2)
    else:  # open_link / scroll_and_capture
        title = raw_result.get("title") or ""
        url = raw_result.get("url") or ""
        text = raw_result.get("cleaned_text") or raw_result.get("new_text") or ""
        page_view = f"Page title: {title}\nURL: {url}\n\nPage text (first 2500 chars):\n{(text or '')[:2500]}"

    prompt = (
        "You are the perception sub-agent for a research scout. Your job is to read the "
        "result of one browser action and decide, in structured form, whether it surfaced a "
        "candidate worth committing to the user's moodboard cluster — and what the parent "
        "agent should do next.\n\n"
        f"[CLUSTER] {ctx.cluster_label}\n"
        f"[USER TASTE PROFILE]\n{ctx.taste_profile}\n\n"
        f"[USER CURRENCY] {ctx.user_currency}\n\n"
        f"[ALREADY COMMITTED] {len(ctx.committed_candidates)}\n\n"
        f"[BROWSER ACTION RESULT — from {source_tool}]\n{page_view}\n\n"
        "Decide: is there a viable candidate here? If yes, fill the candidate_* fields. "
        "If not, explain briefly and recommend the next move. Be honest about non-fits — "
        "don't invent candidates from generic landing pages or popup copy. If you see common "
        "popup language (cookie consent, newsletter signup), set next_action_hint to "
        "'click_close' instead of trying to invent a candidate."
    )
    try:
        data = await _generate_structured(prompt, ObservationInsight)
        return data
    except Exception as e:
        logger.warning(f"observation summarization failed: {e}")
        return None


async def _tool_extract_products(ctx: ScoutContext) -> Dict[str, Any]:
    if ctx.page is None or ctx.page.is_closed():
        return {"error": "no active tab; call open_tab first"}
    if client is None:
        return {"error": "no API key"}
    try:
        page_url = ctx.page.url
        text = await ctx.page.evaluate("() => document.body && document.body.innerText || ''")
        snippet = (text or "")[:6000]
        prompt = (
            "Extract every distinct product, listing, or bookable item visible on this page. "
            "For each, return title, price (string as shown), image_url if any, and product_url "
            "(absolute, relative to the page URL given below). Skip generic navigation items. "
            f"Page URL: {page_url}\n\n"
            f"Page text:\n{snippet}"
        )
        data = await _generate_structured(prompt, ExtractedProducts)
        products = data.get("products", []) if isinstance(data, dict) else []
        ctx.last_extracted_products = products
        return {"products": products, "count": len(products), "page_url": page_url}
    except Exception as e:
        return {"error": str(e)}


def _tool_note(ctx: ScoutContext, content: str) -> Dict[str, Any]:
    entry = append_journal("note", content, references=[ctx.cluster_id])
    append_log("scout", f"[{ctx.scout_id}] noted: {content[:120]}", "info")
    return {"ok": True, "timestamp": entry["timestamp"]}


async def _tool_add_candidate(ctx: ScoutContext, args: Dict[str, Any]) -> Dict[str, Any]:
    """Commit one candidate to the sidebar immediately. Resolves Vertex
    redirector URLs, enriches missing image_url, and pushes over SSE so the
    frontend can render the card while the scout keeps working."""
    url = (args.get("url") or "").strip()
    if not url:
        return {"error": "missing url"}

    # Resolve Vertex grounding redirectors (search_web should have done this
    # already, but be defensive in case the model passed a raw search result).
    if _is_vertex_redirector(url):
        loop = asyncio.get_running_loop()
        resolved = await loop.run_in_executor(None, _resolve_vertex_redirect, url)
        if _is_vertex_redirector(resolved):
            return {"error": "URL is a search redirector; open_link it first, then call add_candidate with the real URL."}
        url = resolved

    title = (args.get("title") or "Untitled").strip()[:180]
    match_reason = (args.get("match_reason") or "").strip()[:800]
    price = args.get("price") or None
    image_url = args.get("image_url") or None
    if image_url and not isinstance(image_url, str):
        image_url = None

    emoji = args.get("emoji") or None
    if isinstance(emoji, str):
        emoji = emoji.strip()[:4] or None  # cap to a couple codepoints

    candidate = Candidate(
        title=title,
        url=url,
        price=price,
        image_url=image_url if (image_url and image_url.startswith("http")) else None,
        emoji=emoji,
        match_reason=match_reason,
    )

    # Enrich image_url right now so the card lands in the sidebar with a cover.
    if not candidate.image_url and candidate.url.startswith("http"):
        try:
            cover = await _resolve_cover_image(candidate.url)
            if cover:
                candidate.image_url = cover
        except Exception as e:
            logger.warning(f"cover enrichment failed for {candidate.url}: {e}")

    # De-dupe against earlier commits in this same scout's run.
    if any(c.url == candidate.url for c in ctx.committed_candidates):
        return {"ok": False, "note": "already committed in this scout run; pick a different candidate"}

    ctx.committed_candidates.append(candidate)

    # Stream to the frontend immediately.
    try:
        push_event({
            "kind": "candidate",
            "candidate": candidate.model_dump(),
            "cluster_id": ctx.cluster_id,
        })
    except Exception as e:
        logger.warning(f"failed to push candidate: {e}")

    append_log(
        "scout",
        f"[{ctx.scout_id}] +candidate: {candidate.title}",
        "success",
        details=f"{candidate.url}\nPrice: {candidate.price or '(n/a)'}\n{candidate.match_reason}",
    )

    return {
        "ok": True,
        "committed_count": len(ctx.committed_candidates),
        "candidate_title": candidate.title,
    }


# --- ReAct loop ---------------------------------------------------------------
async def run_scout_single(
    dispatch: ScoutDispatch,
    taste_profile: str,
    cluster_label: str,
    user_currency: str = "USD",
    cluster_cards: Optional[List[Dict[str, Any]]] = None,
) -> List[Candidate]:
    scout_id = f"Scout-{uuid.uuid4().hex[:4]}"
    ctx = ScoutContext(
        scout_id=scout_id,
        cluster_id=dispatch.cluster_id,
        cluster_label=cluster_label,
        cluster_cards=cluster_cards or [],
        taste_profile=taste_profile,
        user_currency=user_currency,
    )

    append_log(
        "scout",
        f"[{scout_id}] dispatched for cluster '{cluster_label}' (priority={dispatch.priority}, currency={user_currency}).",
        "info",
        details="Search hints:\n- " + "\n- ".join(dispatch.search_hints),
        cluster_id=dispatch.cluster_id,
        phase="start",
    )

    if client is None:
        append_log("scout", f"[{scout_id}] no API key — returning a mock candidate.", "warning")
        await asyncio.sleep(0.3)
        return [Candidate(
            title=f"Mock candidate for {cluster_label}",
            url="https://example.com/mock",
            price="$100",
            image_url=None,
            match_reason="Mock — set GEMINI_API_KEY to enable the real ReAct loop.",
        )]

    try:
        for step in range(MAX_SCOUT_STEPS):
            step_prompt = _build_step_prompt(ctx)
            response = await client.aio.models.generate_content(
                model=MODEL,
                contents=step_prompt,
                config=types.GenerateContentConfig(
                    tools=[SCOUT_TOOLS],
                    tool_config=types.ToolConfig(
                        function_calling_config=types.FunctionCallingConfig(mode="ANY"),
                    ),
                    system_instruction=SCOUT_SYSTEM,
                    # High thinking budget for the orchestrator decision — the
                    # ReAct loop benefits from deep reasoning over each tool's result.
                    thinking_config=types.ThinkingConfig(include_thoughts=True, thinking_level="high"),
                ),
            )

            # Surface thinking parts + locate the function_call
            fc = None
            for cand in (response.candidates or []):
                if not (cand.content and cand.content.parts):
                    continue
                for part in cand.content.parts:
                    if getattr(part, "thought", False) and getattr(part, "text", None):
                        text = part.text.strip()
                        first = text.split("\n", 1)[0]
                        append_log("scout", f"[{scout_id}] thinking: {first[:140]}", "info", details=text)
                    if getattr(part, "function_call", None):
                        fc = part.function_call

            if fc is None:
                append_log("scout", f"[{scout_id}] no tool call returned at step {step+1}; ending.", "warning")
                break

            args = dict(fc.args or {})
            args_preview = json.dumps(args, default=str)
            if len(args_preview) > 160:
                args_preview = args_preview[:160] + "…"
            append_log("scout", f"[{scout_id}] → {fc.name}({args_preview})", "info")

            # Execute the chosen tool
            if fc.name == "done":
                append_log(
                    "scout",
                    f"[{scout_id}] done — committed {len(ctx.committed_candidates)} candidate(s).",
                    "success",
                )
                break
            elif fc.name == "add_candidate":
                result = await _tool_add_candidate(ctx, args)
            elif fc.name == "search_web":
                result = await _tool_search_web(args.get("query", ""))
            elif fc.name in ("open_link", "open_tab"):  # tolerate old name during transition
                result = await _tool_open_tab(ctx, args.get("url", ""))
                if isinstance(result, dict) and "error" not in result:
                    insight = await _summarize_observation(ctx, "open_link", result)
                    if insight:
                        result["insight"] = insight
                        append_log(
                            "scout",
                            f"[{scout_id}] insight: {'LEAD' if insight.get('is_viable_lead') else 'no lead'} — next: {insight.get('next_action_hint')}",
                            "info" if insight.get("is_viable_lead") else "warning",
                            details=json.dumps(insight, indent=2),
                        )
            elif fc.name == "click":
                result = await _tool_click(ctx, args.get("text", ""))
            elif fc.name == "scroll_and_capture":
                result = await _tool_scroll(ctx, args.get("direction", "down"), int(args.get("amount_px") or 800))
                if isinstance(result, dict) and "error" not in result:
                    insight = await _summarize_observation(ctx, "scroll_and_capture", result)
                    if insight:
                        result["insight"] = insight
            elif fc.name == "extract_products":
                result = await _tool_extract_products(ctx)
                if isinstance(result, dict) and "error" not in result:
                    insight = await _summarize_observation(ctx, "extract_products", result)
                    if insight:
                        result["insight"] = insight
                        append_log(
                            "scout",
                            f"[{scout_id}] insight: {'LEAD' if insight.get('is_viable_lead') else 'no lead'} — next: {insight.get('next_action_hint')}",
                            "info" if insight.get("is_viable_lead") else "warning",
                            details=json.dumps(insight, indent=2),
                        )
            elif fc.name == "note":
                result = _tool_note(ctx, args.get("content", ""))
            else:
                result = {"error": f"unknown tool: {fc.name}"}

            # `done` short-circuits above; for everything else, record + log.
            if fc.name != "done":
                ctx.observations.append({"step": step + 1, "action": fc.name, "args": args, "result": result})
                if isinstance(result, dict) and "error" in result:
                    append_log("scout", f"[{scout_id}] observed error: {result['error']}", "warning",
                               details=_summarize_for_log(result, limit=1200))
                else:
                    summary = _summarize_for_log(result, limit=180)
                    append_log("scout", f"[{scout_id}] observed: {summary}", "info",
                               details=_summarize_for_log(result, limit=2000))

        else:
            append_log(
                "scout",
                f"[{scout_id}] hit MAX_SCOUT_STEPS — returning {len(ctx.committed_candidates)} committed candidate(s).",
                "warning",
            )

        # Candidates were streamed and enriched inline via add_candidate; the
        # /scout response just aggregates them as a safety net.
        return list(ctx.committed_candidates)

    except Exception as e:
        append_log("scout", f"[{scout_id}] loop crashed: {e}", "error")
        logger.exception("scout loop crashed")
        return list(ctx.committed_candidates)
    finally:
        # Signal cluster-done to the frontend so the active-state highlight clears.
        append_log(
            "scout",
            f"[{scout_id}] finished cluster '{cluster_label}'.",
            "info",
            cluster_id=ctx.cluster_id,
            phase="end",
        )
        if ctx.page is not None:
            try:
                # Intentionally leave the tab open — the audience should see it.
                pass
            except Exception:
                pass


async def _enrich_candidate_images(candidates: List[Candidate]) -> None:
    """Fill in missing image_url via og:image → screenshot fallback."""
    async def enrich(c: Candidate):
        if c.image_url and c.image_url.startswith("http"):
            return
        if not c.url or not c.url.startswith("http"):
            return
        cover = await _resolve_cover_image(c.url)
        if cover:
            c.image_url = cover

    await asyncio.gather(*(enrich(c) for c in candidates), return_exceptions=True)


# ======================= STAGE (Playwright, sync) =======================
def run_playwright_stage(url: str) -> StageResponse:
    """
    Sync Playwright stub. Launches Chrome with the user's persistent profile,
    navigates, screenshots, and leaves the window open for purchase. Called from
    main.py via run_in_executor to avoid blocking the FastAPI event loop.
    """
    append_log("stage", f"Stage start — url='{url}'", "info")
    user_data_dir = os.path.expandvars("$HOME/chrome-debug-profile2")
    append_log("stage", f"Persistent profile: {user_data_dir}", "info")

    try:
        from playwright.sync_api import sync_playwright

        append_log("stage", "Launching Chromium persistent context…", "info")
        with sync_playwright() as p:
            ctx = p.chromium.launch_persistent_context(
                user_data_dir=user_data_dir,
                headless=False,
                args=["--no-sandbox", "--disable-setuid-sandbox"],
            )
            page = ctx.new_page() if not ctx.pages else ctx.pages[0]

            append_log("stage", f"Navigating to '{url}'…", "info")
            page.goto(url, timeout=30000)
            page.wait_for_timeout(3000)

            screenshot_dir = os.path.abspath("./screenshots")
            os.makedirs(screenshot_dir, exist_ok=True)
            screenshot_path = os.path.join(screenshot_dir, f"stage_{uuid.uuid4().hex[:8]}.png")
            page.screenshot(path=screenshot_path)
            append_log("stage", f"Captured screenshot at {screenshot_path}.", "info")

            # Intentionally do NOT close ctx — window stays open for the user.
            append_log("stage", "Stage success — tab left open in Chrome.", "success")
            return StageResponse(status="success", screenshot_path=screenshot_path)

    except ImportError:
        append_log("stage", "Playwright not installed — simulating stage.", "warning")
        import time
        time.sleep(1.5)
        append_log("stage", f"SIMULATION: would have staged '{url}'.", "success")
        return StageResponse(status="success", screenshot_path="/assets/placeholder-screenshot.png")
    except Exception as e:
        append_log("stage", f"Stage failed: {e}", "error")
        return StageResponse(status="failed", screenshot_path=None)
