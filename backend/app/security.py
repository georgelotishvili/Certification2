from __future__ import annotations

import secrets
from datetime import datetime, timedelta
from typing import Optional

from fastapi import Depends, HTTPException, status, Header
from passlib.context import CryptContext
from sqlalchemy import select
from sqlalchemy.orm import Session

from .database import get_db
from .models import User, UserSession
from .config import get_settings


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


def generate_secure_password() -> str:
    """Generate a secure random password that meets validation requirements."""
    import string
    # Generate password with: uppercase, lowercase, digits, and special chars
    uppercase = string.ascii_uppercase
    lowercase = string.ascii_lowercase
    digits = string.digits
    special = "!@#$%^&*"
    
    # Ensure at least one of each required type
    password_chars = [
        secrets.choice(uppercase),
        secrets.choice(lowercase),
        secrets.choice(digits),
        secrets.choice(special),
    ]
    
    # Fill the rest with random characters (total 12 characters)
    all_chars = uppercase + lowercase + digits + special
    password_chars.extend(secrets.choice(all_chars) for _ in range(8))
    
    # Shuffle to avoid predictable pattern
    secrets.SystemRandom().shuffle(password_chars)
    
    return ''.join(password_chars)


def validate_password_strength(password: str) -> None:
    """
    Validate password strength.
    Requirements:
    - Minimum 8 characters
    - At least one uppercase letter (Latin or Georgian)
    - At least one lowercase letter (Latin or Georgian)
    - At least one digit
    """
    import re
    
    if len(password) < 8:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="პაროლი უნდა იყოს მინიმუმ 8 სიმბოლო"
        )
    
    # Check for uppercase (Latin A-Z or Georgian uppercase)
    if not re.search(r'[A-Zა-ჰ]', password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="პაროლი უნდა შეიცავდეს მინიმუმ ერთ დიდ ასოს"
        )
    
    # Check for lowercase (Latin a-z or Georgian lowercase)
    if not re.search(r'[a-zა-ჰ]', password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="პაროლი უნდა შეიცავდეს მინიმუმ ერთ პატარა ასოს"
        )
    
    # Check for digit
    if not re.search(r'\d', password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="პაროლი უნდა შეიცავდეს მინიმუმ ერთ რიცხვს"
        )


def get_current_user(
    authorization: Optional[str] = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
) -> User:
    """
    Get current authenticated user from Bearer token.
    
    Only accepts Bearer tokens for security.
    x-actor-email header is no longer accepted.
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Bearer token required"
        )
    
    token = authorization.split(" ", 1)[1]
    session = db.scalar(
        select(UserSession).where(
            UserSession.token == token,
            UserSession.expires_at > datetime.utcnow()
        )
    )
    
    if not session:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token"
        )
    
    user = db.get(User, session.user_id)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found"
        )
    
    # Update last_used_at
    session.last_used_at = datetime.utcnow()
    db.commit()
    
    return user


def require_auth(
    authorization: Optional[str] = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
) -> User:
    """
    Require Bearer token authentication (no fallback to x-actor-email).
    Use this for new secure endpoints.
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Bearer token required"
        )
    
    token = authorization.split(" ", 1)[1]
    session = db.scalar(
        select(UserSession).where(
            UserSession.token == token,
            UserSession.expires_at > datetime.utcnow()
        )
    )
    
    if not session:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token"
        )
    
    user = db.get(User, session.user_id)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found"
        )
    
    # Update last_used_at
    session.last_used_at = datetime.utcnow()
    db.commit()
    
    return user


def is_founder(user: User) -> bool:
    """Check if user is the founder (main admin)."""
    settings = get_settings()
    founder_email = (settings.founder_admin_email or "").lower()
    return user.email.lower() == founder_email


def is_admin_or_founder(user: User) -> bool:
    """Check if user is admin or founder."""
    return bool(user.is_admin) or is_founder(user)


def require_admin(
    authorization: Optional[str] = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
) -> User:
    """
    Require admin or founder access via Bearer token.
    Returns the authenticated admin user.
    """
    user = require_auth(authorization=authorization, db=db)
    
    if not is_admin_or_founder(user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required"
        )
    
    return user


def require_founder(
    authorization: Optional[str] = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
) -> User:
    """
    Require founder (main admin) access via Bearer token.
    Returns the authenticated founder user.
    """
    user = require_auth(authorization=authorization, db=db)
    
    if not is_founder(user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Founder access required"
        )
    
    return user


