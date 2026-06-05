from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.orm import Session as DbSession

from ..config import get_settings
from ..models import User


STAGE_NONE = "none"
STAGE_THEORY = "theory"
STAGE_PROJECT_1 = "project_stage_1"
STAGE_PROJECT_2 = "project_stage_2"
STAGE_COMPLETED = "completed"
STAGE_ALL = "all"

STAGE_SEQUENCE = (STAGE_THEORY, STAGE_PROJECT_1, STAGE_PROJECT_2)
START_WINDOW = timedelta(hours=1)


def utcnow() -> datetime:
    return datetime.utcnow()


def is_admin_like(user: User) -> bool:
    settings = get_settings()
    founder_email = (settings.founder_admin_email or "").lower()
    return (user.email or "").lower() == founder_email or bool(user.is_admin)


def reset_exam_flow(user: User) -> None:
    user.exam_permission = False
    user.exam_stage = STAGE_NONE
    user.exam_stage_expires_at = None
    user.exam_stage_started_at = None


def start_exam_flow(user: User, *, now: datetime | None = None) -> None:
    now = now or utcnow()
    user.exam_permission = True
    user.exam_stage = STAGE_THEORY
    user.exam_stage_expires_at = now + START_WINDOW
    user.exam_stage_started_at = None


def _expire_if_unused(user: User, *, now: datetime | None = None) -> bool:
    now = now or utcnow()
    stage = user.exam_stage or STAGE_NONE
    if (
        bool(user.exam_permission)
        and stage in STAGE_SEQUENCE
        and user.exam_stage_started_at is None
        and user.exam_stage_expires_at is not None
        and user.exam_stage_expires_at <= now
    ):
        reset_exam_flow(user)
        return True
    return False


def expire_if_unused(db: DbSession, user: User, *, commit: bool = False) -> bool:
    changed = _expire_if_unused(user)
    if changed:
        db.add(user)
        if commit:
            db.commit()
            db.refresh(user)
    return changed


def require_stage(
    db: DbSession,
    user: User,
    stage: str,
    *,
    mark_started: bool = False,
) -> bool:
    if is_admin_like(user):
        return False

    expire_if_unused(db, user)
    if not user.exam_permission or (user.exam_stage or STAGE_NONE) != stage:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This exam stage is not available",
        )

    if user.exam_stage_started_at is not None and mark_started:
        return False

    if mark_started:
        user.exam_stage_started_at = utcnow()
        db.add(user)
        return True

    return False


def advance_after_stage_result(
    db: DbSession,
    user: User | None,
    completed_stage: str,
) -> bool:
    if not user or is_admin_like(user):
        return False

    expire_if_unused(db, user)
    current_stage = user.exam_stage or STAGE_NONE
    if current_stage != completed_stage:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Result does not match the active exam stage",
        )

    now = utcnow()
    if completed_stage == STAGE_THEORY:
        user.exam_permission = True
        user.exam_stage = STAGE_PROJECT_1
        user.exam_stage_expires_at = now + START_WINDOW
        user.exam_stage_started_at = None
    elif completed_stage == STAGE_PROJECT_1:
        user.exam_permission = True
        user.exam_stage = STAGE_PROJECT_2
        user.exam_stage_expires_at = now + START_WINDOW
        user.exam_stage_started_at = None
    elif completed_stage == STAGE_PROJECT_2:
        user.exam_permission = False
        user.exam_stage = STAGE_COMPLETED
        user.exam_stage_expires_at = None
        user.exam_stage_started_at = None
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unknown exam stage",
        )

    db.add(user)
    return True


def exam_state_payload(user: User, *, is_admin_user: bool | None = None) -> dict[str, Any]:
    admin_user = is_admin_like(user) if is_admin_user is None else bool(is_admin_user)
    if admin_user:
        return {
            "exam_permission": True,
            "exam_stage": STAGE_ALL,
            "exam_stage_expires_at": None,
            "exam_stage_started_at": None,
            "exam_stage_status": "available",
            "exam_stage_remaining_seconds": None,
        }

    _expire_if_unused(user)
    stage = user.exam_stage or STAGE_NONE
    has_permission = bool(user.exam_permission) and stage in STAGE_SEQUENCE
    remaining_seconds: int | None = None
    status_value = "none"

    if has_permission:
        if user.exam_stage_started_at is not None:
            status_value = "started"
        else:
            status_value = "available"
            if user.exam_stage_expires_at:
                remaining_seconds = max(0, int((user.exam_stage_expires_at - utcnow()).total_seconds()))
    elif stage == STAGE_COMPLETED:
        status_value = "completed"

    return {
        "exam_permission": has_permission,
        "exam_stage": stage,
        "exam_stage_expires_at": user.exam_stage_expires_at if has_permission else None,
        "exam_stage_started_at": user.exam_stage_started_at if has_permission else None,
        "exam_stage_status": status_value,
        "exam_stage_remaining_seconds": remaining_seconds,
    }
