from __future__ import annotations

import unicodedata
import uuid
from pathlib import Path
from typing import List, Optional
from urllib.parse import quote

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    Header,
    HTTPException,
    Path as FPath,
    Query,
    Response,
    UploadFile,
    status,
)
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..database import get_db
from ..models import SiteDocument, User
from ..routers.admin import _get_user_from_token, _require_admin
from ..schemas import (
    SiteDocumentCreate,
    SiteDocumentOrderRequest,
    SiteDocumentOut,
    SiteDocumentsListResponse,
    SiteDocumentUpdate,
)
from ..services.bounded_upload import (
    DEFAULT_UPLOAD_MAX_BYTES,
    UploadTooLarge,
    save_upload_stream,
)
from ..services.contract_assembler import (
    CONTRACT_SLOTS,
    docx_bytes_to_html,
    extract_user_fields,
    markdown_to_docx_bytes,
    markdown_to_html,
    populate_contract_docx_bytes,
    populate_contract_html,
)


router = APIRouter()

# ფაილების შესანახი დირექტორია
DOCUMENTS_UPLOAD_DIR = Path("uploads/site_documents")
DOCUMENTS_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
DOCUMENT_UPLOAD_MAX_BYTES = DEFAULT_UPLOAD_MAX_BYTES

BUNDLED_CONTRACTS_DIR = Path(__file__).resolve().parents[1] / "data" / "contracts"
LOCAL_DOC2_DIR = Path(r"C:\Users\george\Desktop\certification kode\akreditacia\ეტაპი 2\არგონი\doc 2")
LOCAL_WORD_DIR = Path(r"C:\Users\george\Desktop\certification kode\akreditacia\ეტაპი 2\არგონი\Word")


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
        lower = candidate.lower()
        if lower.endswith(".docx"):
            suffix = ".docx"
        elif lower.endswith(".pdf"):
            suffix = ".pdf"
        elif lower.endswith(".md"):
            suffix = ".md"
        else:
            suffix = ""
        candidate = candidate[: 255 - len(suffix)].rstrip() + suffix
    return candidate or "document.docx"


def _allowed_document_suffix(filename: str) -> str | None:
    lower = (filename or "").lower()
    if lower.endswith(".docx"):
        return ".docx"
    if lower.endswith(".pdf"):
        return ".pdf"
    if lower.endswith(".md"):
        return ".md"
    return None


def _new_document_storage_path(suffix: str = ".docx") -> tuple[str, Path]:
    safe_suffix = ".pdf" if suffix == ".pdf" else ".docx"
    stored_path = DOCUMENTS_UPLOAD_DIR / f"{uuid.uuid4().hex}{safe_suffix}"
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


def _find_template_docx_for_slot(contract_type: str | None) -> Path | None:
    if not contract_type or contract_type not in CONTRACT_SLOTS:
        return None
    docx_name = CONTRACT_SLOTS[contract_type]["source_docx"]
    for folder in (LOCAL_WORD_DIR, BUNDLED_CONTRACTS_DIR):
        candidate = folder / docx_name
        if candidate.is_file():
            return candidate
    return None


def _process_uploaded_file(
    upload: UploadFile,
    provided_content: str | None,
    contract_type: str | None = None,
) -> tuple[str, str, int, str]:
    """
    Process an uploaded .docx, .md, or .pdf file.
    Returns (stored_file_path, display_filename, file_size_bytes, resolved_html_content).
    """
    display_filename = _safe_document_display_filename(upload.filename)
    allowed_suffix = _allowed_document_suffix(display_filename)
    if not allowed_suffix:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="მხოლოდ .docx, .md და .pdf ფაილებია დაშვებული",
        )

    html_content = (provided_content or "").strip()

    if allowed_suffix == ".md":
        raw_bytes = upload.file.read(DOCUMENT_UPLOAD_MAX_BYTES + 1)
        if len(raw_bytes) > DOCUMENT_UPLOAD_MAX_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail="file too large (max 100MB)",
            )
        md_text = raw_bytes.decode("utf-8-sig", errors="replace")
        if not html_content:
            html_content = markdown_to_html(md_text)

        tpl_docx = _find_template_docx_for_slot(contract_type)
        docx_bytes = markdown_to_docx_bytes(md_text, template_docx=tpl_docx)

        file_path, resolved_file_path = _new_document_storage_path(".docx")
        resolved_file_path.write_bytes(docx_bytes)
        file_size_bytes = len(docx_bytes)

        stem = Path(display_filename).stem
        if stem.endswith("_არგონ"):
            stem = stem[: -len("_არგონ")]
        out_filename = _safe_document_display_filename(f"{stem}.docx")
        return file_path, out_filename, file_size_bytes, html_content

    file_path, resolved_file_path = _new_document_storage_path(allowed_suffix)
    file_size_bytes = _write_document_upload(upload, resolved_file_path)

    if allowed_suffix == ".docx" and not html_content:
        try:
            html_content = docx_bytes_to_html(resolved_file_path.read_bytes())
        except Exception:
            pass

    return file_path, display_filename, file_size_bytes, html_content


def _ensure_default_contracts(db: Session) -> None:
    """Ensure the 4 standard contracts (exam, cert_a, cert_b, cert_c) are seeded in site_documents."""
    try:
        existing_docs = db.scalars(select(SiteDocument)).all()
        by_type = {d.contract_type: d for d in existing_docs if d.contract_type}

        changed = False
        for key, slot in CONTRACT_SLOTS.items():
            if key in by_type:
                continue

            # Check if an existing untagged document matches this slot's code
            code = slot["code"]
            matched = next(
                (
                    d
                    for d in existing_docs
                    if not d.contract_type and (code in (d.title or "") or code in (d.content or ""))
                ),
                None,
            )

            # Locate source markdown and docx template
            md_path = None
            for folder in (LOCAL_DOC2_DIR, BUNDLED_CONTRACTS_DIR):
                candidate = folder / slot["source_md"]
                if candidate.is_file():
                    md_path = candidate
                    break

            if not md_path:
                continue

            md_text = md_path.read_text(encoding="utf-8-sig")
            html_content = markdown_to_html(md_text)
            tpl_docx = _find_template_docx_for_slot(key)
            docx_bytes = markdown_to_docx_bytes(md_text, template_docx=tpl_docx)

            file_path, resolved_file_path = _new_document_storage_path(".docx")
            resolved_file_path.write_bytes(docx_bytes)
            filename = slot["source_docx"]
            file_size_bytes = len(docx_bytes)

            if matched is not None:
                old_file = matched.file_path
                matched.contract_type = key
                matched.title = matched.title or slot["default_title"]
                matched.content = html_content
                matched.file_path = file_path
                matched.filename = filename
                matched.file_size_bytes = file_size_bytes
                db.add(matched)
                if old_file and old_file != file_path:
                    _delete_document_file(old_file)
            else:
                doc = SiteDocument(
                    title=slot["default_title"],
                    content=html_content,
                    order_index=int(slot.get("order_index") or 1),
                    contract_type=key,
                    file_path=file_path,
                    filename=filename,
                    file_size_bytes=file_size_bytes,
                )
                db.add(doc)
            changed = True

        if changed:
            db.commit()
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass


def _is_admin_user(user: User | None) -> bool:
    if not user:
        return False
    if user.is_admin:
        return True
    settings = get_settings()
    founder_email = (settings.founder_admin_email or "").lower()
    return bool(founder_email and (user.email or "").lower() == founder_email)


def _resolve_target_user(
    db: Session,
    authorization: str | None = None,
    token: str | None = None,
    user_id: int | None = None,
) -> User | None:
    auth_header = authorization
    if not auth_header and token:
        clean_tok = token.strip()
        auth_header = clean_tok if clean_tok.lower().startswith("bearer ") else f"Bearer {clean_tok}"

    caller = _get_user_from_token(db, auth_header)
    if user_id is not None:
        if caller and (_is_admin_user(caller) or caller.id == user_id):
            return db.get(User, user_id)
        return None
    return caller


def _document_out(
    doc: SiteDocument,
    user: User | None = None,
    for_user_id: int | None = None,
) -> SiteDocumentOut:
    download_url = None
    if doc.file_path and doc.filename:
        download_url = f"/documents/{doc.id}/download"
        if for_user_id is not None:
            download_url = f"{download_url}?user_id={for_user_id}"

    display_filename = (
        _safe_document_display_filename(doc.filename)
        if doc.filename is not None
        else None
    )

    raw_content = doc.content or ""
    final_content = populate_contract_html(raw_content, user) if user else raw_content

    return SiteDocumentOut(
        id=doc.id,
        title=doc.title or "",
        content=final_content,
        order_index=doc.order_index or 0,
        contract_type=doc.contract_type,
        filename=display_filename,
        file_size_bytes=doc.file_size_bytes,
        download_url=download_url,
        created_at=doc.created_at,
        updated_at=doc.updated_at,
    )


# ----------------- Admin endpoints -----------------


@router.get("/admin/documents", response_model=SiteDocumentsListResponse)
def admin_list_documents(
    user_id: Optional[int] = Query(None, ge=1),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """ყველა დოკუმენტის წამოღება (ადმინისთვის). თუ user_id გადაეცა, ხელშეკრულებები ივსება ამ პირის მონაცემებით."""
    _require_admin(db, authorization)
    _ensure_default_contracts(db)
    target_user = db.get(User, user_id) if user_id else None
    docs = db.scalars(
        select(SiteDocument).order_by(SiteDocument.order_index.asc(), SiteDocument.id.asc())
    ).all()
    return SiteDocumentsListResponse(
        items=[
            _document_out(d, user=target_user, for_user_id=target_user.id if target_user else None)
            for d in docs
        ]
    )


@router.post("/admin/documents/contracts/{contract_type}", response_model=SiteDocumentOut)
async def admin_upload_contract_slot(
    contract_type: str = FPath(...),
    title: Optional[str] = Form(None),
    content: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """ოთხიდან ერთ-ერთი ხელშეკრულების (exam, cert_a, cert_b, cert_c) ატვირთვა ან განახლება."""
    _require_admin(db, authorization)
    slot_key = (contract_type or "").strip().lower()
    if slot_key not in CONTRACT_SLOTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="არასწორი ხელშეკრულების ტიპი (დაშვებულია: exam, cert_a, cert_b, cert_c)",
        )

    slot_info = CONTRACT_SLOTS[slot_key]
    doc = db.scalar(select(SiteDocument).where(SiteDocument.contract_type == slot_key))

    previous_file_path = doc.file_path if doc else None
    new_file_path = None
    filename = doc.filename if doc else None
    file_size_bytes = doc.file_size_bytes if doc else None
    resolved_content = (content or "").strip()

    if file and file.filename:
        new_file_path, filename, file_size_bytes, resolved_content = _process_uploaded_file(
            file,
            provided_content=resolved_content,
            contract_type=slot_key,
        )

    resolved_title = (title or "").strip() or (doc.title if doc and doc.title else slot_info["default_title"])

    try:
        if doc is None:
            doc = SiteDocument(
                title=resolved_title,
                content=resolved_content,
                order_index=int(slot_info.get("order_index") or 1),
                contract_type=slot_key,
                file_path=new_file_path,
                filename=filename,
                file_size_bytes=file_size_bytes,
            )
        else:
            doc.title = resolved_title
            if resolved_content or (file and file.filename):
                doc.content = resolved_content
            if new_file_path:
                doc.file_path = new_file_path
                doc.filename = filename
                doc.file_size_bytes = file_size_bytes

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
    if new_file_path and previous_file_path and previous_file_path != new_file_path:
        _delete_document_file(previous_file_path)

    return _document_out(doc)


@router.post("/admin/documents", response_model=SiteDocumentOut, status_code=status.HTTP_201_CREATED)
async def admin_create_document(
    title: str = Form(...),
    content: str = Form(""),
    contract_type: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """ახალი დოკუმენტის შექმნა Word (.docx), Markdown (.md) ან PDF ფაილით"""
    _require_admin(db, authorization)

    slot_key = (contract_type or "").strip().lower() or None
    if slot_key and slot_key not in CONTRACT_SLOTS:
        slot_key = None

    max_order = db.scalar(select(func.max(SiteDocument.order_index))) or 0

    file_path = None
    filename = None
    file_size_bytes = None
    resolved_content = (content or "").strip()

    if file and file.filename:
        file_path, filename, file_size_bytes, resolved_content = _process_uploaded_file(
            file,
            provided_content=resolved_content,
            contract_type=slot_key,
        )

    try:
        doc = SiteDocument(
            title=title.strip(),
            content=resolved_content,
            order_index=int(max_order) + 1,
            contract_type=slot_key,
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
    contract_type: Optional[str] = Form(None),
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
    if contract_type is not None:
        clean_ct = contract_type.strip().lower()
        doc.contract_type = clean_ct if clean_ct in CONTRACT_SLOTS else None

    previous_file_path = doc.file_path
    new_file_path = None
    resolved_content = content.strip() if content is not None else None

    if file and file.filename:
        try:
            new_file_path, display_filename, file_size_bytes, file_html = _process_uploaded_file(
                file,
                provided_content=resolved_content,
                contract_type=doc.contract_type,
            )
            doc.file_path = new_file_path
            doc.filename = display_filename
            doc.file_size_bytes = file_size_bytes
            resolved_content = file_html
        except BaseException:
            _delete_document_file(new_file_path)
            raise

    if resolved_content is not None:
        doc.content = resolved_content

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

    all_docs = db.scalars(
        select(SiteDocument).order_by(SiteDocument.order_index.asc(), SiteDocument.id.asc())
    ).all()

    current_idx = None
    for i, d in enumerate(all_docs):
        if d.id == doc.id:
            current_idx = i
            break

    if current_idx is None:
        return

    if direction == "up" and current_idx > 0:
        other = all_docs[current_idx - 1]
        doc.order_index, other.order_index = other.order_index, doc.order_index
        db.add(doc)
        db.add(other)
        db.commit()
    elif direction == "down" and current_idx < len(all_docs) - 1:
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

    _delete_document_file(file_path)
    return


@router.get("/documents/{doc_id}/download")
def download_document_file(
    doc_id: int = FPath(..., ge=1),
    user_id: Optional[int] = Query(None, ge=1),
    token: Optional[str] = Query(None),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """Word ან PDF ფაილის ჩამოტვირთვა (ავტორიზებული პირის ან არჩეული user_id-ის მონაცემებით შევსებული)"""
    _ensure_default_contracts(db)
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

    safe_filename = _safe_document_display_filename(doc.filename)
    is_pdf = safe_filename.lower().endswith(".pdf") or str(document_path).lower().endswith(".pdf")
    media_type = (
        "application/pdf"
        if is_pdf
        else "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )

    target_user = _resolve_target_user(db, authorization=authorization, token=token, user_id=user_id)
    if target_user and not is_pdf:
        populated_bytes = populate_contract_docx_bytes(document_path, target_user)
        fields = extract_user_fields(target_user)
        person_slug = (fields.get("full_name") or "").replace(" ", "_").strip("_")
        if person_slug:
            stem = Path(safe_filename).stem
            suffix = Path(safe_filename).suffix or ".docx"
            safe_filename = _safe_document_display_filename(f"{stem}_{person_slug}{suffix}")

        encoded_name = quote(safe_filename)
        headers = {
            "Content-Disposition": f"attachment; filename=\"contract.docx\"; filename*=utf-8''{encoded_name}"
        }
        return Response(content=populated_bytes, media_type=media_type, headers=headers)

    return FileResponse(
        path=document_path,
        filename=safe_filename,
        media_type=media_type,
    )


# ----------------- Public / Authorized endpoints -----------------


@router.get("/documents", response_model=SiteDocumentsListResponse)
def public_list_documents(
    user_id: Optional[int] = Query(None, ge=1),
    token: Optional[str] = Query(None),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """დოკუმენტების წამოღება (ავტორიზებული მომხმარებლისთვის ხელშეკრულებები ივსება მისი მონაცემებით)"""
    _ensure_default_contracts(db)
    target_user = _resolve_target_user(db, authorization=authorization, token=token, user_id=user_id)
    for_uid = user_id if (user_id and target_user) else None
    docs = db.scalars(
        select(SiteDocument).order_by(SiteDocument.order_index.asc(), SiteDocument.id.asc())
    ).all()
    return SiteDocumentsListResponse(
        items=[_document_out(d, user=target_user, for_user_id=for_uid) for d in docs]
    )


@router.get("/documents/{doc_id}", response_model=SiteDocumentOut)
def public_get_document(
    doc_id: int = FPath(..., ge=1),
    user_id: Optional[int] = Query(None, ge=1),
    token: Optional[str] = Query(None),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """ერთი დოკუმენტის წამოღება (ავტორიზებული მომხმარებლისთვის ივსება მისი მონაცემებით)"""
    _ensure_default_contracts(db)
    doc = db.get(SiteDocument, doc_id)
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
    target_user = _resolve_target_user(db, authorization=authorization, token=token, user_id=user_id)
    for_uid = user_id if (user_id and target_user) else None
    return _document_out(doc, user=target_user, for_user_id=for_uid)
