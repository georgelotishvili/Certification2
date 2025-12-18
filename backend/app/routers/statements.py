from __future__ import annotations

from datetime import datetime
from typing import List, Optional
import os

from fastapi import APIRouter, Depends, Header, HTTPException, status, UploadFile, File, Form, Query
from fastapi.responses import FileResponse
from sqlalchemy import select, func
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Statement, User
from ..schemas import StatementOut
from ..services.media_storage import ensure_statement_dir, relative_storage_path, resolve_storage_path


router = APIRouter()


ALLOWED_EXTS = {".zip", ".rar", ".pdf", ".jpg", ".jpeg"}
MAX_BYTES = 100 * 1024 * 1024  # 100MB


def _get_actor_user(
    db: Session,
    actor_email: str | None,
) -> User:
    email = (actor_email or "").strip().lower()
    if not email:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")
    user = db.scalar(select(User).where(func.lower(User.email) == email))
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user


def _validate_attachment(upload: Optional[UploadFile]):
    if not upload:
        return
    ext = os.path.splitext(upload.filename or "")[1].lower()
    if ext not in ALLOWED_EXTS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="file type not allowed (zip/rar/pdf/jpeg only)")
    try:
        upload.file.seek(0, os.SEEK_END)
        size = upload.file.tell()
        upload.file.seek(0)
        if size and size > MAX_BYTES:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="file too large (max 100MB)")
    except Exception:
        pass


def _save_attachment(user_id: int, statement_id: int, upload: UploadFile) -> tuple[str, str, str | None, int | None]:
    directory = ensure_statement_dir(user_id, statement_id)
    safe_name = os.path.basename(upload.filename or "attachment")
    path = directory / safe_name
    total = 0
    with open(path, "wb") as f:
        while True:
            chunk = upload.file.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_BYTES:
                f.close()
                try:
                    path.unlink(missing_ok=True)  # type: ignore[arg-type]
                except Exception:
                    pass
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="file too large (max 100MB)")
            f.write(chunk)
    rel = relative_storage_path(path)
    mime = (upload.content_type or "").strip() or None
    return rel, safe_name, mime, total or None


@router.post("", response_model=StatementOut, status_code=status.HTTP_201_CREATED)
def create_statement(
    message: str = Form(...),
    attachment: UploadFile | None = File(None),
    x_actor_email: str | None = Header(None, alias="x-actor-email"),
    db: Session = Depends(get_db),
) -> StatementOut:
    try:
        user = _get_actor_user(db, x_actor_email)
        msg = (message or "").strip()
        if not msg:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="message required")

        st = Statement(user_id=user.id, message=msg)
        db.add(st)
        db.commit()
        db.refresh(st)

        if attachment:
            _validate_attachment(attachment)
            rel, name, mime, size = _save_attachment(user.id, st.id, attachment)
            st.attachment_path = rel
            st.attachment_filename = name
            st.attachment_mime_type = mime
            st.attachment_size_bytes = size
            db.add(st)
            db.commit()
            db.refresh(st)

        return StatementOut(
            id=st.id,
            message=st.message,
            created_at=st.created_at,
            attachment_filename=getattr(st, 'attachment_filename', None),
        )
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Internal error: {str(e)}")


@router.get("/me", response_model=List[StatementOut])
def list_my_statements(
    x_actor_email: str | None = Header(None, alias="x-actor-email"),
    db: Session = Depends(get_db),
) -> List[StatementOut]:
    try:
        user = _get_actor_user(db, x_actor_email)
        statements = db.scalars(
            select(Statement)
            .where(Statement.user_id == user.id)
            .order_by(Statement.created_at.desc(), Statement.id.desc())
        ).all()
        return [
            StatementOut(
                id=statement.id,
                message=statement.message,
                created_at=statement.created_at,
                attachment_filename=getattr(statement, 'attachment_filename', None),
            )
            for statement in statements
        ]
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Internal error: {str(e)}")


@router.get("/summary")
def statements_summary(
    db: Session = Depends(get_db),
):
    total_unseen = db.scalar(select(func.count()).select_from(Statement).where(Statement.seen_at.is_(None))) or 0
    return {"has_unseen": total_unseen > 0, "unseen_total": total_unseen}


@router.get("/{statement_id}/attachment")
def download_statement_attachment(
    statement_id: int,
    x_actor_email: str | None = Header(None, alias="x-actor-email"),
    actor: str | None = Query(None, description="actor email (fallback for links)"),
    db: Session = Depends(get_db),
):
    """Download statement attachment. Only the owner can download their own statement attachments."""
    try:
        user = _get_actor_user(db, x_actor_email or actor)
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
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Internal error: {str(e)}")

