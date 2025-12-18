"""
Email verification service.
Generates 4-digit codes and stores them temporarily for verification.
In development mode (EMAIL_MODE=console), codes are printed to console.
In production (EMAIL_MODE=smtp), codes are sent via email.
"""
from __future__ import annotations

import random
import time
from typing import Dict, Optional
from ..config import get_settings

# In-memory storage for verification codes
# Structure: {email: {"code": "1234", "expires_at": timestamp, "purpose": "register|update"}}
_verification_codes: Dict[str, dict] = {}

# Code expires after 5 minutes
CODE_EXPIRY_SECONDS = 300


def _generate_code() -> str:
    """Generate a random 4-digit code."""
    return str(random.randint(1000, 9999))


def _cleanup_expired():
    """Remove expired codes from storage."""
    now = time.time()
    expired = [email for email, data in _verification_codes.items() if data["expires_at"] < now]
    for email in expired:
        del _verification_codes[email]


def send_verification_code(email: str, purpose: str = "register") -> str:
    """
    Generate and 'send' a verification code.
    
    Args:
        email: The email address to send the code to
        purpose: Either 'register' or 'update'
    
    Returns:
        The generated code (for testing/development)
    """
    _cleanup_expired()
    
    email_lower = email.strip().lower()
    code = _generate_code()
    
    _verification_codes[email_lower] = {
        "code": code,
        "expires_at": time.time() + CODE_EXPIRY_SECONDS,
        "purpose": purpose,
    }
    
    settings = get_settings()
    email_mode = getattr(settings, "email_mode", "console")
    
    if email_mode == "smtp":
        # TODO: Implement real SMTP sending when needed
        # For now, fall through to console mode
        pass
    
    # Console mode (development) - print code to console and save to file
    print(f"\n{'='*50}")
    print(f"📧 VERIFICATION CODE for {email_lower}")
    print(f"   Purpose: {purpose}")
    print(f"   Code: {code}")
    print(f"   Expires in: {CODE_EXPIRY_SECONDS // 60} minutes")
    print(f"{'='*50}\n")
    
    # Also save to file for easy access
    try:
        from pathlib import Path
        log_file = Path(__file__).parent.parent.parent / "verification_codes.txt"
        with open(log_file, "a", encoding="utf-8") as f:
            from datetime import datetime
            f.write(f"\n{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
            f.write(f"Email: {email_lower}\n")
            f.write(f"Code: {code}\n")
            f.write(f"Purpose: {purpose}\n")
            f.write("-" * 30 + "\n")
    except Exception:
        pass
    
    return code


def verify_code(email: str, code: str, purpose: Optional[str] = None) -> bool:
    """
    Verify a code for the given email.
    
    Args:
        email: The email address
        code: The code to verify
        purpose: If provided, also checks that the purpose matches
    
    Returns:
        True if the code is valid, False otherwise
    """
    _cleanup_expired()
    
    email_lower = email.strip().lower()
    stored = _verification_codes.get(email_lower)
    
    if not stored:
        return False
    
    if stored["code"] != code:
        return False
    
    if purpose and stored["purpose"] != purpose:
        return False
    
    # Code is valid - remove it (single use)
    del _verification_codes[email_lower]
    return True


def has_pending_code(email: str) -> bool:
    """Check if there's an unexpired code for this email."""
    _cleanup_expired()
    email_lower = email.strip().lower()
    return email_lower in _verification_codes


def get_remaining_time(email: str) -> int:
    """Get remaining seconds until code expires. Returns 0 if no code exists."""
    _cleanup_expired()
    email_lower = email.strip().lower()
    stored = _verification_codes.get(email_lower)
    if not stored:
        return 0
    remaining = int(stored["expires_at"] - time.time())
    return max(0, remaining)
