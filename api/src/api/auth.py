"""Authentication dependency — validates BetterAuth session cookie."""

from datetime import UTC, datetime

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_session
from src.models.auth import AuthSession, AuthUser

COOKIE_NAME = "better-auth.session_token"
SECURE_COOKIE_NAME = f"__Secure-{COOKIE_NAME}"


async def get_current_user(
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> AuthUser:
    raw = request.cookies.get(COOKIE_NAME) or request.cookies.get(SECURE_COOKIE_NAME)
    if not raw:
        raise HTTPException(status_code=401, detail="Not authenticated")

    # BetterAuth cookie format is "token.signature" — extract just the token
    token = raw.split(".")[0] if "." in raw else raw

    result = await session.execute(
        select(AuthUser)
        .join(AuthSession, AuthSession.user_id == AuthUser.id)
        .where(
            AuthSession.token == token,
            AuthSession.expires_at > datetime.now(UTC),
        )
    )
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=401, detail="Invalid or expired session")

    return user
