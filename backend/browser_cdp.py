"""Chrome CDP helpers — probe, config, launch hints."""

import os
import logging
from typing import Any, Dict

import requests

logger = logging.getLogger("moodboard.browser_cdp")

CHROME_PROFILE_PATH = os.environ.get(
    "CHROME_PROFILE_PATH",
    os.path.expandvars("$HOME/chrome-debug-profile2"),
)
# Separate profile for Playwright's bundled Chromium fallback so we never
# fight the user's CDP Chrome for the same user-data-dir lock.
CHROME_FALLBACK_PROFILE = os.environ.get(
    "CHROME_FALLBACK_PROFILE",
    os.path.expandvars("$HOME/chrome-playwright-fallback"),
)
SCOUT_CDP_ENDPOINT = os.environ.get("CHROME_CDP_URL", "http://localhost:9222")
CDP_PROBE_TIMEOUT = 2.0


def probe_cdp(endpoint: str = SCOUT_CDP_ENDPOINT) -> Dict[str, Any]:
    """Return whether a Chrome CDP endpoint is listening. Never raises."""
    url = endpoint.rstrip("/") + "/json/version"
    try:
        resp = requests.get(url, timeout=CDP_PROBE_TIMEOUT)
        if resp.status_code != 200:
            return {
                "reachable": False,
                "endpoint": endpoint,
                "error": f"HTTP {resp.status_code}",
            }
        data = resp.json()
        return {
            "reachable": True,
            "endpoint": endpoint,
            "browser": data.get("Browser"),
            "webSocketDebuggerUrl": data.get("webSocketDebuggerUrl"),
        }
    except Exception as e:
        return {"reachable": False, "endpoint": endpoint, "error": str(e)}


def cdp_launch_hint() -> str:
    port = SCOUT_CDP_ENDPOINT.rsplit(":", 1)[-1]
    return (
        "Launch Chrome with remote debugging:\n"
        "  ./scripts/launch-chrome-debug.sh\n"
        "Or manually:\n"
        "  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\\n"
        f"    --remote-debugging-port={port} \\\n"
        f'    --user-data-dir="{CHROME_PROFILE_PATH}"'
    )
