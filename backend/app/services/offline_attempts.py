"""Opt-in offline completion; no changes to legacy submission windows.

The desktop is responsible for freezing answers by the server-issued deadline.
An offline timestamp is a client assertion, not cryptographic proof of timing.
The server binds authorization, enforces its original interval, and atomically
accepts exactly one immutable final payload, however late transport arrives.
"""
from __future__ import annotations

import hashlib
import json
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..models import Answer, OfflineExamAttempt, Session as ExamSession, User, UserExamStageGrant
from .exam_stage import is_admin_like
from .exam_stage_grants import (
    lock_user_stage_transitions, require_stage_permission, sync_legacy_stage_fields,
)
from .offline_grading import (
    capture_project_content, capture_theory_content,
    get_prepared_project_material, lock_project_content,
)


def naive_utc(value: datetime) -> datetime:
    if value.tzinfo is not None:
        return value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def utc_response(value: datetime) -> datetime:
    return naive_utc(value).replace(tzinfo=timezone.utc)


def theory_attempt(db: Session, session_id: int) -> OfflineExamAttempt | None:
    return db.scalar(select(OfflineExamAttempt).where(OfflineExamAttempt.session_id == session_id))


def require_uncancelled_attempt(attempt: OfflineExamAttempt) -> None:
    if attempt.receipt:
        try:
            receipt = json.loads(attempt.receipt)
        except (ValueError, TypeError):
            receipt = None
        if isinstance(receipt, dict) and receipt.get("cancelled") is True:
            raise HTTPException(409, "This offline attempt was cancelled after interruption")


def require_legacy_theory_submission(db: Session, session_id: int) -> None:
    if theory_attempt(db, session_id) is not None:
        raise HTTPException(409, "This offline attempt requires atomic offline-final submission")


def require_legacy_project_submission(db: Session, grant_id: int | None) -> None:
    if grant_id is not None and db.scalar(select(OfflineExamAttempt.id).where(
        OfflineExamAttempt.stage_grant_id == grant_id
    )) is not None:
        raise HTTPException(409, "This offline attempt requires its submission capability")


def register_theory_attempt(db: Session, session) -> OfflineExamAttempt:
    user = db.get(User, session.user_id)
    if user is None:
        raise HTTPException(403, "Candidate not found")
    lock_user_stage_transitions(db, user)
    attempt = theory_attempt(db, session.id)
    if attempt is not None:
        require_uncancelled_attempt(attempt)
        return attempt
    attempt = OfflineExamAttempt(
        token=secrets.token_urlsafe(48), user_id=user.id, stage="theory",
        stage_grant_id=session.stage_grant_id, session_id=session.id,
        started_at=naive_utc(session.started_at), ends_at=naive_utc(session.ends_at),
    )
    db.add(attempt)
    db.flush()
    capture_theory_content(db, attempt, session)
    return attempt


def start_project_attempt(db: Session, user: User, stage: str, payload, project_model,
                          duration_minutes: int) -> OfflineExamAttempt:
    lock_user_stage_transitions(db, user)
    request_id = str(payload.startRequestId) if payload.startRequestId else None
    if not payload.projectCode or (is_admin_like(user) and not request_id):
        raise HTTPException(400, "projectCode and an admin startRequestId are required for offline start")
    if not is_admin_like(user) and payload.stageGrantId is None:
        raise HTTPException(400, "stageGrantId is required for offline start")
    attempt = None
    if request_id:
        attempt = db.scalar(select(OfflineExamAttempt).where(
            OfflineExamAttempt.start_request_id == request_id))
    if attempt is None and payload.stageGrantId is not None:
        attempt = db.scalar(select(OfflineExamAttempt).where(
            OfflineExamAttempt.stage_grant_id == payload.stageGrantId))
    if attempt is not None:
        db.refresh(attempt)
        if (attempt.user_id != user.id or attempt.stage != stage
                or attempt.stage_grant_id != payload.stageGrantId
                or attempt.project_code != payload.projectCode.strip()):
            raise HTTPException(409, "Offline start is already bound to another attempt or project")
        require_uncancelled_attempt(attempt)
        return attempt
    prepared = get_prepared_project_material(db, user.id, stage, payload.stageGrantId)
    if prepared is None and not is_admin_like(user):
        raise HTTPException(409, "Project must be prepared before starting")
    if prepared is not None:
        if (prepared.user_id != user.id or prepared.stage != stage
                or prepared.project_code != payload.projectCode.strip()):
            raise HTTPException(409, "Project code does not match the prepared project")
        project = db.get(project_model, prepared.project_id)
        if project is not None:
            lock_project_content(db, project_model, project.id)
        project_id = prepared.project_id
        project_code = prepared.project_code
        prepared_snapshot = prepared.snapshot
    else:
        project = db.scalar(select(project_model).where(project_model.code == payload.projectCode.strip()))
        if project is None:
            raise HTTPException(404, "Project not found")
        lock_project_content(db, project_model, project.id)
        db.refresh(project)
        db.expire(project, ["answers"])
        if project.code != payload.projectCode.strip():
            raise HTTPException(409, "Prepared project changed; download the materials again")
        project_id = project.id
        project_code = project.code
        prepared_snapshot = None
    grant = require_stage_permission(db, user, stage, mark_started=True,
                                     grant_id=payload.stageGrantId)
    started_at = naive_utc(grant.started_at) if grant else datetime.utcnow()
    ends_at = started_at + timedelta(minutes=duration_minutes)
    if ends_at <= datetime.utcnow():
        raise HTTPException(403, "The original project deadline has passed")
    attempt = OfflineExamAttempt(
        token=secrets.token_urlsafe(48), start_request_id=request_id,
        user_id=user.id, stage=stage, stage_grant_id=grant.id if grant else None,
        project_id=project_id, project_code=project_code,
        started_at=started_at, ends_at=ends_at,
    )
    db.add(attempt)
    db.flush()
    capture_project_content(db, attempt, project, prepared_snapshot=prepared_snapshot)
    return attempt


def authorize_final(db: Session, token: str | None, *, stage: str,
                    grant_id: int | None, session_id: int | None = None,
                    project_code: str | None = None,
                    allow_cancelled: bool = False) -> tuple[OfflineExamAttempt, User]:
    attempt = db.scalar(select(OfflineExamAttempt).where(OfflineExamAttempt.token == token)) if token else None
    if attempt is None:
        raise HTTPException(401, "Invalid offline submission capability")
    user = db.get(User, attempt.user_id)
    if user is None:
        raise HTTPException(403, "Candidate no longer exists")
    lock_user_stage_transitions(db, user)
    db.refresh(attempt)
    if (attempt.stage != stage or attempt.stage_grant_id != grant_id
            or attempt.session_id != session_id
            or attempt.project_code != project_code):
        raise HTTPException(403, "Offline submission does not match its authorized attempt")
    if not allow_cancelled:
        require_uncancelled_attempt(attempt)
    return attempt, user


def check_final(attempt: OfflineExamAttempt, submission_id, finished_at,
                payload: dict) -> tuple[str, dict | None]:
    require_uncancelled_attempt(attempt)
    if submission_id is None or finished_at is None:
        raise HTTPException(400, "submissionId and finishedAt are required for offline completion")
    finished_at = naive_utc(finished_at)
    if not (naive_utc(attempt.started_at) <= finished_at <= naive_utc(attempt.ends_at)):
        raise HTTPException(400, "Offline finish must be within the original exam interval")
    if finished_at > datetime.utcnow() + timedelta(seconds=5):
        raise HTTPException(400, "Offline finish cannot be in the future")
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"),
                                       ensure_ascii=False).encode("utf-8")).hexdigest()
    if attempt.submission_id is not None:
        if attempt.submission_id != str(submission_id) or attempt.payload_hash != digest:
            raise HTTPException(409, "This attempt already has a different frozen final submission")
        if not attempt.receipt:
            raise HTTPException(409, "Offline result receipt is unavailable")
        return digest, json.loads(attempt.receipt)
    return digest, None


def record_receipt(db: Session, attempt: OfflineExamAttempt, submission_id,
                   digest: str, response: dict) -> None:
    attempt.submission_id = str(submission_id)
    attempt.payload_hash = digest
    attempt.submitted_at = datetime.utcnow()
    attempt.receipt = json.dumps(response, ensure_ascii=False)
    db.add(attempt)


def cancel_interrupted_attempt(db: Session, payload, *, authenticated_user: User | None = None) -> dict:
    """Terminate an exact unsubmitted attempt, never a replacement grant/result.

    A cancellation is a durable terminal receipt in the existing ledger.  It is
    not an exam result and cannot be overwritten by a delayed final submission.
    The same user transition lock serializes finalization, cancellation and
    administrator re-grants, including on SQLite.
    """
    token = payload.offline_submission_token
    if not token:
        # A power failure can lose the successful Start response. A new owner
        # login may cancel that exact existing attempt without recovering or
        # resuming it. Never create a cancellation for an unknown start intent.
        if authenticated_user is None:
            raise HTTPException(401, "An offline capability or candidate login is required")
        lock_user_stage_transitions(db, authenticated_user)
        if payload.stage == "theory":
            if payload.session_id is None:
                raise HTTPException(400, "session_id is required for theory cancellation")
            attempt = theory_attempt(db, payload.session_id)
        else:
            if payload.start_request_id is None:
                raise HTTPException(400, "start_request_id is required without an offline capability")
            attempt = db.scalar(select(OfflineExamAttempt).where(
                OfflineExamAttempt.start_request_id == str(payload.start_request_id)))
        if attempt is None:
            raise HTTPException(404, "The interrupted start has no issued offline attempt")
        if attempt.user_id != authenticated_user.id:
            raise HTTPException(403, "Only this attempt's candidate may cancel it")
        token = attempt.token
    attempt, user = authorize_final(
        db, token, stage=payload.stage,
        grant_id=payload.stage_grant_id, session_id=payload.session_id,
        project_code=payload.project_code, allow_cancelled=True,
    )
    if (payload.start_request_id is not None
            and attempt.start_request_id != str(payload.start_request_id)):
        raise HTTPException(403, "Cancellation does not match its original start request")
    event = payload.model_dump(mode="json", exclude={"offline_submission_token"})
    event["operation"] = "cancel_interrupted_attempt"
    digest = hashlib.sha256(json.dumps(
        event, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
    ).encode("utf-8")).hexdigest()
    if attempt.submission_id is not None:
        if (attempt.submission_id == str(payload.cancellation_id)
                and attempt.payload_hash == digest and attempt.receipt):
            receipt = json.loads(attempt.receipt)
            if isinstance(receipt, dict) and receipt.get("cancelled") is True:
                return receipt
        raise HTTPException(409, "This offline attempt already has a terminal receipt")

    session = db.get(ExamSession, attempt.session_id) if attempt.session_id is not None else None
    if session is not None:
        db.refresh(session)
        if session.finished_at is not None or session.exam_snapshot:
            raise HTTPException(409, "A completed exam session cannot be cancelled")
    grant = db.get(UserExamStageGrant, attempt.stage_grant_id) if attempt.stage_grant_id is not None else None
    if grant is not None:
        db.refresh(grant)
        if grant.user_id != user.id or grant.stage != attempt.stage:
            raise HTTPException(409, "Offline attempt grant binding is invalid")
        if grant.consumed_at is not None:
            raise HTTPException(409, "A completed exam grant cannot be cancelled")

    now = datetime.utcnow()
    if session is not None:
        # finished_at would label this a completed/graded exam in existing
        # admin views. Inactive + no finish is already represented as aborted.
        session.active = False
        db.execute(delete(Answer).where(Answer.session_id == session.id))
        db.add(session)
    if grant is not None and grant.revoked_at is None:
        grant.revoked_at = now
        db.add(grant)
    sync_legacy_stage_fields(db, user)
    response = {
        "cancelled": True,
        "stage": attempt.stage,
        "stage_grant_id": attempt.stage_grant_id,
        "session_id": attempt.session_id,
        "project_code": attempt.project_code,
        "cancellation_id": str(payload.cancellation_id),
        "cancelled_at": utc_response(now).isoformat().replace("+00:00", "Z"),
    }
    record_receipt(db, attempt, payload.cancellation_id, digest, response)
    return response


def project_final_context(db: Session, stage: str, payload):
    attempt, user = authorize_final(db, payload.offlineSubmissionToken, stage=stage,
                                   grant_id=payload.stageGrantId,
                                   project_code=payload.projectCode.strip())
    digest, receipt = check_final(attempt, payload.submissionId, payload.finishedAt,
                                 payload.model_dump(mode="json", exclude={"offlineSubmissionToken"}))
    return attempt, user, digest, receipt
