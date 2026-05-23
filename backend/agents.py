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
from pydantic import BaseModel

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
event_logs: List[Dict[str, Any]] = []
event_queue: asyncio.Queue = asyncio.Queue()


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


async def _screenshot_page_via_browser(url: str, timeout_ms: int = 10000) -> Optional[str]:
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


def append_log(agent: str, message: str, level: str = "info", details: Optional[str] = None):
    timestamp = datetime.now().strftime("%H:%M:%S")
    entry: Dict[str, Any] = {"agent": agent, "message": message, "level": level, "timestamp": timestamp}
    if details:
        entry["details"] = details
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

Articulate `taste_profile` as a paragraph the user would recognize as describing them — the underlying sensibility and direction, not a list of items.

Identify `gaps` as 3–5 concrete additions whose absence is conspicuous given the rest of the board. Gaps must be specific enough that a search agent can act on them directly — name materials, places, price tiers, or formats where the existing cards make those constraints explicit.
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
    prompt = f"{CURATE_PROMPT}\n\nBoard cards (JSON, image cards' pixel data attached above):\n{json.dumps(cards_json, indent=2)}"

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
SCOUT_PROMPT = """\
Role: Product and reference scout with live web search.

You receive one cluster, its search hints, the user's overall taste profile, and the user's preferred display currency. Perform real web research with your search tool and surface exactly 3 candidates that would meaningfully extend the moodboard. Candidates may be products, articles, bookings, references, or images — whichever best satisfies the hints in context.

Ground each candidate in a real web source surfaced by the search tool — do not invent URLs. Lean on the most specific qualifier in each hint (a district, material, brand, price tier, date) when forming queries.

Pricing: when a candidate is purchasable or bookable, format the price in the user's preferred currency. If the source price is in a different currency, convert at approximate current rates and show the converted figure first with the original in parentheses — e.g. "$40 (~¥6,000)". Do not omit a price the source clearly states.

Return your answer as a JSON array of exactly 3 objects with these fields:
- title: the candidate's actual name as it appears on the source page
- url: the real, cited URL from your search results
- price: string in the user's currency when purchasable/bookable, else null
- image_url: representative image URL if you have one from the source, else null
- match_reason: why this candidate fits, in terms specific enough that a skeptical user could verify — reference the cluster identity, the taste profile, or specific entities. Avoid generalities.

Output only the JSON array. No commentary, no code fences.
"""


CDP_ENDPOINT = "http://localhost:9222"


async def _open_urls_in_chrome(urls: List[str], cluster_label: str) -> None:
    """Open each URL as a new tab in the user's running Chrome via CDP.
    Gracefully degrades with a log warning if Chrome is not reachable at CDP_ENDPOINT."""
    if not urls:
        return
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        append_log("scout", "Playwright not installed — skipping Chrome tab orchestration.", "warning")
        return

    async with async_playwright() as p:
        try:
            browser = await p.chromium.connect_over_cdp(CDP_ENDPOINT)
        except Exception as e:
            append_log(
                "scout",
                f"Chrome CDP unreachable at {CDP_ENDPOINT} — tabs will not open.",
                "warning",
                details=(
                    "To enable live tab orchestration, launch Chrome with:\n"
                    "  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \\\n"
                    "    --remote-debugging-port=9222 \\\n"
                    "    --user-data-dir=\"$HOME/chrome-debug-profile2\"\n\n"
                    f"Error: {e}"
                ),
            )
            return

        ctx = browser.contexts[0] if browser.contexts else await browser.new_context()

        async def open_one(url: str):
            try:
                page = await ctx.new_page()
                append_log("scout", f"Chrome → opening tab for '{cluster_label}': {url}", "info")
                await page.goto(url, timeout=15000, wait_until="domcontentloaded")
            except Exception as e:
                append_log("scout", f"Chrome tab failed: {url}", "warning", details=str(e))

        await asyncio.gather(*(open_one(u) for u in urls), return_exceptions=True)
        await browser.close()  # disconnects CDP; tabs stay open


async def _enrich_candidate_images(candidates: List[Candidate]) -> None:
    """Fill in missing image_url for each candidate via og:image → screenshot fallback."""
    async def enrich(c: Candidate):
        if c.image_url and c.image_url.startswith("http"):
            return
        if not c.url or not c.url.startswith("http"):
            return
        cover = await _resolve_cover_image(c.url)
        if cover:
            c.image_url = cover

    await asyncio.gather(*(enrich(c) for c in candidates), return_exceptions=True)


def _extract_candidates(text: str, cited: List[Dict[str, str]]) -> List[Candidate]:
    """Robustly extract candidate JSON from the grounded model output.
    Falls back to a list synthesized from grounding citations if parsing fails."""
    cleaned = text.strip()
    if "```json" in cleaned:
        cleaned = cleaned.split("```json", 1)[1].split("```", 1)[0].strip()
    elif cleaned.startswith("```"):
        cleaned = cleaned.split("```", 1)[1].split("```", 1)[0].strip()

    candidates: List[Candidate] = []
    try:
        start = cleaned.find("[")
        end = cleaned.rfind("]")
        raw = cleaned[start:end + 1] if start >= 0 and end > start else cleaned
        data = json.loads(raw)
        if isinstance(data, dict) and "candidates" in data:
            data = data["candidates"]
        for item in data[:3]:
            candidates.append(Candidate(**item))
    except Exception:
        for c in cited[:3]:
            candidates.append(Candidate(
                title=c.get("title") or "Source",
                url=c["url"],
                price=None,
                image_url=None,
                match_reason="Surfaced via grounded web search for this cluster.",
            ))
    return candidates


async def run_scout_single(
    dispatch: ScoutDispatch,
    taste_profile: str,
    cluster_label: str,
    user_currency: str = "USD",
) -> List[Candidate]:
    append_log(
        "scout",
        f"Scout dispatched for '{cluster_label}' (priority={dispatch.priority}, currency={user_currency}).",
        "info",
        details="Search hints:\n- " + "\n- ".join(dispatch.search_hints),
    )

    if client is None:
        append_log("scout", "No API key — returning mock candidates.", "warning")
        await asyncio.sleep(0.5)
        return [
            Candidate(
                title=f"Mock candidate for {cluster_label}",
                url="https://example.com/mock",
                price="$100",
                image_url="https://images.unsplash.com/photo-1493976040374-85c8e12f0c0e?auto=format&fit=crop&w=400&q=80",
                match_reason="Mock match reason.",
            )
        ]

    payload = {
        "cluster_label": cluster_label,
        "search_hints": dispatch.search_hints,
        "taste_profile": taste_profile,
        "user_currency": user_currency,
    }
    prompt = f"{SCOUT_PROMPT}\n\nScout brief:\n{json.dumps(payload, indent=2)}"

    config = types.GenerateContentConfig(
        tools=[types.Tool(google_search=types.GoogleSearch())],
        thinking_config=types.ThinkingConfig(include_thoughts=True, thinking_budget=-1),
    )

    full_text = ""
    cited: List[Dict[str, str]] = []

    try:
        stream = await client.aio.models.generate_content_stream(
            model=MODEL,
            contents=prompt,
            config=config,
        )
        async for chunk in stream:
            for cand in (chunk.candidates or []):
                if cand.content and cand.content.parts:
                    for part in cand.content.parts:
                        is_thought = bool(getattr(part, "thought", False))
                        text = getattr(part, "text", None) or ""
                        if is_thought and text.strip():
                            first_line = text.strip().split("\n", 1)[0]
                            headline = first_line[:120] + ("…" if len(first_line) > 120 else "")
                            append_log(
                                "scout",
                                f"[thinking] {headline}",
                                "info",
                                details=text.strip(),
                            )
                        elif text:
                            full_text += text
                gm = getattr(cand, "grounding_metadata", None)
                if gm and getattr(gm, "grounding_chunks", None):
                    for gc in gm.grounding_chunks:
                        web = getattr(gc, "web", None)
                        if web and getattr(web, "uri", None):
                            cited.append({"url": web.uri, "title": getattr(web, "title", "") or ""})

        # De-dupe cited URLs preserving order
        seen = set()
        cited = [c for c in cited if not (c["url"] in seen or seen.add(c["url"]))]

        if cited:
            append_log(
                "scout",
                f"Grounded '{cluster_label}' in {len(cited)} real source(s).",
                "success",
                details="\n".join(f"• {c['title'] or '(untitled)'}\n  {c['url']}" for c in cited[:10]),
            )

        candidates = _extract_candidates(full_text, cited)

        # Enrich any candidate missing an image_url by fetching og:image from its source URL.
        await _enrich_candidate_images(candidates)

        urls_to_open = [c.url for c in candidates if c.url and c.url.startswith("http")][:3]
        if urls_to_open:
            asyncio.create_task(_open_urls_in_chrome(urls_to_open, cluster_label))

        append_log("scout", f"Scout returned {len(candidates)} candidate(s) for '{cluster_label}'.", "success")
        return candidates
    except Exception as e:
        append_log("scout", f"Scout failed for '{cluster_label}': {e}", "error")
        return []


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
