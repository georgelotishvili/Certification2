from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, Header, HTTPException, status, UploadFile, File, Path as FPath
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import AppFile
from ..schemas import AppFileOut
from ..services.media_storage import ensure_media_root, resolve_storage_path, delete_storage_file, relative_storage_path
from ..routers.admin import _require_admin


router = APIRouter()


def _app_file_out(f: AppFile) -> AppFileOut:
    return AppFileOut(
        id=f.id,
        filename=f.filename,
        mime_type=f.mime_type,
        size_bytes=f.size_bytes,
        created_at=f.created_at,
        url=f"/app-files/{f.id}/download",
    )


def _ensure_app_files_dir():
    root = ensure_media_root()
    app_dir = root / "app_files"
    app_dir.mkdir(parents=True, exist_ok=True)
    return app_dir


ALLOWED_EXTENSIONS = {".zip", ".rar", ".7z", ".exe", ".msi"}


def _validate_app_file(upload: UploadFile | None) -> None:
    import os

    if not upload:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="file is required")

    ext = os.path.splitext(upload.filename or "")[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="file type not allowed")


async def _save_app_file(upload: UploadFile) -> tuple[str, str, str, int | None]:
    """
    Persist uploaded file under media/app_files and return:
    (relative_storage_path, stored_filename, mime_type, size_bytes)
    """
    import os

    app_dir = _ensure_app_files_dir()
    original_name = os.path.basename(upload.filename or "file")
    if not original_name:
        original_name = "file"

    base, ext = os.path.splitext(original_name)
    if not ext:
        ext = ".zip"

    candidate = app_dir / (base + ext)
    suffix = 1
    while candidate.exists() and suffix < 1000:
        candidate = app_dir / f"{base}_{suffix}{ext}"
        suffix += 1

    size = 0
    with open(candidate, "wb") as out:
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            out.write(chunk)
            size += len(chunk)

    rel_path = relative_storage_path(candidate)
    mime_type = upload.content_type or "application/octet-stream"
    return rel_path, os.path.basename(candidate), mime_type, size or None


# ----------------- Admin endpoints -----------------


@router.get("/admin/app-files", response_model=List[AppFileOut])
def admin_list_app_files(
    x_actor_email: str | None = Header(None, alias="x-actor-email"),
    db: Session = Depends(get_db),
):
    _require_admin(db, x_actor_email)
    files = db.scalars(select(AppFile).order_by(AppFile.created_at.desc())).all()
    return [_app_file_out(f) for f in files]


@router.post("/admin/app-files", response_model=AppFileOut, status_code=status.HTTP_201_CREATED)
async def admin_create_app_file(
    file: UploadFile = File(...),
    x_actor_email: str | None = Header(None, alias="x-actor-email"),
    db: Session = Depends(get_db),
):
    _require_admin(db, x_actor_email)
    _validate_app_file(file)

    storage_path, stored_filename, mime_type, size_bytes = await _save_app_file(file)

    app_file = AppFile(
        storage_path=storage_path,
        filename=stored_filename,
        mime_type=mime_type,
        size_bytes=size_bytes,
    )
    db.add(app_file)
    db.commit()
    db.refresh(app_file)

    return _app_file_out(app_file)


@router.delete("/admin/app-files/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
def admin_delete_app_file(
    file_id: int = FPath(..., ge=1),
    x_actor_email: str | None = Header(None, alias="x-actor-email"),
    db: Session = Depends(get_db),
):
    _require_admin(db, x_actor_email)
    app_file = db.get(AppFile, file_id)
    if not app_file:
        return

    if app_file.storage_path:
        try:
            delete_storage_file(app_file.storage_path)
        except Exception:
            # Best-effort: ignore filesystem errors
            pass

    db.delete(app_file)
    db.commit()
    return


# ----------------- Download endpoint -----------------


@router.get("/app-files/{file_id}/download")
def download_app_file(
    file_id: int = FPath(..., ge=1),
    x_actor_email: str | None = Header(None, alias="x-actor-email"),
    db: Session = Depends(get_db),
):
    _require_admin(db, x_actor_email)
    app_file = db.get(AppFile, file_id)
    if not app_file or not app_file.storage_path:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    try:
        path = resolve_storage_path(app_file.storage_path)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found") from exc

    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File missing")

    try:
        return FileResponse(
            path,
            media_type=app_file.mime_type or "application/octet-stream",
            filename=app_file.filename or path.name,
        )
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found") from exc
