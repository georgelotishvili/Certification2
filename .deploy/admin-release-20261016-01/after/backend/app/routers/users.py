from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
from uuid import uuid4

from fastapi import APIRouter, Body, Depends, HTTPException, status, Query, Header, UploadFile, File, Request
from fastapi.responses import FileResponse
from sqlalchemy import select, or_, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import User, Certificate, Rating, Comment, ExpertUpload, UserSession, PlanningLetter
from ..schemas import (
    UserCreate, UserOut, PublicUserOut, PublicPersonPageOut, PublicCertificateOut,
    UserProfileUpdateRequest, CertificateOut, CertificateCreate, CertificateUpdate, CertificateNotifyRequest,
    SendVerificationCodeRequest, SendVerificationCodeResponse, VerifyCodeRequest, VerifyCodeResponse,
    UserCreateWithVerification,
)
from ..config import get_settings
from ..security import hash_code, verify_code, validate_password_strength, get_current_user
from ..services.media_storage import resolve_storage_path, relative_storage_path, certificate_file_path, delete_storage_file, ensure_media_root
from ..services.expert_certificate_cleanup import delete_expert_certificate_files
from ..services.bounded_upload import (
    DEFAULT_UPLOAD_MAX_BYTES,
    UploadTooLarge,
    save_upload_stream,
)
from ..services import email_verification
from ..services.planning_email import ATTACHMENT_MAX_BYTES, deliver_letter
from ..services.exam_stage_grants import (
    exam_state_with_permissions,
    expire_unused_stage_permissions,
)
from ..services.user_codes import (
    UserCodeConflict,
    UserCodeGenerationError,
    move_user_code,
    reserve_registration_code,
)
from ..rate_limiter import (
    code_verify_limiter,
    verification_account_limiter,
    verification_limiter,
)


router = APIRouter()
CERTIFICATE_UPLOAD_MAX_BYTES = DEFAULT_UPLOAD_MAX_BYTES


def _get_user_from_token(db: Session, authorization: str | None) -> User | None:
    """Get user from Bearer token."""
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    token = authorization.split(" ", 1)[1]
    session = db.scalar(
        select(UserSession).where(
            UserSession.token == token,
            UserSession.expires_at > datetime.utcnow()
        )
    )
    if not session:
        return None
    return db.get(User, session.user_id)


def _require_auth(db: Session, authorization: str | None) -> User:
    """Require authenticated user via Bearer token."""
    user = _get_user_from_token(db, authorization)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Bearer token required")
    return user


def _require_admin(db: Session, authorization: str | None) -> User:
    """Require admin user via Bearer token."""
    user = _require_auth(db, authorization)
    settings = get_settings()
    founder_email = (settings.founder_admin_email or "").lower()
    if user.email.lower() == founder_email or user.is_admin:
        return user
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="admin only")


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

    # Expert certificate cleanup treats the persisted code as untrusted.
    if cert.level and cert.level.lower() == "expert" and cert.unique_code:
        delete_expert_certificate_files(cert.unique_code)

# ============== Email Verification Endpoints ==============

@router.post("/send-verification-code", response_model=SendVerificationCodeResponse)
def send_verification_code_endpoint(
    request: Request,
    payload: SendVerificationCodeRequest,
    db: Session = Depends(get_db),
):
    """
    Send a 4-digit verification code to the given email.
    Purpose can be 'register', 'update', or 'password_reset'.
    Rate limited per IP and per normalized email/purpose pair.
    """
    # Rate limiting: 3 codes per minute per IP
    verification_limiter.check(request)
    
    email_lower = payload.email.strip().lower()
    purpose = (payload.purpose or "").strip().lower()
    if purpose not in {"register", "update", "password_reset"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="invalid verification purpose",
        )
    verification_account_limiter.check_key((email_lower, purpose))
    
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
    """
    Verify a code for the given email.
    Returns whether the code is valid.
    Note: This does NOT consume the code - it just checks validity.
    Rate limited: 5 attempts per minute per IP.
    """
    # Rate limiting: 5 verifications per minute per IP
    code_verify_limiter.check(request)
    
    email_lower = payload.email.strip().lower()
    
    # Preserve the existing non-consuming response contract, but use the same
    # attempt tracking and lockout as the consuming verification flows.
    valid = email_verification.verify_code(
        email_lower,
        payload.code,
        payload.purpose,
        consume=False,
    )
    return VerifyCodeResponse(valid=valid)


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

    settings = get_settings()
    is_founder = (settings.founder_admin_email or "").lower() == email_norm
    password_hash = hash_code(password_trimmed)

    # A reservation and the new account form one transaction. Retry allocation
    # collisions without consuming the email verification code a second time.
    for attempt in range(3):
        try:
            code = reserve_registration_code(db, personal_id_norm)
            user = User(
                personal_id=personal_id_norm,
                first_name=first_name_norm,
                last_name=last_name_norm,
                phone=phone_norm,
                email=email_norm,
                password_hash=password_hash,
                code=code,
                is_admin=is_founder or False,
            )
            db.add(user)
            db.commit()
            break
        except UserCodeConflict:
            db.rollback()
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="პირადი ნომრისა და კოდის კავშირი შესამოწმებელია; მიმართეთ ადმინისტრატორს")
        except UserCodeGenerationError:
            db.rollback()
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="კოდის მინიჭება დროებით ვერ შესრულდა; სცადეთ ხელახლა")
        except IntegrityError:
            db.rollback()
            conflict = db.scalar(select(User.id).where(or_(
                User.personal_id == personal_id_norm,
                func.lower(User.email) == email_norm,
                User.phone == phone_norm,
            )))
            if conflict is not None:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="ეს მონაცემები სისტემაში უკვე რეგისტრირებულია")
            if attempt == 2:
                raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="რეგისტრაცია დროებით ვერ შესრულდა; სცადეთ ხელახლა")
        except Exception:
            db.rollback()
            raise
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
    exam_state = exam_state_with_permissions(db, user, is_admin_user=is_admin_user)
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
        exam_permission=bool(exam_state["exam_permission"]),
        exam_stage=exam_state["exam_stage"],
        exam_stage_expires_at=exam_state["exam_stage_expires_at"],
        exam_stage_started_at=exam_state["exam_stage_started_at"],
        exam_stage_status=exam_state["exam_stage_status"],
        exam_stage_remaining_seconds=exam_state["exam_stage_remaining_seconds"],
        exam_stage_permissions=exam_state["exam_stage_permissions"],
        created_at=user.created_at,
    )


def _public_person_page(db: Session, *, user_id: int | None = None, code: str | None = None) -> PublicPersonPageOut:
    """Resolve only a current public registry entry; never a deleted reservation."""
    query = (
        select(User, Certificate)
        .join(Certificate, Certificate.user_id == User.id)
        .where(Certificate.status.in_(("active", "suspended", "expired")))
    )
    if code is not None:
        # QR identity is the immutable account code, not the editable label on
        # a certificate. Use ASCII digits only and never fall back to user ID.
        if len(code) != 10 or not code.isascii() or not code.isdigit():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
        query = query.where(User.code == code)
    else:
        query = query.where(User.id == user_id)
    row = db.execute(query.limit(1)).first()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    user, cert = row
    effective_status = cert.status
    if effective_status == "active" and cert.valid_until is not None:
        # Stored timestamps are naive UTC; tolerate aware timestamps without
        # changing the record or making a guest GET perform database writes.
        valid_until = cert.valid_until
        if valid_until.tzinfo is not None:
            valid_until = valid_until.astimezone(timezone.utc).replace(tzinfo=None)
        if valid_until < datetime.utcnow():
            effective_status = "expired"
    return PublicPersonPageOut(
        id=user.id,
        code=user.code,
        first_name=user.first_name,
        last_name=user.last_name,
        email=user.email,
        created_at=user.created_at,
        certificate=PublicCertificateOut(
            unique_code=cert.unique_code,
            level=cert.level,
            status=effective_status,
            issue_date=cert.issue_date,
            validity_term=cert.validity_term,
            valid_until=cert.valid_until,
        ),
    )


@router.get("/public/by-code/{code}", response_model=PublicPersonPageOut)
def public_person_page_by_code(code: str, db: Session = Depends(get_db)):
    """Stable QR destination lookup, available without authentication."""
    return _public_person_page(db, code=code)


@router.get("/{user_id}/public-details", response_model=PublicPersonPageOut)
def public_person_page(user_id: int, db: Session = Depends(get_db)):
    """Public profile and certificate verification data for an existing link."""
    return _public_person_page(db, user_id=user_id)


@router.get("/{user_id}/public", response_model=PublicUserOut)
def public_profile(
    user_id: int,
    db: Session = Depends(get_db),
):
    """
    Public profile lookup by user_id. Returns only the fields approved for public display.
    Access: public, but only for people included in the certified-person registry.
    """
    user = db.scalar(
        select(User)
        .join(Certificate, Certificate.user_id == User.id)
        .where(
            User.id == user_id,
            Certificate.status.in_(("active", "suspended", "expired")),
        )
        .limit(1)
    )
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return PublicUserOut(
        first_name=user.first_name,
        last_name=user.last_name,
        email=user.email,
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
    if not is_admin_user and expire_unused_stage_permissions(db, u, commit=True):
        db.refresh(u)
    exam_state = exam_state_with_permissions(db, u, is_admin_user=is_admin_user)
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
        exam_permission=bool(exam_state["exam_permission"]),
        exam_stage=exam_state["exam_stage"],
        exam_stage_expires_at=exam_state["exam_stage_expires_at"],
        exam_stage_started_at=exam_state["exam_stage_started_at"],
        exam_stage_status=exam_state["exam_stage_status"],
        exam_stage_remaining_seconds=exam_state["exam_stage_remaining_seconds"],
        exam_stage_permissions=exam_state["exam_stage_permissions"],
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

    if personal_id_changed:
        try:
            move_user_code(db, user, personal_id)
        except (UserCodeConflict, IntegrityError):
            db.rollback()
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="ამ პირად ნომერზე კოდის გადაბმა შეუძლებელია; მიმართეთ ადმინისტრატორს")

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
        if expire_unused_stage_permissions(db, user, commit=True):
            db.refresh(user)
        exam_perm = bool(user.exam_permission)

    exam_state = exam_state_with_permissions(db, user, is_admin_user=is_admin_user)
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
        exam_permission=bool(exam_state.get("exam_permission", exam_perm)),
        exam_stage=exam_state.get("exam_stage"),
        exam_stage_expires_at=exam_state.get("exam_stage_expires_at"),
        exam_stage_started_at=exam_state.get("exam_stage_started_at"),
        exam_stage_status=exam_state.get("exam_stage_status"),
        exam_stage_remaining_seconds=exam_state.get("exam_stage_remaining_seconds"),
        exam_stage_permissions=exam_state.get("exam_stage_permissions", {}),
        created_at=user.created_at,
    )


CERTIFICATE_LEVEL_LABELS = {
    "architect": "შენობა-ნაგებობის არქიტექტორი",
    "municipal": "პროექტის შემსწავლელი სპეციალისტი",
    "expert": "არქიტექტურული პროექტის ექსპერტი",
}

CERTIFICATE_STATUS_LABELS = {
    "active": "მოქმედი",
    "suspended": "შეჩერებული",
    "expired": "ვადაგასული",
}


def _format_cert_date(dt: datetime | None) -> str:
    if not dt:
        return "—"
    return dt.strftime("%d-%m-%Y")


DEFAULT_CERT_ISSUED_SUBJECT = "სერტიფიკატის გაცემა და საჯარო რეესტრში ასახვა"
DEFAULT_CERT_ISSUED_BODY = (
    "ბატონო/ქალბატონო {name},\n"
    "გაცნობებთ, რომ თქვენზე გაიცა შესაბამისობის სერტიფიკატი და მონაცემები აისახა ინსტიტუტის სერტიფიცირებულ პირთა საჯარო რეესტრში.\n\n"
    "• სერტიფიკატის ნომერი: {code}\n"
    "• სერტიფიცირების კატეგორია: {qualification}\n"
    "• გაცემის თარიღი: {issue_date}\n"
    "• მოქმედების ბოლო თარიღი: {valid_until}\n"
    "• საჯარო რეესტრის ბმული: https://gipc.org.ge\n\n"
    "შეტყობინებას თან ერთვის ელექტრონული სერტიფიკატი (PDF). სერტიფიკატისა და სერტიფიცირების სტატუსის გამოყენება დასაშვებია მხოლოდ მინიჭებული კატეგორიის, მოქმედების ვადისა და სასერტიფიკაციო ხელშეკრულებით განსაზღვრული პირობების ფარგლებში (GIPC-PRO-006).\n\n"
    "პატივისცემით,\n"
    "შპს „საქართველოს პროფესიული სერტიფიცირების ინსტიტუტი“"
)


def _load_saved_cert_issued_template() -> tuple[str, str]:
    try:
        root = ensure_media_root().resolve()
        meta_path = (root / "planning" / "templates" / "cert_issued" / "template.json").resolve()
        if meta_path.is_file():
            data = json.loads(meta_path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                subj = (data.get("subject") or "").strip() or DEFAULT_CERT_ISSUED_SUBJECT
                body = (data.get("body") or "").strip() or DEFAULT_CERT_ISSUED_BODY
                return subj, body
    except Exception:
        pass
    return DEFAULT_CERT_ISSUED_SUBJECT, DEFAULT_CERT_ISSUED_BODY


def _render_cert_tokens(text: str, tokens: dict[str, str]) -> str:
    result = text or ""
    for key, val in tokens.items():
        result = result.replace(f"{{{key}}}", val)
    return result


def _build_certificate_activation_email(
    user: User,
    cert: Certificate,
    custom_subject: str | None = None,
    custom_body: str | None = None,
) -> tuple[str, str]:
    full_name = f"{(user.first_name or '').strip()} {(user.last_name or '').strip()}".strip() or "—"
    unique_code = (cert.unique_code or user.code or "—").strip()
    level_key = (cert.level or "architect").strip().lower()
    qualification_label = CERTIFICATE_LEVEL_LABELS.get(level_key, cert.level or "—")
    status_key = (cert.status or "active").strip().lower()
    status_label = CERTIFICATE_STATUS_LABELS.get(status_key, cert.status or "მოქმედი")
    issue_date_str = _format_cert_date(cert.issue_date or cert.created_at or datetime.utcnow())
    valid_until_str = _format_cert_date(cert.valid_until)

    tokens = {
        "name": full_name,
        "personal_id": user.personal_id or "—",
        "code": unique_code,
        "qualification": qualification_label,
        "status": status_label,
        "issue_date": issue_date_str,
        "valid_until": valid_until_str,
        "date": issue_date_str,
    }

    tmpl_subject, tmpl_body = _load_saved_cert_issued_template()
    raw_subject = (custom_subject or "").strip() or tmpl_subject
    raw_body = (custom_body or "").strip() or tmpl_body

    return _render_cert_tokens(raw_subject, tokens), _render_cert_tokens(raw_body, tokens)


def _send_certificate_activation_notification(
    db: Session,
    user: User,
    cert: Certificate,
    actor_email: str,
    custom_subject: str | None = None,
    custom_body: str | None = None,
) -> tuple[str, str | None]:
    subject, body = _build_certificate_activation_email(user, cert, custom_subject, custom_body)
    now = datetime.utcnow()
    req_id = str(uuid4())
    fingerprint = hashlib.sha256(
        json.dumps(
            {
                "user_id": user.id,
                "cert_id": cert.id,
                "unique_code": cert.unique_code,
                "status": cert.status,
                "req_id": req_id,
            },
            ensure_ascii=False,
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()

    attachment_path_rel: str | None = None
    attachment_filename: str | None = None
    attachment_size: int | None = None

    if cert.file_path:
        try:
            src_path = resolve_storage_path(cert.file_path)
            if src_path.is_file():
                size = src_path.stat().st_size
                if 0 < size <= ATTACHMENT_MAX_BYTES:
                    root = ensure_media_root().resolve()
                    dest_dir = (root / "planning" / f"letters/{user.id}").resolve()
                    if dest_dir.is_relative_to(root / "planning"):
                        dest_dir.mkdir(parents=True, exist_ok=True)
                        dest_path = dest_dir / f"{uuid4().hex}.pdf"
                        shutil.copyfile(src_path, dest_path)
                        attachment_path_rel = relative_storage_path(dest_path)
                        code_label = (cert.unique_code or user.code or "certificate").strip()
                        attachment_filename = f"certificate-{code_label}.pdf"
                        attachment_size = int(size)
        except Exception:
            attachment_path_rel = None
            attachment_filename = None
            attachment_size = None

    letter = PlanningLetter(
        user_id=user.id,
        kind="certificate",
        event_date=(cert.issue_date or now).date(),
        event_time=now.strftime("%H:%M"),
        period="cert_issued",
        request_id=req_id,
        request_fingerprint=fingerprint,
        to_email=user.email,
        subject=subject,
        body=body,
        attachment_filename=attachment_filename,
        attachment_path=attachment_path_rel,
        attachment_size_bytes=attachment_size,
        status="sending",
        attempts=1,
        created_by=actor_email,
    )
    db.add(letter)
    db.commit()
    db.refresh(letter)

    try:
        delivery_status, error = deliver_letter(letter)
        if delivery_status not in ("sent", "failed", "simulated", "uncertain"):
            raise ValueError("Invalid delivery result")
    except Exception:
        delivery_status, error = "uncertain", "გაგზავნის შედეგი დაუდასტურებელია. გადაამოწმეთ ოფიციალური ელფოსტა."
    letter.status, letter.error = delivery_status, error
    if delivery_status == "sent":
        letter.sent_at = datetime.utcnow()
    db.add(letter)
    db.commit()
    db.refresh(letter)
    return letter.status, letter.error


def _certificate_out_with_notification(
    cert: Certificate,
    notification_status: str | None = None,
    notification_error: str | None = None,
) -> CertificateOut:
    out = CertificateOut.model_validate(cert)
    out.notification_status = notification_status
    out.notification_error = notification_error
    return out


@router.get("/{user_id}/certificate", response_model=CertificateOut)
def get_certificate(
    user_id: int,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """Get certificate for a user"""
    user = db.scalar(select(User).where(User.id == user_id))
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    # AuthZ: allow any authenticated actor to view certificate metadata
    _require_auth(db, authorization)
    
    cert = db.scalar(select(Certificate).where(Certificate.user_id == user_id))
    if not cert:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Certificate not found")
    
    return CertificateOut.model_validate(cert)


@router.post("/{user_id}/certificate", response_model=CertificateOut, status_code=status.HTTP_201_CREATED)
def create_certificate(
    user_id: int,
    payload: CertificateCreate,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """Create certificate for a user"""
    user = db.scalar(select(User).where(User.id == user_id))
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    # Only admin/founder can create
    actor = _require_admin(db, authorization)
    
    existing = db.scalar(select(Certificate).where(Certificate.user_id == user_id))
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Certificate already exists")
    
    cert = Certificate(
        user_id=user_id,
        unique_code=payload.unique_code or user.code,
        level=payload.level or "architect",
        status=payload.status or "active",
        issue_date=payload.issue_date,
        validity_term=payload.validity_term,
        valid_until=payload.valid_until,
        exam_score=None,
    )
    db.add(cert)
    db.commit()
    db.refresh(cert)
    
    notif_status = None
    notif_error = None
    if payload.send_notification:
        notif_status, notif_error = _send_certificate_activation_notification(
            db, user, cert, actor.email, payload.notification_subject, payload.notification_body
        )
    
    return _certificate_out_with_notification(cert, notif_status, notif_error)


@router.put("/{user_id}/certificate", response_model=CertificateOut)
def update_certificate(
    user_id: int,
    payload: CertificateUpdate,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """Update certificate for a user"""
    user = db.scalar(select(User).where(User.id == user_id))
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    # Only admin/founder can update
    actor = _require_admin(db, authorization)
    
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
    cert.exam_score = None
    
    cert.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(cert)
    
    notif_status = None
    notif_error = None
    if payload.send_notification:
        notif_status, notif_error = _send_certificate_activation_notification(
            db, user, cert, actor.email, payload.notification_subject, payload.notification_body
        )
    
    return _certificate_out_with_notification(cert, notif_status, notif_error)


@router.post("/{user_id}/certificate/notify", response_model=CertificateOut)
def notify_certificate_activation(
    user_id: int,
    payload: CertificateNotifyRequest | None = Body(None),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """Send official §3.11 certificate issuance & public registry activation notification."""
    user = db.scalar(select(User).where(User.id == user_id))
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    actor = _require_admin(db, authorization)
    cert = db.scalar(select(Certificate).where(Certificate.user_id == user_id))
    if not cert:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Certificate not found")
    notif_status, notif_error = _send_certificate_activation_notification(
        db,
        user,
        cert,
        actor.email,
        payload.subject if payload else None,
        payload.body if payload else None,
    )
    return _certificate_out_with_notification(cert, notif_status, notif_error)


@router.delete("/{user_id}/certificate", status_code=status.HTTP_204_NO_CONTENT)
def delete_certificate(
    user_id: int,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """Delete certificate for a user"""
    user = db.scalar(select(User).where(User.id == user_id))
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    # Only admin/founder can delete
    _require_admin(db, authorization)
    
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
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """Upload certificate PDF for a user (admin/founder only)."""
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    # Only admin/founder can upload
    _require_admin(db, authorization)

    cert = db.scalar(select(Certificate).where(Certificate.user_id == user_id))
    if not cert:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Certificate not found")

    content_type = (file.content_type or "").lower()
    if content_type not in ("application/pdf", "application/x-pdf", "binary/octet-stream", "application/octet-stream"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="ფაილი უნდა იყოს PDF")

    # Keep the currently published file intact until the database accepts the
    # replacement. A unique server-side name also avoids overwriting a legacy
    # certificate.pdf before the commit succeeds.
    previous_file_path = cert.file_path
    target = certificate_file_path(user_id, f"certificate-{uuid4().hex}.pdf")
    new_file_saved = False

    try:
        size = save_upload_stream(
            file.file,
            target,
            max_bytes=CERTIFICATE_UPLOAD_MAX_BYTES,
        )
        new_file_saved = True

        # Update DB meta. The filename remains stable so downloads keep the
        # existing public filename even though storage uses a unique name.
        new_file_path = relative_storage_path(target)
        cert.file_path = new_file_path
        cert.filename = "certificate.pdf"
        cert.mime_type = "application/pdf"
        cert.size_bytes = int(size)
        cert.updated_at = datetime.utcnow()
        db.add(cert)
        db.commit()
    except UploadTooLarge as exc:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="file too large (max 100MB)",
        ) from exc
    except BaseException:
        # A write/path/DB failure must leave the old certificate available and
        # must not leave a partial or unreferenced replacement behind.
        try:
            db.rollback()
        finally:
            if new_file_saved:
                try:
                    target.unlink(missing_ok=True)
                except OSError:
                    pass
        raise

    # Only after the new path is committed may the old file be removed. The
    # storage helper rejects paths outside MEDIA_ROOT and supports legacy paths.
    if previous_file_path and previous_file_path != new_file_path:
        try:
            delete_storage_file(previous_file_path)
        except Exception:
            pass
    return None


@router.get("/{user_id}/certificate/file")
def download_certificate_file(
    user_id: int,
    authorization: str | None = Header(None, alias="Authorization"),
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


@router.get("/me", response_model=UserOut)
def get_current_user_info(
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """
    Get current authenticated user's info.
    Returns fresh data from database (not cached).
    """
    user = _require_auth(db, authorization)
    
    # Refresh from database to get latest values
    db.refresh(user)
    
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
        exam_perm = True
    else:
        if expire_unused_stage_permissions(db, user, commit=True):
            db.refresh(user)
        exam_perm = bool(user.exam_permission)

    exam_state = exam_state_with_permissions(db, user, is_admin_user=is_admin_user)
    
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
        exam_permission=bool(exam_state.get("exam_permission", exam_perm)),
        exam_stage=exam_state.get("exam_stage"),
        exam_stage_expires_at=exam_state.get("exam_stage_expires_at"),
        exam_stage_started_at=exam_state.get("exam_stage_started_at"),
        exam_stage_status=exam_state.get("exam_stage_status"),
        exam_stage_remaining_seconds=exam_state.get("exam_stage_remaining_seconds"),
        exam_stage_permissions=exam_state.get("exam_stage_permissions", {}),
        created_at=user.created_at,
    )
