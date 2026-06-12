"""Extension browser command bridge — dispatches actions over SSE, awaits results."""

from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from typing import Any, Dict, List, Optional

logger = logging.getLogger("moodboard.browser_bridge")

BROWSER_BACKEND = os.environ.get("BROWSER_BACKEND", "extension").strip().lower()
ACTION_TIMEOUT_SEC = float(os.environ.get("BROWSER_ACTION_TIMEOUT", "90"))

_pending: Dict[str, asyncio.Future] = {}
_queued_actions: Dict[str, Dict[str, Any]] = {}
_extension_last_seen: float = 0.0

_TOOL_TIMEOUTS: Dict[str, float] = {
    "open_link": 90.0,
    "open_tab": 90.0,
    "google_search": 45.0,
    "click": 30.0,
    "scroll_and_capture": 30.0,
    "extract_products": 45.0,
    "extract_page": 45.0,
}


def browser_backend() -> str:
    return BROWSER_BACKEND if BROWSER_BACKEND in ("extension", "playwright") else "extension"


def use_extension_browser() -> bool:
    return browser_backend() == "extension"


def mark_extension_connected() -> None:
    global _extension_last_seen
    _extension_last_seen = time.time()


def extension_connected(within_sec: float = 120.0) -> bool:
    if _extension_last_seen <= 0:
        return False
    return (time.time() - _extension_last_seen) < within_sec


def get_pending_browser_actions() -> List[Dict[str, Any]]:
    """Return queued actions for extension HTTP polling (MV3 service workers miss SSE)."""
    return list(_queued_actions.values())


def _remove_queued_action(action_id: str) -> None:
    _queued_actions.pop(action_id, None)


def resolve_browser_action(action_id: str, result: Optional[Dict[str, Any]] = None, error: Optional[str] = None) -> bool:
    _remove_queued_action(action_id)
    fut = _pending.pop(action_id, None)
    if fut is None or fut.done():
        logger.warning("browser action result for unknown or settled id: %s", action_id)
        return False
    if error:
        fut.set_result({"error": error})
    else:
        fut.set_result(result or {})
    return True


def _action_timeout(tool: str, override: Optional[float]) -> float:
    if override is not None:
        return override
    return _TOOL_TIMEOUTS.get(tool, ACTION_TIMEOUT_SEC)


async def dispatch_browser_action(
    scout_id: str,
    tool: str,
    args: Optional[Dict[str, Any]] = None,
    *,
    timeout: Optional[float] = None,
) -> Dict[str, Any]:
    """Emit browser_action on SSE and block until extension posts /browser/result."""
    from agents import push_event

    if not extension_connected():
        return {
            "error": (
                "Chrome extension not connected. Load the Moodboard extension and "
                "ensure the backend is running."
            )
        }

    action_id = str(uuid.uuid4())
    loop = asyncio.get_running_loop()
    fut: asyncio.Future = loop.create_future()
    _pending[action_id] = fut

    payload = {
        "kind": "browser_action",
        "action_id": action_id,
        "scout_id": scout_id,
        "tool": tool,
        "args": args or {},
    }
    _queued_actions[action_id] = payload
    push_event(payload)

    wait_sec = _action_timeout(tool, timeout)
    try:
        return await asyncio.wait_for(fut, timeout=wait_sec)
    except asyncio.TimeoutError:
        _pending.pop(action_id, None)
        _remove_queued_action(action_id)
        return {"error": f"extension browser action timed out ({tool})"}
    except Exception as e:
        _pending.pop(action_id, None)
        _remove_queued_action(action_id)
        return {"error": str(e)}
