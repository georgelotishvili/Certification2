from __future__ import annotations

from datetime import datetime
from typing import List, Optional
import os
from uuid import uuid4
import zipfile

from fastapi import APIRouter, Depends, Header, HTTPException, status, UploadFile, File, Form, Query
from fastapi.responses import FileResponse
from sqlalchemy import select, func
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Statement, User, UserSession, format_statement_doc_number
from ..schemas import StatementOut
from ..services.email_verification import send_statement_confirmation_email
from ..services.media_storage import ensure_statement_dir, relative_storage_path, resolve_storage_path, delete_storage_file
from ..services.bounded_upload import (
    DEFAULT_UPLOAD_MAX_BYTES,
    UploadTooLarge,
    save_upload_stream,
)


router = APIRouter()


ALLOWED_EXTS = {".zip", ".rar", ".pdf", ".jpg", ".jpeg", ".png", ".doc", ".docx"}
MAX_BYTES = DEFAULT_UPLOAD_MAX_BYTES


def _get_actor_user(
    db: Session,
    authorization: str | None = None,
) -> User:
    """Get user from Bearer token."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Bearer token required")
    
    token = authorization.split(" ", 1)[1]
    session = db.scalar(
        select(UserSession).where(
            UserSession.token == token,
            UserSession.expires_at > datetime.utcnow()
        )
    )
    if not session:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")
    
    user = db.get(User, session.user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    
    return user


def _validate_attachment(upload: Optional[UploadFile]):
    if not upload:
        return
    ext = os.path.splitext(upload.filename or "")[1].lower()
    if ext not in ALLOWED_EXTS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="file type not allowed (zip/rar/pdf/jpeg/png/word only)")


def _save_attachment(user_id: int, statement_id: int, upload: UploadFile) -> tuple[str, str, str | None, int | None]:
    directory = ensure_statement_dir(user_id, statement_id)
    safe_name = os.path.basename(upload.filename or "attachment")
    ext = os.path.splitext(safe_name)[1].lower()
    path = directory / f"{uuid4().hex}{ext}"
    try:
        total = save_upload_stream(upload.file, path, max_bytes=MAX_BYTES)
    except UploadTooLarge as exc:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="file too large (max 100MB)",
        ) from exc
    rel = relative_storage_path(path)
    mime = (upload.content_type or "").strip() or None
    return rel, safe_name, mime, total or None


def _save_multiple_attachments(user_id: int, statement_id: int, uploads: List[UploadFile]) -> tuple[str, str, str | None, int | None]:
    directory = ensure_statement_dir(user_id, statement_id)
    temp_paths = []
    used_names: dict[str, int] = {}
    total_bytes = 0
    zip_path = directory / f"{uuid4().hex}.zip"
    try:
        for idx, upload in enumerate(uploads, start=1):
            raw_name = os.path.basename(upload.filename or f"document_{idx}")
            base, ext = os.path.splitext(raw_name)
            count = used_names.get(raw_name.lower(), 0)
            used_names[raw_name.lower()] = count + 1
            arcname = f"{base}_{count + 1}{ext}" if count > 0 else raw_name

            tmp_path = directory / f"tmp_{uuid4().hex}{ext.lower()}"
            temp_paths.append((tmp_path, arcname))
            remaining = MAX_BYTES - total_bytes
            if remaining <= 0:
                raise UploadTooLarge("Total upload size exceeded")
            written = save_upload_stream(upload.file, tmp_path, max_bytes=remaining)
            total_bytes += written

        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for tmp_path, arcname in temp_paths:
                if tmp_path.exists():
                    zf.write(tmp_path, arcname=arcname)
    except UploadTooLarge as exc:
        zip_path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="file too large (max 100MB)",
        ) from exc
    finally:
        for tmp_path, _ in temp_paths:
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                pass

    zip_size = zip_path.stat().st_size if zip_path.exists() else total_bytes
    rel = relative_storage_path(zip_path)
    return rel, f"documents_{statement_id}.zip", "application/zip", zip_size or None


@router.post("", response_model=StatementOut, status_code=status.HTTP_201_CREATED)
def create_statement(
    message: str = Form(...),
    attachment: UploadFile | None = File(None),
    attachments: List[UploadFile] | None = File(None),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
) -> StatementOut:
    saved_storage_path: str | None = None
    committed = False
    try:
        user = _get_actor_user(db, authorization)
        msg = (message or "").strip()
        if not msg:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="message required")

        upload_list: List[UploadFile] = []
        if isinstance(attachments, list):
            for item in attachments:
                if item is not None and getattr(item, "filename", None):
                    upload_list.append(item)
        if not upload_list and attachment is not None and getattr(attachment, "filename", None):
            upload_list.append(attachment)

        for item in upload_list:
            _validate_attachment(item)

        st = Statement(user_id=user.id, message=msg)
        db.add(st)
        db.flush()
        if not st.doc_number:
            st.doc_number = format_statement_doc_number(st)

        if len(upload_list) == 1:
            rel, name, mime, size = _save_attachment(user.id, st.id, upload_list[0])
            saved_storage_path = rel
            st.attachment_path = rel
            st.attachment_filename = name
            st.attachment_mime_type = mime
            st.attachment_size_bytes = size
        elif len(upload_list) > 1:
            rel, name, mime, size = _save_multiple_attachments(user.id, st.id, upload_list)
            saved_storage_path = rel
            st.attachment_path = rel
            st.attachment_filename = name
            st.attachment_mime_type = mime
            st.attachment_size_bytes = size

        db.commit()
        committed = True
        db.refresh(st)

        user_email = (getattr(user, "email", None) or "").strip()
        full_name = f"{getattr(user, 'first_name', '') or ''} {getattr(user, 'last_name', '') or ''}".strip()
        if user_email:
            send_statement_confirmation_email(user_email, full_name)

        return StatementOut(
            id=st.id,
            doc_number=format_statement_doc_number(st),
            message=st.message,
            created_at=st.created_at,
            attachment_filename=getattr(st, 'attachment_filename', None),
        )
    except HTTPException:
        if not committed:
            try:
                db.rollback()
            except Exception:
                pass
            if saved_storage_path:
                delete_storage_file(saved_storage_path)
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        if not committed:
            try:
                db.rollback()
            except Exception:
                pass
            if saved_storage_path:
                delete_storage_file(saved_storage_path)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Internal server error")


@router.get("/me", response_model=List[StatementOut])
def list_my_statements(
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
) -> List[StatementOut]:
    try:
        user = _get_actor_user(db, authorization)
        statements = db.scalars(
            select(Statement)
            .where(Statement.user_id == user.id)
            .order_by(Statement.created_at.desc(), Statement.id.desc())
        ).all()
        return [
            StatementOut(
                id=statement.id,
                doc_number=format_statement_doc_number(statement),
                message=statement.message,
                created_at=statement.created_at,
                attachment_filename=getattr(statement, 'attachment_filename', None),
            )
            for statement in statements
        ]
    except HTTPException:
        raise
    except Exception:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Internal server error")


@router.get("/summary")
def statements_summary(
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    from .admin import _require_admin
    _require_admin(db, authorization)
    total_unseen = db.scalar(select(func.count()).select_from(Statement).where(Statement.seen_at.is_(None))) or 0
    return {"has_unseen": total_unseen > 0, "unseen_total": total_unseen}


@router.get("/{statement_id}/attachment")
def download_statement_attachment(
    statement_id: int,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """Download statement attachment. Only the owner can download their own statement attachments."""
    try:
        user = _get_actor_user(db, authorization)
        statement = db.scalar(select(Statement).where(Statement.id == statement_id))
        if not statement:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Statement not found")
        if statement.user_id != user.id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
        if not statement.attachment_path:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Attachment not found")
        try:
            abs_path = resolve_storage_path(statement.attachment_path)
        except ValueError:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
        if not abs_path.exists():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
        filename = statement.attachment_filename or abs_path.name
        return FileResponse(
            abs_path,
            media_type=statement.attachment_mime_type or "application/octet-stream",
            filename=filename,
        )
    except HTTPException:
        raise
    except Exception:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Internal server error")
