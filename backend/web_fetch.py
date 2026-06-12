"""Fetch web page content as markdown via markdown.new (Cloudflare)."""

import asyncio
import logging
import os
import re
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import requests

logger = logging.getLogger("moodboard.web_fetch")

MARKDOWN_NEW_API = "https://markdown.new/"
DEFAULT_TIMEOUT = 15.0
INGEST_MAX_CHARS = 8000
SCOUT_PREVIEW_CHARS = 1200

# Domains where markdown pre-screen is low-value; scout should open_link directly.
_RETAIL_DOMAIN_RE = re.compile(
    r"(amazon|ebay|etsy|shopify|nordstrom|ssense|farfetch|mrporter|net-a-porter|"
    r"uniqlo|zara|hm\.com|nike|adidas|rei\.com|backcountry|"
    r"booking\.com|airbnb|expedia|kayak|hotels\.com|"
    r"wayfair|ikea|target\.com|walmart|bestbuy)",
    re.I,
)

_FETCH_SEMA = asyncio.Semaphore(4)


def markdown_fetch_enabled() -> bool:
    return os.environ.get("MARKDOWN_FETCH", "1").strip().lower() not in ("0", "false", "no")


def looks_like_url(text: str) -> bool:
    t = (text or "").strip()
    return bool(re.match(r"https?://\S+", t, re.I))


def is_retail_url(url: str) -> bool:
    try:
        host = urlparse(url).netloc.lower()
        return bool(_RETAIL_DOMAIN_RE.search(host))
    except Exception:
        return False


def should_fetch_markdown_for_scout(url: str) -> bool:
    """Skip retail/booking domains where interactive browser is required."""
    if not markdown_fetch_enabled():
        return False
    return not is_retail_url(url)


def _fetch_markdown_sync(url: str, timeout: float) -> Optional[Dict[str, Any]]:
    try:
        resp = requests.post(
            MARKDOWN_NEW_API,
            json={"url": url, "method": "auto", "retain_images": False},
            headers={"Content-Type": "application/json"},
            timeout=timeout,
        )
        if resp.status_code != 200:
            logger.warning("markdown.new HTTP %s for %s", resp.status_code, url)
            return None
        data = resp.json()
        if not data.get("success"):
            return None
        content = data.get("content")
        if not isinstance(content, str) or not content.strip():
            return None
        return {
            "title": data.get("title"),
            "content": content.strip(),
            "method": data.get("method"),
            "tokens": data.get("tokens"),
        }
    except Exception as e:
        logger.warning("fetch_markdown failed for %s: %s", url, e)
        return None


async def fetch_markdown(
    url: str,
    *,
    timeout: float = DEFAULT_TIMEOUT,
    max_chars: int = INGEST_MAX_CHARS,
) -> Optional[str]:
    """Return page markdown for *url*, or None on failure."""
    if not markdown_fetch_enabled() or not url or not url.startswith("http"):
        return None
    async with _FETCH_SEMA:
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, lambda: _fetch_markdown_sync(url, timeout))
    if not result:
        return None
    md = result["content"]
    if len(md) > max_chars:
        md = md[:max_chars] + "\n\n[…truncated]"
    return md


async def fetch_markdown_previews(
    urls: List[str],
    *,
    max_urls: int = 3,
    max_chars: int = SCOUT_PREVIEW_CHARS,
) -> Dict[str, str]:
    """Fetch markdown previews for up to *max_urls* scout-suitable URLs in parallel."""
    targets = [u for u in urls if should_fetch_markdown_for_scout(u)][:max_urls]
    if not targets:
        return {}

    async def one(u: str) -> tuple[str, Optional[str]]:
        md = await fetch_markdown(u, max_chars=max_chars)
        return u, md

    pairs = await asyncio.gather(*(one(u) for u in targets), return_exceptions=True)
    out: Dict[str, str] = {}
    for item in pairs:
        if isinstance(item, Exception):
            continue
        url, md = item
        if md:
            out[url] = md
    return out
