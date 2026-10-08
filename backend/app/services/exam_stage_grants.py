from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.orm import Session as DbSession

from ..models import User, UserExamStageGrant
from .exam_stage import (
    STAGE_ALL,
    STAGE_COMPLETED,
    STAGE_NONE,
    STAGE_PROJECT_1,
    STAGE_PROJECT_2,
    STAGE_SEQUENCE,
    STAGE_THEORY,
    is_admin_like,
)


START_WINDOW = timedelta(hours=1)


def utcnow() -> datetime:
    return datetime.utcnow()


def _naive_utc(value: datetime | None) -> datetime | None:
    if value is None or value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def validate_stage(stage: str) -> str:
    if stage not in STAGE_SEQUENCE:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown exam stage")
    return stage


def lock_user_stage_transitions(db: DbSession, user: User) -> None:
    """Serialize one user's grant/session/result transitions at the DB row.

    SQLite ignores ``SELECT FOR UPDATE``.  A scoped no-op UPDATE obtains its
    write lock before any grant read; other databases obtain the normal row
    write lock.  The caller's surrounding transaction releases it on
    commit/rollback.
    """
    if user.id is None:
        db.flush()
    db.execute(
        update(User)
        .where(User.id == user.id)
        .values(exam_permission=User.exam_permission)
        .execution_options(synchronize_session=False)
    )


def _open_grants_stmt(user_id: int, stage: str | None = None):
    stmt = select(UserExamStageGrant).where(
        UserExamStageGrant.user_id == user_id,
        UserExamStageGrant.consumed_at.is_(None),
        UserExamStageGrant.revoked_at.is_(None),
        UserExamStageGrant.expired_at.is_(None),
    )
    if stage is not None:
        stmt = stmt.where(UserExamStageGrant.stage == stage)
    return stmt.order_by(UserExamStageGrant.id.desc())


def current_open_grant(
    db: DbSession,
    user: User,
    stage: str,
) -> UserExamStageGrant | None:
    validate_stage(stage)
    return db.scalars(_open_grants_stmt(user.id, stage)).first()


def _expire_due_grants(
    db: DbSession,
    user: User,
    *,
    now: datetime | None = None,
) -> bool:
    now = _naive_utc(now) or utcnow()
    due_stmt = _open_grants_stmt(user.id).where(
        UserExamStageGrant.started_at.is_(None),
        UserExamStageGrant.expires_at <= now,
    )
    # Most profile/admin polls have nothing to expire.  Avoid taking a write
    # lock in that common read path; if a candidate is due, lock then recheck.
    if db.scalars(due_stmt).first() is None:
        return False
    lock_user_stage_transitions(db, user)
    changed = False
    for grant in db.scalars(due_stmt).all():
        grant.expired_at = now
        db.add(grant)
        changed = True
    if changed:
        # Production SessionLocal disables autoflush.  Dependent eligibility
        # queries in the same request must observe that these rows are closed.
        db.flush()
    return changed


def _latest_grants(db: DbSession, user: User) -> dict[str, UserExamStageGrant]:
    rows = db.scalars(
        select(UserExamStageGrant)
        .where(UserExamStageGrant.user_id == user.id)
        .order_by(UserExamStageGrant.id.desc())
    ).all()
    latest: dict[str, UserExamStageGrant] = {}
    for row in rows:
        if row.stage in STAGE_SEQUENCE and row.stage not in latest:
            latest[row.stage] = row
    return latest


def sync_legacy_stage_fields(db: DbSession, user: User) -> bool:
    """Project independent grants onto the retained single-stage fields."""
    # Callers may just have revoked/consumed/started a grant.  SessionLocal is
    # configured with autoflush=False, so make the projection authoritative.
    db.flush()
    by_stage = {
        grant.stage: grant
        for grant in db.scalars(_open_grants_stmt(user.id)).all()
    }

    selected: UserExamStageGrant | None = None
    for stage in STAGE_SEQUENCE:
        candidate = by_stage.get(stage)
        if candidate is not None and candidate.started_at is not None:
            selected = candidate
            break
    if selected is None:
        for stage in STAGE_SEQUENCE:
            candidate = by_stage.get(stage)
            if candidate is not None:
                selected = candidate
                break

    old = (
        bool(user.exam_permission),
        user.exam_stage,
        _naive_utc(user.exam_stage_expires_at),
        _naive_utc(user.exam_stage_started_at),
    )
    if selected is not None:
        user.exam_permission = True
        user.exam_stage = selected.stage
        user.exam_stage_expires_at = _naive_utc(selected.expires_at)
        user.exam_stage_started_at = _naive_utc(selected.started_at)
    else:
        latest = _latest_grants(db, user)
        all_completed = all(
            latest.get(stage) is not None and latest[stage].consumed_at is not None
            for stage in STAGE_SEQUENCE
        )
        user.exam_permission = False
        user.exam_stage = STAGE_COMPLETED if all_completed else STAGE_NONE
        user.exam_stage_expires_at = None
        user.exam_stage_started_at = None

    new = (
        bool(user.exam_permission),
        user.exam_stage,
        _naive_utc(user.exam_stage_expires_at),
        _naive_utc(user.exam_stage_started_at),
    )
    if new != old:
        db.add(user)
        return True
    return False


def grant_stage_permission(
    db: DbSession,
    user: User,
    stage: str,
    *,
    now: datetime | None = None,
    replace_started: bool = False,
    expected_grant_id: int | None = None,
) -> UserExamStageGrant | None:
    stage = validate_stage(stage)
    if is_admin_like(user):
        return None
    now = _naive_utc(now) or utcnow()
    lock_user_stage_transitions(db, user)
    _expire_due_grants(db, user, now=now)
    existing = current_open_grant(db, user, stage)
    if existing is not None:
        # The row may already be present in a long-lived Session identity map.
        # Refresh only after taking the user's transition lock so replacement
        # decisions use the current database generation and start state.
        db.refresh(existing)
        if replace_started:
            if (
                existing.started_at is None
                or expected_grant_id is None
                or existing.id != expected_grant_id
            ):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="The running exam attempt changed; refresh and try again",
                )
            existing.revoked_at = now
            db.add(existing)
            db.flush()
        elif existing.started_at is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="This exam stage is already in progress",
            )
        else:
            if expected_grant_id is not None:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="expected_grant_id requires replace_started=true",
                )
            sync_legacy_stage_fields(db, user)
            return existing
    elif replace_started:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="The running exam attempt changed; refresh and try again",
        )
    elif expected_grant_id is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="expected_grant_id requires replace_started=true",
        )

    grant = UserExamStageGrant(
        user_id=user.id,
        stage=stage,
        granted_at=now,
        expires_at=now + START_WINDOW,
    )
    db.add(grant)
    db.flush()
    sync_legacy_stage_fields(db, user)
    return grant


def revoke_stage_permission(
    db: DbSession,
    user: User,
    stage: str,
    *,
    now: datetime | None = None,
    allow_started: bool = True,
) -> bool:
    stage = validate_stage(stage)
    now = _naive_utc(now) or utcnow()
    lock_user_stage_transitions(db, user)
    changed = _expire_due_grants(db, user, now=now)
    open_grants = db.scalars(_open_grants_stmt(user.id, stage)).all()
    for grant in open_grants:
        db.refresh(grant)
    if not allow_started and any(grant.started_at is not None for grant in open_grants):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An exam attempt is already in progress",
        )
    for grant in open_grants:
        grant.revoked_at = now
        db.add(grant)
        changed = True
    return sync_legacy_stage_fields(db, user) or changed


def reset_all_stage_permissions(
    db: DbSession,
    user: User,
    *,
    now: datetime | None = None,
) -> bool:
    now = _naive_utc(now) or utcnow()
    lock_user_stage_transitions(db, user)
    changed = _expire_due_grants(db, user, now=now)
    for grant in db.scalars(_open_grants_stmt(user.id)).all():
        grant.revoked_at = now
        db.add(grant)
        changed = True
    return sync_legacy_stage_fields(db, user) or changed


def expire_unused_stage_permissions(
    db: DbSession,
    user: User,
    *,
    commit: bool = False,
    now: datetime | None = None,
) -> bool:
    changed = _expire_due_grants(db, user, now=now)
    changed = sync_legacy_stage_fields(db, user) or changed
    if changed and commit:
        db.commit()
        db.refresh(user)
    return changed


def require_stage_permission(
    db: DbSession,
    user: User,
    stage: str,
    *,
    mark_started: bool = False,
    grant_id: int | None = None,
) -> UserExamStageGrant | None:
    stage = validate_stage(stage)
    if is_admin_like(user):
        return None
    lock_user_stage_transitions(db, user)
    _expire_due_grants(db, user)
    grant = db.get(UserExamStageGrant, grant_id) if grant_id is not None else current_open_grant(db, user, stage)
    if grant is not None:
        db.refresh(grant)
    if (
        grant is None
        or grant.user_id != user.id
        or grant.stage != stage
        or grant.consumed_at is not None
        or grant.revoked_at is not None
        or grant.expired_at is not None
    ):
        sync_legacy_stage_fields(db, user)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This exam stage is not available",
        )
    if mark_started and grant.started_at is None:
        grant.started_at = utcnow()
        db.add(grant)
    sync_legacy_stage_fields(db, user)
    return grant


def completion_grant(
    db: DbSession,
    user: User,
    stage: str,
    grant_id: int | None,
) -> UserExamStageGrant | None:
    stage = validate_stage(stage)
    if is_admin_like(user):
        return None
    lock_user_stage_transitions(db, user)
    if grant_id is not None:
        grant = db.get(UserExamStageGrant, grant_id)
    else:
        grant = current_open_grant(db, user, stage)
        if grant is not None:
            db.refresh(grant)
        unresolved_revoked = db.scalars(
            select(UserExamStageGrant)
            .where(
                UserExamStageGrant.user_id == user.id,
                UserExamStageGrant.stage == stage,
                UserExamStageGrant.started_at.is_not(None),
                UserExamStageGrant.revoked_at.is_not(None),
                UserExamStageGrant.consumed_at.is_(None),
                UserExamStageGrant.expired_at.is_(None),
            )
            .order_by(UserExamStageGrant.id.desc())
        ).all()
        for unresolved in unresolved_revoked:
            db.refresh(unresolved)
        if grant is not None and grant.started_at is not None and unresolved_revoked:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="stageGrantId is required for this result",
            )
        if (grant is None or grant.started_at is None) and len(unresolved_revoked) == 1:
            grant = unresolved_revoked[0]
    if grant is not None:
        db.refresh(grant)
    if (
        grant is None
        or grant.user_id != user.id
        or grant.stage != stage
        or grant.started_at is None
        or grant.expired_at is not None
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Exam stage has not been started",
        )
    return grant


def consume_stage_permission(
    db: DbSession,
    user: User | None,
    stage: str,
    *,
    grant_id: int | None = None,
    now: datetime | None = None,
) -> bool:
    if user is None or is_admin_like(user):
        return False
    grant = completion_grant(db, user, stage, grant_id)
    if grant is None or grant.consumed_at is not None:
        return False
    grant.consumed_at = _naive_utc(now) or utcnow()
    db.add(grant)
    sync_legacy_stage_fields(db, user)
    return True


def _permission_item(
    grant: UserExamStageGrant | None,
    *,
    now: datetime,
) -> dict[str, Any]:
    if grant is None:
        return {
            "granted": False,
            "status": "none",
            "grant_id": None,
            "granted_at": None,
            "expires_at": None,
            "started_at": None,
            "remaining_seconds": None,
        }
    if grant.consumed_at is not None:
        # Completion closes authorization for a new start, while retaining the
        # generation identifier that owns the stored result.
        item_status, granted, grant_id = "completed", False, grant.id
    elif grant.revoked_at is not None:
        item_status, granted, grant_id = "none", False, None
    elif grant.expired_at is not None:
        item_status, granted, grant_id = "expired", False, grant.id
    elif grant.started_at is not None:
        # The checkbox represents permission to start, not permission to keep
        # running.  A started grant remains valid only for its bound attempt
        # and exact-ID completion, but cannot authorize another start.
        item_status, granted, grant_id = "started", False, grant.id
    else:
        item_status, granted, grant_id = "available", True, grant.id

    expires_at = _naive_utc(grant.expires_at)
    remaining_seconds: int | None = None
    if item_status == "available" and expires_at is not None:
        remaining_seconds = max(0, int((expires_at - now).total_seconds()))
    return {
        "granted": granted,
        "status": item_status,
        "grant_id": grant_id,
        "granted_at": _naive_utc(grant.granted_at),
        "expires_at": expires_at,
        "started_at": _naive_utc(grant.started_at),
        "remaining_seconds": remaining_seconds,
    }


def exam_state_with_permissions(
    db: DbSession,
    user: User,
    *,
    is_admin_user: bool | None = None,
) -> dict[str, Any]:
    admin_user = is_admin_like(user) if is_admin_user is None else bool(is_admin_user)
    if admin_user:
        permissions = {
            stage: {
                "granted": True,
                "status": "available",
                "grant_id": None,
                "granted_at": None,
                "expires_at": None,
                "started_at": None,
                "remaining_seconds": None,
            }
            for stage in STAGE_SEQUENCE
        }
        return {
            "exam_permission": True,
            "exam_stage": STAGE_ALL,
            "exam_stage_expires_at": None,
            "exam_stage_started_at": None,
            "exam_stage_status": "available",
            "exam_stage_remaining_seconds": None,
            "exam_stage_permissions": permissions,
        }

    now = utcnow()
    _expire_due_grants(db, user, now=now)
    sync_legacy_stage_fields(db, user)
    latest = _latest_grants(db, user)
    permissions = {
        stage: _permission_item(latest.get(stage), now=now)
        for stage in STAGE_SEQUENCE
    }
    legacy_stage = user.exam_stage or STAGE_NONE
    selected = permissions.get(legacy_stage)
    if selected and (
        selected["granted"] or selected["status"] == "started"
    ):
        legacy_status = selected["status"]
        remaining = selected["remaining_seconds"]
        expires_at = selected["expires_at"]
        started_at = selected["started_at"]
    else:
        legacy_status = "completed" if legacy_stage == STAGE_COMPLETED else "none"
        remaining = expires_at = started_at = None
    return {
        "exam_permission": any(item["granted"] for item in permissions.values()),
        "exam_stage": legacy_stage,
        "exam_stage_expires_at": expires_at,
        "exam_stage_started_at": started_at,
        "exam_stage_status": legacy_status,
        "exam_stage_remaining_seconds": remaining,
        "exam_stage_permissions": permissions,
    }

