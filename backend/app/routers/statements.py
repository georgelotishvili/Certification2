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
from ..models import (
    Statement,
    User,
    UserSession,
    build_statement_attachments_list,
    format_statement_doc_number,
)
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


def _save_multiple_attachments(
    user_id: int,
    statement_id: int,
    uploads: List[UploadFile],
    *,
    zip_prefix: str = "documents",
) -> tuple[str, str, str | None, int | None]:
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
    return rel, f"{zip_prefix}_{statement_id}.zip", "application/zip", zip_size or None


def _clean_upload_list(items: List[UploadFile] | None) -> List[UploadFile]:
    out: List[UploadFile] = []
    if isinstance(items, list):
        for item in items:
            if item is not None and getattr(item, "filename", None):
                out.append(item)
    return out


def _save_slot_uploads(
    user_id: int,
    statement_id: int,
    uploads: List[UploadFile],
    *,
    zip_prefix: str = "documents",
) -> tuple[str, str, str | None, int | None]:
    if len(uploads) == 1:
        return _save_attachment(user_id, statement_id, uploads[0])
    return _save_multiple_attachments(user_id, statement_id, uploads, zip_prefix=zip_prefix)


def _get_statement_slot_fields(statement: Statement, slot: int = 1) -> tuple[str | None, str | None, str | None]:
    if slot == 2:
        return statement.attachment2_path, statement.attachment2_filename, statement.attachment2_mime_type
    if slot == 3:
        return statement.attachment3_path, statement.attachment3_filename, statement.attachment3_mime_type
    return statement.attachment_path, statement.attachment_filename, statement.attachment_mime_type


@router.post("", response_model=StatementOut, status_code=status.HTTP_201_CREATED)
def create_statement(
    message: str = Form(...),
    attachment: UploadFile | None = File(None),
    attachments: List[UploadFile] = File(default=[]),
    id_attachments: List[UploadFile] = File(default=[]),
    diploma_attachments: List[UploadFile] = File(default=[]),
    experience_attachments: List[UploadFile] = File(default=[]),
    is_exam_application: bool = Form(default=False),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
) -> StatementOut:
    saved_storage_paths: list[str] = []
    committed = False
    try:
        user = _get_actor_user(db, authorization)
        msg = (message or "").strip()
        if not msg:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="message required")

        slot1_list = _clean_upload_list(id_attachments)
        slot2_list = _clean_upload_list(diploma_attachments)
        slot3_list = _clean_upload_list(experience_attachments)
        using_three_slots = bool(is_exam_application or slot1_list or slot2_list or slot3_list)

        if using_three_slots:
            if not slot1_list:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="გთხოვთ ატვირთოთ პირადობის დამადასტურებელი დოკუმენტის ასლი",
                )
            if not slot2_list:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="გთხოვთ ატვირთოთ უმაღლესი განათლების დამადასტურებელი დოკუმენტის (დიპლომის) ასლი ან განმარტებითი ბარათი",
                )
            if not slot3_list:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="გთხოვთ ატვირთოთ პროფესიული გამოცდილების დამადასტურებელი დოკუმენტაცია",
                )
            for item in (*slot1_list, *slot2_list, *slot3_list):
                _validate_attachment(item)
            upload_list: List[UploadFile] = []
        else:
            upload_list = _clean_upload_list(attachments)
            if not upload_list and attachment is not None and getattr(attachment, "filename", None):
                upload_list.append(attachment)
            for item in upload_list:
                _validate_attachment(item)

        st = Statement(user_id=user.id, message=msg)
        db.add(st)
        db.flush()
        if not st.doc_number:
            st.doc_number = format_statement_doc_number(st)

        if using_three_slots:
            rel1, name1, mime1, size1 = _save_slot_uploads(
                user.id, st.id, slot1_list, zip_prefix="piradoba"
            )
            saved_storage_paths.append(rel1)
            st.attachment_path = rel1
            st.attachment_filename = name1
            st.attachment_mime_type = mime1
            st.attachment_size_bytes = size1

            rel2, name2, mime2, size2 = _save_slot_uploads(
                user.id, st.id, slot2_list, zip_prefix="diplomi"
            )
            saved_storage_paths.append(rel2)
            st.attachment2_path = rel2
            st.attachment2_filename = name2
            st.attachment2_mime_type = mime2
            st.attachment2_size_bytes = size2

            rel3, name3, mime3, size3 = _save_slot_uploads(
                user.id, st.id, slot3_list, zip_prefix="gamocdileba"
            )
            saved_storage_paths.append(rel3)
            st.attachment3_path = rel3
            st.attachment3_filename = name3
            st.attachment3_mime_type = mime3
            st.attachment3_size_bytes = size3
        elif upload_list:
            rel, name, mime, size = _save_slot_uploads(
                user.id, st.id, upload_list, zip_prefix="documents"
            )
            saved_storage_paths.append(rel)
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
            attachments=build_statement_attachments_list(st),
        )
    except HTTPException:
        if not committed:
            try:
                db.rollback()
            except Exception:
                pass
            for sp in saved_storage_paths:
                delete_storage_file(sp)
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        if not committed:
            try:
                db.rollback()
            except Exception:
                pass
            for sp in saved_storage_paths:
                delete_storage_file(sp)
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
                attachments=build_statement_attachments_list(statement),
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
    slot: int = Query(1, ge=1, le=3),
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
        rel_path, orig_filename, mime_type = _get_statement_slot_fields(statement, slot)
        if not rel_path:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Attachment not found")
        try:
            abs_path = resolve_storage_path(rel_path)
        except ValueError:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
        if not abs_path.exists():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
        filename = orig_filename or abs_path.name
        return FileResponse(
            abs_path,
            media_type=mime_type or "application/octet-stream",
            filename=filename,
        )
    except HTTPException:
        raise
    except Exception:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Internal server error")
