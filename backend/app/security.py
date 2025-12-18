from __future__ import annotations

import secrets
from passlib.context import CryptContext


_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_code(plain: str) -> str:
    return _pwd_context.hash(plain)


def verify_code(plain: str, hashed: str) -> bool:
    try:
        return _pwd_context.verify(plain, hashed)
    except Exception:
        return False


def generate_session_token() -> str:
    return secrets.token_urlsafe(32)


