from __future__ import annotations

import hashlib
import hmac


def sign_payload(payload: str, secret: str) -> str:
    """Generate HMAC-SHA256 signature for a payload."""
    return hmac.new(
        secret.encode(),
        payload.encode(),
        hashlib.sha256,
    ).hexdigest()


def verify_signature(payload: str, signature: str, secret: str) -> bool:
    """Verify HMAC-SHA256 signature using constant-time comparison."""
    expected = sign_payload(payload, secret)
    return hmac.compare_digest(expected, signature)
