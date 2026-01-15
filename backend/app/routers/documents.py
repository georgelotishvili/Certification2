from __future__ import annotations

import os
import uuid
import shutil
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


router = APIRouter()

# ფაილების შესანახი დირექტორია
DOCUMENTS_UPLOAD_DIR = Path("uploads/site_documents")
DOCUMENTS_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


def _document_out(doc: SiteDocument) -> SiteDocumentOut:
    download_url = None
    if doc.file_path and doc.filename:
        download_url = f"/documents/{doc.id}/download"
    
    return SiteDocumentOut(
        id=doc.id,
        title=doc.title or "",
        content=doc.content or "",
        order_index=doc.order_index or 0,
        filename=doc.filename,
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
        if not file.filename.lower().endswith('.docx'):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="მხოლოდ .docx ფაილებია დაშვებული"
            )
        
        # უნიკალური სახელი
        unique_name = f"{uuid.uuid4().hex}_{file.filename}"
        file_path = str(DOCUMENTS_UPLOAD_DIR / unique_name)
        filename = file.filename
        
        # შევინახოთ ფაილი
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
        
        file_size_bytes = os.path.getsize(file_path)

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

    # თუ ახალი ფაილი ატვირთულია
    if file and file.filename:
        # შევამოწმოთ რომ .docx არის
        if not file.filename.lower().endswith('.docx'):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="მხოლოდ .docx ფაილებია დაშვებული"
            )
        
        # წავშალოთ ძველი ფაილი თუ არსებობს
        if doc.file_path and os.path.exists(doc.file_path):
            try:
                os.remove(doc.file_path)
            except OSError:
                pass
        
        # უნიკალური სახელი
        unique_name = f"{uuid.uuid4().hex}_{file.filename}"
        file_path = str(DOCUMENTS_UPLOAD_DIR / unique_name)
        
        # შევინახოთ ფაილი
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
        
        doc.file_path = file_path
        doc.filename = file.filename
        doc.file_size_bytes = os.path.getsize(file_path)

    db.add(doc)
    db.commit()
    db.refresh(doc)

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
    if doc.file_path and os.path.exists(doc.file_path):
        try:
            os.remove(doc.file_path)
        except OSError:
            pass

    db.delete(doc)
    db.commit()
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
    
    if not doc.file_path or not os.path.exists(doc.file_path):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    
    return FileResponse(
        path=doc.file_path,
        filename=doc.filename or "document.docx",
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
