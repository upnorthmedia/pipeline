"""Tests for crypto service."""

from unittest.mock import patch

import pytest
from cryptography.fernet import Fernet


def _gen_key():
    return Fernet.generate_key().decode()


@pytest.fixture(autouse=True)
def _set_encryption_key():
    key = _gen_key()
    with patch("src.services.crypto.settings") as mock_settings:
        mock_settings.wp_encryption_key = key
        yield


def test_encrypt_decrypt_roundtrip():
    from src.services.crypto import decrypt, encrypt

    plaintext = "my-secret-app-password-1234"
    cipher = encrypt(plaintext)
    assert cipher != plaintext
    assert decrypt(cipher) == plaintext


def test_encrypt_produces_different_ciphertexts():
    from src.services.crypto import encrypt

    a = encrypt("same-password")
    b = encrypt("same-password")
    # Fernet uses random IV, so ciphertexts should differ
    assert a != b


def test_decrypt_wrong_key_fails():
    from src.services.crypto import encrypt

    cipher = encrypt("test-password")

    # Use a different key for decryption
    other_key = _gen_key()
    with patch("src.services.crypto.settings") as mock_settings:
        mock_settings.wp_encryption_key = other_key
        from src.services.crypto import decrypt

        with pytest.raises(Exception):
            decrypt(cipher)


def test_missing_key_raises():
    with patch("src.services.crypto.settings") as mock_settings:
        mock_settings.wp_encryption_key = ""
        from src.services.crypto import encrypt

        with pytest.raises(ValueError, match="WP_ENCRYPTION_KEY not set"):
            encrypt("test")
