from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path
from typing import List, Optional
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, status, Header, UploadFile, File, Form, Path as FPath, Query
from fastapi.responses import FileResponse
from sqlalchemy import select, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..database import get_db
from ..config import get_settings
from ..models import User, Certificate, ExpertUpload, UserSession
from ..schemas import ExpertUploadOut
from ..services.candidate_status import compute_effective_certificate_status, get_transitional_deadline_date
from ..services.media_storage import ensure_media_root, resolve_storage_path, delete_storage_file
from ..services.bounded_upload import (
    DEFAULT_UPLOAD_MAX_BYTES,
    UploadTooLarge,
    save_upload_stream,
)


router = APIRouter()

ALLOWED_EXTS = {".pdf", ".zip", ".rar"}
MAX_BYTES = DEFAULT_UPLOAD_MAX_BYTES


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


def _must_expert(db: Session, user_id: int, *, require_active: bool = True) -> Certificate:
    cert = db.scalar(select(Certificate).where(Certificate.user_id == user_id))
    if not cert:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="not certified")
    if (cert.level or "").lower() != "expert":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="not expert")
    if require_active:
        eff_status = compute_effective_certificate_status(cert, get_transitional_deadline_date())
        if eff_status != "active":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="სერტიფიკატი არ არის აქტიური (შეჩერებულია ან ვადაგასულია)",
            )
    return cert


def _ensure_owner(upload: ExpertUpload, user_id: int):
    if upload.user_id != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="not owner")


def _gen_unique_code(db: Session) -> str:
    today = datetime.utcnow().strftime("%Y-%m-%d")
    prefix = f"EX-{today}-"
    existing_codes = db.scalars(
        select(ExpertUpload.unique_code).where(ExpertUpload.unique_code.like(f"{prefix}%"))
    ).all()
    max_seq = 0
    for code in existing_codes:
        suffix = (code or "")[len(prefix):]
        if suffix.isdigit():
            max_seq = max(max_seq, int(suffix))
    return f"{prefix}{max_seq + 1:03d}"


def _expert_dir(unique_code: str) -> Path:
    if not isinstance(unique_code, str):
        raise ValueError("Invalid expert storage code")

    code = unique_code.strip()
    if (
        len(code) <= len("EX-")
        or not code.startswith("EX-")
        or "/" in code
        or chr(92) in code
    ):
        raise ValueError("Invalid expert storage code")

    code_path = Path(code)
    if code_path.is_absolute() or code_path.parts != (code,) or code_path.name != code:
        raise ValueError("Invalid expert storage code")

    try:
        media_root = ensure_media_root().resolve()
        configured_expert_root = media_root / "expert"
        if configured_expert_root.is_symlink():
            raise ValueError("Invalid expert storage root")
        configured_expert_root.mkdir(exist_ok=True)
        if configured_expert_root.is_symlink():
            raise ValueError("Invalid expert storage root")

        expert_root = configured_expert_root.resolve()
        if (
            expert_root != configured_expert_root
            or expert_root.parent != media_root
            or not expert_root.is_dir()
        ):
            raise ValueError("Invalid expert storage root")

        candidate = expert_root / code
        if candidate.is_symlink():
            raise ValueError("Invalid expert storage directory")
        candidate.mkdir(exist_ok=True)
        if candidate.is_symlink():
            raise ValueError("Invalid expert storage directory")

        expert_dir = candidate.resolve()
        if (
            expert_dir != candidate
            or expert_dir.parent != expert_root
            or not expert_dir.is_dir()
        ):
            raise ValueError("Invalid expert storage directory")
        return expert_dir
    except (OSError, RuntimeError) as exc:
        raise ValueError("Invalid expert storage directory") from exc


def _validate_file(upload: Optional[UploadFile]):
    if not upload:
        return
    ext = os.path.splitext(upload.filename or "")[1].lower()
    if ext not in ALLOWED_EXTS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="file type not allowed")


def _save_file(unique_code: str, upload: UploadFile) -> tuple[str, str]:
    directory = _expert_dir(unique_code)
    safe_name = os.path.basename(upload.filename or "file")
    ext = os.path.splitext(safe_name)[1].lower()
    path = directory / f"{uuid4().hex}{ext}"
    try:
        save_upload_stream(upload.file, path, max_bytes=MAX_BYTES)
    except UploadTooLarge as exc:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="file too large (max 100MB)",
        ) from exc
    rel = str(path.resolve().relative_to(ensure_media_root().resolve()))
    return rel, safe_name


def _cleanup_saved_files(storage_paths: list[str]) -> None:
    for storage_path in storage_paths:
        delete_storage_file(storage_path)


def _to_out(eu: ExpertUpload) -> ExpertUploadOut:
    return ExpertUploadOut(
        id=eu.id,
        unique_code=eu.unique_code,
        status=eu.status,
        building_function=eu.building_function or "",
        cadastral_code=eu.cadastral_code or "",
        project_address=eu.project_address or "",
        expertise_filename=eu.expertise_filename,
        project_filename=eu.project_filename,
        created_at=eu.created_at,
        submitted_at=eu.submitted_at,
    )


@router.get("/mine", response_model=List[ExpertUploadOut])
def list_mine(authorization: str | None = Header(None, alias="Authorization"), db: Session = Depends(get_db)):
    user = _require_auth(db, authorization)
    rows = db.execute(select(ExpertUpload).where(ExpertUpload.user_id == user.id).order_by(ExpertUpload.created_at.desc(), ExpertUpload.id.desc())).scalars().all()
    return [_to_out(row) for row in rows]


@router.get("/of/{user_id}", response_model=List[ExpertUploadOut])
def list_public_of(user_id: int, db: Session = Depends(get_db)):
    """
    Public list of submitted expert uploads for a given user.
    No authentication required.
    """
    # Ensure user is expert-certified; otherwise allow but will likely be empty
    try:
        cert = _must_expert(db, user_id, require_active=False)
        _ = cert  # silence linter
    except HTTPException:
        # Not expert or not certified -> return empty list
        return []
    rows = db.execute(
        select(ExpertUpload).where(
            ExpertUpload.user_id == user_id,
            ExpertUpload.status == "submitted",
        ).order_by(ExpertUpload.created_at.desc(), ExpertUpload.id.desc())
    ).scalars().all()
    return [_to_out(row) for row in rows]

@router.post("", response_model=ExpertUploadOut, status_code=status.HTTP_201_CREATED)
async def create_upload(
    building_function: str = Form(""),
    cadastral_code: str = Form(""),
    project_address: str = Form(""),
    expertise: UploadFile | None = File(None),
    project: UploadFile | None = File(None),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    user = _require_auth(db, authorization)
    _must_expert(db, user.id)
    _validate_file(expertise)
    _validate_file(project)
    eu: ExpertUpload | None = None
    code = ""
    for _attempt in range(5):
        code = _gen_unique_code(db)
        candidate = ExpertUpload(
            user_id=user.id,
            unique_code=code,
            status="draft",
            building_function=building_function.strip(),
            cadastral_code=cadastral_code.strip(),
            project_address=project_address.strip(),
        )
        db.add(candidate)
        try:
            db.flush()
            eu = candidate
            break
        except IntegrityError:
            db.rollback()
    if eu is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="????????? ????? ????????? ??? ????????, ?????? ???????")
    saved_paths: list[str] = []
    try:
        if expertise:
            eu.expertise_path, eu.expertise_filename = _save_file(code, expertise)
            saved_paths.append(eu.expertise_path)
        if project:
            eu.project_path, eu.project_filename = _save_file(code, project)
            saved_paths.append(eu.project_path)
        db.add(eu)
        db.commit()
    except BaseException:
        try:
            db.rollback()
        except Exception:
            pass
        _cleanup_saved_files(saved_paths)
        raise
    db.refresh(eu)
    return _to_out(eu)


@router.put("/{upload_id}", response_model=ExpertUploadOut)
async def update_upload(
    upload_id: int = FPath(..., ge=1),
    building_function: str = Form(""),
    cadastral_code: str = Form(""),
    project_address: str = Form(""),
    expertise: UploadFile | None = File(None),
    project: UploadFile | None = File(None),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    user = _require_auth(db, authorization)
    _must_expert(db, user.id)
    eu = db.scalar(select(ExpertUpload).where(ExpertUpload.id == upload_id))
    if not eu:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    _ensure_owner(eu, user.id)
    if eu.status != "draft":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="not editable")

    _validate_file(expertise)
    _validate_file(project)

    previous_expertise_path = eu.expertise_path
    previous_project_path = eu.project_path
    saved_paths: list[str] = []
    try:
        new_expertise = _save_file(eu.unique_code, expertise) if expertise else None
        if new_expertise:
            saved_paths.append(new_expertise[0])
        new_project = _save_file(eu.unique_code, project) if project else None
        if new_project:
            saved_paths.append(new_project[0])

        # Always update fields when provided (even if empty string).
        eu.building_function = building_function.strip()
        eu.cadastral_code = cadastral_code.strip()
        eu.project_address = project_address.strip()
        if new_expertise:
            eu.expertise_path, eu.expertise_filename = new_expertise
        if new_project:
            eu.project_path, eu.project_filename = new_project
        db.commit()
    except BaseException:
        try:
            db.rollback()
        except Exception:
            pass
        _cleanup_saved_files(saved_paths)
        raise
    db.refresh(eu)

    if expertise and previous_expertise_path and previous_expertise_path != eu.expertise_path:
        delete_storage_file(previous_expertise_path)
    if project and previous_project_path and previous_project_path != eu.project_path:
        delete_storage_file(previous_project_path)

    return _to_out(eu)


@router.delete("/{upload_id}/file")
def delete_file(
    upload_id: int,
    file_type: str = Query(..., pattern="^(expertise|project)$"),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    user = _require_auth(db, authorization)
    eu = db.scalar(select(ExpertUpload).where(ExpertUpload.id == upload_id))
    if not eu:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    _ensure_owner(eu, user.id)
    if eu.status != "draft":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="not editable")
    path_attr = f"{file_type}_path"
    name_attr = f"{file_type}_filename"
    path = getattr(eu, path_attr, None)
    if path:
        delete_storage_file(path)
    setattr(eu, path_attr, None)
    setattr(eu, name_attr, None)
    db.commit()
    return {"ok": True}

@router.post("/{upload_id}/delete")
def admin_delete_upload_post(
    upload_id: int,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """
    Admin delete via POST (fallback for environments blocking DELETE).
    """
    return admin_delete_upload(upload_id=upload_id, authorization=authorization, db=db)


@router.post("/{upload_id}/submit", response_model=ExpertUploadOut)
def submit_upload(
    upload_id: int,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    user = _require_auth(db, authorization)
    _must_expert(db, user.id)
    eu = db.scalar(select(ExpertUpload).where(ExpertUpload.id == upload_id))
    if not eu:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    _ensure_owner(eu, user.id)
    if eu.status != "draft":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="already submitted")
    # Require both files to be present
    if not eu.expertise_path or not eu.project_path:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="both files required")
    eu.status = "submitted"
    eu.submitted_at = datetime.utcnow()
    db.commit()
    db.refresh(eu)
    return _to_out(eu)


@router.get("/{upload_id}/download")
def download_file(
    upload_id: int,
    file_type: str = Query(..., pattern="^(expertise|project)$"),
    authorization: str | None = Header(None, alias="Authorization"),
    token: str | None = Query(None, description="Bearer token (fallback for direct links)"),
    db: Session = Depends(get_db),
):
    # Support both header and query token for direct links
    auth_str = authorization or (f"Bearer {token}" if token else None)
    user = _require_auth(db, auth_str)
    eu = db.scalar(select(ExpertUpload).where(ExpertUpload.id == upload_id))
    if not eu:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    _ensure_owner(eu, user.id)
    path_attr = f"{file_type}_path"
    name_attr = f"{file_type}_filename"
    path = getattr(eu, path_attr, None)
    filename = getattr(eu, name_attr, None) or "file"
    if not path:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="file not found")
    abs_path = resolve_storage_path(path)
    if not abs_path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="file not found")
    return FileResponse(abs_path, filename=filename)


@router.get("/public/{upload_id}/download")
def public_download_file(
    upload_id: int,
    file_type: str = Query(..., pattern="^(expertise|project)$"),
    db: Session = Depends(get_db),
):
    """
    Public download for submitted expert uploads only.
    """
    eu = db.scalar(select(ExpertUpload).where(ExpertUpload.id == upload_id))
    if not eu:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    if eu.status != "submitted":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="not public")
    path_attr = f"{file_type}_path"
    name_attr = f"{file_type}_filename"
    path = getattr(eu, path_attr, None)
    filename = getattr(eu, name_attr, None) or "file"
    if not path:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="file not found")
    abs_path = resolve_storage_path(path)
    if not abs_path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="file not found")
    return FileResponse(abs_path, filename=filename)


@router.delete("/{upload_id}")
def admin_delete_upload(
    upload_id: int,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """
    Delete an expert upload (admin only). Removes DB row and stored files.
    """
    _require_admin(db, authorization)
    eu = db.scalar(select(ExpertUpload).where(ExpertUpload.id == upload_id))
    if not eu:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    # Remove files if present
    for path_attr in ("expertise_path", "project_path"):
        path = getattr(eu, path_attr, None)
        if path:
            delete_storage_file(path)
    db.delete(eu)
    db.commit()
    return {"ok": True}
