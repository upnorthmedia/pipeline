"""Live API key validation — lightweight test calls per provider."""

from __future__ import annotations

import logging

import anthropic
import httpx
from google import genai

logger = logging.getLogger(__name__)


async def validate_anthropic(api_key: str) -> tuple[bool, str | None]:
    """Validate Anthropic key with a minimal API call."""
    if not api_key:
        return False, "No key provided"
    try:
        client = anthropic.AsyncAnthropic(api_key=api_key)
        await client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=1,
            messages=[{"role": "user", "content": "hi"}],
        )
        return True, None
    except anthropic.AuthenticationError:
        return False, "Invalid API key"
    except Exception as e:
        return False, str(e)


async def validate_perplexity(api_key: str) -> tuple[bool, str | None]:
    """Validate Perplexity key with a minimal API call."""
    if not api_key:
        return False, "No key provided"
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                "https://api.perplexity.ai/chat/completions",
                headers={"Authorization": f"Bearer {api_key}"},
                json={
                    "model": "sonar",
                    "max_tokens": 1,
                    "messages": [{"role": "user", "content": "hi"}],
                },
            )
            if resp.status_code == 401:
                return False, "Invalid API key"
            if resp.status_code == 200:
                return True, None
            return False, f"Unexpected status {resp.status_code}"
    except Exception as e:
        return False, str(e)


async def validate_gemini(api_key: str) -> tuple[bool, str | None]:
    """Validate Gemini key with a lightweight metadata call."""
    if not api_key:
        return False, "No key provided"
    try:
        client = genai.Client(api_key=api_key)
        # List models is a metadata-only call, no token cost
        list(client.models.list())
        return True, None
    except Exception as e:
        err = str(e)
        if "401" in err or "API_KEY_INVALID" in err or "PERMISSION_DENIED" in err:
            return False, "Invalid API key"
        return False, err


VALIDATORS = {
    "anthropic": validate_anthropic,
    "perplexity": validate_perplexity,
    "gemini": validate_gemini,
}


async def validate_keys(
    keys: dict[str, str],
) -> dict[str, tuple[bool, str | None]]:
    """Validate multiple keys, returning results per provider."""
    results: dict[str, tuple[bool, str | None]] = {}
    for provider, key in keys.items():
        if provider in VALIDATORS and key:
            results[provider] = await VALIDATORS[provider](key)
    return results
