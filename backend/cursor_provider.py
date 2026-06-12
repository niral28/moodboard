"""Cursor Agent SDK provider — vision / structured JSON via composer-2.5.

Requires:
  pip install cursor-sdk
  CURSOR_API_KEY=...   (Cursor Dashboard → Integrations → API Keys)

Typical use (vision only, Ollama for reasoning):
  LLM_PROVIDER=ollama
  LLM_VISION_PROVIDER=cursor
  LLM_VISION_MODEL=composer-2.5
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from typing import Any, Dict, List, Optional

from pydantic import BaseModel

from llm_provider import (
    BaseLLMProvider,
    ContentPart,
    ToolCallResult,
    _duckduckgo_search,
)

logger = logging.getLogger("moodboard.cursor")

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def _extract_json(text: str) -> Dict[str, Any]:
    """Parse JSON from agent output, tolerating markdown fences."""
    raw = (text or "").strip()
    if not raw:
        return {}
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw)
    if fence:
        raw = fence.group(1).strip()
    return json.loads(raw)


class CursorProvider(BaseLLMProvider):
    """One-shot Agent.prompt calls — best suited for vision + structured ingest/curate."""

    def __init__(self, model: Optional[str] = None):
        self._model = model or os.environ.get("LLM_VISION_MODEL") or os.environ.get(
            "CURSOR_MODEL", "composer-2.5"
        )
        self._api_key = os.environ.get("CURSOR_API_KEY", "")
        self._cwd = os.environ.get("CURSOR_SDK_CWD", _REPO_ROOT)

    @property
    def provider_name(self) -> str:
        return "cursor"

    @property
    def model(self) -> str:
        return self._model

    @property
    def available(self) -> bool:
        if not self._api_key.strip():
            return False
        try:
            import cursor_sdk  # noqa: F401
        except ImportError:
            return False
        return True

    def _agent_options(self):
        from cursor_sdk import AgentOptions, LocalAgentOptions

        return AgentOptions(
            api_key=self._api_key,
            model=self._model,
            local=LocalAgentOptions(cwd=self._cwd),
        )

    def _build_message(self, prompt: str, parts: Optional[List[ContentPart]] = None):
        from cursor_sdk import SDKImage, UserMessage

        images = []
        for part in parts or []:
            if isinstance(part, tuple):
                img_bytes, mime = part
                images.append(SDKImage.from_data(img_bytes, mime))

        if images:
            return UserMessage(text=prompt, images=images)
        return prompt

    def _prompt_structured_sync(
        self,
        prompt: str,
        schema: type[BaseModel],
        parts: Optional[List[ContentPart]] = None,
    ) -> Dict[str, Any]:
        from cursor_sdk import Agent, CursorAgentError

        schema_json = schema.model_json_schema()
        full_prompt = (
            "You are a JSON-only analysis API. Do not use tools, shell, or edit files. "
            "Analyze any attached images and respond with ONLY valid JSON matching the schema "
            "below — no markdown fences, no commentary.\n\n"
            f"{prompt}\n\n"
            f"JSON schema:\n{json.dumps(schema_json, indent=2)}"
        )
        message = self._build_message(full_prompt, parts)
        options = self._agent_options()

        try:
            result = Agent.prompt(message, options)
        except CursorAgentError as e:
            raise RuntimeError(f"Cursor SDK failed to start: {e}") from e

        if result.status != "finished":
            raise RuntimeError(
                f"Cursor agent run ended with status={result.status!r} "
                f"(result={result.result!r})"
            )

        return _extract_json(result.result or "{}")

    async def generate_structured(
        self,
        prompt: str,
        schema: type[BaseModel],
        parts: Optional[List[ContentPart]] = None,
    ) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None,
            lambda: self._prompt_structured_sync(prompt, schema, parts),
        )

    async def generate_tool_call(
        self,
        prompt: str,
        tools: List[Dict[str, Any]],
        system_instruction: Optional[str] = None,
    ) -> Optional[ToolCallResult]:
        raise NotImplementedError(
            "Cursor SDK is not wired for scout tool-calling. "
            "Use LLM_PROVIDER=ollama|gemini for the ReAct loop; "
            "set LLM_VISION_PROVIDER=cursor for image analysis only."
        )

    async def web_search(self, query: str) -> List[Dict[str, str]]:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, _duckduckgo_search, query)
