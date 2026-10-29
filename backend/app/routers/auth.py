from __future__ import annotations

from datetime import datetime, timedelta
import logging
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Response, status, Request
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Exam, ExamCode, Session as ExamSession, User, UserSession
from ..schemas import (
    AuthCodeRequest,
    AuthCodeResponse,
    ForgotPasswordRequest,
    ForgotPasswordResponse,
    LoginRequest,
    LoginResponse,
    ResetPasswordRequest,
    UserOut,
)
from ..security import generate_session_token, verify_code, hash_code, validate_password_strength
from ..config import get_settings
from ..rate_limiter import (
    code_verify_limiter,
    login_account_limiter,
    login_limiter,
    verification_account_limiter,
    verification_limiter,
)
from ..services import email_verification
from ..services.exam_stage_grants import (
    exam_state_with_permissions,
    expire_unused_stage_permissions,
)


router = APIRouter()
logger = logging.getLogger(__name__)


@router.post("/code", response_model=AuthCodeResponse)
def auth_with_code(payload: AuthCodeRequest, db: Session = Depends(get_db)):
    exam: Optional[Exam] = db.get(Exam, payload.exam_id)
    if not exam:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Exam not found")

    # Find a matching code entry
    code_stmt = select(ExamCode).where(
        ExamCode.exam_id == exam.id,
        ExamCode.disabled == False,  # noqa: E712
        ExamCode.used == False,      # noqa: E712
    )
    candidates = db.scalars(code_stmt).all()
    match: Optional[ExamCode] = None
    for c in candidates:
        if verify_code(payload.code, c.code_hash):
            match = c
            break

    if not match:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or used code")

    # One active session per code: ensure no active session remains within time window
    active_stmt = select(ExamSession).where(
        ExamSession.code_id == match.id,
        ExamSession.active == True,  # noqa: E712
    )
    active_session = db.scalars(active_stmt).first()
    now = datetime.utcnow()
    if active_session and (active_session.finished_at is None and active_session.ends_at > now):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Active session already exists for this code")

    token = generate_session_token()
    ends_at = now + timedelta(minutes=exam.duration_minutes)
    session = ExamSession(
        exam_id=exam.id,
        code_id=match.id,
        token=token,
        started_at=now,
        ends_at=ends_at,
        active=True,
    )
    db.add(session)

    # Mark code as used (single-use)
    match.used = True
    match.used_at = now

    db.commit()
    db.refresh(session)

    return AuthCodeResponse(
        session_id=session.id,
        token=token,
        exam_id=exam.id,
        duration_minutes=exam.duration_minutes,
        ends_at=ends_at,
    )


@router.post("/login", response_model=LoginResponse)
def login(request: Request, payload: LoginRequest, db: Session = Depends(get_db)):
    """Login with email and password."""
    # Rate limiting: 5 attempts per minute per IP
    login_limiter.check(request)
    
    email_norm = (payload.email or "").strip().lower()
    if not email_norm:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email required")
    login_account_limiter.check_key(email_norm)
    
    user = db.scalar(select(User).where(User.email == email_norm))
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")
    
    # Verify password (trim to match frontend behavior)
    # Try trimmed password first (for new registrations), then original (for legacy users)
    password_trimmed = (payload.password or "").strip()
    password_original = payload.password or ""
    
    # First try trimmed password (standard case)
    if verify_code(password_trimmed, user.password_hash):
        pass  # Success
    # Fallback: try original password (for legacy users with spaces in stored hash)
    elif password_original != password_trimmed and verify_code(password_original, user.password_hash):
        pass  # Success with original
    else:
        # Debug: check if password_hash might be empty or invalid
        if not user.password_hash or len(user.password_hash.strip()) == 0:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="User password not properly configured. Please contact administrator."
            )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")
    
    # Generate token and store in database
    token = generate_session_token()
    now = datetime.utcnow()
    expires_at = now + timedelta(days=30)  # 30 days expiration
    
    # Create session in database
    try:
        session = UserSession(
            user_id=user.id,
            token=token,
            created_at=now,
            expires_at=expires_at,
            last_used_at=now,
        )
        db.add(session)
        db.commit()
    except Exception as e:
        import logging
        logging.error(f"Failed to create UserSession: {e}")
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="?????? ?????? ??? ????????. ?????? ?????? ???????.",
        ) from e
    
    # Get user info with proper permissions
    settings = get_settings()
    founder_email = (settings.founder_admin_email or "").lower()
    is_founder = email_norm == founder_email
    is_admin_user = is_founder or bool(user.is_admin)
    
    if is_founder:
        exam_perm = True
    elif is_admin_user:
        exam_perm = True
    else:
        if expire_unused_stage_permissions(db, user, commit=True):
            db.refresh(user)
        exam_perm = bool(user.exam_permission)

    exam_state = exam_state_with_permissions(db, user, is_admin_user=is_admin_user)
    user_out = UserOut(
        id=user.id,
        personal_id=user.personal_id,
        first_name=user.first_name,
        last_name=user.last_name,
        phone=user.phone,
        email=user.email,
        code=user.code,
        is_admin=is_admin_user,
        is_founder=is_founder,
        exam_permission=bool(exam_state.get("exam_permission", exam_perm)),
        exam_stage=exam_state.get("exam_stage"),
        exam_stage_expires_at=exam_state.get("exam_stage_expires_at"),
        exam_stage_started_at=exam_state.get("exam_stage_started_at"),
        exam_stage_status=exam_state.get("exam_stage_status"),
        exam_stage_remaining_seconds=exam_state.get("exam_stage_remaining_seconds"),
        exam_stage_permissions=exam_state.get("exam_stage_permissions", {}),
        created_at=user.created_at,
    )
    
    response = LoginResponse(token=token, user=user_out)
    login_account_limiter.reset_key(email_norm)
    return response


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    authorization: Optional[str] = Header(default=None),
    db: Session = Depends(get_db),
):
    """Revoke the current website session without affecting exam sessions."""
    if authorization:
        scheme, separator, raw_token = authorization.partition(" ")
        token = raw_token.strip()
        if separator and scheme.lower() == "bearer" and token:
            user_session = db.scalar(
                select(UserSession).where(UserSession.token == token)
            )
            if user_session is not None:
                db.delete(user_session)
                db.commit()

    # Logout is intentionally idempotent: stale or missing tokens are already
    # logged out from the server's point of view.
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/forgot-password", response_model=ForgotPasswordResponse)
def forgot_password(request: Request, payload: ForgotPasswordRequest, db: Session = Depends(get_db)):
    """
    Password recovery endpoint.
    Sends a one-time reset code to the user's email.
    """
    verification_limiter.check(request)

    email_norm = (payload.email or "").strip().lower()
    if not email_norm:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email required")
    verification_account_limiter.check_key(
        (email_norm, "password_reset")
    )
    
    user = db.scalar(select(User).where(User.email == email_norm))
    if user:
        try:
            email_verification.send_verification_code(email_norm, "password_reset")
        except RuntimeError:
            # Keep the public response identical for registered and unknown
            # addresses, including during an SMTP outage. Otherwise the status
            # code itself becomes an account-enumeration signal.
            logger.warning("Password reset email delivery failed", exc_info=True)
    
    return ForgotPasswordResponse(
        success=True,
        message="თუ ელფოსტა რეგისტრირებულია, აღდგენის კოდი გამოგეგზავნათ"
    )


@router.post("/reset-password", response_model=ForgotPasswordResponse)
def reset_password(request: Request, payload: ResetPasswordRequest, db: Session = Depends(get_db)):
    """Reset a password after verifying the one-time email code."""
    code_verify_limiter.check(request)

    email_norm = (payload.email or "").strip().lower()
    verification_code = (payload.verification_code or "").strip()
    new_password = (payload.new_password or "").strip()
    confirm_new_password = (payload.confirm_new_password or "").strip()

    if not email_norm:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email required")
    if not verification_code:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="ვერიფიკაციის კოდი საჭიროა")
    if not new_password:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="გთხოვთ შეიყვანოთ ახალი პაროლი")

    validate_password_strength(new_password)

    if new_password != confirm_new_password:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="პაროლები არ ემთხვევა")

    user = db.scalar(select(User).where(User.email == email_norm))
    if not user or not email_verification.verify_code(email_norm, verification_code, "password_reset"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="ვერიფიკაციის კოდი არასწორია ან ვადაგასულია",
        )

    user.password_hash = hash_code(new_password)
    # A password reset is also an account-recovery event. Invalidate every web
    # login session for this user so a previously copied bearer token cannot
    # survive the reset. Exam sessions use a separate model and are untouched.
    db.execute(delete(UserSession).where(UserSession.user_id == user.id))
    db.add(user)
    db.commit()

    return ForgotPasswordResponse(
        success=True,
        message="პაროლი წარმატებით შეიცვალა"
    )


