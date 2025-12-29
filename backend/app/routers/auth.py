from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Exam, ExamCode, Session as ExamSession, User, UserSession
from ..schemas import AuthCodeRequest, AuthCodeResponse, LoginRequest, LoginResponse, UserOut, ForgotPasswordRequest, ForgotPasswordResponse
from ..security import generate_session_token, verify_code, hash_code, generate_secure_password
from ..config import get_settings
from ..rate_limiter import login_limiter


router = APIRouter()


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
        # If session creation fails, still return token (backward compatibility)
        # Log error but don't fail login
        import logging
        logging.error(f"Failed to create UserSession: {e}")
        db.rollback()
    
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
        exam_perm = bool(user.exam_permission)
    
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
        exam_permission=exam_perm,
        created_at=user.created_at,
    )
    
    return LoginResponse(token=token, user=user_out)


@router.post("/forgot-password", response_model=ForgotPasswordResponse)
def forgot_password(payload: ForgotPasswordRequest, db: Session = Depends(get_db)):
    """
    Password recovery endpoint.
    Generates a new password for the user and sends it to their email.
    In development mode, writes to verification_codes.txt file.
    """
    email_norm = (payload.email or "").strip().lower()
    if not email_norm:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email required")
    
    user = db.scalar(select(User).where(User.email == email_norm))
    if not user:
        # Don't reveal if email exists or not (security best practice)
        return ForgotPasswordResponse(
            success=True,
            message="თუ ელფოსტა რეგისტრირებულია, პაროლი გამოგეგზავნათ"
        )
    
    # Generate new secure password
    new_password = generate_secure_password()
    
    # Hash and update password
    user.password_hash = hash_code(new_password)
    db.add(user)
    db.commit()
    
    # Send password via email/file (similar to email verification)
    settings = get_settings()
    email_mode = getattr(settings, "email_mode", "console")
    
    if email_mode == "smtp":
        # TODO: Implement real SMTP sending when needed
        # For now, fall through to console mode
        pass
    
    # Console mode (development) - write to verification_codes.txt
    try:
        from pathlib import Path
        log_file = Path(__file__).parent.parent.parent / "verification_codes.txt"
        with open(log_file, "a", encoding="utf-8") as f:
            from datetime import datetime
            f.write(f"\n{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
            f.write(f"Email: {email_norm}\n")
            f.write(f"Password: {new_password}\n")
            f.write(f"Purpose: password_recovery\n")
            f.write("-" * 30 + "\n")
    except Exception:
        pass
    
    # Also print to console for visibility
    try:
        print(f"\n{'='*50}")
        print(f"PASSWORD RECOVERY for {email_norm}")
        print(f"   New Password: {new_password}")
        print(f"{'='*50}\n")
    except Exception:
        pass
    
    return ForgotPasswordResponse(
        success=True,
        message="თუ ელფოსტა რეგისტრირებულია, პაროლი გამოგეგზავნათ"
    )


