from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, Header, HTTPException, status, Path as FPath
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


def _document_out(doc: SiteDocument) -> SiteDocumentOut:
    return SiteDocumentOut(
        id=doc.id,
        title=doc.title or "",
        content=doc.content or "",
        order_index=doc.order_index or 0,
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
def admin_create_document(
    payload: SiteDocumentCreate,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """ახალი დოკუმენტის შექმნა"""
    _require_admin(db, authorization)

    # Get max order_index
    max_order = db.scalar(select(func.max(SiteDocument.order_index))) or 0

    doc = SiteDocument(
        title=(payload.title or "").strip(),
        content=(payload.content or "").strip(),
        order_index=int(max_order) + 1,
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)

    return _document_out(doc)


@router.put("/admin/documents/{doc_id}", response_model=SiteDocumentOut)
def admin_update_document(
    payload: SiteDocumentUpdate,
    doc_id: int = FPath(..., ge=1),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """დოკუმენტის რედაქტირება"""
    _require_admin(db, authorization)

    doc = db.get(SiteDocument, doc_id)
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    if payload.title is not None:
        doc.title = payload.title.strip()
    if payload.content is not None:
        doc.content = payload.content.strip()

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
    """დოკუმენტის წაშლა (სრული წაშლა ბაზიდან)"""
    _require_admin(db, authorization)

    doc = db.get(SiteDocument, doc_id)
    if not doc:
        return

    db.delete(doc)
    db.commit()
    return


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
