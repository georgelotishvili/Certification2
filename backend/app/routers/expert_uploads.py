from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, status, Header, UploadFile, File, Form, Path as FPath, Query
from fastapi.responses import FileResponse
from sqlalchemy import select, func
from sqlalchemy.orm import Session

from ..database import get_db
from ..config import get_settings
from ..models import User, Certificate, ExpertUpload
from ..schemas import ExpertUploadOut
from ..services.media_storage import ensure_media_root, resolve_storage_path, delete_storage_file


router = APIRouter()

ALLOWED_EXTS = {".pdf", ".zip", ".rar"}
MAX_BYTES = 1024 * 1024 * 1024  # 1GB


def _actor(db: Session, actor_email: Optional[str]) -> User:
    eml = (actor_email or "").strip().lower()
    if not eml:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="actor required")
    user = db.scalar(select(User).where(User.email == eml))
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="actor not found")
    return user


def _must_expert(db: Session, user_id: int) -> Certificate:
    cert = db.scalar(select(Certificate).where(Certificate.user_id == user_id))
    if not cert:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="not certified")
    if (cert.level or "").lower() != "expert":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="not expert")
    return cert


def _ensure_owner(upload: ExpertUpload, user_id: int):
    if upload.user_id != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="not owner")


def _gen_unique_code(db: Session) -> str:
    today = datetime.utcnow().strftime("%Y-%m-%d")
    prefix = f"EX-{today}-"
    count = db.scalar(select(func.count(ExpertUpload.id)).where(ExpertUpload.unique_code.like(f"{prefix}%"))) or 0
    seq = f"{count + 1:03d}"
    return prefix + seq


def _expert_dir(unique_code: str) -> Path:
    root = ensure_media_root()
    d = root / "expert" / unique_code
    d.mkdir(parents=True, exist_ok=True)
    return d


def _validate_file(upload: Optional[UploadFile]):
    if not upload:
        return
    ext = os.path.splitext(upload.filename or "")[1].lower()
    if ext not in ALLOWED_EXTS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="file type not allowed")
    # Try read small chunk to detect size; rely on header otherwise
    try:
        upload.file.seek(0, os.SEEK_END)
        size = upload.file.tell()
        upload.file.seek(0)
        if size and size > MAX_BYTES:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="file too large")
    except Exception:
        pass


def _save_file(unique_code: str, upload: UploadFile) -> tuple[str, str]:
    directory = _expert_dir(unique_code)
    safe_name = os.path.basename(upload.filename or "file")
    path = directory / safe_name
    with open(path, "wb") as f:
        while True:
            chunk = upload.file.read(1024 * 1024)
            if not chunk:
                break
            f.write(chunk)
    rel = str(path.resolve().relative_to(ensure_media_root().resolve()))
    return rel, safe_name


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
def list_mine(x_actor_email: Optional[str] = Header(None, alias="x-actor-email"), db: Session = Depends(get_db)):
    user = _actor(db, x_actor_email)
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
        cert = _must_expert(db, user_id)
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
    x_actor_email: Optional[str] = Header(None, alias="x-actor-email"),
    db: Session = Depends(get_db),
):
    user = _actor(db, x_actor_email)
    _must_expert(db, user.id)
    code = _gen_unique_code(db)
    eu = ExpertUpload(
        user_id=user.id,
        unique_code=code,
        status="draft",
        building_function=building_function.strip(),
        cadastral_code=cadastral_code.strip(),
        project_address=project_address.strip(),
    )
    _validate_file(expertise)
    _validate_file(project)
    if expertise:
        eu.expertise_path, eu.expertise_filename = _save_file(code, expertise)
    if project:
        eu.project_path, eu.project_filename = _save_file(code, project)
    db.add(eu)
    db.commit()
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
    x_actor_email: Optional[str] = Header(None, alias="x-actor-email"),
    db: Session = Depends(get_db),
):
    user = _actor(db, x_actor_email)
    _must_expert(db, user.id)
    eu = db.scalar(select(ExpertUpload).where(ExpertUpload.id == upload_id))
    if not eu:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    _ensure_owner(eu, user.id)
    if eu.status != "draft":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="not editable")

    # Always update fields when provided (even if empty string)
    eu.building_function = building_function.strip()
    eu.cadastral_code = cadastral_code.strip()
    eu.project_address = project_address.strip()
    _validate_file(expertise)
    _validate_file(project)
    if expertise:
        eu.expertise_path, eu.expertise_filename = _save_file(eu.unique_code, expertise)
    if project:
        eu.project_path, eu.project_filename = _save_file(eu.unique_code, project)
    db.commit()
    db.refresh(eu)
    return _to_out(eu)


@router.delete("/{upload_id}/file")
def delete_file(
    upload_id: int,
    file_type: str = Query(..., pattern="^(expertise|project)$"),
    x_actor_email: Optional[str] = Header(None, alias="x-actor-email"),
    db: Session = Depends(get_db),
):
    user = _actor(db, x_actor_email)
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
    x_actor_email: Optional[str] = Header(None, alias="x-actor-email"),
    actor: Optional[str] = Query(None, description="actor email (fallback for links)"),
    db: Session = Depends(get_db),
):
    """
    Admin delete via POST (fallback for environments blocking DELETE).
    """
    return admin_delete_upload(upload_id=upload_id, x_actor_email=x_actor_email, actor=actor, db=db)


@router.post("/{upload_id}/submit", response_model=ExpertUploadOut)
def submit_upload(
    upload_id: int,
    x_actor_email: Optional[str] = Header(None, alias="x-actor-email"),
    db: Session = Depends(get_db),
):
    user = _actor(db, x_actor_email)
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
    x_actor_email: Optional[str] = Header(None, alias="x-actor-email"),
    actor: Optional[str] = Query(None, description="actor email (fallback for links)"),
    db: Session = Depends(get_db),
):
    user = _actor(db, x_actor_email or actor)
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
    x_actor_email: Optional[str] = Header(None, alias="x-actor-email"),
    actor: Optional[str] = Query(None, description="actor email (fallback for links)"),
    db: Session = Depends(get_db),
):
    """
    Delete an expert upload (admin only). Removes DB row and stored files.
    """
    actor = _actor(db, x_actor_email or actor)
    settings = get_settings()
    founder = (settings.founder_admin_email or "").strip().lower()
    if not (actor.is_admin or (actor.email or "").strip().lower() == founder):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="admin only")
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