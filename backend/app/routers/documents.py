from __future__ import annotations

import uuid
import unicodedata
from typing import List, Optional
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, status, Path as FPath, UploadFile, File, Form
from fastapi.responses import FileResponse
from sqlalchemy import select, func
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import SiteDocument
from ..schemas import (
    SiteDocumentOut,
    SiteDocumentCreate,
    SiteDocumentUpdate,
    SiteDocumentsListResponse,
    SiteDocumentOrderRequest,
)
from ..routers.admin import _require_admin
from ..services.bounded_upload import (
    DEFAULT_UPLOAD_MAX_BYTES,
    UploadTooLarge,
    save_upload_stream,
)


router = APIRouter()

# ფაილების შესანახი დირექტორია
DOCUMENTS_UPLOAD_DIR = Path("uploads/site_documents")
DOCUMENTS_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
DOCUMENT_UPLOAD_MAX_BYTES = DEFAULT_UPLOAD_MAX_BYTES


def _documents_root() -> Path:
    DOCUMENTS_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    return DOCUMENTS_UPLOAD_DIR.resolve()


def _resolve_document_path(candidate: str | Path) -> Path:
    root = _documents_root()
    resolved = Path(candidate).resolve()
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise ValueError("Invalid document storage path") from exc
    return resolved


def _safe_document_display_filename(filename: str | None) -> str:
    candidate = (filename or "").replace("\\", "/").rsplit("/", 1)[-1]
    candidate = "".join(
        character
        for character in candidate
        if not unicodedata.category(character).startswith("C")
    ).strip()
    if candidate in {"", ".", ".."}:
        return "document.docx"

    if len(candidate) > 255:
        suffix = ".docx" if candidate.lower().endswith(".docx") else ""
        candidate = candidate[: 255 - len(suffix)].rstrip() + suffix
    return candidate or "document.docx"


def _new_document_storage_path() -> tuple[str, Path]:
    stored_path = DOCUMENTS_UPLOAD_DIR / f"{uuid.uuid4().hex}.docx"
    resolved_path = _resolve_document_path(stored_path)
    return str(stored_path).replace("\\", "/"), resolved_path


def _write_document_upload(upload: UploadFile, destination: Path) -> int:
    safe_destination = _resolve_document_path(destination)
    try:
        return save_upload_stream(
            upload.file,
            safe_destination,
            max_bytes=DOCUMENT_UPLOAD_MAX_BYTES,
        )
    except UploadTooLarge as exc:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="file too large (max 100MB)",
        ) from exc


def _delete_document_file(stored_path: str | Path | None) -> bool:
    if not stored_path:
        return False
    try:
        path = _resolve_document_path(stored_path)
    except ValueError:
        return False
    try:
        if not path.is_file():
            return False
        path.unlink()
    except OSError:
        return False
    return True


def _document_out(doc: SiteDocument) -> SiteDocumentOut:
    download_url = None
    if doc.file_path and doc.filename:
        download_url = f"/documents/{doc.id}/download"
    display_filename = (
        _safe_document_display_filename(doc.filename)
        if doc.filename is not None
        else None
    )
    
    return SiteDocumentOut(
        id=doc.id,
        title=doc.title or "",
        content=doc.content or "",
        order_index=doc.order_index or 0,
        filename=display_filename,
        file_size_bytes=doc.file_size_bytes,
        download_url=download_url,
        created_at=doc.created_at,
        updated_at=doc.updated_at,
    )


# ----------------- Admin endpoints -----------------


@router.get("/admin/documents", response_model=SiteDocumentsListResponse)
def admin_list_documents(
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """ყველა დოკუმენტის წამოღება (ადმინისთვის)"""
    _require_admin(db, authorization)
    docs = db.scalars(
        select(SiteDocument).order_by(SiteDocument.order_index.asc(), SiteDocument.id.asc())
    ).all()
    return SiteDocumentsListResponse(items=[_document_out(d) for d in docs])


@router.post("/admin/documents", response_model=SiteDocumentOut, status_code=status.HTTP_201_CREATED)
async def admin_create_document(
    title: str = Form(...),
    content: str = Form(""),
    file: Optional[UploadFile] = File(None),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """ახალი დოკუმენტის შექმნა Word ფაილით"""
    _require_admin(db, authorization)

    # Get max order_index
    max_order = db.scalar(select(func.max(SiteDocument.order_index))) or 0

    file_path = None
    filename = None
    file_size_bytes = None

    # თუ ფაილი ატვირთულია
    if file and file.filename:
        # შევამოწმოთ რომ .docx არის
        display_filename = _safe_document_display_filename(file.filename)
        if not display_filename.lower().endswith('.docx'):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="მხოლოდ .docx ფაილებია დაშვებული"
            )
        
        # უნიკალური სახელი
        file_path, resolved_file_path = _new_document_storage_path()
        filename = display_filename
        
        # შევინახოთ ფაილი
        file_size_bytes = _write_document_upload(file, resolved_file_path)

    try:
        doc = SiteDocument(
            title=title.strip(),
            content=content.strip(),
            order_index=int(max_order) + 1,
            file_path=file_path,
            filename=filename,
            file_size_bytes=file_size_bytes,
        )
        db.add(doc)
        db.commit()
    except BaseException:
        try:
            db.rollback()
        except Exception:
            pass
        _delete_document_file(file_path)
        raise
    db.refresh(doc)

    return _document_out(doc)


@router.put("/admin/documents/{doc_id}", response_model=SiteDocumentOut)
async def admin_update_document(
    doc_id: int = FPath(..., ge=1),
    title: Optional[str] = Form(None),
    content: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """დოკუმენტის რედაქტირება"""
    _require_admin(db, authorization)

    doc = db.get(SiteDocument, doc_id)
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    if title is not None:
        doc.title = title.strip()
    if content is not None:
        doc.content = content.strip()

    previous_file_path = doc.file_path
    new_file_path = None

    # თუ ახალი ფაილი ატვირთულია
    if file and file.filename:
        # შევამოწმოთ რომ .docx არის
        display_filename = _safe_document_display_filename(file.filename)
        if not display_filename.lower().endswith('.docx'):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="მხოლოდ .docx ფაილებია დაშვებული"
            )
        
        # Keep the previous file until the new database state commits.
        # უნიკალური სახელი
        new_file_path, resolved_file_path = _new_document_storage_path()
        
        # შევინახოთ ფაილი
        try:
            file_size_bytes = _write_document_upload(file, resolved_file_path)
            doc.file_path = new_file_path
            doc.filename = display_filename
            doc.file_size_bytes = file_size_bytes
        except BaseException:
            _delete_document_file(new_file_path)
            raise

    try:
        db.add(doc)
        db.commit()
    except BaseException:
        try:
            db.rollback()
        except Exception:
            pass
        _delete_document_file(new_file_path)
        raise
    db.refresh(doc)

    if new_file_path and previous_file_path != new_file_path:
        _delete_document_file(previous_file_path)

    return _document_out(doc)


@router.patch("/admin/documents/{doc_id}/order", status_code=status.HTTP_204_NO_CONTENT)
def admin_change_document_order(
    payload: SiteDocumentOrderRequest,
    doc_id: int = FPath(..., ge=1),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """დოკუმენტის რიგითობის შეცვლა (up/down)"""
    _require_admin(db, authorization)

    doc = db.get(SiteDocument, doc_id)
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    direction = (payload.direction or "").lower().strip()
    if direction not in ("up", "down"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="direction must be 'up' or 'down'")

    # Get all documents sorted by order_index
    all_docs = db.scalars(
        select(SiteDocument).order_by(SiteDocument.order_index.asc(), SiteDocument.id.asc())
    ).all()

    # Find current index
    current_idx = None
    for i, d in enumerate(all_docs):
        if d.id == doc.id:
            current_idx = i
            break

    if current_idx is None:
        return

    if direction == "up" and current_idx > 0:
        # Swap with previous
        other = all_docs[current_idx - 1]
        doc.order_index, other.order_index = other.order_index, doc.order_index
        db.add(doc)
        db.add(other)
        db.commit()
    elif direction == "down" and current_idx < len(all_docs) - 1:
        # Swap with next
        other = all_docs[current_idx + 1]
        doc.order_index, other.order_index = other.order_index, doc.order_index
        db.add(doc)
        db.add(other)
        db.commit()

    return


@router.delete("/admin/documents/{doc_id}", status_code=status.HTTP_204_NO_CONTENT)
def admin_delete_document(
    doc_id: int = FPath(..., ge=1),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """დოკუმენტის წაშლა (სრული წაშლა ბაზიდან და ფაილის წაშლა)"""
    _require_admin(db, authorization)

    doc = db.get(SiteDocument, doc_id)
    if not doc:
        return

    # წავშალოთ ფაილი თუ არსებობს
    file_path = doc.file_path
    db.delete(doc)
    try:
        db.commit()
    except BaseException:
        try:
            db.rollback()
        except Exception:
            pass
        raise

    # Delete the file only after the database row deletion is committed.
    _delete_document_file(file_path)
    return


@router.get("/documents/{doc_id}/download")
def download_document_file(
    doc_id: int = FPath(..., ge=1),
    db: Session = Depends(get_db),
):
    """Word ფაილის ჩამოტვირთვა"""
    doc = db.get(SiteDocument, doc_id)
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
    
    if not doc.file_path:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    try:
        document_path = _resolve_document_path(doc.file_path)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    if not document_path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    
    return FileResponse(
        path=document_path,
        filename=_safe_document_display_filename(doc.filename),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )


# ----------------- Public endpoints -----------------


@router.get("/documents", response_model=SiteDocumentsListResponse)
def public_list_documents(db: Session = Depends(get_db)):
    """დოკუმენტების წამოღება მთავარი გვერდისთვის"""
    docs = db.scalars(
        select(SiteDocument).order_by(SiteDocument.order_index.asc(), SiteDocument.id.asc())
    ).all()
    return SiteDocumentsListResponse(items=[_document_out(d) for d in docs])


@router.get("/documents/{doc_id}", response_model=SiteDocumentOut)
def public_get_document(
    doc_id: int = FPath(..., ge=1),
    db: Session = Depends(get_db),
):
    """ერთი დოკუმენტის წამოღება"""
    doc = db.get(SiteDocument, doc_id)
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
    return _document_out(doc)
