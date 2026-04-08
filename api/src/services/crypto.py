from __future__ import annotations

from cryptography.fernet import Fernet

from src.config import settings


def _get_fernet() -> Fernet:
    key = settings.wp_encryption_key
    if not key:
        msg = (
            "WP_ENCRYPTION_KEY not set. Generate one with: "
            "python -c 'from cryptography.fernet import Fernet; "
            "print(Fernet.generate_key().decode())'"
        )
        raise ValueError(msg)
    return Fernet(key.encode() if isinstance(key, str) else key)


def encrypt(plaintext: str) -> str:
    return _get_fernet().encrypt(plaintext.encode()).decode()


def decrypt(ciphertext: str) -> str:
    return _get_fernet().decrypt(ciphertext.encode()).decode()
