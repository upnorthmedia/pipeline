from __future__ import annotations

import json

from src.services.hmac_signing import sign_payload, verify_signature


def test_sign_and_verify_roundtrip():
    secret = "test-secret-key-12345"
    payload = json.dumps({"event": "post.published", "slug": "test"})
    signature = sign_payload(payload, secret)
    assert verify_signature(payload, signature, secret)


def test_invalid_signature_rejected():
    secret = "test-secret-key-12345"
    payload = json.dumps({"event": "post.published", "slug": "test"})
    assert not verify_signature(payload, "invalid-signature", secret)


def test_tampered_payload_rejected():
    secret = "test-secret-key-12345"
    payload = json.dumps({"event": "post.published", "slug": "test"})
    signature = sign_payload(payload, secret)
    tampered = json.dumps({"event": "post.published", "slug": "hacked"})
    assert not verify_signature(tampered, signature, secret)


def test_wrong_secret_rejected():
    payload = json.dumps({"event": "post.published", "slug": "test"})
    signature = sign_payload(payload, "correct-secret")
    assert not verify_signature(payload, signature, "wrong-secret")
