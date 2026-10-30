from __future__ import annotations

import json
import random
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    Header,
    HTTPException,
    Path,
    Query,
    UploadFile,
    status,
)
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..database import get_db
from ..models import Answer, Block, Exam, ExamMedia, Option, Question, Session as ExamSession, User, UserSession
from ..schemas import (
    AllQuestionsBlockOut,
    AllQuestionsResponse,
    AnswerRequest,
    AnswerResponse,
    BatchAnswerItem,
    BatchAnswersRequest,
    BatchAnswersResponse,
    ExamConfigResponse,
    MediaUploadResponse,
    ExamGateVerifyRequest,
    ExamGateVerifyResponse,
    OptionOut,
    QuestionOut,
    QuestionsResponse,
    StartSessionRequest,
    StartSessionResponse,
    OfflineTheoryFinalRequest,
    OfflineAttemptCancelRequest,
)
from ..services.exam_lifecycle import (
    auto_close_session_if_expired,
    ensure_submission_window,
    finalize_exam_session,
    finish_response_from_session,
)
from ..services.exam_stage import STAGE_THEORY, is_admin_like
from ..services.exam_stage_grants import require_stage_permission
from ..services.offline_attempts import (
    authorize_final, check_final, naive_utc, record_receipt,
    register_theory_attempt, require_legacy_theory_submission, utc_response,
    theory_attempt, cancel_interrupted_attempt, require_uncancelled_attempt,
)
from ..services.offline_grading import (
    ensure_prepared_theory_block,
    get_prepared_theory_material,
    grade_theory_snapshot,
    prepare_theory_content,
    record_legacy_theory_answers,
    theory_blocks,
)
from ..services.media_storage import (
    relative_storage_path,
    resolve_storage_path,
    write_chunk,
    ensure_file_path,
)


router = APIRouter()

MEDIA_TYPES = {"camera", "screen"}


@router.get("/offline/capabilities")
def offline_capabilities():
    """Public, non-mutating deployment check before a client authorizes Start."""
    return {"protocol": 1, "grading_snapshots": True, "interruption_cancellation": True}


@router.post("/offline/cancel")
def cancel_offline_attempt(
    payload: OfflineAttemptCancelRequest,
    authorization: Optional[str] = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    owner = _get_user_from_auth(db, authorization) if not payload.offline_submission_token else None
    response = cancel_interrupted_attempt(db, payload, authenticated_user=owner)
    db.commit()
    return response


def _get_user_from_auth(db: Session, authorization: Optional[str]) -> User:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Bearer token required")
    token = authorization.split(" ", 1)[1]
    user_session = db.scalar(
        select(UserSession).where(
            UserSession.token == token,
            UserSession.expires_at > datetime.utcnow(),
        )
    )
    if not user_session:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")
    user = db.get(User, user_session.user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user


def _block_out(block: Block) -> dict:
    return {
        "id": block.id,
        "title": block.title,
        "qty": block.qty,
        "order_index": block.order_index,
        "chapter_id": block.chapter_id,
        "subchapter_id": block.subchapter_id,
        "chapter_name": block.chapter.name if block.chapter else None,
        "subchapter_name": block.subchapter.name if block.subchapter else None,
    }


@router.post("/gate/verify", response_model=ExamGateVerifyResponse)
def verify_gate_password(payload: ExamGateVerifyRequest, db: Session = Depends(get_db)):
    exam = db.get(Exam, payload.exam_id)
    if not exam:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Exam not found")
    valid = bool(exam.gate_password) and exam.gate_password == payload.password
    return ExamGateVerifyResponse(valid=valid)


@router.post("/session/start", response_model=StartSessionResponse)
def start_session(
    payload: StartSessionRequest,
    authorization: Optional[str] = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    exam = db.get(Exam, payload.exam_id)
    if not exam:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Exam not found")
    candidate_code = (payload.candidate_code or "").strip()
    candidate_user = (
        db.scalar(select(User).where(User.code == candidate_code))
        if candidate_code
        else None
    )
    current_user = _get_user_from_auth(db, authorization)
    if not candidate_user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Candidate not found")
    if candidate_user.id != current_user.id and not is_admin_like(current_user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Candidate mismatch")
    stage_grant = require_stage_permission(
        db,
        candidate_user,
        STAGE_THEORY,
        mark_started=False,
    )
    now = datetime.now(timezone.utc)
    if stage_grant is not None:
        existing_session = db.scalar(
            select(ExamSession)
            .where(
                ExamSession.user_id == candidate_user.id,
                ExamSession.stage_grant_id == stage_grant.id,
                ExamSession.finished_at.is_(None),
            )
            .order_by(ExamSession.id.desc())
        )
        if existing_session is not None:
            if not payload.prepare_only and stage_grant.started_at is None:
                stage_grant = require_stage_permission(
                    db,
                    candidate_user,
                    STAGE_THEORY,
                    mark_started=True,
                    grant_id=stage_grant.id,
                )
            existing_exam = (
                exam
                if existing_session.exam_id == exam.id
                else db.get(Exam, existing_session.exam_id)
            )
            db.commit()
            return StartSessionResponse(
                session_id=existing_session.id,
                token=existing_session.token,
                exam_id=existing_session.exam_id,
                duration_minutes=(
                    existing_exam.duration_minutes if existing_exam else exam.duration_minutes
                ),
                ends_at=existing_session.ends_at,
                stage_grant_id=existing_session.stage_grant_id,
            )
        if stage_grant.started_at is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="This permission is already bound to an exam attempt",
            )
        if not payload.prepare_only:
            stage_grant = require_stage_permission(
                db,
                candidate_user,
                STAGE_THEORY,
                mark_started=True,
                grant_id=stage_grant.id,
            )
    ends_at = now + timedelta(hours=1)
    token = f"sess_{now.timestamp()}_{random.randint(1000,9999)}"
    session = ExamSession(
        exam_id=exam.id,
        token=token,
        started_at=now,
        ends_at=ends_at,
        active=False,
        user_id=candidate_user.id if candidate_user else None,
        stage_grant_id=stage_grant.id if stage_grant else None,
        candidate_first_name=payload.candidate_first_name,
        candidate_last_name=payload.candidate_last_name,
        candidate_code=candidate_code,
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return StartSessionResponse(
        session_id=session.id,
        token=token,
        exam_id=exam.id,
        duration_minutes=exam.duration_minutes,
        ends_at=ends_at,
        stage_grant_id=session.stage_grant_id,
    )


def _get_session_or_401(
    session_id: int,
    db: Session,
    authorization: Optional[str],
) -> ExamSession:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")
    token = authorization.split(" ", 1)[1]
    session = db.get(ExamSession, session_id)
    if not session or session.token != token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid session token")
    return session


@router.post("/{session_id}/begin", response_model=StartSessionResponse)
def begin_session(
    session_id: int = Path(...),
    offline: bool = Query(False),
    authorization: Optional[str] = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    session = _get_session_or_401(session_id, db, authorization)
    issued_offline = theory_attempt(db, session.id)
    if issued_offline is not None:
        # Switching to the legacy Begin URL must never revive a cancelled
        # offline attempt, including an administrator's no-grant test session.
        require_uncancelled_attempt(issued_offline)
    previous_offline = issued_offline if offline else None
    if previous_offline is not None:
        # Recover a lost start response even after the original clock expired;
        # return its original interval, never authorize a fresh start.
        return StartSessionResponse(
            session_id=session.id, token=session.token, exam_id=session.exam_id,
            duration_minutes=int((previous_offline.ends_at - previous_offline.started_at).total_seconds() / 60),
            ends_at=utc_response(previous_offline.ends_at), stage_grant_id=previous_offline.stage_grant_id,
            offline_submission_token=previous_offline.token, server_now=utc_response(datetime.utcnow()),
            started_at=utc_response(previous_offline.started_at),
        )
    if offline and not session.selected_map:
        raise HTTPException(status_code=400, detail="Download all questions before offline begin")
    if session.finished_at:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Session already finished")

    now = datetime.utcnow()
    if not session.active and session.ends_at <= now:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Session preparation expired")

    exam = db.get(Exam, session.exam_id)
    if not exam:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Exam not found")

    if session.active:
        if session.ends_at <= now:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Session inactive or expired")
    else:
        candidate_user = session.user or (
            db.get(User, session.user_id) if session.user_id is not None else None
        )
        if candidate_user is None:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Candidate not found")
        # This database-scoped transition lock is intentionally acquired
        # before checking other sessions, so simultaneous Begin clicks cannot
        # both pass a query-then-update race.
        require_stage_permission(
            db,
            candidate_user,
            STAGE_THEORY,
            mark_started=True,
            grant_id=session.stage_grant_id,
        )
        # A concurrent Begin for this same session may have committed while
        # we waited for the user's transition lock.  Refresh before deciding
        # whether this request is the one that starts the clock.
        db.refresh(session)
        if session.active:
            if session.ends_at <= now:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Session inactive or expired",
                )
        else:
            if session.stage_grant_id is not None:
                another_active = db.scalar(
                    select(ExamSession.id).where(
                        ExamSession.stage_grant_id == session.stage_grant_id,
                        ExamSession.id != session.id,
                        ExamSession.active == True,  # noqa: E712
                        ExamSession.finished_at.is_(None),
                    )
                )
                if another_active is not None:
                    raise HTTPException(
                        status_code=status.HTTP_409_CONFLICT,
                        detail="This permission already has an active session",
                    )
            session.started_at = now
            session.ends_at = now + timedelta(minutes=exam.duration_minutes)
            session.active = True
            db.add(session)
            if not offline:
                db.commit()
                db.refresh(session)

    offline_attempt = register_theory_attempt(db, session) if offline else None
    if offline_attempt is not None:
        db.commit()
    return StartSessionResponse(
        session_id=session.id,
        token=session.token,
        exam_id=exam.id,
        duration_minutes=exam.duration_minutes,
        ends_at=utc_response(session.ends_at) if offline_attempt else session.ends_at,
        stage_grant_id=session.stage_grant_id,
        offline_submission_token=offline_attempt.token if offline_attempt else None,
        server_now=utc_response(datetime.utcnow()) if offline_attempt else None,
        started_at=utc_response(offline_attempt.started_at) if offline_attempt else None,
    )


@router.get("/{exam_id}/config", response_model=ExamConfigResponse)
def get_exam_config(exam_id: int = Path(...), db: Session = Depends(get_db)):
    exam = db.get(Exam, exam_id)
    if not exam:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Exam not found")

    blocks_stmt = (
        select(Block)
        .options(selectinload(Block.chapter), selectinload(Block.subchapter))
        .where(Block.exam_id == exam.id, Block.enabled == True)  # noqa: E712
        .order_by(Block.order_index)
    )
    blocks = db.scalars(blocks_stmt).all()
    return ExamConfigResponse(
        exam_id=exam.id,
        title=exam.title,
        duration_minutes=exam.duration_minutes,
        blocks=[_block_out(block) for block in blocks],
    )


@router.get("/{session_id}/questions", response_model=QuestionsResponse)
def get_block_questions(
    session_id: int = Path(...),
    block_id: int = Query(..., description="Target block id"),
    authorization: Optional[str] = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    session = _get_session_or_401(session_id, db, authorization)
    now = datetime.utcnow()
    if not session.active or session.ends_at <= now:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Session inactive or expired")

    b_snap, changed = ensure_prepared_theory_block(db, session, block_id)
    if changed:
        db.commit()

    out_questions = [
        QuestionOut(
            id=q["id"],
            code=q.get("code") or "",
            text=q.get("text") or "",
            order_index=q.get("order_index") or 0,
            options=[OptionOut(id=o["id"], text=o["text"]) for o in q.get("options", [])],
        )
        for q in b_snap.get("questions", [])
    ]

    return QuestionsResponse(
        block_id=b_snap["id"],
        block_title=b_snap.get("title") or "",
        chapter_id=b_snap.get("chapter_id"),
        subchapter_id=b_snap.get("subchapter_id"),
        chapter_name=b_snap.get("chapter_name"),
        subchapter_name=b_snap.get("subchapter_name"),
        qty=b_snap.get("qty") if b_snap.get("qty") is not None else len(out_questions),
        questions=out_questions,
    )


@router.get("/{session_id}/all-questions", response_model=AllQuestionsResponse)
def get_all_questions(
    session_id: int = Path(...),
    authorization: Optional[str] = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """ყველა ბლოკის ყველა კითხვის ერთიანი ჩატვირთვა ოფლაინ რეჟიმისთვის."""
    session = _get_session_or_401(session_id, db, authorization)
    now = datetime.utcnow()
    if session.finished_at or session.ends_at <= now:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Session inactive or expired")

    existing_prepared = get_prepared_theory_material(db, session.id)
    if existing_prepared is not None:
        snapshot = json.loads(existing_prepared.snapshot)
        result_blocks: List[AllQuestionsBlockOut] = []
        for b in sorted(theory_blocks(snapshot), key=lambda item: (item.get("order_index") or 0, item["id"])):
            out_questions = [
                QuestionOut(
                    id=q["id"],
                    code=q.get("code") or "",
                    text=q.get("text") or "",
                    order_index=q.get("order_index") or 0,
                    options=[OptionOut(id=o["id"], text=o["text"]) for o in q.get("options", [])],
                )
                for q in b.get("questions", [])
            ]
            result_blocks.append(AllQuestionsBlockOut(
                block_id=b["id"],
                block_title=b.get("title") or "",
                chapter_id=b.get("chapter_id"),
                subchapter_id=b.get("subchapter_id"),
                chapter_name=b.get("chapter_name"),
                subchapter_name=b.get("subchapter_name"),
                qty=b.get("qty") if b.get("qty") is not None else len(out_questions),
                questions=out_questions,
            ))
        return AllQuestionsResponse(blocks=result_blocks)

    blocks_stmt = select(Block).where(
        Block.exam_id == session.exam_id, Block.enabled == True  # noqa: E712
    ).options(
        selectinload(Block.chapter),
        selectinload(Block.subchapter),
    ).order_by(Block.order_index)
    blocks = db.scalars(blocks_stmt).all()

    if not blocks:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No blocks found")

    selected_map: Dict[str, List[int]] = {}
    if session.selected_map:
        try:
            selected_map = json.loads(session.selected_map)
        except Exception:
            selected_map = {}

    map_changed = False
    result_blocks: List[AllQuestionsBlockOut] = []

    for block in blocks:
        key = str(block.id)
        if key not in selected_map:
            q_stmt = (
                select(Question)
                .where(Question.block_id == block.id, Question.enabled == True)  # noqa: E712
                .order_by(Question.order_index)
            )
            all_questions = db.scalars(q_stmt).all()
            if not all_questions:
                continue
            choose_n = min(block.qty, len(all_questions))
            selected = random.sample(all_questions, k=choose_n)
            random.shuffle(selected)
            selected_map[key] = [q.id for q in selected]
            map_changed = True

        selected_ids = selected_map[key]
        q_stmt2 = select(Question).where(Question.id.in_(selected_ids))
        questions_unsorted = db.scalars(q_stmt2).all()
        id_to_question = {q.id: q for q in questions_unsorted}
        questions = [id_to_question[qid] for qid in selected_ids if qid in id_to_question]

        out_questions: List[QuestionOut] = []
        for q in questions:
            o_stmt = select(Option).where(Option.question_id == q.id)
            opts = db.scalars(o_stmt).all()
            out_questions.append(
                QuestionOut(
                    id=q.id,
                    code=q.code,
                    text=q.text,
                    order_index=q.order_index,
                    options=[OptionOut(id=o.id, text=o.text) for o in opts],
                )
            )

        result_blocks.append(AllQuestionsBlockOut(
            block_id=block.id,
            block_title=block.title,
            chapter_id=block.chapter_id,
            subchapter_id=block.subchapter_id,
            chapter_name=block.chapter.name if block.chapter else None,
            subchapter_name=block.subchapter.name if block.subchapter else None,
            qty=block.qty,
            questions=out_questions,
        ))

    if map_changed or not session.selected_map:
        session.selected_map = json.dumps(selected_map)
        db.add(session)
        db.flush()
    prepare_theory_content(db, session)
    db.commit()

    return AllQuestionsResponse(blocks=result_blocks)


@router.post("/{session_id}/answers/batch", response_model=BatchAnswersResponse)
def submit_answers_batch(
    payload: BatchAnswersRequest,
    session_id: int = Path(...),
    authorization: Optional[str] = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """ყველა პასუხის ერთიანი გაგზავნა ოფლაინ რეჟიმისთვის."""
    session = _get_session_or_401(session_id, db, authorization)
    require_legacy_theory_submission(db, session.id)
    if not session.active and finish_response_from_session(session):
        return BatchAnswersResponse(saved=0)
    if auto_close_session_if_expired(db, session):
        db.commit()
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Session inactive or expired")
    ensure_submission_window(session)

    saved_count = record_legacy_theory_answers(
        db,
        session,
        [(item.question_id, item.option_id) for item in payload.answers],
        strict=False,
    )
    db.commit()
    return BatchAnswersResponse(saved=saved_count)


def _parse_bool(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in {"1", "true", "yes", "t", "on"}


def _parse_int(value: object) -> Optional[int]:
    try:
        if value is None:
            return None
        return int(str(value).strip() or "0")
    except (TypeError, ValueError):
        return None


# NOTE: Media upload endpoint გათიშულია - ჩანაწერები ინახება ლოკალურად დესკტოპ აპში
# @router.post("/{session_id}/media", response_model=MediaUploadResponse)
# def upload_exam_media(...): ...


@router.post("/{session_id}/answer", response_model=AnswerResponse)
def submit_answer(
    payload: AnswerRequest,
    session_id: int = Path(...),
    authorization: Optional[str] = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    session = _get_session_or_401(session_id, db, authorization)
    require_legacy_theory_submission(db, session.id)
    now = datetime.utcnow()
    if not session.active or session.ends_at <= now:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Session inactive or expired")

    record_legacy_theory_answers(
        db,
        session,
        [(payload.question_id, payload.option_id)],
        strict=True,
    )
    db.commit()
    return AnswerResponse(correct=False, saved=True)


@router.post("/{session_id}/finish")
def finish_exam(
    session_id: int = Path(...),
    authorization: Optional[str] = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    session = _get_session_or_401(session_id, db, authorization)
    require_legacy_theory_submission(db, session.id)
    existing_response = finish_response_from_session(session)
    if not session.active and existing_response:
        return existing_response
    if auto_close_session_if_expired(db, session):
        db.commit()
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Session inactive or expired")
    ensure_submission_window(session)

    response = finalize_exam_session(db, session, finished_at=datetime.utcnow())
    db.commit()
    return response


@router.post("/{session_id}/offline-final")
def finish_offline_exam(
    payload: OfflineTheoryFinalRequest,
    session_id: int = Path(...),
    authorization: Optional[str] = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    token = authorization.split(" ", 1)[1] if authorization and authorization.lower().startswith("bearer ") else None
    attempt, _ = authorize_final(db, token, stage=STAGE_THEORY,
                                 grant_id=payload.stage_grant_id, session_id=session_id)
    digest, receipt = check_final(attempt, payload.submission_id, payload.finished_at,
                                 payload.model_dump(mode="json"))
    if receipt is not None:
        return receipt
    session = db.get(ExamSession, session_id)
    db.refresh(session)
    if session.finished_at is not None:
        raise HTTPException(409, "Exam attempt has already been finalized")
    if (session.stage_grant_id != attempt.stage_grant_id
            or session.user_id != attempt.user_id
            or naive_utc(session.ends_at) != naive_utc(attempt.ends_at)):
        raise HTTPException(409, "Offline exam binding changed")
    grading_snapshot, correctness = grade_theory_snapshot(db, attempt, payload.answers, payload.finished_at)
    validated = []
    for item in payload.answers:
        option = db.get(Option, item.option_id)
        # The immutable report remains authoritative even if configuration
        # edits removed these historical rows. Keep live-FK detail rows only
        # when they still exist; never recreate deleted question-bank content.
        if option is not None and option.question_id == item.question_id:
            validated.append(item)
    # Full replacement, including unanswered questions, and grading share one
    # transaction with the receipt. A dropped response can only replay it.
    for previous in db.scalars(select(Answer).where(Answer.session_id == session.id)).all():
        db.delete(previous)
    for item in validated:
        db.add(Answer(session_id=session.id, question_id=item.question_id,
                      option_id=item.option_id, is_correct=correctness[item.question_id],
                      answered_at=naive_utc(payload.finished_at)))
    db.flush()
    response = finalize_exam_session(db, session, finished_at=payload.finished_at,
                                     grading_snapshot=grading_snapshot)
    response.update(submission_id=str(payload.submission_id), session_id=session.id,
                    stage_grant_id=session.stage_grant_id)
    record_receipt(db, attempt, payload.submission_id, digest, response)
    db.commit()
    return response


