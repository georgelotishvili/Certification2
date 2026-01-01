from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import List
import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, status, Path as FPath, UploadFile, File
from fastapi.responses import FileResponse
from sqlalchemy import select, func
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Regulation
from ..routers.admin import _require_admin
from ..services.media_storage import ensure_media_root
from pydantic import BaseModel


router = APIRouter()


# Schemas
class RegulationOut(BaseModel):
    id: int
    title: str
    filename: str | None
    order_index: int
    created_at: datetime

    class Config:
        from_attributes = True


class RegulationCreate(BaseModel):
    title: str = ""


class RegulationUpdate(BaseModel):
    title: str | None = None


class RegulationsReorderRequest(BaseModel):
    ids: List[int]


# Constants
REGULATIONS_FOLDER = "regulations"
ALLOWED_EXTENSIONS = {".pdf"}


def _get_regulations_folder() -> Path:
    """Get the regulations folder path."""
    media_root = ensure_media_root()
    folder = media_root / REGULATIONS_FOLDER
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _regulation_out(reg: Regulation) -> RegulationOut:
    return RegulationOut(
        id=reg.id,
        title=reg.title or "",
        filename=reg.filename,
        order_index=reg.order_index or 0,
        created_at=reg.created_at,
    )


# ----------------- Admin endpoints -----------------


@router.get("/admin/regulations", response_model=List[RegulationOut])
def admin_list_regulations(
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    regulations = db.scalars(select(Regulation).order_by(Regulation.order_index.asc(), Regulation.id.asc())).all()
    return [_regulation_out(r) for r in regulations]


@router.post("/admin/regulations", response_model=RegulationOut, status_code=status.HTTP_201_CREATED)
def admin_create_regulation(
    payload: RegulationCreate,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)

    max_order = db.scalar(select(func.max(Regulation.order_index))) or 0

    regulation = Regulation(
        order_index=int(max_order) + 1,
        title=payload.title.strip() if payload.title else "",
    )
    db.add(regulation)
    db.commit()
    db.refresh(regulation)

    return _regulation_out(regulation)


@router.put("/admin/regulations/{regulation_id}", response_model=RegulationOut)
def admin_update_regulation(
    payload: RegulationUpdate,
    regulation_id: int = FPath(..., ge=1),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    regulation = db.get(Regulation, regulation_id)
    if not regulation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Regulation not found")

    if payload.title is not None:
        regulation.title = payload.title.strip()

    db.add(regulation)
    db.commit()
    db.refresh(regulation)

    return _regulation_out(regulation)


@router.post("/admin/regulations/{regulation_id}/upload", response_model=RegulationOut)
def admin_upload_regulation_file(
    regulation_id: int = FPath(..., ge=1),
    file: UploadFile = File(...),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    regulation = db.get(Regulation, regulation_id)
    if not regulation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Regulation not found")

    # Validate file extension
    original_filename = file.filename or "document"
    ext = Path(original_filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"File type not allowed. Allowed: {', '.join(ALLOWED_EXTENSIONS)}"
        )

    # Delete old file if exists
    if regulation.file_path:
        old_path = Path(regulation.file_path)
        if old_path.exists():
            try:
                old_path.unlink()
            except Exception:
                pass

    # Save new file
    folder = _get_regulations_folder()
    unique_name = f"{uuid.uuid4().hex}{ext}"
    file_path = folder / unique_name

    try:
        content = file.file.read()
        file_path.write_bytes(content)
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Failed to save file: {e}")

    # Update regulation
    regulation.filename = original_filename
    regulation.file_path = str(file_path).replace("\\", "/")
    regulation.updated_at = datetime.utcnow()

    db.add(regulation)
    db.commit()
    db.refresh(regulation)

    return _regulation_out(regulation)


@router.get("/admin/regulations/{regulation_id}/download")
def admin_download_regulation(
    regulation_id: int = FPath(..., ge=1),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    regulation = db.get(Regulation, regulation_id)
    if not regulation or not regulation.file_path:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    file_path = Path(regulation.file_path)
    if not file_path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found on disk")

    return FileResponse(
        path=str(file_path),
        filename=regulation.filename or "document",
        media_type="application/octet-stream",
    )


@router.post("/admin/regulations/reorder", status_code=status.HTTP_204_NO_CONTENT)
def admin_reorder_regulations(
    payload: RegulationsReorderRequest,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    ids = [int(v) for v in (payload.ids or []) if isinstance(v, int) or (isinstance(v, str) and v.isdigit())]
    if not ids:
        return

    regulations = db.scalars(select(Regulation).where(Regulation.id.in_(ids))).all()
    by_id = {r.id: r for r in regulations}

    order = 1
    for raw_id in ids:
        reg = by_id.get(int(raw_id))
        if not reg:
            continue
        reg.order_index = order
        db.add(reg)
        order += 1

    db.commit()
    return


@router.delete("/admin/regulations/{regulation_id}", status_code=status.HTTP_204_NO_CONTENT)
def admin_delete_regulation(
    regulation_id: int = FPath(..., ge=1),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    regulation = db.get(Regulation, regulation_id)
    if not regulation:
        return

    # Delete file if exists
    if regulation.file_path:
        file_path = Path(regulation.file_path)
        if file_path.exists():
            try:
                file_path.unlink()
            except Exception:
                pass

    db.delete(regulation)
    db.commit()
    return


# ----------------- Public endpoints (for exam) -----------------


@router.get("/regulations", response_model=List[RegulationOut])
def public_list_regulations(db: Session = Depends(get_db)):
    """Public endpoint for exam - list all regulations."""
    regulations = db.scalars(select(Regulation).order_by(Regulation.order_index.asc(), Regulation.id.asc())).all()
    return [_regulation_out(r) for r in regulations]


@router.get("/regulations/{regulation_id}/view")
def public_view_regulation(
    regulation_id: int = FPath(..., ge=1),
    db: Session = Depends(get_db),
):
    """Public endpoint for exam - view regulation PDF inline."""
    regulation = db.get(Regulation, regulation_id)
    if not regulation or not regulation.file_path:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    file_path = Path(regulation.file_path)
    if not file_path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found on disk")

    # PDF inline display
    return FileResponse(
        path=str(file_path),
        media_type="application/pdf",
        headers={
            "Content-Disposition": "inline",
        },
    )

