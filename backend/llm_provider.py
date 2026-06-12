"""Model-agnostic LLM provider layer.

Switch backends via environment variables:

  LLM_PROVIDER=ollama|gemini|openai|cursor  (default: ollama) — reasoning / tool loop
  LLM_MODEL=qwen3.5:9b                      (main model id)
  LLM_VISION_PROVIDER=gemini|cursor         (optional; defaults to LLM_PROVIDER)
  LLM_VISION_MODEL=gemini-2.5-flash         (optional; vision/multimodal model)
  SEARCH_PROVIDER=main|chrome|gemini        (default main — DDG; never uses vision unless gemini)
  OLLAMA_BASE_URL=http://localhost:11434/v1
  GEMINI_API_KEY=...                        (required for gemini vision or main)
  OPENAI_API_KEY=...                        (required when LLM_PROVIDER=openai)
  CURSOR_API_KEY=...                        (required when LLM_VISION_PROVIDER=cursor)
  CURSOR_SDK_CWD=/path/to/repo              (optional; local agent cwd, default repo root)

Hybrid example (local reasoning + Cursor vision):
  LLM_PROVIDER=ollama
  LLM_MODEL=qwen3.5:9b
  LLM_VISION_PROVIDER=cursor
  LLM_VISION_MODEL=composer-2.5
  CURSOR_API_KEY=...

Hybrid example (local reasoning + Gemini vision):
  LLM_PROVIDER=ollama
  LLM_MODEL=qwen3.5:9b
  LLM_VISION_PROVIDER=gemini
  LLM_VISION_MODEL=gemini-2.5-flash
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple, Union

from pydantic import BaseModel

logger = logging.getLogger("moodboard.llm")

ContentPart = Union[str, Tuple[bytes, str]]  # text or (image_bytes, mime_type)


def _parts_have_images(parts: Optional[List[ContentPart]]) -> bool:
    return any(isinstance(p, tuple) for p in (parts or []))


@dataclass
class ToolCallResult:
    name: str
    args: Dict[str, Any]
    thinking: Optional[str] = None


# Scout tools in OpenAI function-calling format (works with Ollama + Gemini conversion).
SCOUT_TOOLS: List[Dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "search_web",
            "description": (
                "Search the web for a query. Returns top results [{title, snippet, url}]. "
                "Use to discover candidate sources before opening tabs. "
                "Queries should be specific and qualifier-rich (include materials, brands, "
                "price tiers, locations from the cluster or feedback)."
            ),
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "open_link",
            "description": (
                "Open a link from your search results in a real Chrome tab. Use this to "
                "verify a candidate by reading the actual page rather than relying on a "
                "search snippet. Returns the page title and the first ~3000 chars of "
                "visible text. The opened tab becomes the active tab for follow-up "
                "scroll_and_capture and extract_products calls."
            ),
            "parameters": {
                "type": "object",
                "properties": {"url": {"type": "string"}},
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "click",
            "description": (
                "Click an element on the active tab by its visible text. Use to dismiss "
                "popups ('Accept', 'No thanks', 'Close'), follow on-site links, or activate "
                "filters. open_link already attempts to auto-dismiss common popups — only "
                "call click if the page still has overlays in the way, or you need to "
                "navigate within the site."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "Visible text of the target — exact or substring.",
                    },
                },
                "required": ["text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "scroll_and_capture",
            "description": (
                "Scroll the active tab in a direction and return newly visible text. "
                "Use after open_tab when relevant content is below the fold."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "direction": {"type": "string", "enum": ["down", "up"]},
                    "amount_px": {"type": "integer"},
                },
                "required": ["direction", "amount_px"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "extract_products",
            "description": (
                "Run a structured-extraction pass on the active tab. Returns a list of "
                "products [{title, price, image_url, product_url}]. Use when the active "
                "tab lists multiple items and you want a clean comparable set."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "note",
            "description": (
                "Record a durable observation to the shared Journal — visible to other "
                "scouts and to future Ticks. Use for insights worth remembering beyond "
                "this scout's loop."
            ),
            "parameters": {
                "type": "object",
                "properties": {"content": {"type": "string"}},
                "required": ["content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "add_candidate",
            "description": (
                "Commit one verified candidate to the user's sidebar IMMEDIATELY. "
                "The user watches candidates appear in real time as you call this, "
                "so do not batch them — call add_candidate the moment you've verified "
                "a lead via open_link/extract_products, then keep researching the next. "
                "Aim for 3-5 calls total over the course of your loop. "
                "Provide title, url (a real destination, not a search redirector), "
                "match_reason; include price in the user's currency and image_url "
                "when known from the page you visited."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "url": {"type": "string"},
                    "price": {"type": "string"},
                    "image_url": {"type": "string"},
                    "emoji": {
                        "type": "string",
                        "description": (
                            "A single emoji representing this candidate visually "
                            "(e.g. '🪵' for a wooden bench). Used when image_url is missing."
                        ),
                    },
                    "match_reason": {"type": "string"},
                },
                "required": ["title", "url", "match_reason"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "done",
            "description": (
                "Terminate this scout. Call after you've added 3-5 candidates via "
                "add_candidate and have nothing more worth committing. Takes no arguments."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
]


def _build_user_message(prompt: str, parts: Optional[List[ContentPart]] = None) -> Dict[str, Any]:
    content: List[Dict[str, Any]] = []
    for part in parts or []:
        if isinstance(part, str):
            content.append({"type": "text", "text": part})
        else:
            img_bytes, mime = part
            b64 = base64.b64encode(img_bytes).decode("ascii")
            content.append(
                {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}}
            )
    content.append({"type": "text", "text": prompt})
    return {"role": "user", "content": content}


def _duckduckgo_search(query: str, limit: int = 8) -> List[Dict[str, str]]:
    """Lightweight web search fallback when Gemini Google Search is unavailable."""
    import requests
    from urllib.parse import quote, unquote

    url = f"https://lite.duckduckgo.com/lite/?q={quote(query)}"
    try:
        resp = requests.get(
            url,
            timeout=12,
            headers={"User-Agent": "Mozilla/5.0 Moodboard/1.0"},
        )
        if resp.status_code != 200:
            return []

        results: List[Dict[str, str]] = []
        rows = re.findall(
            r'<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>(.*?)</a>',
            resp.text,
            flags=re.IGNORECASE | re.DOTALL,
        )
        snippets = re.findall(
            r'<td class="result-snippet"[^>]*>(.*?)</td>',
            resp.text,
            flags=re.IGNORECASE | re.DOTALL,
        )

        for i, (href, title_html) in enumerate(rows):
            if len(results) >= limit:
                break
            title = re.sub(r"<[^>]+>", "", title_html).strip()
            snippet = ""
            if i < len(snippets):
                snippet = re.sub(r"<[^>]+>", "", snippets[i]).strip()
            link = unquote(href)
            if link.startswith("//"):
                link = "https:" + link
            if not link.startswith("http"):
                continue
            results.append({"title": title, "url": link, "snippet": snippet})
        return results
    except Exception as e:
        logger.warning(f"DuckDuckGo search failed for '{query}': {e}")
        return []


class BaseLLMProvider(ABC):
    @property
    @abstractmethod
    def provider_name(self) -> str: ...

    @property
    @abstractmethod
    def model(self) -> str: ...

    @property
    @abstractmethod
    def available(self) -> bool: ...

    @property
    def label(self) -> str:
        return f"{self.provider_name} ({self.model})"

    @abstractmethod
    async def generate_structured(
        self,
        prompt: str,
        schema: type[BaseModel],
        parts: Optional[List[ContentPart]] = None,
    ) -> Dict[str, Any]: ...

    @abstractmethod
    async def generate_tool_call(
        self,
        prompt: str,
        tools: List[Dict[str, Any]],
        system_instruction: Optional[str] = None,
    ) -> Optional[ToolCallResult]: ...

    @abstractmethod
    async def web_search(self, query: str) -> List[Dict[str, str]]: ...


_THINK_TAG_RE = re.compile(
    "<" + "think" + ">" + r"(.*?)" + "<" + "/" + "think" + ">",
    re.DOTALL | re.IGNORECASE,
)


def _extract_thinking_from_message(message: Any) -> Optional[str]:
    """Pull reasoning trace from OpenAI-compat message (Ollama, DeepSeek, etc.)."""
    parts: List[str] = []
    for attr in ("reasoning", "reasoning_content"):
        val = getattr(message, attr, None)
        if val and str(val).strip():
            parts.append(str(val).strip())
    content = message.content or ""
    if content.strip():
        m = _THINK_TAG_RE.search(content)
        if m:
            parts.append(m.group(1).strip())
        elif not getattr(message, "tool_calls", None):
            parts.append(content.strip())
    return "\n\n".join(parts) if parts else None


class OpenAICompatibleProvider(BaseLLMProvider):
    """OpenAI Chat Completions API — used for Ollama and OpenAI."""

    def __init__(self, provider_name: str, base_url: str, model: str, api_key: str):
        from openai import AsyncOpenAI

        self._provider_name = provider_name
        self._model = model
        self._client = AsyncOpenAI(base_url=base_url, api_key=api_key)

    @property
    def provider_name(self) -> str:
        return self._provider_name

    @property
    def model(self) -> str:
        return self._model

    @property
    def available(self) -> bool:
        return True

    async def generate_structured(
        self,
        prompt: str,
        schema: type[BaseModel],
        parts: Optional[List[ContentPart]] = None,
    ) -> Dict[str, Any]:
        messages = [_build_user_message(prompt, parts)]
        schema_json = schema.model_json_schema()

        try:
            response = await self._client.chat.completions.create(
                model=self._model,
                messages=messages,
                temperature=0.0,
                response_format={
                    "type": "json_schema",
                    "json_schema": {
                        "name": schema.__name__,
                        "schema": schema_json,
                        "strict": False,
                    },
                },
            )
            text = response.choices[0].message.content or "{}"
            return json.loads(text)
        except Exception as first_err:
            logger.debug(f"json_schema mode failed ({first_err}); falling back to json_object.")

        fallback_prompt = (
            f"{prompt}\n\n"
            f"Respond with valid JSON matching this schema:\n"
            f"{json.dumps(schema_json, indent=2)}"
        )
        response = await self._client.chat.completions.create(
            model=self._model,
            messages=[_build_user_message(fallback_prompt, parts)],
            temperature=0.0,
            response_format={"type": "json_object"},
        )
        text = response.choices[0].message.content or "{}"
        return json.loads(text)

    async def generate_tool_call(
        self,
        prompt: str,
        tools: List[Dict[str, Any]],
        system_instruction: Optional[str] = None,
    ) -> Optional[ToolCallResult]:
        messages: List[Dict[str, Any]] = []
        if system_instruction:
            messages.append({"role": "system", "content": system_instruction})
        messages.append({"role": "user", "content": prompt})

        response = await self._client.chat.completions.create(
            model=self._model,
            messages=messages,
            tools=tools,
            tool_choice="required",
            temperature=0.0,
            **self._tool_call_extra(),
        )
        message = response.choices[0].message
        thinking = _extract_thinking_from_message(message)

        if not message.tool_calls:
            return None

        call = message.tool_calls[0]
        args_raw = call.function.arguments or "{}"
        try:
            args = json.loads(args_raw)
        except json.JSONDecodeError:
            args = {}

        return ToolCallResult(name=call.function.name, args=args, thinking=thinking)

    def _tool_call_extra(self) -> Dict[str, Any]:
        return {}

    async def web_search(self, query: str) -> List[Dict[str, str]]:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, _duckduckgo_search, query)


class OllamaProvider(OpenAICompatibleProvider):
    def __init__(self, model: Optional[str] = None):
        base_url = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434/v1")
        model = model or os.environ.get("LLM_MODEL", "qwen3.5:9b")
        api_key = os.environ.get("OPENAI_API_KEY", "ollama")
        super().__init__("ollama", base_url, model, api_key)
        self._base_root = base_url.rstrip("/").removesuffix("/v1")

    def _tool_call_extra(self) -> Dict[str, Any]:
        # Qwen3 / DeepSeek etc. return reasoning in the `reasoning` field when think is on.
        return {"extra_body": {"think": True}}

    @property
    def available(self) -> bool:
        try:
            import requests

            resp = requests.get(f"{self._base_root}/api/tags", timeout=3)
            return resp.status_code == 200
        except Exception:
            return False


class OpenAIProvider(OpenAICompatibleProvider):
    def __init__(self, model: Optional[str] = None):
        api_key = os.environ.get("OPENAI_API_KEY", "")
        model = model or os.environ.get("LLM_MODEL", "gpt-4o-mini")
        super().__init__("openai", "https://api.openai.com/v1", model, api_key)

    @property
    def available(self) -> bool:
        return bool(os.environ.get("OPENAI_API_KEY"))


def _openai_property_to_gemini(prop: Dict[str, Any]) -> Any:
    from google.genai import types

    prop_type = (prop.get("type") or "string").upper()
    kwargs: Dict[str, Any] = {"type": prop_type}
    if "description" in prop:
        kwargs["description"] = prop["description"]
    if "enum" in prop:
        kwargs["enum"] = prop["enum"]
    return types.Schema(**kwargs)


def _openai_tools_to_gemini(tools: List[Dict[str, Any]]) -> Any:
    from google.genai import types

    declarations = []
    for tool in tools:
        fn = tool["function"]
        props = fn.get("parameters", {}).get("properties", {})
        gemini_props = {k: _openai_property_to_gemini(v) for k, v in props.items()}
        declarations.append(
            types.FunctionDeclaration(
                name=fn["name"],
                description=fn.get("description", ""),
                parameters=types.Schema(
                    type="OBJECT",
                    properties=gemini_props,
                    required=fn.get("parameters", {}).get("required", []),
                ),
            )
        )
    return types.Tool(function_declarations=declarations)


def _gemini_parts_from_content(parts: Optional[List[ContentPart]]) -> List[Any]:
    from google.genai import types

    gemini_parts: List[Any] = []
    for part in parts or []:
        if isinstance(part, str):
            gemini_parts.append(part)
        else:
            img_bytes, mime = part
            gemini_parts.append(types.Part.from_bytes(data=img_bytes, mime_type=mime))
    return gemini_parts


class GeminiProvider(BaseLLMProvider):
    def __init__(self, model: Optional[str] = None):
        from google import genai
        from google.genai import types

        self._types = types
        api_key = os.environ.get("GEMINI_API_KEY")
        self._client = genai.Client(api_key=api_key) if api_key else None
        self._model = model or os.environ.get("LLM_MODEL", "gemini-2.5-flash")
        self._thinking = types.ThinkingConfig(thinking_budget=-1)

    @property
    def provider_name(self) -> str:
        return "gemini"

    @property
    def model(self) -> str:
        return self._model

    @property
    def available(self) -> bool:
        return self._client is not None

    async def generate_structured(
        self,
        prompt: str,
        schema: type[BaseModel],
        parts: Optional[List[ContentPart]] = None,
    ) -> Dict[str, Any]:
        contents = _gemini_parts_from_content(parts)
        contents.append(prompt)
        response = await self._client.aio.models.generate_content(
            model=self._model,
            contents=contents,
            config=self._types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=schema,
                thinking_config=self._thinking,
            ),
        )
        return json.loads(response.text)

    async def generate_tool_call(
        self,
        prompt: str,
        tools: List[Dict[str, Any]],
        system_instruction: Optional[str] = None,
    ) -> Optional[ToolCallResult]:
        gemini_tools = _openai_tools_to_gemini(tools)
        response = await self._client.aio.models.generate_content(
            model=self._model,
            contents=prompt,
            config=self._types.GenerateContentConfig(
                tools=[gemini_tools],
                tool_config=self._types.ToolConfig(
                    function_calling_config=self._types.FunctionCallingConfig(mode="ANY"),
                ),
                system_instruction=system_instruction,
                thinking_config=self._types.ThinkingConfig(
                    include_thoughts=True,
                    thinking_level="high",
                ),
            ),
        )

        thinking: Optional[str] = None
        fc = None
        for cand in (response.candidates or []):
            if not (cand.content and cand.content.parts):
                continue
            for part in cand.content.parts:
                if getattr(part, "thought", False) and getattr(part, "text", None):
                    thinking = part.text.strip()
                if getattr(part, "function_call", None):
                    fc = part.function_call

        if fc is None:
            return None

        return ToolCallResult(
            name=fc.name,
            args=dict(fc.args or {}),
            thinking=thinking,
        )

    async def web_search(self, query: str) -> List[Dict[str, str]]:
        resp = await self._client.aio.models.generate_content(
            model=self._model,
            contents=(
                f"Web search request: {query}\n\n"
                "Use your search tool and return the top 5-8 results as bullet points: "
                "'TITLE — URL — one-line snippet'. No commentary."
            ),
            config=self._types.GenerateContentConfig(
                tools=[self._types.Tool(google_search=self._types.GoogleSearch())],
            ),
        )

        raw_results: List[Dict[str, str]] = []
        for cand in (resp.candidates or []):
            gm = getattr(cand, "grounding_metadata", None)
            if gm and getattr(gm, "grounding_chunks", None):
                for gc in gm.grounding_chunks:
                    web = getattr(gc, "web", None)
                    if web and getattr(web, "uri", None):
                        raw_results.append(
                            {
                                "title": getattr(web, "title", "") or "",
                                "url": web.uri,
                                "snippet": "",
                            }
                        )

        if not raw_results:
            text = (resp.text or "").strip()
            for line in text.splitlines():
                line = line.strip().lstrip("•-*").strip()
                if " — " in line and "http" in line:
                    chunks = [p.strip() for p in line.split(" — ", 2)]
                    if len(chunks) >= 2:
                        raw_results.append(
                            {
                                "title": chunks[0],
                                "url": chunks[1],
                                "snippet": chunks[2] if len(chunks) > 2 else "",
                            }
                        )
        return raw_results


class LLMRouter:
    """Routes text/reasoning calls to the main provider and image calls to vision."""

    def __init__(self, main: BaseLLMProvider, vision: BaseLLMProvider):
        self._main = main
        self._vision = vision

    @property
    def provider_name(self) -> str:
        return self._main.provider_name

    @property
    def model(self) -> str:
        return self._main.model

    @property
    def available(self) -> bool:
        return self._main.available

    @property
    def vision_available(self) -> bool:
        return self._vision.available

    @property
    def split_vision(self) -> bool:
        return self._vision is not self._main

    @property
    def label(self) -> str:
        if self._vision is self._main:
            return self._main.label
        return f"reasoning={self._main.label}, vision={self._vision.label}"

    def structured_provider(self, parts: Optional[List[ContentPart]] = None) -> BaseLLMProvider:
        if _parts_have_images(parts) and self._vision.available:
            return self._vision
        return self._main

    async def generate_structured(
        self,
        prompt: str,
        schema: type[BaseModel],
        parts: Optional[List[ContentPart]] = None,
    ) -> Dict[str, Any]:
        provider = self.structured_provider(parts)
        if not provider.available:
            raise RuntimeError(f"LLM unavailable for structured output ({provider.label})")
        if provider is not self._main:
            logger.info(f"Vision route → {provider.label}")
        return await provider.generate_structured(prompt, schema, parts=parts)

    async def generate_tool_call(
        self,
        prompt: str,
        tools: List[Dict[str, Any]],
        system_instruction: Optional[str] = None,
    ) -> Optional[ToolCallResult]:
        return await self._main.generate_tool_call(prompt, tools, system_instruction)

    async def web_search(self, query: str) -> List[Dict[str, str]]:
        # Gemini Google Search only when explicitly requested (uses API credits).
        if search_provider() == "gemini":
            if self._vision.provider_name == "gemini" and self._vision.available:
                return await self._vision.web_search(query)
            gemini = _build_provider("gemini")
            if gemini.available:
                return await gemini.web_search(query)
        return await self._main.web_search(query)


def search_provider() -> str:
    """main=DDG via reasoning LLM; chrome=extension Google tab; gemini=Google Search API."""
    name = os.environ.get("SEARCH_PROVIDER", "main").strip().lower()
    if name in ("main", "ddg", "duckduckgo"):
        return "main"
    if name in ("chrome", "gemini"):
        return name
    return "main"


_provider: Optional[LLMRouter] = None


def get_llm_provider() -> LLMRouter:
    global _provider
    if _provider is None:
        _provider = _build_router()
    return _provider


def _build_provider(name: str, model: Optional[str] = None) -> BaseLLMProvider:
    provider = name.strip().lower()
    if provider == "gemini":
        return GeminiProvider(model=model)
    if provider == "openai":
        return OpenAIProvider(model=model)
    if provider == "cursor":
        from cursor_provider import CursorProvider

        return CursorProvider(model=model)
    return OllamaProvider(model=model)


def _build_router() -> LLMRouter:
    main_name = os.environ.get("LLM_PROVIDER", "ollama")
    main_model = os.environ.get("LLM_MODEL")
    vision_name = os.environ.get("LLM_VISION_PROVIDER", main_name)
    vision_model = os.environ.get("LLM_VISION_MODEL")
    if vision_model is None and vision_name.strip().lower() == "gemini":
        vision_model = "gemini-2.5-flash"
    if vision_model is None and vision_name.strip().lower() == "cursor":
        vision_model = "composer-2.5"

    main = _build_provider(main_name, main_model)
    same_stack = (
        vision_name.strip().lower() == main_name.strip().lower()
        and (vision_model or None) == (main_model or None)
    )
    vision = main if same_stack else _build_provider(vision_name, vision_model)

    if vision is not main:
        logger.info(f"Hybrid LLM: {main.label} + vision {vision.label}")
    else:
        logger.info(f"LLM: {main.label}")

    return LLMRouter(main, vision)
