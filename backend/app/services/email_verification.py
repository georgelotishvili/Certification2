"""
Email verification service.
Generates 4-digit codes and stores them temporarily for verification.
In development mode (EMAIL_MODE=console), codes are printed to console.
In production (EMAIL_MODE=smtp), codes are sent via email.
"""
from __future__ import annotations

import hmac
import secrets
import time
from threading import RLock
from typing import Dict, Optional, Tuple
from ..config import get_settings

# In-memory storage for verification codes
# Structure: {email: {"code": "1234", "expires_at": timestamp, "purpose": "register|update|password_reset"}}
_verification_codes: Dict[str, dict] = {}

# In-memory storage for verification attempts (brute force protection).
# Attempts are isolated by email and purpose so one verification flow cannot
# lock a different flow for the same address.
# Structure: {(email, purpose): {"count": int, "locked_until": timestamp or None}}
_verification_attempts: Dict[Tuple[str, str], dict] = {}
_verification_lock = RLock()

VALID_VERIFICATION_PURPOSES = frozenset(
    {"register", "update", "password_reset"}
)
_ANY_PURPOSE = "*"
_INVALID_PURPOSE = "__invalid__"

# Code expires after 5 minutes
CODE_EXPIRY_SECONDS = 300

# Maximum verification attempts before lockout
MAX_VERIFICATION_ATTEMPTS = 5
LOCKOUT_DURATION_SECONDS = 900  # 15 minutes


def _generate_code() -> str:
    """Generate a cryptographically secure 4-digit code."""
    return str(1000 + secrets.randbelow(9000))


def _normalize_purpose(purpose: Optional[str]) -> str:
    if purpose is None:
        return _ANY_PURPOSE
    normalized = purpose.strip().lower()
    if normalized in VALID_VERIFICATION_PURPOSES:
        return normalized
    return _INVALID_PURPOSE


def _attempt_key(email: str, purpose: Optional[str]) -> Tuple[str, str]:
    return (email.strip().lower(), _normalize_purpose(purpose))


def _constant_time_equal(left: str, right: str) -> bool:
    return hmac.compare_digest(left.encode("utf-8"), right.encode("utf-8"))


def _raise_locked(locked_until: float) -> None:
    from fastapi import HTTPException, status

    remaining = max(0, int(locked_until - time.time()))
    raise HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail=f"ძალიან ბევრი მცდელობა. სცადეთ {remaining // 60 + 1} წუთის შემდეგ",
    )


def _record_failed_attempt_locked(key: Tuple[str, str]) -> None:
    attempts = _verification_attempts.get(key, {"count": 0, "locked_until": None})
    new_count = attempts.get("count", 0) + 1
    locked_until = None
    if new_count >= MAX_VERIFICATION_ATTEMPTS:
        locked_until = time.time() + LOCKOUT_DURATION_SECONDS

    _verification_attempts[key] = {
        "count": new_count,
        "locked_until": locked_until,
    }
    if locked_until:
        _raise_locked(locked_until)


def _cleanup_expired_locked() -> None:
    """Remove expired state while ``_verification_lock`` is held."""
    now = time.time()
    expired = [email for email, data in _verification_codes.items() if data["expires_at"] < now]
    for email in expired:
        del _verification_codes[email]
    
    # Clean up expired lockouts
    expired_lockouts = [
        key for key, data in _verification_attempts.items()
        if data.get("locked_until") and data["locked_until"] < now
    ]
    for key in expired_lockouts:
        _verification_attempts[key] = {"count": 0, "locked_until": None}


def _cleanup_expired() -> None:
    """Thread-safe cleanup entry point retained for existing callers/tests."""
    with _verification_lock:
        _cleanup_expired_locked()


def _is_smtp_mode(settings) -> bool:
    email_mode = (getattr(settings, "email_mode", "") or "").strip().lower()
    mail_mailer = (getattr(settings, "mail_mailer", "") or "").strip().lower()
    return email_mode == "smtp" or mail_mailer == "smtp"


def _is_console_mode(settings) -> bool:
    """Return True only for the explicitly configured development mode."""
    email_mode = (getattr(settings, "email_mode", "") or "").strip().lower()
    mail_mailer = (getattr(settings, "mail_mailer", "") or "").strip().lower()
    return email_mode == "console" or mail_mailer == "console"


def _get_smtp_config(settings) -> dict:
    smtp_host = getattr(settings, "smtp_host", None) or getattr(settings, "mail_host", None)
    smtp_port = getattr(settings, "smtp_port", None) or getattr(settings, "mail_port", None) or 587
    smtp_user = getattr(settings, "smtp_user", None) or getattr(settings, "mail_username", None)
    smtp_password = getattr(settings, "smtp_password", None) or getattr(settings, "mail_password", None)
    smtp_encryption = (
        getattr(settings, "smtp_encryption", None)
        or getattr(settings, "mail_encryption", None)
        or ("ssl" if int(smtp_port) == 465 else "tls")
    )
    from_address = getattr(settings, "mail_from_address", None) or smtp_user
    raw_from_name = str(getattr(settings, "mail_from_name", None) or "").strip()
    if not raw_from_name or raw_from_name in ("${APP_NAME}", "Exam Backend"):
        from_name = "GIPC"
    else:
        from_name = raw_from_name

    return {
        "host": smtp_host,
        "port": int(smtp_port),
        "user": smtp_user,
        "password": smtp_password,
        "encryption": str(smtp_encryption or "").strip().lower(),
        "from_address": from_address,
        "from_name": from_name,
    }


def _send_smtp_message(to_email: str, subject: str, body: str) -> bool:
    settings = get_settings()
    config = _get_smtp_config(settings)
    if not config["host"] or not config["user"] or not config["password"]:
        return False

    try:
        import smtplib
        from email.mime.text import MIMEText
        from email.mime.multipart import MIMEMultipart
        from email.utils import formataddr

        msg = MIMEMultipart()
        msg["From"] = formataddr((config["from_name"], config["from_address"] or config["user"]))
        msg["To"] = to_email
        msg["Subject"] = subject
        msg.attach(MIMEText(body, "plain", "utf-8"))

        server = None
        try:
            if config["encryption"] == "ssl" or config["port"] == 465:
                server = smtplib.SMTP_SSL(config["host"], config["port"], timeout=20)
            else:
                server = smtplib.SMTP(config["host"], config["port"], timeout=20)
                if config["encryption"] != "none":
                    server.starttls()
            server.login(config["user"], config["password"])
            server.send_message(msg)
        finally:
            if server is not None:
                try:
                    server.quit()
                except Exception:
                    pass
        return True
    except Exception as e:
        print(f"Failed to send email via SMTP: {e}")
        return False


def _emit_console_code(email: str, purpose: str, code: str) -> None:
    """Print a code only in the explicitly selected development mode."""
    try:
        print(f"\n{'='*50}")
        print(f"VERIFICATION CODE for {email}")
        print(f"   Purpose: {purpose}")
        print(f"   Code: {code}")
        print(f"   Expires in: {CODE_EXPIRY_SECONDS // 60} minutes")
        print(f"{'='*50}\n")
    except Exception:
        pass


def send_verification_code(email: str, purpose: str = "register") -> str:
    """
    Generate and 'send' a verification code.
    
    Args:
        email: The email address to send the code to
        purpose: Either 'register', 'update', or 'password_reset'
    
    Returns:
        The generated code (for testing/development)
    """
    _cleanup_expired()
    
    email_lower = email.strip().lower()
    code = _generate_code()
    normalized_purpose = _normalize_purpose(purpose)
    
    subject = "GIPC - ვერიფიკაციის კოდი"
    body = f"""გამარჯობა!

თქვენი ვერიფიკაციის კოდია: {code}

კოდი მოქმედებს {CODE_EXPIRY_SECONDS // 60} წუთის განმავლობაში.

პატივისცემით,
საქართველოს პროფესიული სერტიფიცირების ინსტიტუტი (GIPC)
https://gipc.org.ge
"""

    settings = get_settings()
    if _is_smtp_mode(settings):
        if not _send_smtp_message(email_lower, subject, body):
            # Never expose a production code through the development fallback.
            raise RuntimeError("Failed to send verification email")
    elif _is_console_mode(settings):
        _emit_console_code(email_lower, purpose, code)
    else:
        raise RuntimeError("EMAIL_MODE must be either 'smtp' or 'console'")

    # Store the code only after its configured delivery path succeeds. A failed
    # SMTP resend therefore leaves any previously delivered code intact.
    with _verification_lock:
        _cleanup_expired_locked()
        _verification_codes[email_lower] = {
            "code": code,
            "expires_at": time.time() + CODE_EXPIRY_SECONDS,
            "purpose": normalized_purpose,
        }

    return code


def verify_code(
    email: str,
    code: str,
    purpose: Optional[str] = None,
    *,
    consume: bool = True,
) -> bool:
    """Validate a code, enforcing a per-email-and-purpose attempt lockout.

    Consuming verification remains the default for registration, profile
    updates, and password resets. The public pre-check endpoint uses
    ``consume=False`` so its existing response contract remains unchanged,
    while failed pre-checks now count toward the same lockout.
    """
    email_lower = email.strip().lower()
    normalized_purpose = _normalize_purpose(purpose)
    attempt_key = _attempt_key(email_lower, normalized_purpose)
    with _verification_lock:
        _cleanup_expired_locked()
        attempts = _verification_attempts.get(
            attempt_key,
            {"count": 0, "locked_until": None},
        )
        locked_until = attempts.get("locked_until")
        if locked_until and locked_until > time.time():
            _raise_locked(locked_until)

        stored = _verification_codes.get(email_lower)
        candidate_code = str(code or "").strip()
        stored_code = str(stored.get("code", "")) if stored else ""
        stored_purpose = _normalize_purpose(stored.get("purpose")) if stored else ""

        # Compare user-controlled values with constant-time comparisons. Unknown
        # purposes always fail and share one bounded attempt bucket.
        code_matches = _constant_time_equal(stored_code, candidate_code)
        purpose_matches = purpose is None or (
            normalized_purpose != _INVALID_PURPOSE
            and _constant_time_equal(stored_purpose, normalized_purpose)
        )
        if not stored or not code_matches or not purpose_matches:
            _record_failed_attempt_locked(attempt_key)
            return False

        if consume:
            del _verification_codes[email_lower]
        _verification_attempts[attempt_key] = {"count": 0, "locked_until": None}
        return True


def has_pending_code(email: str) -> bool:
    """Check if there's an unexpired code for this email."""
    email_lower = email.strip().lower()
    with _verification_lock:
        _cleanup_expired_locked()
        return email_lower in _verification_codes


def get_remaining_time(email: str) -> int:
    """Get remaining seconds until code expires. Returns 0 if no code exists."""
    email_lower = email.strip().lower()
    with _verification_lock:
        _cleanup_expired_locked()
        stored = _verification_codes.get(email_lower)
        if not stored:
            return 0
        remaining = int(stored["expires_at"] - time.time())
        return max(0, remaining)
