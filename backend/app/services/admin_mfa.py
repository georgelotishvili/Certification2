"""Session-bound administrative TOTP elevation, isolated from exam state.

Secrets are encrypted with a separately provisioned Fernet key. Recovery codes
are random 96-bit values and only digests are stored. All credential mutations
take the SQLite writer lock before reading state, so concurrent consumers cannot
reuse an OTP/recovery code. No credential, code or token is an audit detail.
"""
from __future__ import annotations

import calendar
import hashlib
import json
import math
from pathlib import Path
import re
import secrets
from datetime import datetime, timedelta

from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException
import pyotp
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import (
    AdminMfaCredential, AdminMfaElevation, AdminMfaPending,
    AdminMfaRecoveryCode, AuditEvent, User, UserSession,
)

ISSUER = "GIPC"
ELEVATION_LIFETIME = timedelta(hours=8)
IDLE_LIFETIME = timedelta(minutes=30)
PENDING_LIFETIME = timedelta(minutes=10)
FAILURE_WINDOW = timedelta(minutes=10)
LOCKOUT_DURATION = timedelta(minutes=15)
MAX_FAILURES = 5
RECOVERY_COUNT = 10
NO_STORE = {"Cache-Control": "no-store", "Pragma": "no-cache"}


def _now() -> datetime:
    return datetime.utcnow()


def _error(status: int, code: str, message: str, **headers):
    raise HTTPException(status_code=status, detail={"code": code, "message": message},
                        headers={**NO_STORE, **headers})


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _fernet() -> Fernet:
    settings = get_settings()
    key = getattr(settings, "admin_mfa_encryption_key", None)
    try:
        if not key:
            key_file = getattr(settings, "admin_mfa_key_file", None)
            if not key_file or not Path(key_file).is_absolute():
                raise ValueError("MFA key is not configured")
            # Limit reads and never include path/secret in an exception response.
            with Path(key_file).open("rb") as handle:
                key = handle.read(128).strip()
        return Fernet(key.encode("ascii") if isinstance(key, str) else key)
    except (OSError, ValueError, TypeError, UnicodeError):
        _error(503, "ADMIN_MFA_UNAVAILABLE", "დამატებითი ავტორიზაცია დროებით მიუწვდომელია. დაუკავშირდით ადმინისტრატორს.")


def _decrypt(ciphertext: str) -> str:
    try:
        return _fernet().decrypt(ciphertext.encode("ascii")).decode("ascii")
    except (InvalidToken, ValueError, UnicodeError):
        _error(503, "ADMIN_MFA_UNAVAILABLE", "დამატებითი ავტორიზაცია დროებით მიუწვდომელია. დაუკავშირდით ადმინისტრატორს.")


def _identity(db: Session, authorization: str | None, now: datetime):
    scheme, _, token = (authorization or "").partition(" ")
    token = token.strip()
    if scheme.lower() != "bearer" or not token or len(token) > 128:
        _error(401, "AUTH_REQUIRED", "გთხოვთ, ხელახლა გაიაროთ ავტორიზაცია.")
    login = db.scalar(select(UserSession).where(
        UserSession.token == token, UserSession.expires_at > now,
    ).execution_options(populate_existing=True))
    if login is None:
        _error(401, "AUTH_REQUIRED", "გთხოვთ, ხელახლა გაიაროთ ავტორიზაცია.")
    # Read role directly from SQL, but do not refresh/overwrite unrelated dirty
    # ORM fields that the surrounding endpoint may have staged.
    identity = db.execute(select(User.id, User.email, User.is_admin).where(User.id == login.user_id)).first()
    user = db.get(User, login.user_id)
    if user is None:
        _error(401, "AUTH_REQUIRED", "გთხოვთ, ხელახლა გაიაროთ ავტორიზაცია.")
    founder = (getattr(get_settings(), "founder_admin_email", "") or "").strip().lower()
    if identity is None or not (identity.is_admin or (founder and identity.email.lower() == founder)):
        _error(403, "ADMIN_REQUIRED", "ამ მოქმედებაზე წვდომა აქვს მხოლოდ ადმინისტრატორს.")
    return user, login, token_digest(token)


def _credential(db: Session, user_id: int):
    return db.scalar(select(AdminMfaCredential).where(
        AdminMfaCredential.user_id == user_id,
    ).execution_options(populate_existing=True))


def _enrolled(credential) -> bool:
    return bool(credential and credential.enabled_at and credential.secret_ciphertext)


def _valid_elevation(db, user_id, digest, credential, now):
    if not _enrolled(credential):
        return None
    return db.scalar(select(AdminMfaElevation).where(
        AdminMfaElevation.token_hash == digest,
        AdminMfaElevation.user_id == user_id,
        AdminMfaElevation.generation == credential.generation,
        AdminMfaElevation.expires_at > now,
        AdminMfaElevation.last_used_at > now - IDLE_LIFETIME,
    ).execution_options(populate_existing=True))


def _expires(grant, login):
    return min(grant.expires_at, grant.last_used_at + IDLE_LIFETIME, login.expires_at).isoformat() + "Z"


def require_admin_mfa(db: Session, authorization: str | None, user=None):
    """Validate every privileged call without committing the caller's work.

    The optional user is not trusted: the active token and role are read again.
    The request DB finalizer persists an idle touch in its own transaction after
    closing the request session. This helper never modifies exam sessions.
    """
    now = _now()
    with db.no_autoflush:
        actual_user, login, digest = _identity(db, authorization, now)
        if user is not None and actual_user.id != user.id:
            _error(403, "ADMIN_REQUIRED", "ადმინისტრატორის ავტორიზაცია ვერ დადასტურდა.")
        credential = _credential(db, actual_user.id)
        grant = _valid_elevation(db, actual_user.id, digest, credential, now)
        if grant is None:
            _error(403, "ADMIN_MFA_REQUIRED", "ადმინისტრატორის გვერდზე შესასვლელად დაადასტურეთ Google Authenticator-ის კოდი.")
        _fernet()  # Misconfigured deployment must not silently bypass protection.
        db.info["admin_mfa_activity"] = {
            "token_hash": digest, "user_id": actual_user.id,
            "generation": grant.generation, "verified_at": grant.verified_at,
            "at": now, "login_id": login.id, "login_created_at": login.created_at,
        }
        return actual_user


def touch_admin_mfa_activity(bind, pending: dict) -> None:
    """Persist activity without reviving an expired/rotated/revoked elevation."""
    now = _now()
    at = pending["at"]
    if at > now or at <= now - IDLE_LIFETIME:
        return
    with Session(bind) as db, db.begin():
        db.execute(update(AdminMfaElevation).where(
            AdminMfaElevation.token_hash == pending["token_hash"],
            AdminMfaElevation.user_id == pending["user_id"],
            AdminMfaElevation.generation == pending["generation"],
            AdminMfaElevation.verified_at == pending["verified_at"],
            AdminMfaElevation.expires_at > now,
            AdminMfaElevation.last_used_at > now - IDLE_LIFETIME,
            AdminMfaElevation.last_used_at < at,
            AdminMfaElevation.user_id.in_(select(UserSession.user_id).where(
                UserSession.id == pending["login_id"],
                UserSession.created_at == pending["login_created_at"],
                UserSession.expires_at > now,
            )),
            AdminMfaElevation.user_id.in_(select(AdminMfaCredential.user_id).where(
                AdminMfaCredential.generation == pending["generation"],
                AdminMfaCredential.enabled_at.is_not(None),
            )),
        ).values(last_used_at=at))


def _audit(db, user, action, *, method=None):
    details = {"method": method} if method else {}
    db.add(AuditEvent(
        category="auth", action="auth.admin_mfa." + action,
        actor_id=user.id, actor_label=f"ადმინისტრატორი #{user.id}",
        target_type="admin_mfa", target_id=user.id,
        target_label=f"ადმინისტრატორის დამატებითი ავტორიზაცია #{user.id}",
        details=json.dumps(details, ensure_ascii=False, separators=(",", ":")),
    ))


def _lock(db: Session):
    # A no-op UPDATE takes SQLite's writer lock even before a row exists. Unlike
    # SELECT FOR UPDATE (ignored by SQLite), this serializes all code consumers.
    if db.bind.dialect.name == "sqlite":
        db.connection().exec_driver_sql("UPDATE admin_mfa_credentials SET user_id=user_id WHERE 0")


def _locked_identity(db, authorization):
    _lock(db)
    now = _now()
    user, login, digest = _identity(db, authorization, now)
    # Bounded MFA-only housekeeping: never delete a login or exam permission.
    db.execute(delete(AdminMfaPending).where(AdminMfaPending.expires_at <= now))
    db.execute(delete(AdminMfaElevation).where(or_(
        AdminMfaElevation.expires_at <= now,
        AdminMfaElevation.last_used_at <= now - IDLE_LIFETIME,
    )))
    credential = _credential(db, user.id)
    if credential is None:
        credential = AdminMfaCredential(user_id=user.id)
        db.add(credential)
        db.flush()
    elif db.bind.dialect.name != "sqlite":
        credential = db.scalar(select(AdminMfaCredential).where(
            AdminMfaCredential.user_id == user.id).with_for_update())
    if credential.locked_until and credential.locked_until > now:
        wait = max(1, math.ceil((credential.locked_until - now).total_seconds()))
        _error(429, "ADMIN_MFA_LOCKED", "ბევრი არასწორი მცდელობა. სცადეთ მოგვიანებით.", **{"Retry-After": str(wait)})
    _fernet()
    return now, user, login, digest, credential


def _fail(db, user, credential, now, *, password=False):
    if (not credential.failure_window_at or credential.failure_window_at <= now - FAILURE_WINDOW
            or (credential.locked_until and credential.locked_until <= now)):
        credential.failed_attempts = 0
        credential.failure_window_at = now
        credential.locked_until = None
    credential.failed_attempts += 1
    _audit(db, user, "failed", method="password" if password else "code")
    if credential.failed_attempts >= MAX_FAILURES:
        credential.locked_until = now + LOCKOUT_DURATION
    db.commit()  # Persist failed attempts even though the HTTP request fails.
    if credential.locked_until:
        _error(429, "ADMIN_MFA_LOCKED", "ბევრი არასწორი მცდელობა. სცადეთ 15 წუთში.", **{"Retry-After": "900"})
    _error(400, "ADMIN_MFA_INVALID", "პაროლი არასწორია." if password else "კოდი არასწორია, ვადაგასულია ან უკვე გამოყენებულია.")


def _password(db, user, credential, now, password):
    from ..security import verify_code
    value = password or ""
    if not (verify_code(value.strip(), user.password_hash)
            or (value != value.strip() and verify_code(value, user.password_hash))):
        _fail(db, user, credential, now, password=True)


def _clear_failures(credential):
    credential.failed_attempts = 0
    credential.failure_window_at = None
    credential.locked_until = None


def _totp_counter(secret, code, now):
    normalized = re.sub(r"\s", "", code or "")
    if not re.fullmatch(r"[0-9]{6}", normalized):
        return None
    counter = calendar.timegm(now.utctimetuple()) // 30
    generator = pyotp.TOTP(secret, digits=6, interval=30)
    for candidate in (counter, counter - 1, counter + 1):
        if candidate >= 0 and secrets.compare_digest(generator.generate_otp(candidate), normalized):
            return candidate
    return None


def recovery_digest(user_id: int, code: str) -> str:
    normalized = re.sub(r"[-\s]", "", code or "").upper()
    return hashlib.sha256(f"GIPC-admin-recovery-v1:{user_id}:{normalized}".encode("ascii", errors="replace")).hexdigest()


def _new_recovery_codes(db, user_id, now):
    db.execute(delete(AdminMfaRecoveryCode).where(AdminMfaRecoveryCode.user_id == user_id))
    result = []
    for _ in range(RECOVERY_COUNT):
        raw = secrets.token_hex(12).upper()
        code = "-".join(raw[i:i + 4] for i in range(0, len(raw), 4))
        db.add(AdminMfaRecoveryCode(user_id=user_id, code_hash=recovery_digest(user_id, code), created_at=now))
        result.append(code)
    return result


def _grant(db, user, login, digest, credential, now):
    grant = db.get(AdminMfaElevation, digest)
    if grant is None:
        grant = AdminMfaElevation(token_hash=digest, user_id=user.id)
        db.add(grant)
    grant.generation = credential.generation
    grant.verified_at = grant.last_used_at = now
    grant.expires_at = min(now + ELEVATION_LIFETIME, login.expires_at)
    return grant


def mfa_status(db, authorization):
    now = _now()
    user, login, digest = _identity(db, authorization, now)
    _fernet()
    credential = _credential(db, user.id)
    grant = _valid_elevation(db, user.id, digest, credential, now)
    return dict(enrolled=_enrolled(credential), verified=grant is not None,
                expires_at=_expires(grant, login) if grant else None,
                recovery_codes_remaining=int(db.scalar(select(func.count()).select_from(AdminMfaRecoveryCode).where(
                    AdminMfaRecoveryCode.user_id == user.id, AdminMfaRecoveryCode.used_at.is_(None))) or 0))


def begin_setup(db, authorization, password):
    now, user, login, digest, credential = _locked_identity(db, authorization)
    if _enrolled(credential) and _valid_elevation(db, user.id, digest, credential, now) is None:
        _error(403, "ADMIN_MFA_REQUIRED", "ტელეფონის შესაცვლელად ჯერ დაადასტურეთ მოქმედი ან აღდგენის კოდი.")
    _password(db, user, credential, now, password)
    pending = db.get(AdminMfaPending, user.id)
    # A repeated setup request from the same session keeps the displayed QR
    # valid. A secret is never disclosed solely by GET/status or a login token.
    if (pending and pending.token_hash == digest and pending.expires_at > now
            and pending.credential_generation == credential.generation):
        secret = _decrypt(pending.secret_ciphertext)
    else:
        secret = pyotp.random_base32(length=32)
        if pending is None:
            pending = AdminMfaPending(user_id=user.id)
            db.add(pending)
        pending.token_hash = digest
        pending.secret_ciphertext = _fernet().encrypt(secret.encode("ascii")).decode("ascii")
        pending.credential_generation = credential.generation
        pending.created_at, pending.expires_at = now, now + PENDING_LIFETIME
        _audit(db, user, "setup_started")
    db.commit()
    return dict(secret=secret, otpauth_uri=pyotp.TOTP(secret).provisioning_uri(name=user.email, issuer_name=ISSUER),
                issuer=ISSUER, account_name=user.email)


def confirm_setup(db, authorization, code):
    now, user, login, digest, credential = _locked_identity(db, authorization)
    pending = db.get(AdminMfaPending, user.id)
    if (not pending or pending.token_hash != digest or pending.expires_at <= now
            or pending.credential_generation != credential.generation):
        _error(400, "ADMIN_MFA_SETUP_EXPIRED", "მიბმის დრო ამოიწურა. დაიწყეთ ტელეფონის მიბმა თავიდან.")
    if _enrolled(credential) and _valid_elevation(db, user.id, digest, credential, now) is None:
        _error(403, "ADMIN_MFA_REQUIRED", "ტელეფონის შესაცვლელად ჯერ დაადასტურეთ მოქმედი ან აღდგენის კოდი.")
    secret = _decrypt(pending.secret_ciphertext)
    counter = _totp_counter(secret, code, now)
    if counter is None:
        _fail(db, user, credential, now)
    credential.secret_ciphertext = pending.secret_ciphertext
    credential.enabled_at = now
    credential.generation += 1
    credential.last_totp_counter = counter
    _clear_failures(credential)
    db.delete(pending)
    db.execute(delete(AdminMfaElevation).where(AdminMfaElevation.user_id == user.id))
    codes = _new_recovery_codes(db, user.id, now)
    grant = _grant(db, user, login, digest, credential, now)
    _audit(db, user, "enabled", method="totp")
    db.commit()
    return dict(verified=True, expires_at=_expires(grant, login), recovery_codes=codes)


def verify_mfa(db, authorization, code):
    now, user, login, digest, credential = _locked_identity(db, authorization)
    if not _enrolled(credential):
        _error(403, "ADMIN_MFA_SETUP_REQUIRED", "ჯერ მიაბით Google Authenticator თქვენს ანგარიშს.")
    counter = _totp_counter(_decrypt(credential.secret_ciphertext), code, now)
    recovery_used = False
    if counter is not None and (credential.last_totp_counter is None or counter > credential.last_totp_counter):
        credential.last_totp_counter = counter
    else:
        normalized = re.sub(r"[-\s]", "", code or "").upper()
        recovery = None
        if re.fullmatch(r"[0-9A-F]{24}", normalized):
            recovery = db.scalar(select(AdminMfaRecoveryCode).where(
                AdminMfaRecoveryCode.user_id == user.id,
                AdminMfaRecoveryCode.code_hash == recovery_digest(user.id, normalized),
                AdminMfaRecoveryCode.used_at.is_(None)))
        if recovery is None:
            _fail(db, user, credential, now)
        recovery.used_at = now
        recovery_used = True
    _clear_failures(credential)
    grant = _grant(db, user, login, digest, credential, now)
    _audit(db, user, "verified", method="recovery" if recovery_used else "totp")
    db.commit()
    return dict(verified=True, expires_at=_expires(grant, login), recovery_code_used=recovery_used)


def regenerate_recovery_codes(db, authorization, password):
    now, user, login, digest, credential = _locked_identity(db, authorization)
    if _valid_elevation(db, user.id, digest, credential, now) is None:
        _error(403, "ADMIN_MFA_REQUIRED", "ჯერ დაადასტურეთ მოქმედი ან აღდგენის კოდი.")
    _password(db, user, credential, now, password)
    codes = _new_recovery_codes(db, user.id, now)
    _clear_failures(credential)
    _audit(db, user, "recovery_regenerated")
    db.commit()
    return dict(recovery_codes=codes)


def lock_mfa(db, authorization):
    _lock(db)
    user, _login, digest = _identity(db, authorization, _now())
    db.execute(delete(AdminMfaElevation).where(AdminMfaElevation.token_hash == digest))
    db.execute(delete(AdminMfaPending).where(AdminMfaPending.token_hash == digest))
    _audit(db, user, "locked")
    db.commit()
    return dict(verified=False)
