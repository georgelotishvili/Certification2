from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import List, Optional
from urllib.parse import quote
import re
import unicodedata
import uuid

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    Header,
    HTTPException,
    Path as FPath,
    UploadFile,
    status,
)
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import GuideDocument, GuideVideo
from ..routers.admin import _require_admin
from ..schemas import (
    GuideDocumentOrderRequest,
    GuideDocumentOut,
    GuideDocumentsListResponse,
    GuideVideoCreate,
    GuideVideoOut,
    GuideVideosReorderRequest,
    GuideVideoUpdate,
)
from ..services.bounded_upload import (
    DEFAULT_UPLOAD_MAX_BYTES,
    UploadTooLarge,
    save_async_upload,
)
from ..services.contract_assembler import (
    docx_bytes_to_html,
    markdown_to_docx_bytes,
    markdown_to_html,
    strip_internal_annexes,
    structured_text_to_html,
)


router = APIRouter()

GUIDE_UPLOAD_DIR = Path("uploads/guide_documents")
GUIDE_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
GUIDE_UPLOAD_MAX_BYTES = DEFAULT_UPLOAD_MAX_BYTES
_STRIP_FILENAME_TAG = "_\u10d0\u10e0\u10d2\u10dd\u10dc"
BUNDLED_DOC28_MD = (
    Path(__file__).resolve().parent.parent
    / "data"
    / "contracts"
    / "28_ვებგვერდზე_განსათავსებელი_სავალდებულო_ინფორმაცია.md"
)


def _guide_root() -> Path:
    GUIDE_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    return GUIDE_UPLOAD_DIR.resolve()


def _resolve_guide_path(candidate: str | Path) -> Path:
    root = _guide_root()
    resolved = Path(candidate).resolve()
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise ValueError("Invalid guide storage path") from exc
    return resolved


def _safe_guide_filename(filename: str | None) -> str:
    candidate = (filename or "").replace("\\", "/").rsplit("/", 1)[-1]
    candidate = "".join(
        ch for ch in candidate if not unicodedata.category(ch).startswith("C")
    ).strip()
    if candidate in {"", ".", ".."}:
        return "guide.docx"
    stem = Path(candidate).stem
    suffix = Path(candidate).suffix
    if stem.endswith(_STRIP_FILENAME_TAG):
        candidate = f"{stem[: -len(_STRIP_FILENAME_TAG)]}{suffix}"
    return candidate or "guide.docx"


def _ensure_default_guide_docs(db: Session) -> None:
    """Keep the 8 default GuideDocument pages synchronized with bundled 28_... .md."""
    if not BUNDLED_DOC28_MD.is_file():
        return
    try:
        docs = list(
            db.scalars(
                select(GuideDocument).order_by(GuideDocument.order_index.asc(), GuideDocument.id.asc())
            ).all()
        )
        by_title = {(d.title or "").strip(): d for d in docs}
        cert_doc = by_title.get("სერტიფიცირება")
        forms_doc = by_title.get("ფორმები და საჯარო დოკუმენტაცია")
        if (
            cert_doc is not None
            and forms_doc is not None
            and "GIPC-CON-001 (გარდამავალი)" in (cert_doc.content or "")
            and "GIPC-CON-001 (გარდამავალი)" in (forms_doc.content or "")
        ):
            return

        raw_md = BUNDLED_DOC28_MD.read_text(encoding="utf-8-sig")
        parts = re.split(r"(?m)^## გვერდი:\s*", raw_md)
        if len(parts) <= 1:
            return

        changed = False
        for idx, part in enumerate(parts[1:], 1):
            part_clean = re.split(r"(?m)^## საჯარო ინფორმაციის გამოქვეყნებისა", part)[0].strip()
            lines = part_clean.splitlines()
            if not lines:
                continue
            title = lines[0].strip()
            body = "\n".join(lines[1:]).strip()
            body_promoted = re.sub(r"(?m)^####\s+", "### ", body)
            body_promoted = re.sub(r"(?m)^###\s+", "## ", body_promoted)
            html_content = markdown_to_html(body_promoted)
            docx_bytes = markdown_to_docx_bytes(f"# {title}\n\n{body_promoted}\n")
            display_filename = f"{idx}. {title}.docx"

            existing = by_title.get(title)
            if existing is not None:
                if existing.content == html_content and existing.file_size_bytes == len(docx_bytes):
                    continue
                unique_name = f"guide_{uuid.uuid4().hex[:12]}.docx"
                file_path = _resolve_guide_path(_guide_root() / unique_name)
                file_path.write_bytes(docx_bytes)
                old_fp = existing.file_path
                existing.content = html_content
                existing.file_path = str(file_path)
                existing.filename = display_filename
                existing.file_size_bytes = len(docx_bytes)
                existing.order_index = idx
                existing.updated_at = datetime.utcnow()
                db.add(existing)
                if old_fp and old_fp != str(file_path):
                    _delete_guide_file_from_disk(old_fp)
                changed = True
            else:
                unique_name = f"guide_{uuid.uuid4().hex[:12]}.docx"
                file_path = _resolve_guide_path(_guide_root() / unique_name)
                file_path.write_bytes(docx_bytes)
                new_doc = GuideDocument(
                    title=title,
                    content=html_content,
                    order_index=idx,
                    file_path=str(file_path),
                    filename=display_filename,
                    file_size_bytes=len(docx_bytes),
                )
                db.add(new_doc)
                changed = True

        if changed:
            db.commit()
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass


def _get_guide_doc_record(db: Session) -> Optional[GuideDocument]:
    _ensure_default_guide_docs(db)
    return db.scalars(
        select(GuideDocument).order_by(GuideDocument.order_index.asc(), GuideDocument.id.asc())
    ).first()


def _get_all_guide_docs(db: Session) -> List[GuideDocument]:
    _ensure_default_guide_docs(db)
    return list(
        db.scalars(
            select(GuideDocument).order_by(GuideDocument.order_index.asc(), GuideDocument.id.asc())
        ).all()
    )


def _guide_doc_out(doc: Optional[GuideDocument]) -> GuideDocumentOut:
    if not doc:
        return GuideDocumentOut(
            id=None,
            title="გზამკვლევი",
            content="",
            order_index=0,
            filename=None,
            file_size_bytes=None,
            download_url=None,
            available=False,
            created_at=None,
            updated_at=None,
        )

    has_file = False
    if doc.file_path:
        try:
            fp = _resolve_guide_path(doc.file_path)
            has_file = fp.exists() and fp.is_file()
        except ValueError:
            has_file = False

    content_str = (doc.content or "").strip()
    is_available = bool(content_str or has_file)
    dl_url = f"/guide/documents/{doc.id}/download" if (has_file and doc.id) else ("/guide/document/download" if has_file else None)

    return GuideDocumentOut(
        id=doc.id,
        title=(doc.title or "გზამკვლევი").strip() or "გზამკვლევი",
        content=doc.content or "",
        order_index=int(getattr(doc, "order_index", 0) or 0),
        filename=_safe_guide_filename(doc.filename) if (has_file and doc.filename) else None,
        file_size_bytes=doc.file_size_bytes if has_file else None,
        download_url=dl_url,
        available=is_available,
        created_at=doc.created_at,
        updated_at=doc.updated_at,
    )


def _delete_guide_file_from_disk(stored_path: str | None) -> None:
    if not stored_path:
        return
    try:
        old_fp = _resolve_guide_path(stored_path)
        if old_fp.exists() and old_fp.is_file():
            old_fp.unlink()
    except (OSError, ValueError):
        pass


async def _apply_guide_doc_fields(
    doc: GuideDocument,
    title: Optional[str],
    content: Optional[str],
    file: Optional[UploadFile],
    remove_file: bool = False,
) -> None:
    if title is not None:
        cleaned_title = title.strip()
        if cleaned_title:
            doc.title = cleaned_title
        elif not doc.title:
            doc.title = "ინფორმაცია"

    if remove_file and not (file and file.filename):
        _delete_guide_file_from_disk(doc.file_path)
        doc.file_path = None
        doc.filename = None
        doc.file_size_bytes = None

    extracted_html_from_file = ""
    if file and file.filename:
        ext = Path(file.filename).suffix.lower()
        allowed_exts = {".docx", ".doc", ".md", ".txt", ".pdf"}
        if ext not in allowed_exts:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="დაშვებულია მხოლოდ .docx, .md, .txt ან .pdf ფაილები",
            )

        _delete_guide_file_from_disk(doc.file_path)

        unique_name = f"guide_{uuid.uuid4().hex[:12]}{ext}"
        file_path = _resolve_guide_path(_guide_root() / unique_name)
        try:
            file_size = await save_async_upload(
                file, file_path, max_bytes=GUIDE_UPLOAD_MAX_BYTES
            )
        except UploadTooLarge as exc:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail="ფაილის ზომა აჭარბებს დასაშვებ ლიმიტს",
            ) from exc

        doc.file_path = str(file_path)
        doc.filename = _safe_guide_filename(file.filename)
        doc.file_size_bytes = file_size

        try:
            raw_bytes = file_path.read_bytes()
            if ext in {".docx", ".doc"}:
                extracted_html_from_file = docx_bytes_to_html(raw_bytes)
            elif ext in {".md", ".txt"}:
                text_str = strip_internal_annexes(raw_bytes.decode("utf-8-sig", errors="replace"))
                extracted_html_from_file = structured_text_to_html(text_str)
        except Exception:
            extracted_html_from_file = ""

    if extracted_html_from_file:
        doc.content = extracted_html_from_file
    elif content is not None and content.strip():
        doc.content = structured_text_to_html(strip_internal_annexes(content))
    elif content is not None and not (file and file.filename):
        doc.content = ""

    doc.updated_at = datetime.utcnow()


def _serve_guide_doc_file(doc: Optional[GuideDocument]) -> FileResponse:
    if not doc or not doc.file_path:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="დოკუმენტის ფაილი არ მოიძებნა",
        )
    try:
        file_path = _resolve_guide_path(doc.file_path)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="დოკუმენტის ფაილი არ მოიძებნა",
        ) from exc

    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="დოკუმენტის ფაილი არ მოიძებნა",
        )

    filename = _safe_guide_filename(doc.filename or file_path.name)
    encoded_filename = quote(filename)
    ext = file_path.suffix.lower()
    if ext == ".pdf":
        media_type = "application/pdf"
        disposition = f"inline; filename*=UTF-8''{encoded_filename}"
    elif ext in {".md", ".txt"}:
        media_type = "text/plain; charset=utf-8"
        disposition = f"attachment; filename*=UTF-8''{encoded_filename}"
    else:
        media_type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        disposition = f"attachment; filename*=UTF-8''{encoded_filename}"

    return FileResponse(
        path=str(file_path),
        media_type=media_type,
        headers={"Content-Disposition": disposition},
    )


def _guide_video_out(video: GuideVideo) -> GuideVideoOut:
    return GuideVideoOut(
        id=video.id,
        title=video.title or "",
        url=video.url or "",
        order_index=video.order_index or 0,
        created_at=video.created_at,
    )


# ----------------- Guide / Info Navigation Documents Endpoints (Public & Admin) -----------------


@router.get("/guide/documents", response_model=GuideDocumentsListResponse)
def public_list_guide_documents(db: Session = Depends(get_db)):
    docs = _get_all_guide_docs(db)
    out_items = [_guide_doc_out(d) for d in docs]
    return GuideDocumentsListResponse(items=[it for it in out_items if it.available])


@router.get("/guide/documents/{doc_id}", response_model=GuideDocumentOut)
def public_get_guide_document_by_id(
    doc_id: int = FPath(..., ge=1),
    db: Session = Depends(get_db),
):
    doc = db.get(GuideDocument, doc_id)
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="დოკუმენტი არ მოიძებნა")
    return _guide_doc_out(doc)


@router.get("/guide/documents/{doc_id}/download")
def public_download_guide_document_by_id(
    doc_id: int = FPath(..., ge=1),
    db: Session = Depends(get_db),
):
    doc = db.get(GuideDocument, doc_id)
    return _serve_guide_doc_file(doc)


@router.get("/guide/document", response_model=GuideDocumentOut)
def public_get_guide_document(db: Session = Depends(get_db)):
    doc = _get_guide_doc_record(db)
    return _guide_doc_out(doc)


@router.get("/guide/document/download")
def public_download_guide_document(db: Session = Depends(get_db)):
    doc = _get_guide_doc_record(db)
    return _serve_guide_doc_file(doc)


@router.get("/admin/guide/documents", response_model=GuideDocumentsListResponse)
def admin_list_guide_documents(
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    docs = _get_all_guide_docs(db)
    return GuideDocumentsListResponse(items=[_guide_doc_out(d) for d in docs])


@router.post("/admin/guide/documents", response_model=GuideDocumentOut, status_code=status.HTTP_201_CREATED)
async def admin_create_guide_document(
    title: str = Form(...),
    content: Optional[str] = Form(""),
    file: Optional[UploadFile] = File(None),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    cleaned_title = (title or "").strip()
    if not cleaned_title:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="სათაური სავალდებულოა")

    max_order = db.scalar(select(func.max(GuideDocument.order_index))) or 0
    doc = GuideDocument(
        title=cleaned_title,
        content="",
        order_index=int(max_order) + 1,
    )
    await _apply_guide_doc_fields(doc, cleaned_title, content, file, remove_file=False)
    db.add(doc)
    db.commit()
    db.refresh(doc)
    return _guide_doc_out(doc)


@router.put("/admin/guide/documents/{doc_id}", response_model=GuideDocumentOut)
async def admin_update_guide_document(
    doc_id: int = FPath(..., ge=1),
    title: Optional[str] = Form(None),
    content: Optional[str] = Form(None),
    remove_file: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    doc = db.get(GuideDocument, doc_id)
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="დოკუმენტი არ მოიძებნა")

    should_remove_file = str(remove_file or "").strip().lower() in {"1", "true", "yes"}
    await _apply_guide_doc_fields(doc, title, content, file, remove_file=should_remove_file)
    db.add(doc)
    db.commit()
    db.refresh(doc)
    return _guide_doc_out(doc)


@router.delete("/admin/guide/documents/{doc_id}", status_code=status.HTTP_204_NO_CONTENT)
def admin_delete_guide_document_by_id(
    doc_id: int = FPath(..., ge=1),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    doc = db.get(GuideDocument, doc_id)
    if not doc:
        return
    _delete_guide_file_from_disk(doc.file_path)
    db.delete(doc)
    db.commit()
    return


@router.patch("/admin/guide/documents/{doc_id}/order", status_code=status.HTTP_204_NO_CONTENT)
def admin_reorder_guide_document(
    payload: GuideDocumentOrderRequest,
    doc_id: int = FPath(..., ge=1),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    docs = _get_all_guide_docs(db)
    idx = next((i for i, d in enumerate(docs) if d.id == doc_id), None)
    if idx is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="დოკუმენტი არ მოიძებნა")

    direction = (payload.direction or "").strip().lower()
    if direction == "up" and idx > 0:
        docs[idx], docs[idx - 1] = docs[idx - 1], docs[idx]
    elif direction == "down" and idx < len(docs) - 1:
        docs[idx], docs[idx + 1] = docs[idx + 1], docs[idx]
    else:
        return

    for order_idx, d in enumerate(docs, start=1):
        d.order_index = order_idx
        db.add(d)
    db.commit()
    return


@router.get("/admin/guide/document", response_model=GuideDocumentOut)
def admin_get_guide_document(
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    doc = _get_guide_doc_record(db)
    return _guide_doc_out(doc)


async def _upsert_guide_document(
    title: Optional[str],
    content: Optional[str],
    file: Optional[UploadFile],
    authorization: str | None,
    db: Session,
) -> GuideDocumentOut:
    _require_admin(db, authorization)

    doc = _get_guide_doc_record(db)
    is_new = doc is None
    if is_new:
        max_order = db.scalar(select(func.max(GuideDocument.order_index))) or 0
        doc = GuideDocument(title="გზამკვლევი", content="", order_index=int(max_order) + 1)

    await _apply_guide_doc_fields(doc, title, content, file, remove_file=False)
    db.add(doc)
    db.commit()
    db.refresh(doc)
    return _guide_doc_out(doc)


@router.post("/admin/guide/document", response_model=GuideDocumentOut)
async def admin_post_guide_document(
    title: Optional[str] = Form(None),
    content: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    return await _upsert_guide_document(title, content, file, authorization, db)


@router.put("/admin/guide/document", response_model=GuideDocumentOut)
async def admin_put_guide_document(
    title: Optional[str] = Form(None),
    content: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    return await _upsert_guide_document(title, content, file, authorization, db)


@router.delete("/admin/guide/document", status_code=status.HTTP_204_NO_CONTENT)
def admin_delete_guide_document(
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    doc = _get_guide_doc_record(db)
    if not doc:
        return

    if doc.file_path:
        try:
            fp = _resolve_guide_path(doc.file_path)
            if fp.exists():
                fp.unlink()
        except (OSError, ValueError):
            pass

    db.delete(doc)
    db.commit()
    return


# ----------------- Legacy Video Endpoints -----------------


@router.get("/admin/guide/videos", response_model=List[GuideVideoOut])
def admin_list_guide_videos(
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    videos = db.scalars(
        select(GuideVideo).order_by(GuideVideo.order_index.asc(), GuideVideo.id.asc())
    ).all()
    return [_guide_video_out(v) for v in videos]


@router.post(
    "/admin/guide/videos",
    response_model=GuideVideoOut,
    status_code=status.HTTP_201_CREATED,
)
def admin_create_guide_video(
    payload: GuideVideoCreate,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)

    max_order = db.scalar(select(func.max(GuideVideo.order_index))) or 0

    video = GuideVideo(
        order_index=int(max_order) + 1,
        title=payload.title.strip() if payload.title else "",
        url=payload.url.strip() if payload.url else "",
    )
    db.add(video)
    db.commit()
    db.refresh(video)

    return _guide_video_out(video)


@router.put("/admin/guide/videos/{video_id}", response_model=GuideVideoOut)
def admin_update_guide_video(
    payload: GuideVideoUpdate,
    video_id: int = FPath(..., ge=1),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    video = db.get(GuideVideo, video_id)
    if not video:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Video not found"
        )

    if payload.title is not None:
        video.title = payload.title.strip()
    if payload.url is not None:
        if not payload.url.strip():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="URL cannot be empty"
            )
        video.url = payload.url.strip()

    db.add(video)
    db.commit()
    db.refresh(video)

    return _guide_video_out(video)


@router.post("/admin/guide/videos/reorder", status_code=status.HTTP_204_NO_CONTENT)
def admin_reorder_guide_videos(
    payload: GuideVideosReorderRequest,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    ids = [
        int(v)
        for v in (payload.ids or [])
        if isinstance(v, int) or (isinstance(v, str) and v.isdigit())
    ]
    if not ids:
        return

    videos = db.scalars(select(GuideVideo).where(GuideVideo.id.in_(ids))).all()
    by_id = {v.id: v for v in videos}

    order = 1
    for raw_id in ids:
        vid = by_id.get(int(raw_id))
        if not vid:
            continue
        vid.order_index = order
        db.add(vid)
        order += 1

    db.commit()
    return


@router.delete(
    "/admin/guide/videos/{video_id}", status_code=status.HTTP_204_NO_CONTENT
)
def admin_delete_guide_video(
    video_id: int = FPath(..., ge=1),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    video = db.get(GuideVideo, video_id)
    if not video:
        return

    db.delete(video)
    db.commit()
    return


@router.get("/guide/videos", response_model=List[GuideVideoOut])
def public_list_guide_videos(db: Session = Depends(get_db)):
    videos = db.scalars(
        select(GuideVideo).order_by(GuideVideo.order_index.asc(), GuideVideo.id.asc())
    ).all()
    return [_guide_video_out(v) for v in videos]
