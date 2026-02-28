import asyncio
import logging
from dataclasses import dataclass

import anthropic
import httpx
from google import genai
from google.genai import types as genai_types

from src.config import settings

logger = logging.getLogger(__name__)

MAX_RETRIES = 3
BASE_DELAY = 1.0


def _is_retryable(exc: Exception) -> bool:
    """Return True if the error is transient and worth retrying."""
    # httpx HTTP status errors
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        return code == 429 or code >= 500
    # Anthropic API errors
    if isinstance(exc, anthropic.APIStatusError):
        return exc.status_code == 429 or exc.status_code >= 500
    # Network-level errors (timeout, connection refused, etc.)
    if isinstance(exc, (httpx.TimeoutException, httpx.ConnectError)):
        return True
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError, ConnectionError, OSError)):
        return True
    return False


def _retry_after(exc: Exception) -> float | None:
    """Extract Retry-After header value (seconds) if present."""
    headers = None
    if isinstance(exc, httpx.HTTPStatusError):
        headers = exc.response.headers
    elif isinstance(exc, anthropic.APIStatusError) and hasattr(exc, "response"):
        headers = exc.response.headers
    if headers:
        val = headers.get("retry-after")
        if val:
            try:
                return float(val)
            except ValueError:
                pass
    return None


async def _retry(fn, retries: int = MAX_RETRIES, base_delay: float = BASE_DELAY):
    """Retry an async function with exponential backoff on transient errors only."""
    for attempt in range(retries):
        try:
            return await fn()
        except Exception as e:
            if attempt == retries - 1 or not _is_retryable(e):
                raise
            retry_delay = _retry_after(e)
            delay = (
                retry_delay if retry_delay is not None else base_delay * (2**attempt)
            )
            logger.warning(
                f"Attempt {attempt + 1} failed ({type(e).__name__}): {e}. "
                f"Retrying in {delay}s..."
            )
            await asyncio.sleep(delay)


@dataclass
class LLMResponse:
    content: str
    model: str
    tokens_in: int
    tokens_out: int


class PerplexityClient:
    """Perplexity API client using their OpenAI-compatible endpoint."""

    BASE_URL = "https://api.perplexity.ai"

    def __init__(self, api_key: str | None = None):
        self.api_key = api_key or settings.perplexity_api_key
        self._client = httpx.AsyncClient(
            base_url=self.BASE_URL,
            headers={"Authorization": f"Bearer {self.api_key}"},
            timeout=120.0,
        )

    async def chat(
        self,
        prompt: str,
        model: str = "sonar-pro",
        system: str | None = None,
    ) -> LLMResponse:
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        async def _call():
            response = await self._client.post(
                "/chat/completions",
                json={"model": model, "messages": messages},
            )
            response.raise_for_status()
            data = response.json()
            usage = data.get("usage", {})
            return LLMResponse(
                content=data["choices"][0]["message"]["content"],
                model=model,
                tokens_in=usage.get("prompt_tokens", 0),
                tokens_out=usage.get("completion_tokens", 0),
            )

        return await _retry(_call)

    async def close(self):
        await self._client.aclose()


class ClaudeClient:
    """Anthropic Claude API client."""

    def __init__(self, api_key: str | None = None):
        self.api_key = api_key or settings.anthropic_api_key
        self._client = anthropic.AsyncAnthropic(
            api_key=self.api_key,
            timeout=httpx.Timeout(300.0),
        )

    async def chat(
        self,
        prompt: str,
        model: str = "claude-opus-4-6",
        system: str | None = None,
        max_tokens: int = 16000,
        thinking_budget: int = 10000,
    ) -> LLMResponse:
        async def _call():
            # Ensure max_tokens > thinking budget (API requirement)
            effective_max = max(max_tokens, thinking_budget + 1024)
            kwargs: dict = {
                "model": model,
                "max_tokens": effective_max,
                "messages": [{"role": "user", "content": prompt}],
                "thinking": {
                    "type": "enabled",
                    "budget_tokens": thinking_budget,
                },
            }
            if system:
                kwargs["system"] = system
            response = await self._client.messages.create(**kwargs)

            # Extract text content (skip thinking blocks)
            text_parts = [
                block.text for block in response.content if block.type == "text"
            ]
            content = "\n".join(text_parts)

            return LLMResponse(
                content=content,
                model=model,
                tokens_in=response.usage.input_tokens,
                tokens_out=response.usage.output_tokens,
            )

        return await _retry(_call)

    async def close(self):
        await self._client.close()


class GeminiClient:
    """Google Gemini API client for image generation."""

    def __init__(self, api_key: str | None = None):
        self.api_key = api_key or settings.gemini_api_key
        self._client = genai.Client(api_key=self.api_key)

    async def generate_image(
        self,
        prompt: str,
        model: str = "gemini-3.1-flash-image-preview",
        aspect_ratio: str = "4:3",
        image_size: str = "1K",
    ) -> bytes:
        """Generate an image and return PNG bytes."""

        async def _call():
            config = genai_types.GenerateContentConfig(
                response_modalities=["IMAGE"],
                image_config=genai_types.ImageConfig(
                    aspect_ratio=aspect_ratio,
                    image_size=image_size,
                ),
            )
            # genai client is sync, run in thread with 180s timeout
            loop = asyncio.get_event_loop()
            response = await asyncio.wait_for(
                loop.run_in_executor(
                    None,
                    lambda: self._client.models.generate_content(
                        model=model, contents=prompt, config=config
                    ),
                ),
                timeout=180.0,
            )

            if not response.parts:
                raise RuntimeError(
                    "Empty response from Gemini (possible safety filter)"
                )

            for part in response.parts:
                if part.inline_data:
                    return part.inline_data.data

            raise RuntimeError("No image returned in Gemini response")

        return await _retry(_call)
