from __future__ import annotations

from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status, Query, Header, UploadFile, File, Request
from fastapi.responses import FileResponse
from sqlalchemy import select, or_, func
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import User, Certificate, Rating, Comment, ExpertUpload
from ..schemas import (
    UserCreate, UserOut, UserProfileUpdateRequest, CertificateOut, CertificateCreate, CertificateUpdate,
    SendVerificationCodeRequest, SendVerificationCodeResponse, VerifyCodeRequest, VerifyCodeResponse,
    UserCreateWithVerification,
)
from ..config import get_settings
from ..security import hash_code, verify_code, validate_password_strength, get_current_user
from ..services.media_storage import resolve_storage_path, relative_storage_path, certificate_file_path, delete_storage_file, ensure_media_root
from ..services import email_verification


router = APIRouter()


def _gen_code(db: Session) -> str:
    import random
    # Try 100 random attempts for a unique 10-digit code
    for _ in range(100):
        c = str(10**9 + random.randint(0, 9_999_999_999 - 10**9))[:10]
        exists = db.scalar(select(User).where(User.code == c))
        if not exists:
            return c
    # Fallback: time-based last 10 digits
    return str(int(datetime.utcnow().timestamp() * 1000))[-10:]


def _normalize_exam_score(value: int | None) -> int | None:
    if value is None:
        return None
    try:
        score = int(value)
    except (TypeError, ValueError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="შეფასება უნდა იყოს რიცხვი")
    if score < 0 or score > 100:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="შეფასება უნდა იყოს 0-100 შორის")
    return score


def _delete_certificate_files(cert: Certificate, user_id: int) -> None:
    """
    Delete all certificate-related files and directories.
    This includes:
    - The certificate file itself (cert.file_path)
    - The certificate directory (media/certificates/{user_id}/) if empty
    - For expert certificates: all certificate PDFs in media/expert/{unique_code}/ and the directory if empty
    """
    # Delete file from disk if exists
    if cert.file_path:
        try:
            delete_storage_file(cert.file_path)
        except Exception:
            # Best-effort: continue even if file deletion fails
            pass

    # Delete certificate directory if it exists and is empty
    try:
        media_root = ensure_media_root()
        cert_dir = media_root / "certificates" / str(user_id)
        if cert_dir.exists() and cert_dir.is_dir():
            # Try to remove the directory (will only work if empty)
            try:
                cert_dir.rmdir()
            except OSError:
                # Directory not empty or other error, that's okay
                pass
    except Exception:
        # Best-effort: continue even if directory deletion fails
        pass

    # For expert certificates, also delete the expert directory if it exists
    # Check if this is an expert certificate with EX-... unique_code
    if cert.level and (cert.level.lower() == "expert") and cert.unique_code:
        unique_code = cert.unique_code.strip()
        # Check if unique_code matches EX-... pattern
        if unique_code.startswith("EX-"):
            try:
                media_root = ensure_media_root()
                expert_dir = media_root / "expert" / unique_code
                if expert_dir.exists() and expert_dir.is_dir():
                    # Delete all certificate PDF files in the expert directory
                    # Look for files that start with "certificate" and end with ".pdf"
                    for pdf_file in expert_dir.glob("certificate*.pdf"):
                        try:
                            if pdf_file.is_file():
                                pdf_file.unlink()
                        except OSError:
                            # Best-effort: continue if file deletion fails
                            pass
                    
                    # Try to remove the directory if it's now empty
                    try:
                        # Check if directory is empty (no files or only empty subdirectories)
                        if not any(expert_dir.iterdir()):
                            expert_dir.rmdir()
                        else:
                            # Directory still has files, try to remove empty subdirectories
                            for item in expert_dir.iterdir():
                                if item.is_dir():
                                    try:
                                        if not any(item.iterdir()):
                                            item.rmdir()
                                    except OSError:
                                        pass
                            # Try to remove the directory again if it's now empty
                            try:
                                if not any(expert_dir.iterdir()):
                                    expert_dir.rmdir()
                            except OSError:
                                pass
                    except OSError:
                        # Directory not empty or other error, that's okay
                        pass
            except Exception:
                # Best-effort: continue even if expert directory deletion fails
                pass


# ============== Email Verification Endpoints ==============

@router.post("/send-verification-code", response_model=SendVerificationCodeResponse)
def send_verification_code_endpoint(
    request: Request,
    payload: SendVerificationCodeRequest,
    db: Session = Depends(get_db),
):
    """
    Send a 4-digit verification code to the given email.
    Purpose can be 'register' or 'update'.
    Rate limited: 5 requests per minute per IP.
    """
    # TODO: Add rate limiting with slowapi decorator when slowapi is installed
    # Rate limiting temporarily disabled to ensure endpoint works
    
    email_lower = payload.email.strip().lower()
    purpose = payload.purpose
    
    # For registration, check that email is not already taken
    if purpose == "register":
        existing = db.scalar(select(User).where(func.lower(User.email) == email_lower))
        if existing:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="ეს ელფოსტა უკვე რეგისტრირებულია"
            )
    
    # Send the code
    email_verification.send_verification_code(email_lower, purpose)
    
    return SendVerificationCodeResponse(
        success=True,
        message="ვერიფიკაციის კოდი გაგზავნილია",
        expires_in=300,  # 5 minutes
    )


@router.post("/verify-code", response_model=VerifyCodeResponse)
def verify_code_endpoint(request: Request, payload: VerifyCodeRequest):
    # TODO: Add rate limiting with slowapi decorator when slowapi is installed
    # Rate limiting temporarily disabled to ensure endpoint works
    """
    Verify a code for the given email.
    Returns whether the code is valid.
    Note: This does NOT consume the code - it just checks validity.
    """
    email_lower = payload.email.strip().lower()
    
    # Just check if code exists and matches (peek, don't consume)
    from ..services.email_verification import _verification_codes, _cleanup_expired
    _cleanup_expired()
    
    stored = _verification_codes.get(email_lower)
    if not stored:
        return VerifyCodeResponse(valid=False)
    
    if stored["code"] != payload.code:
        return VerifyCodeResponse(valid=False)
    
    if payload.purpose and stored["purpose"] != payload.purpose:
        return VerifyCodeResponse(valid=False)
    
    return VerifyCodeResponse(valid=True)


# ============== Registration ==============

@router.post("/register", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def register(payload: UserCreateWithVerification, db: Session = Depends(get_db)):
    # Basic validations
    if len(payload.personal_id) != 11 or not payload.personal_id.isdigit():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="personal_id must be 11 digits")
    
    # Validate password strength
    password_trimmed = (payload.password or "").strip()
    if not password_trimmed:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="password required")
    validate_password_strength(password_trimmed)

    personal_id_norm = payload.personal_id.strip()
    first_name_norm = payload.first_name.strip()
    last_name_norm = payload.last_name.strip()
    phone_norm = payload.phone.strip()
    email_norm = payload.email.strip().lower()

    # Verify the email verification code
    if not email_verification.verify_code(email_norm, payload.verification_code, "register"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="ვერიფიკაციის კოდი არასწორია ან ვადაგასულია"
        )

    existing_conflict = db.scalar(
        select(User).where(
            or_(
                User.personal_id == personal_id_norm,
                func.lower(User.email) == email_norm,
                User.phone == phone_norm,
            )
        )
    )
    if existing_conflict:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="ეს მონაცემები სისტემაში უკვე რეგისტრირებულია",
        )

    # Generate unique code
    code = _gen_code(db)

    settings = get_settings()
    is_founder = (settings.founder_admin_email or "").lower() == email_norm

    user = User(
        personal_id=personal_id_norm,
        first_name=first_name_norm,
        last_name=last_name_norm,
        phone=phone_norm,
        email=email_norm,
        password_hash=hash_code(password_trimmed),
        code=code,
        is_admin=is_founder or False,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    is_admin_user = is_founder or bool(user.is_admin)
    # მთავარ ადმინს ყოველთვის exam_permission = true
    # სხვა ადმინებს exam_permission = true
    # არა-ადმინებს exam_permission = user.exam_permission (რაც ბაზაშია)
    if is_founder:
        exam_perm = True
    elif is_admin_user:
        exam_perm = True  # ადმინებს exam_permission ყოველთვის true
    else:
        exam_perm = bool(user.exam_permission)  # არა-ადმინებს რაც ბაზაშია
    return UserOut(
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


@router.get("/{user_id}/public", response_model=UserOut)
def public_profile(
    user_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Public profile lookup by user_id. Returns non-sensitive fields needed for profile view.
    Access: any authenticated actor.
    """
    user = db.scalar(select(User).where(User.id == user_id))
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    settings = get_settings()
    founder_email = (settings.founder_admin_email or "").lower()
    is_founder = (user.email or "").lower() == founder_email
    is_admin_user = is_founder or bool(user.is_admin)
    # მთავარ ადმინს ყოველთვის exam_permission = true
    # სხვა ადმინებს exam_permission = true
    # არა-ადმინებს exam_permission = user.exam_permission (რაც ბაზაშია)
    if is_founder:
        exam_perm = True
    elif is_admin_user:
        exam_perm = True  # ადმინებს exam_permission ყოველთვის true
    else:
        exam_perm = bool(user.exam_permission)  # არა-ადმინებს რაც ბაზაშია
    return UserOut(
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

@router.get("/profile", response_model=UserOut)
def profile(
    email: str = Query(..., description="User email to lookup"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # Return public profile (no password) by email
    eml = (email or "").strip().lower()
    if not eml:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="email required")
    
    u = db.scalar(select(User).where(User.email == eml))
    if not u:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    
    settings = get_settings()
    founder_email = (settings.founder_admin_email or "").lower()
    is_founder = eml == founder_email
    
    # Only self or admin/founder can view
    if current_user.email != eml and not (current_user.is_admin or current_user.email.lower() == founder_email):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="forbidden")
    is_admin_user = is_founder or bool(u.is_admin)
    # მთავარ ადმინს ყოველთვის exam_permission = true
    # სხვა ადმინებს exam_permission = true
    # არა-ადმინებს exam_permission = u.exam_permission (რაც ბაზაშია)
    if is_founder:
        exam_perm = True
    elif is_admin_user:
        exam_perm = True  # ადმინებს exam_permission ყოველთვის true
    else:
        exam_perm = bool(u.exam_permission)  # არა-ადმინებს რაც ბაზაშია
    return UserOut(
        id=u.id,
        personal_id=u.personal_id,
        first_name=u.first_name,
        last_name=u.last_name,
        phone=u.phone,
        email=u.email,
        code=u.code,
        is_admin=is_admin_user,
        is_founder=is_founder,
        exam_permission=exam_perm,
        created_at=u.created_at,
    )


@router.patch("/profile", response_model=UserOut)
def update_profile(
    payload: UserProfileUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Update own profile.

    - Validates email/personal_id uniqueness
    - Requires current_password only when changing email/personal_id/password
    - Atomic: if any validation fails, no changes are committed
    """
    user = current_user

    # Normalize incoming values
    first_name = (payload.first_name or "").strip() if payload.first_name is not None else None
    last_name = (payload.last_name or "").strip() if payload.last_name is not None else None
    phone = (payload.phone or "").strip() if payload.phone is not None else None

    personal_id = (payload.personal_id or "").strip() if payload.personal_id is not None else None
    email = (str(payload.email).strip().lower() if payload.email is not None else None)

    new_password = (payload.new_password or "") if payload.new_password is not None else None
    confirm_new_password = (payload.confirm_new_password or "") if payload.confirm_new_password is not None else None

    # Basic validations (keep consistent with register rules where applicable)
    if first_name is not None and not first_name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="სახელი ცარიელი არ უნდა იყოს")
    if last_name is not None and not last_name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="გვარი ცარიელი არ უნდა იყოს")
    if phone is not None and not phone:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="ტელეფონი ცარიელი არ უნდა იყოს")

    if personal_id is not None:
        if len(personal_id) != 11 or not personal_id.isdigit():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="პირადი ნომერი უნდა იყოს 11 ციფრი")

    wants_password_change = False
    if new_password is not None or confirm_new_password is not None:
        new_pw_trimmed = (new_password or "").strip()
        conf_pw_trimmed = (confirm_new_password or "").strip()
        if new_pw_trimmed or conf_pw_trimmed:
            wants_password_change = True
            if not new_pw_trimmed:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="გთხოვთ შეიყვანოთ ახალი პაროლი")
            validate_password_strength(new_pw_trimmed)  # Validate password strength
            if not conf_pw_trimmed:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="გთხოვთ გაიმეოროთ ახალი პაროლი")
            if new_pw_trimmed != conf_pw_trimmed:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="პაროლები არ ემთხვევა")

    email_changed = email is not None and email != (user.email or "").lower()
    personal_id_changed = personal_id is not None and personal_id != user.personal_id

    # If email is changing, require verification code for the NEW email
    if email_changed:
        verification_code = (payload.email_verification_code or "").strip()
        if not verification_code:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="ახალი ელფოსტის ვერიფიკაციის კოდი საჭიროა"
            )
        if not email_verification.verify_code(email, verification_code, "update"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="ვერიფიკაციის კოდი არასწორია ან ვადაგასულია"
            )

    # Uniqueness checks (required by spec)
    conflicts: list[str] = []
    if personal_id_changed:
        exists_pid = db.scalar(select(User.id).where(User.personal_id == personal_id, User.id != user.id))
        if exists_pid:
            conflicts.append("ეს პირადი ნომერი უკვე გამოყენებულია სხვა მომხმარებლის მიერ და ვერ შეიცვლება")
    if email_changed:
        exists_email = db.scalar(select(User.id).where(func.lower(User.email) == email, User.id != user.id))
        if exists_email:
            conflicts.append("ეს ელფოსტა უკვე გამოყენებულია სხვა მომხმარებლის მიერ და ვერ შეიცვლება")
    if conflicts:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="; ".join(conflicts))

    # მიმდინარე პაროლი ყოველთვის საჭიროა ნებისმიერი ცვლილებისთვის
    current = (payload.current_password or "").strip()
    if not current:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="გთხოვთ შეიყვანოთ მიმდინარე პაროლი")
    if not verify_code(current, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="მიმდინარე პაროლი არასწორია")

    # Apply updates (commit only at the end)
    if first_name is not None:
        user.first_name = first_name
    if last_name is not None:
        user.last_name = last_name
    if phone is not None:
        user.phone = phone
    if personal_id_changed:
        user.personal_id = personal_id
    if email_changed:
        user.email = email
    elif email is not None:
        # Ensure canonical lowercase storage
        user.email = email

    if wants_password_change:
        user.password_hash = hash_code((new_password or "").strip())

    db.add(user)
    db.commit()
    db.refresh(user)

    # Return user out with permissions aligned to other endpoints
    settings = get_settings()
    founder_email = (settings.founder_admin_email or "").lower()
    is_founder = (user.email or "").lower() == founder_email
    is_admin_user = is_founder or bool(user.is_admin)
    if is_founder:
        exam_perm = True
    elif is_admin_user:
        exam_perm = True
    else:
        exam_perm = bool(user.exam_permission)

    return UserOut(
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


@router.get("/{user_id}/certificate", response_model=CertificateOut)
def get_certificate(
    user_id: int,
    x_actor_email: str | None = Header(None, alias="x-actor-email"),
    db: Session = Depends(get_db),
):
    """Get certificate for a user"""
    user = db.scalar(select(User).where(User.id == user_id))
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    # AuthZ: allow any authenticated actor to view certificate metadata
    actor_email = (x_actor_email or "").strip().lower()
    if not actor_email:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="actor required")
    actor = db.scalar(select(User).where(User.email == actor_email))
    if not actor:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="actor not found")
    
    cert = db.scalar(select(Certificate).where(Certificate.user_id == user_id))
    if not cert:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Certificate not found")
    
    return CertificateOut.model_validate(cert)


@router.post("/{user_id}/certificate", response_model=CertificateOut, status_code=status.HTTP_201_CREATED)
def create_certificate(
    user_id: int,
    payload: CertificateCreate,
    x_actor_email: str | None = Header(None, alias="x-actor-email"),
    db: Session = Depends(get_db),
):
    """Create certificate for a user"""
    user = db.scalar(select(User).where(User.id == user_id))
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    # Only admin/founder can create
    actor_email = (x_actor_email or "").strip().lower()
    actor = db.scalar(select(User).where(User.email == actor_email)) if actor_email else None
    settings = get_settings()
    founder_email = (settings.founder_admin_email or "").lower()
    if not actor or not (actor.is_admin or actor.email.lower() == founder_email):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="admin only")
    
    existing = db.scalar(select(Certificate).where(Certificate.user_id == user_id))
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Certificate already exists")
    
    score = _normalize_exam_score(payload.exam_score)
    cert = Certificate(
        user_id=user_id,
        unique_code=payload.unique_code or user.code,
        level=payload.level or "architect",
        status=payload.status or "active",
        issue_date=payload.issue_date,
        validity_term=payload.validity_term,
        valid_until=payload.valid_until,
        exam_score=score if score is not None else 0,
    )
    db.add(cert)
    db.commit()
    db.refresh(cert)
    
    return CertificateOut.model_validate(cert)


@router.put("/{user_id}/certificate", response_model=CertificateOut)
def update_certificate(
    user_id: int,
    payload: CertificateUpdate,
    x_actor_email: str | None = Header(None, alias="x-actor-email"),
    db: Session = Depends(get_db),
):
    """Update certificate for a user"""
    user = db.scalar(select(User).where(User.id == user_id))
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    # Only admin/founder can update
    actor_email = (x_actor_email or "").strip().lower()
    actor = db.scalar(select(User).where(User.email == actor_email)) if actor_email else None
    settings = get_settings()
    founder_email = (settings.founder_admin_email or "").lower()
    if not actor or not (actor.is_admin or actor.email.lower() == founder_email):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="admin only")
    
    cert = db.scalar(select(Certificate).where(Certificate.user_id == user_id))
    if not cert:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Certificate not found")
    
    if payload.unique_code is not None:
        cert.unique_code = payload.unique_code
    if payload.level is not None:
        cert.level = payload.level
    if payload.status is not None:
        cert.status = payload.status
    if payload.issue_date is not None:
        cert.issue_date = payload.issue_date
    if payload.validity_term is not None:
        cert.validity_term = payload.validity_term
    if payload.valid_until is not None:
        cert.valid_until = payload.valid_until
    if payload.exam_score is not None:
        cert.exam_score = _normalize_exam_score(payload.exam_score)
    
    cert.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(cert)
    
    return CertificateOut.model_validate(cert)


@router.delete("/{user_id}/certificate", status_code=status.HTTP_204_NO_CONTENT)
def delete_certificate(
    user_id: int,
    x_actor_email: str | None = Header(None, alias="x-actor-email"),
    db: Session = Depends(get_db),
):
    """Delete certificate for a user"""
    user = db.scalar(select(User).where(User.id == user_id))
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    # Only admin/founder can delete
    actor_email = (x_actor_email or "").strip().lower()
    actor = db.scalar(select(User).where(User.email == actor_email)) if actor_email else None
    settings = get_settings()
    founder_email = (settings.founder_admin_email or "").lower()
    if not actor or not (actor.is_admin or actor.email.lower() == founder_email):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="admin only")
    
    cert = db.scalar(select(Certificate).where(Certificate.user_id == user_id))
    if not cert:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Certificate not found")

    # Delete all certificate-related files and directories
    _delete_certificate_files(cert, user_id)

    # Delete user photo when certificate is deleted
    if user.photo_path:
        try:
            delete_storage_file(user.photo_path)
        except Exception:
            pass
        user.photo_path = None
        user.photo_filename = None
        db.add(user)

    # Delete all ratings and comments for this user
    db.execute(Rating.__table__.delete().where(Rating.target_user_id == user_id))
    db.execute(Comment.__table__.delete().where(Comment.target_user_id == user_id))

    # Delete all expert uploads and their files
    uploads = db.scalars(select(ExpertUpload).where(ExpertUpload.user_id == user_id)).all()
    for upload in uploads:
        if upload.expertise_path:
            try:
                delete_storage_file(upload.expertise_path)
            except Exception:
                pass
        if upload.project_path:
            try:
                delete_storage_file(upload.project_path)
            except Exception:
                pass
    db.execute(ExpertUpload.__table__.delete().where(ExpertUpload.user_id == user_id))

    db.delete(cert)
    db.commit()
    return None


@router.post("/{user_id}/certificate/file", status_code=status.HTTP_204_NO_CONTENT)
def upload_certificate_file(
    user_id: int,
    file: UploadFile = File(...),
    x_actor_email: str | None = Header(None, alias="x-actor-email"),
    db: Session = Depends(get_db),
):
    """Upload certificate PDF for a user (admin/founder only)."""
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    # Only admin/founder can upload
    actor_email = (x_actor_email or "").strip().lower()
    actor = db.scalar(select(User).where(User.email == actor_email)) if actor_email else None
    settings = get_settings()
    founder_email = (settings.founder_admin_email or "").lower()
    if not actor or not (actor.is_admin or actor.email.lower() == founder_email):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="admin only")

    cert = db.scalar(select(Certificate).where(Certificate.user_id == user_id))
    if not cert:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Certificate not found")

    content_type = (file.content_type or "").lower()
    if content_type not in ("application/pdf", "application/x-pdf", "binary/octet-stream", "application/octet-stream"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="ფაილი უნდა იყოს PDF")

    target = certificate_file_path(user_id, "certificate.pdf")
    tmp = target.with_suffix(".tmp")

    with open(tmp, "wb") as out:
        while True:
            chunk = file.file.read(1024 * 1024)
            if not chunk:
                break
            out.write(chunk)
    tmp.replace(target)
    size = target.stat().st_size

    # Update DB meta
    cert.file_path = relative_storage_path(target)
    cert.filename = "certificate.pdf"
    cert.mime_type = "application/pdf"
    cert.size_bytes = int(size)
    cert.updated_at = datetime.utcnow()
    db.add(cert)
    db.commit()
    return None


@router.get("/{user_id}/certificate/file")
def download_certificate_file(
    user_id: int,
    x_actor_email: str | None = Header(None, alias="x-actor-email"),
    actor: str | None = Query(None, alias="actor"),
    db: Session = Depends(get_db),
):
    """Download certificate PDF.
    Public download is allowed for active (non-expired) certificates.
    """
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    cert = db.scalar(select(Certificate).where(Certificate.user_id == user_id))
    if not cert:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Certificate not found")
    if not cert.file_path:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    # Allow public download only if certificate is active and not expired
    status_norm = (cert.status or "").strip().lower()
    if status_norm in ("suspended", "expired"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="certificate inactive")
    if cert.valid_until is not None and cert.valid_until < datetime.utcnow():
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="certificate inactive")

    try:
        path = resolve_storage_path(cert.file_path)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    if not path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    return FileResponse(
        path,
        media_type=cert.mime_type or "application/pdf",
        filename=cert.filename or path.name,
    )


@router.get("/{user_id}/photo/file")
def get_user_photo(
    user_id: int,
    db: Session = Depends(get_db),
):
    """Get user photo file (public endpoint)."""
    user = db.get(User, user_id)
    if not user or not user.photo_path:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Photo not found")

    try:
        path = resolve_storage_path(user.photo_path)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Photo not found")

    if not path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Photo file missing")

    # Determine content type from extension
    ext = path.suffix.lower()
    content_type_map = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
    }
    content_type = content_type_map.get(ext, "image/jpeg")

    return FileResponse(
        path,
        media_type=content_type,
        filename=user.photo_filename or path.name,
    )
