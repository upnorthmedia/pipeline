"""Next.js integration endpoints (test connection, publish webhook)."""

from __future__ import annotations

import json
import logging
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from src.api.auth import get_current_user
from src.database import get_session
from src.models.auth import AuthUser
from src.models.profile import WebsiteProfile
from src.services.crypto import decrypt
from src.services.hmac_signing import sign_payload

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/profiles", tags=["nextjs"])


async def _get_user_profile(
    profile_id: uuid.UUID,
    user: AuthUser,
    session: AsyncSession,
) -> WebsiteProfile:
    profile = await session.get(WebsiteProfile, profile_id)
    if not profile or profile.user_id != user.id:
        raise HTTPException(status_code=404, detail="Profile not found")
    return profile


@router.post("/{profile_id}/nextjs/test")
async def test_nextjs_connection(
    profile_id: uuid.UUID,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Send a test webhook to verify the Next.js connection."""
    profile = await _get_user_profile(profile_id, user, session)

    if not profile.nextjs_webhook_url or not profile.nextjs_webhook_secret:
        return {"connected": False, "error": "Webhook URL or secret not configured"}

    try:
        secret = decrypt(profile.nextjs_webhook_secret)
    except Exception:
        return {"connected": False, "error": "Failed to decrypt webhook secret"}

    import httpx

    payload = json.dumps(
        {
            "event": "test",
            "timestamp": datetime.now(UTC).isoformat(),
        }
    )
    signature = sign_payload(payload, secret)

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                profile.nextjs_webhook_url,
                content=payload,
                headers={
                    "Content-Type": "application/json",
                    "X-Jena-Signature": signature,
                },
            )
        if response.status_code == 200:
            return {"connected": True}
        return {
            "connected": False,
            "error": f"Webhook returned {response.status_code}",
        }
    except httpx.RequestError as exc:
        return {"connected": False, "error": str(exc)}
