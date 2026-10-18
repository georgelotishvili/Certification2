from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import List, Optional
from urllib.parse import quote
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
    GuideDocumentOut,
    GuideVideoCreate,
    GuideVideoOut,
    GuideVideosReorderRequest,
    GuideVideoUpdate,
)
from ..services.bounded_upload import (
    DEFAULT_UPLOAD_MAX_BYTES,
    UploadTooLarge,
    save_upload_stream,
)
from ..services.contract_assembler import (
    docx_bytes_to_html,
    structured_text_to_html,
)


router = APIRouter()

GUIDE_UPLOAD_DIR = Path("uploads/guide_documents")
GUIDE_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
GUIDE_UPLOAD_MAX_BYTES = DEFAULT_UPLOAD_MAX_BYTES


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
    return candidate


def _get_guide_doc_record(db: Session) -> Optional[GuideDocument]:
    return db.scalars(
        select(GuideDocument).order_by(GuideDocument.id.asc())
    ).first()


def _guide_doc_out(doc: Optional[GuideDocument]) -> GuideDocumentOut:
    if not doc:
        return GuideDocumentOut(
            id=None,
            title="გზამკვლევი",
            content="",
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

    return GuideDocumentOut(
        id=doc.id,
        title=(doc.title or "გზამკვლევი").strip() or "გზამკვლევი",
        content=doc.content or "",
        filename=doc.filename if has_file else None,
        file_size_bytes=doc.file_size_bytes if has_file else None,
        download_url="/guide/document/download" if has_file else None,
        available=is_available,
        created_at=doc.created_at,
        updated_at=doc.updated_at,
    )


def _guide_video_out(video: GuideVideo) -> GuideVideoOut:
    return GuideVideoOut(
        id=video.id,
        title=video.title or "",
        url=video.url or "",
        order_index=video.order_index or 0,
        created_at=video.created_at,
    )


# ----------------- Guide Document Endpoints (Admin & Public) -----------------


@router.get("/guide/document", response_model=GuideDocumentOut)
def public_get_guide_document(db: Session = Depends(get_db)):
    doc = _get_guide_doc_record(db)
    return _guide_doc_out(doc)


@router.get("/guide/document/download")
def public_download_guide_document(db: Session = Depends(get_db)):
    doc = _get_guide_doc_record(db)
    if not doc or not doc.file_path:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="გზამკვლევის ფაილი არ მოიძებნა",
        )
    try:
        file_path = _resolve_guide_path(doc.file_path)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="გზამკვლევის ფაილი არ მოიძებნა",
        ) from exc

    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="გზამკვლევის ფაილი არ მოიძებნა",
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
        doc = GuideDocument(title="გზამკვლევი", content="")

    if title is not None:
        cleaned_title = title.strip()
        doc.title = cleaned_title or "გზამკვლევი"

    extracted_html_from_file = ""
    if file and file.filename:
        ext = Path(file.filename).suffix.lower()
        allowed_exts = {".docx", ".doc", ".md", ".txt", ".pdf"}
        if ext not in allowed_exts:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="დაშვებულია მხოლოდ .docx, .md, .txt ან .pdf ფაილები",
            )

        # Delete old file if exists
        if doc.file_path:
            try:
                old_fp = _resolve_guide_path(doc.file_path)
                if old_fp.exists():
                    old_fp.unlink()
            except (OSError, ValueError):
                pass

        unique_name = f"guide_{uuid.uuid4().hex[:12]}{ext}"
        file_path = _resolve_guide_path(_guide_root() / unique_name)
        try:
            file_size = await save_upload_stream(
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
                text_str = raw_bytes.decode("utf-8", errors="replace")
                extracted_html_from_file = structured_text_to_html(text_str)
        except Exception:
            extracted_html_from_file = ""

    if content is not None and content.strip():
        doc.content = structured_text_to_html(content)
    elif extracted_html_from_file:
        doc.content = extracted_html_from_file
    elif content is not None and not file:
        doc.content = ""

    doc.updated_at = datetime.utcnow()
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
