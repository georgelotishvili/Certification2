from __future__ import annotations

import json as _json
from hashlib import sha256
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, status, Path as FPath, Response, Query, UploadFile, File
from fastapi.responses import FileResponse
import uuid
from sqlalchemy import case, func, select, or_, delete
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from ..config import get_settings
from ..database import get_db
from ..models import Block, ExamMedia, Question, Session as ExamSession, Answer, Option, Question as Q, TaxonomyChapter, TaxonomySubchapter, User, Exam, Statement, Certificate, ExpertUpload, UserSession, _generate_gate_password
from ..models import CertBooking, ExamSchedule, PlanningLetter, MultiApartmentEvaluation, MultiFunctionalEvaluation, format_statement_doc_number
from ..schemas import (
    AdminBlocksResponse,
    AdminBlocksUpdateRequest,
    AdminBlockPayload,
    AdminQuestionPayload,
    AdminAnswerPayload,
    AdminStatsResponse,
    ExamSettingsResponse,
    ExamSettingsUpdateRequest,
    ResultListItem,
    ResultListResponse,
    ResultDetailResponse,
    ResultMediaResponse,
    ResultMediaItem,
    AnswerDetail,
    AnswerOptionDetail,
    BlockStatDetail,
    UsersListResponse,
    UserOut,
    ToggleAdminRequest,
    ToggleExamPermissionRequest,
    ToggleExamStagePermissionRequest,
    UpdateCandidateStatusRequest,
    AdminUserUpdateRequest,
    AdminStatementsResponse,
    AdminStatementOut,
    StatementSeenRequest,
    StatementAnsweredRequest,
    StatementAnsweredResponse,
)
from ..services.exam_lifecycle import auto_close_expired_sessions, auto_close_session_if_expired
from ..services.offline_grading import guard_pending_session_delete, lock_exam_content
from ..services.exam_stage import STAGE_THEORY
from ..services.exam_stage_grants import (
    current_open_grant,
    exam_state_with_permissions,
    expire_unused_stage_permissions,
    grant_stage_permission,
    reset_all_stage_permissions,
    revoke_stage_permission,
)
from ..services.media_storage import resolve_storage_path, ensure_media_root, delete_storage_file
from ..services.expert_certificate_cleanup import delete_expert_certificate_files
from ..services.user_codes import UserCodeConflict, move_user_code, remember_user_code
from ..services.candidate_status import (
    NON_PASS_CERT_PERIODS,
    _cancel_active_bookings_for_user,
    get_user_latest_requested_category,
    normalize_cert_category,
    reconcile_user_candidate_status_after_delete,
    sync_all_user_candidates,
)
from ..services.bounded_upload import (
    DEFAULT_UPLOAD_MAX_BYTES,
    UploadTooLarge,
    save_async_upload,
)


router = APIRouter()

MEDIA_TYPES = ("camera", "screen")


def _get_user_from_token(db: Session, authorization: str | None) -> User | None:
    """Get user from Bearer token."""
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    token = authorization.split(" ", 1)[1]
    session = db.scalar(
        select(UserSession).where(
            UserSession.token == token,
            UserSession.expires_at > datetime.utcnow()
        )
    )
    if not session:
        return None
    return db.get(User, session.user_id)


def _require_admin(
    db: Session,
    authorization: str | None = None,
) -> User:
    """Require admin access via Bearer token."""
    user = _get_user_from_token(db, authorization)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Bearer token required")
    
    settings = get_settings()
    founder_email = (settings.founder_admin_email or "").lower()
    
    if user.email.lower() == founder_email:
        return user
    
    if user.is_admin:
        return user
    
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Admin access required")


def _is_founder_actor(authorization: str | None, db: Session) -> bool:
    """Check if the token belongs to founder."""
    user = _get_user_from_token(db, authorization)
    if not user:
        return False
    settings = get_settings()
    return (settings.founder_admin_email or "").lower() == user.email.lower()


def _get_actor_email(authorization: str | None, db: Session) -> str | None:
    """Get actor email from Bearer token."""
    user = _get_user_from_token(db, authorization)
    return user.email.lower() if user else None


def _get_or_create_exam(db: Session, exam_id: int | None = None) -> Exam:
    exam: Exam | None = None
    if exam_id:
        exam = db.get(Exam, exam_id)
    if not exam:
        exam = db.scalars(select(Exam).order_by(Exam.id.asc()).limit(1)).first()
    if not exam:
        exam = Exam(title="Default Exam", duration_minutes=45)
        db.add(exam)
        db.commit()
        db.refresh(exam)
        return exam
    if not exam.gate_password:
        exam.gate_password = _generate_gate_password()
        db.add(exam)
        db.commit()
        db.refresh(exam)
    return exam


def _exam_settings_payload(exam: Exam) -> ExamSettingsResponse:
    return ExamSettingsResponse(
        exam_id=exam.id,
        title=exam.title,
        duration_minutes=exam.duration_minutes,
        gate_password=exam.gate_password or "",
    )


def _blocks_payload(exam: Exam) -> AdminBlocksResponse:
    ordered_blocks = sorted(exam.blocks, key=lambda b: (b.order_index or 0, b.id))
    blocks: list[AdminBlockPayload] = []
    for block_index, block in enumerate(ordered_blocks, start=1):
        ordered_questions = sorted(block.questions, key=lambda q: (q.order_index or 0, q.id))
        question_payloads: list[AdminQuestionPayload] = []
        for question_index, question in enumerate(ordered_questions, start=1):
            options = sorted(question.options, key=lambda o: o.id)
            answers = [
                AdminAnswerPayload(id=str(option.id), text=option.text)
                for option in options
            ]
            correct_id = next((str(option.id) for option in options if option.is_correct), None)
            question_payloads.append(
                AdminQuestionPayload(
                    id=str(question.id),
                    text=question.text,
                    code=question.code,
                    answers=answers,
                    correct_answer_id=correct_id,
                    enabled=question.enabled,
                )
            )
        blocks.append(
            AdminBlockPayload(
                id=str(block.id),
                number=block.order_index or block_index,
                name=block.title,
                qty=block.qty,
                chapter_id=block.chapter_id,
                subchapter_id=block.subchapter_id,
                enabled=block.enabled,
                questions=question_payloads,
            )
        )
    return AdminBlocksResponse(exam_id=exam.id, blocks=blocks)


@router.get("/auth/verify", status_code=status.HTTP_204_NO_CONTENT)
def verify_admin_access(
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
) -> Response:
    _require_admin(db, authorization)
    is_founder = _is_founder_actor(authorization, db)
    return Response(
        status_code=status.HTTP_204_NO_CONTENT,
        headers={"X-Is-Founder": "true" if is_founder else "false"},
    )


@router.get("/exam/settings", response_model=ExamSettingsResponse)
def get_exam_settings(
    exam_id: int | None = None,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    exam = _get_or_create_exam(db, exam_id)
    return _exam_settings_payload(exam)


@router.put("/exam/settings", response_model=ExamSettingsResponse)
def update_exam_settings(
    payload: ExamSettingsUpdateRequest,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    exam = _get_or_create_exam(db, payload.exam_id)

    if payload.title is not None:
        candidate = payload.title.strip()
        if candidate:
            exam.title = candidate

    if payload.duration_minutes is not None:
        duration = max(1, payload.duration_minutes)
        exam.duration_minutes = duration

    if payload.gate_password is not None:
        exam.gate_password = payload.gate_password.strip()

    db.add(exam)
    db.commit()
    db.refresh(exam)
    return _exam_settings_payload(exam)


@router.get("/exam/blocks", response_model=AdminBlocksResponse)
def get_exam_blocks(
    exam_id: int | None = None,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    exam = _get_or_create_exam(db, exam_id)
    return _blocks_payload(exam)


@router.put("/exam/blocks", response_model=AdminBlocksResponse)
def update_exam_blocks(
    payload: AdminBlocksUpdateRequest,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    exam = _get_or_create_exam(db, payload.exam_id)
    lock_exam_content(db, exam.id)

    existing_blocks = db.scalars(
        select(Block)
        .where(Block.exam_id == exam.id)
        .options(
            selectinload(Block.questions).selectinload(Question.options),
            selectinload(Block.questions).selectinload(Question.answers),
        )
    ).all()

    block_index_default = 0
    processed_block_ids: set[int] = set()
    block_by_id = {str(block.id): block for block in existing_blocks}

    def _parse_int(value: str | int | None) -> int | None:
        try:
            if value is None:
                return None
            return int(value)
        except (TypeError, ValueError):
            return None

    chapter_by_id = {
        chapter.id: chapter
        for chapter in db.scalars(select(TaxonomyChapter)).all()
    }
    subchapter_by_id = {
        subchapter.id: subchapter
        for subchapter in db.scalars(select(TaxonomySubchapter)).all()
    }
    taxonomy_configured = bool(chapter_by_id)

    def _resolve_block_taxonomy(block_payload: AdminBlockPayload) -> tuple[int | None, int | None]:
        chapter_id = _parse_int(block_payload.chapter_id)
        subchapter_id = _parse_int(block_payload.subchapter_id)
        has_any_value = chapter_id is not None or subchapter_id is not None
        if taxonomy_configured or has_any_value:
            if chapter_id is None or subchapter_id is None:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Chapter and subchapter are required",
                )
            if chapter_id not in chapter_by_id:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chapter not found")
            subchapter = subchapter_by_id.get(subchapter_id)
            if not subchapter:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Subchapter not found")
            if subchapter.chapter_id != chapter_id:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Subchapter does not belong to chapter",
                )
        return chapter_id, subchapter_id

    for block_index, block_payload in enumerate(payload.blocks or [], start=1):
        questions_payload = block_payload.questions or []
        qty = max(0, min(block_payload.qty, len(questions_payload)))
        chapter_id, subchapter_id = _resolve_block_taxonomy(block_payload)

        block_id_int = _parse_int(block_payload.id)
        if block_id_int is not None and str(block_id_int) in block_by_id:
            block = block_by_id[str(block_id_int)]
        else:
            block = Block(exam_id=exam.id)
            db.add(block)
            exam.blocks.append(block)

        block_index_default += 1
        block.title = (block_payload.name or "").strip() or f"ბლოკი {block_index_default}"
        block.qty = qty
        block.order_index = block_payload.number or block_index_default
        block.chapter_id = chapter_id
        block.subchapter_id = subchapter_id
        block.enabled = block_payload.enabled

        db.flush()

        block_by_id[str(block.id)] = block
        processed_block_ids.add(block.id)

        existing_questions = {str(question.id): question for question in block.questions}
        processed_question_ids: set[int] = set()

        for question_index, question_payload in enumerate(questions_payload, start=1):
            question_id_int = _parse_int(question_payload.id)
            if question_id_int is not None and str(question_id_int) in existing_questions:
                question = existing_questions[str(question_id_int)]
            else:
                question = Question(block_id=block.id)
                db.add(question)
                block.questions.append(question)
                existing_questions[str(question.id)] = question

            question.code = question_payload.code or f"Q-{block.id}-{question_index}"
            question.text = (question_payload.text or "").strip()
            question.order_index = question_index
            question.enabled = question_payload.enabled

            db.flush()

            processed_question_ids.add(question.id)

            existing_options = {str(option.id): option for option in question.options}
            processed_option_ids: set[int] = set()

            for answer_payload in question_payload.answers or []:
                option_id_int = _parse_int(answer_payload.id)
                if option_id_int is not None and str(option_id_int) in existing_options:
                    option = existing_options[str(option_id_int)]
                else:
                    option = Option(question_id=question.id)
                    db.add(option)
                    question.options.append(option)
                    existing_options[str(option.id)] = option

                option.text = (answer_payload.text or "").strip()
                option.is_correct = (
                    str(answer_payload.id) == str(question_payload.correct_answer_id)
                    if question_payload.correct_answer_id is not None
                    else False
                )

                db.flush()

                processed_option_ids.add(option.id)

            if question.options and not any(opt.is_correct for opt in question.options):
                first_option = min(question.options, key=lambda opt: opt.id)
                first_option.is_correct = True

            if existing_options:
                for option in list(existing_options.values()):
                    if option.id not in processed_option_ids:
                        # Cascade delete associated answers first
                        db.execute(delete(Answer).where(Answer.option_id == option.id))
                        db.delete(option)

        for question in list(existing_questions.values()):
            if question.id not in processed_question_ids:
                # Cascade delete associated answers first
                for option in question.options:
                    db.execute(delete(Answer).where(Answer.option_id == option.id))
                db.delete(question)

    for block in existing_blocks:
        if block.id not in processed_block_ids:
            # Cascade delete associated answers first
            for question in block.questions:
                for option in question.options:
                    db.execute(delete(Answer).where(Answer.option_id == option.id))
            db.delete(block)

    db.commit()
    refreshed_exam = _get_or_create_exam(db, exam.id)
    return _blocks_payload(refreshed_exam)


@router.get("/stats", response_model=AdminStatsResponse)
def admin_stats(
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)

    total_blocks = db.scalar(select(func.count()).select_from(Block)) or 0
    total_questions = db.scalar(select(func.count()).select_from(Question)) or 0
    enabled_blocks = db.scalar(select(func.count()).select_from(Block).where(Block.enabled == True)) or 0  # noqa: E712
    enabled_questions = db.scalar(select(func.count()).select_from(Question).where(Question.enabled == True)) or 0  # noqa: E712

    return AdminStatsResponse(
        total_blocks=total_blocks,
        total_questions=total_questions,
        enabled_blocks=enabled_blocks,
        enabled_questions=enabled_questions,
    )


def _session_status(session: ExamSession) -> str:
    if session.finished_at:
        if session.exam_snapshot:
            try:
                snapshot = _json.loads(session.exam_snapshot)
                if isinstance(snapshot, dict) and snapshot.get("auto_closed"):
                    return "auto_closed"
            except Exception:
                pass
        return "completed"
    if session.active:
        return "in_progress"
    return "aborted"


def _build_result_item(session: ExamSession, personal_id: str | None = None) -> ResultListItem:
    return ResultListItem(
        session_id=session.id,
        started_at=session.started_at,
        finished_at=session.finished_at,
        candidate_first_name=session.candidate_first_name,
        candidate_last_name=session.candidate_last_name,
        candidate_code=session.candidate_code,
        score_percent=session.score_percent or 0.0,
        exam_id=session.exam_id,
        ends_at=session.ends_at,
        status=_session_status(session),
        personal_id=personal_id,
    )


def _load_session_snapshot(session: ExamSession) -> dict | None:
    if not session.exam_snapshot:
        return None
    try:
        snapshot = _json.loads(session.exam_snapshot)
    except Exception:
        return None
    return snapshot if isinstance(snapshot, dict) else None


def _snapshot_blocks(snapshot: dict) -> list[dict]:
    blocks: list[dict] = []
    for chapter in snapshot.get("chapters") or []:
        if not isinstance(chapter, dict):
            continue
        for subchapter in chapter.get("subchapters") or []:
            if not isinstance(subchapter, dict):
                continue
            for block in subchapter.get("blocks") or []:
                if isinstance(block, dict):
                    blocks.append(block)
    for block in snapshot.get("untagged_blocks") or []:
        if isinstance(block, dict):
            blocks.append(block)
    return blocks


def _snapshot_option_payload(option: dict) -> AnswerOptionDetail:
    return AnswerOptionDetail(
        option_id=int(option.get("option_id") or option.get("id") or 0),
        option_text=str(option.get("option_text") or option.get("text") or ""),
        is_correct=bool(option.get("is_correct")),
        is_selected=bool(option.get("is_selected")),
    )


def _snapshot_result_detail(
    session: ExamSession,
    snapshot: dict,
    personal_id: str | None,
) -> ResultDetailResponse:
    summary = snapshot.get("summary") if isinstance(snapshot.get("summary"), dict) else {}
    exam = snapshot.get("exam") if isinstance(snapshot.get("exam"), dict) else {}
    block_stats: list[BlockStatDetail] = []
    answers: list[AnswerDetail] = []

    for block in _snapshot_blocks(snapshot):
        block_id = int(block.get("id") or 0)
        stats = block.get("stats") if isinstance(block.get("stats"), dict) else {}
        block_stats.append(
            BlockStatDetail(
                block_id=block_id,
                block_title=block.get("title"),
                total=int(stats.get("total", 0) or 0),
                correct=int(stats.get("correct", 0) or 0),
                percent=float(stats.get("percent", 0.0) or 0.0),
            )
        )
        for question in block.get("questions") or []:
            if not isinstance(question, dict):
                continue
            selected_option = question.get("selected_option") if isinstance(question.get("selected_option"), dict) else None
            correct_option = question.get("correct_option") if isinstance(question.get("correct_option"), dict) else None
            answers.append(
                AnswerDetail(
                    question_id=int(question.get("question_id") or question.get("id") or 0),
                    question_code=str(question.get("question_code") or question.get("code") or ""),
                    question_text=str(question.get("question_text") or question.get("text") or ""),
                    block_id=block_id or None,
                    block_title=block.get("title"),
                    selected_option_id=question.get("selected_option_id"),
                    selected_option_text=selected_option.get("text") if selected_option else None,
                    is_correct=question.get("is_correct"),
                    answered_at=question.get("answered_at"),
                    correct_option_id=question.get("correct_option_id"),
                    correct_option_text=correct_option.get("text") if correct_option else None,
                    options=[
                        _snapshot_option_payload(option)
                        for option in (question.get("options") or [])
                        if isinstance(option, dict)
                    ],
                )
            )

    return ResultDetailResponse(
        session=_build_result_item(session, personal_id),
        exam_title=exam.get("title"),
        total_questions=int(summary.get("total", 0) or 0),
        answered_questions=int(summary.get("answered", 0) or 0),
        correct_answers=int(summary.get("correct", 0) or 0),
        block_stats=block_stats,
        answers=answers,
        snapshot=snapshot,
        legacy=False,
    )


# Results list
@router.get("/results", response_model=ResultListResponse)
def results_list(
    page: int = 1,
    size: int = 50,
    candidate_code: str | None = None,
    personal_id: str | None = None,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    auto_close_expired_sessions(db)

    candidate_code_norm = (candidate_code or "").strip().lower() or None
    personal_id_norm = (personal_id or "").strip().lower() or None

    stmt = select(ExamSession).order_by(ExamSession.started_at.desc())

    code_filters: list[str] = []
    if personal_id_norm:
        codes_stmt = select(User.code).where(func.lower(User.personal_id) == personal_id_norm)
        codes_for_personal = [code for code in db.scalars(codes_stmt).all() if code]
        if not codes_for_personal:
            return ResultListResponse(items=[], total=0)
        code_filters.extend([code.strip().lower() for code in codes_for_personal if code])

    if candidate_code_norm:
        code_filters.append(candidate_code_norm)

    if code_filters:
        stmt = stmt.where(func.lower(ExamSession.candidate_code).in_(code_filters))

    filtered = bool(candidate_code_norm or personal_id_norm)

    if filtered:
        sessions = db.scalars(stmt).all()
        total = len(sessions)
    else:
        offset = max(0, (page - 1) * size)
        paged_stmt = stmt.offset(offset).limit(size)
        sessions = db.scalars(paged_stmt).all()
        total = db.scalar(select(func.count()).select_from(ExamSession)) or 0

    candidate_codes = {
        (s.candidate_code or "").strip().lower()
        for s in sessions
        if s.candidate_code
    }
    user_by_code: dict[str, User] = {}
    if candidate_codes:
        users = db.scalars(
            select(User).where(func.lower(User.code).in_(list(candidate_codes)))
        ).all()
        user_by_code = {
            (u.code or "").strip().lower(): u
            for u in users
            if u.code
        }

    items: list[ResultListItem] = []
    for s in sessions:
        code_key = (s.candidate_code or "").strip().lower()
        personal_id_value = user_by_code.get(code_key).personal_id if code_key in user_by_code else None
        items.append(_build_result_item(s, personal_id_value))

    return ResultListResponse(items=items, total=total)


# Result details
@router.get("/results/{session_id}", response_model=ResultDetailResponse)
def result_detail(
    session_id: int = FPath(...),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    s = db.get(ExamSession, session_id)
    if not s:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    if auto_close_session_if_expired(db, s):
        db.commit()
        db.refresh(s)
    personal_id_value: str | None = None
    if s.candidate_code:
        personal_id_value = db.scalar(
            select(User.personal_id)
            .where(func.lower(User.code) == func.lower(s.candidate_code))
            .limit(1)
        )

    snapshot = _load_session_snapshot(s)
    if snapshot:
        return _snapshot_result_detail(s, snapshot, personal_id_value)

    exam_title: str | None = None
    if s.exam_id:
        exam = db.get(Exam, s.exam_id)
        if exam:
            exam_title = exam.title

    answers = db.scalars(select(Answer).where(Answer.session_id == s.id)).all()
    answer_by_question = {ans.question_id: ans for ans in answers}

    selected_map: dict[str, list[int]] = {}
    if s.selected_map:
        try:
            raw_map = _json.loads(s.selected_map)
            if isinstance(raw_map, dict):
                for key, value in raw_map.items():
                    try:
                        int_key = int(key)
                    except (TypeError, ValueError):
                        continue
                    cleaned: list[int] = []
                    for item in value or []:
                        try:
                            cleaned.append(int(item))
                        except (TypeError, ValueError):
                            continue
                    selected_map[str(int_key)] = cleaned
        except Exception:
            selected_map = {}

    ordered_question_ids: list[int] = []
    for _, qids in selected_map.items():
        for qid in qids:
            if qid not in ordered_question_ids:
                ordered_question_ids.append(qid)

    answers_sorted = sorted(answers, key=lambda a: a.answered_at or s.started_at)
    if not ordered_question_ids:
        ordered_question_ids = [ans.question_id for ans in answers_sorted]

    question_ids = set(ordered_question_ids) | {ans.question_id for ans in answers}
    questions = (
        db.scalars(select(Q).where(Q.id.in_(question_ids))).all()
        if question_ids
        else []
    )
    question_map = {q.id: q for q in questions}

    block_ids = {q.block_id for q in questions}
    for key in selected_map.keys():
        try:
            block_ids.add(int(key))
        except (TypeError, ValueError):
            continue

    blocks = (
        db.scalars(select(Block).where(Block.id.in_(block_ids))).all()
        if block_ids
        else []
    )
    block_map = {b.id: b for b in blocks}

    options = (
        db.scalars(select(Option).where(Option.question_id.in_(question_ids))).all()
        if question_ids
        else []
    )
    options_by_id = {opt.id: opt for opt in options}
    options_by_question: dict[int, list[Option]] = {}
    for opt in options:
        options_by_question.setdefault(opt.question_id, []).append(opt)
    for question_options in options_by_question.values():
        question_options.sort(key=lambda option: option.id)
    correct_option_map: dict[int, Option] = {}
    for opt in options:
        if opt.is_correct:
            correct_option_map[opt.question_id] = opt

    question_sequence: list[int] = []
    seen_questions: set[int] = set()
    for qid in ordered_question_ids:
        if qid not in seen_questions:
            question_sequence.append(qid)
            seen_questions.add(qid)
    for ans in answers_sorted:
        if ans.question_id not in seen_questions:
            question_sequence.append(ans.question_id)
            seen_questions.add(ans.question_id)

    block_sequence: list[int] = []
    seen_blocks: set[int] = set()
    for key in selected_map.keys():
        try:
            block_id = int(key)
        except (TypeError, ValueError):
            continue
        if block_id not in seen_blocks:
            block_sequence.append(block_id)
            seen_blocks.add(block_id)
    if not block_sequence and block_map:
        block_sequence = [
            b.id for b in sorted(block_map.values(), key=lambda blk: ((blk.order_index or 0), blk.id))
        ]
        seen_blocks = set(block_sequence)
    for block_id in block_ids:
        if block_id not in seen_blocks:
            block_sequence.append(block_id)
            seen_blocks.add(block_id)

    raw_block_stats = []
    if s.block_stats:
        try:
            raw_block_stats = _json.loads(s.block_stats)
        except Exception:
            raw_block_stats = []
    raw_block_map = {}
    for entry in raw_block_stats:
        if not isinstance(entry, dict):
            continue
        try:
            block_id = int(entry.get("block_id"))
        except (TypeError, ValueError):
            continue
        raw_block_map[block_id] = entry

    block_stats_payload: list[BlockStatDetail] = []
    for block_id in block_sequence:
        entry = raw_block_map.get(block_id)
        if entry:
            total = int(entry.get("total", 0) or 0)
            correct = int(entry.get("correct", 0) or 0)
            percent = float(entry.get("percent", 0.0) or 0.0)
        else:
            question_ids_in_block = selected_map.get(str(block_id), [])
            if not question_ids_in_block and block_id in block_map:
                question_ids_in_block = [
                    q.id for q in question_map.values() if q.block_id == block_id
                ]
            total = len(question_ids_in_block)
            answers_for_block = [
                answer_by_question[qid]
                for qid in question_ids_in_block
                if qid in answer_by_question
            ]
            correct = sum(1 for ans in answers_for_block if ans.is_correct)
            percent = round((correct / total) * 100.0, 2) if total else 0.0

        block_stats_payload.append(
            BlockStatDetail(
                block_id=block_id,
                block_title=block_map.get(block_id).title if block_id in block_map else None,
                total=total,
                correct=correct,
                percent=percent,
            )
        )

    answers_payload: list[AnswerDetail] = []
    for qid in question_sequence:
        question = question_map.get(qid)
        if not question:
            continue
        answer = answer_by_question.get(qid)
        selected_option = options_by_id.get(answer.option_id) if answer else None
        correct_option = correct_option_map.get(qid)
        option_details: list[AnswerOptionDetail] = []
        for option in options_by_question.get(qid, []):
            option_details.append(
                AnswerOptionDetail(
                    option_id=option.id,
                    option_text=option.text,
                    is_correct=bool(option.is_correct),
                    is_selected=bool(answer and option.id == answer.option_id),
                )
            )
        block = block_map.get(question.block_id)
        answers_payload.append(
            AnswerDetail(
                question_id=question.id,
                question_code=question.code,
                question_text=question.text,
                block_id=question.block_id,
                block_title=block.title if block else None,
                selected_option_id=selected_option.id if selected_option else None,
                selected_option_text=selected_option.text if selected_option else None,
                is_correct=answer.is_correct if answer else None,
                answered_at=answer.answered_at if answer else None,
                correct_option_id=correct_option.id if correct_option else None,
                correct_option_text=correct_option.text if correct_option else None,
                options=option_details,
            )
        )

    total_questions = len(question_sequence)
    answered_questions = sum(1 for qid in question_sequence if qid in answer_by_question)
    correct_answers = sum(1 for ans in answer_by_question.values() if ans.is_correct)

    session_payload = _build_result_item(s, personal_id_value)

    return ResultDetailResponse(
        session=session_payload,
        exam_title=exam_title,
        total_questions=total_questions,
        answered_questions=answered_questions,
        correct_answers=correct_answers,
        block_stats=block_stats_payload,
        answers=answers_payload,
        snapshot=None,
        legacy=True,
        legacy_message="ისტორიული მონაცემი — დეტალი snapshot-ით არ არის ხელმისაწვდომი",
    )


# NOTE: Media endpoints გათიშულია - ჩანაწერები ინახება ლოკალურად დესკტოპ აპში
# @router.get("/results/{session_id}/media", response_model=ResultMediaResponse)
# def result_media_meta(...): ...
# @router.get("/results/{session_id}/media/file")
# def result_media_file(...): ...


@router.delete("/results/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_result(
    session_id: int = FPath(...),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    admin_user = _require_admin(db, authorization)

    settings = get_settings()
    founder_email = (settings.founder_admin_email or "").lower()
    if founder_email != admin_user.email.lower():
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only founder can delete results")

    session_obj = db.get(ExamSession, session_id)
    if not session_obj:
        return
    guard_pending_session_delete(db, session_id)

    # Delete video files from disk before deleting the session
    media_records = db.scalars(select(ExamMedia).where(ExamMedia.session_id == session_id)).all()
    for media in media_records:
        if media.storage_path:
            # We keep session directory cleanup logic below, so don't touch parents here
            delete_storage_file(media.storage_path, remove_empty_parents=False)

    # Delete the session directory if it exists and is empty
    try:
        media_root = ensure_media_root()
        session_dir = media_root / f"session_{session_id}"
        if session_dir.exists() and session_dir.is_dir():
            # Try to remove the directory (will only work if empty or all files deleted)
            try:
                session_dir.rmdir()
            except OSError:
                # Directory not empty or other error, that's okay
                pass
    except Exception:
        pass  # Continue even if directory deletion fails

    db.delete(session_obj)
    db.commit()
    return


@router.get("/statements/{statement_id}/file")
def admin_download_statement_file(
    statement_id: int,
    authorization: str | None = Header(None, alias="Authorization"),
    actor: str | None = Query(None, alias="actor"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    st = db.get(Statement, statement_id)
    if not st or not st.attachment_path:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    try:
        path = resolve_storage_path(st.attachment_path)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    if not path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    return FileResponse(
        path,
        media_type=st.attachment_mime_type or "application/octet-stream",
        filename=st.attachment_filename or path.name,
    )


# ================= Users admin endpoints =================

def _today_in_tbilisi() -> date:
    return datetime.now(timezone(timedelta(hours=4))).date()


def _format_pct(value: float | int | None) -> str:
    val = round(float(value or 0.0), 2)
    if val == int(val):
        return str(int(val))
    return f"{val:.2f}".rstrip("0").rstrip(".")


def _extract_theory_stage_summary(session: ExamSession) -> dict:
    snapshot = _load_session_snapshot(session)
    chapters_out: list[dict] = []
    if snapshot:
        for ch in snapshot.get("chapters") or []:
            if not isinstance(ch, dict):
                continue
            stats = ch.get("stats") if isinstance(ch.get("stats"), dict) else {}
            total = int(stats.get("total", 0) or 0)
            correct = int(stats.get("correct", 0) or 0)
            percent = round(float(stats.get("percent", 0.0) or 0.0), 2)
            if total > 0:
                chapters_out.append({
                    "title": str(ch.get("name") or "თავი").strip(),
                    "total": total,
                    "correct": correct,
                    "percent": percent,
                })
        for blk in snapshot.get("untagged_blocks") or []:
            if not isinstance(blk, dict):
                continue
            stats = blk.get("stats") if isinstance(blk.get("stats"), dict) else {}
            total = int(stats.get("total", 0) or 0)
            correct = int(stats.get("correct", 0) or 0)
            percent = round(float(stats.get("percent", 0.0) or 0.0), 2)
            if total > 0:
                chapters_out.append({
                    "title": str(blk.get("title") or f"ბლოკი {blk.get('id', '')}").strip(),
                    "total": total,
                    "correct": correct,
                    "percent": percent,
                })
    if not chapters_out and session.block_stats:
        try:
            raw_stats = _json.loads(session.block_stats)
            if isinstance(raw_stats, list):
                for entry in raw_stats:
                    if not isinstance(entry, dict):
                        continue
                    total = int(entry.get("total", 0) or 0)
                    correct = int(entry.get("correct", 0) or 0)
                    percent = round(float(entry.get("percent", 0.0) or 0.0), 2)
                    if total > 0:
                        chapters_out.append({
                            "title": str(entry.get("block_title") or f"ბლოკი {entry.get('block_id', '')}").strip(),
                            "total": total,
                            "correct": correct,
                            "percent": percent,
                        })
        except Exception:
            pass

    score_pct = round(float(session.score_percent or 0.0), 2)
    if chapters_out:
        if any(c["percent"] < 70 for c in chapters_out):
            level = "fail"
        elif any(c["percent"] < 75 for c in chapters_out):
            level = "a"
        else:
            level = "bc"
    else:
        if score_pct < 70:
            level = "fail"
        elif score_pct < 75:
            level = "a"
        else:
            level = "bc"

    finished_at = session.finished_at or session.started_at
    return {
        "session_id": session.id,
        "finished_at": finished_at,
        "score_percent": score_pct,
        "chapters": chapters_out,
        "level": level,
    }


def _extract_practical_stage_summary(eval_row) -> dict:
    pct = round(float(eval_row.percentage or 0.0), 2)
    wrong = int(eval_row.wrong_count or 0)
    correct = int(eval_row.correct_count or 0)
    total_correct = int(eval_row.total_correct_answers or 0)
    if pct < 70 or wrong >= 3:
        level = "fail"
    elif pct < 75 or wrong == 2:
        level = "a"
    else:
        level = "bc"
    finished_at = eval_row.finished_at or eval_row.created_at
    return {
        "evaluation_id": eval_row.id,
        "finished_at": finished_at,
        "percentage": pct,
        "wrong_count": wrong,
        "correct_count": correct,
        "total_correct_answers": total_correct,
        "level": level,
    }


def _build_exam_outcome_payload(
    s1: dict | None,
    s2: dict | None,
    s3: dict | None,
    last_letter_at: datetime | None,
) -> dict:
    stages_map = {"stage1": s1, "stage2": s2, "stage3": s3}
    present = {k: v for k, v in stages_map.items() if v is not None}
    if not present:
        return {
            "has_results": False,
            "unacknowledged": False,
            "outcome": "none",
            "category_label": None,
            "results_text": "",
            "latest_exam_at": None,
            "completed_stages": 0,
        }

    timestamps = [v["finished_at"] for v in present.values() if v.get("finished_at") is not None]
    latest_exam_at = max(timestamps) if timestamps else None

    if latest_exam_at is not None:
        sitting_cutoff = latest_exam_at - timedelta(days=2)
        present = {
            k: v for k, v in present.items()
            if v.get("finished_at") is None or v["finished_at"] >= sitting_cutoff
        }

    if last_letter_at is None:
        unacknowledged = True
        cycle_stages = present
    elif latest_exam_at and latest_exam_at > last_letter_at:
        unacknowledged = True
        cycle_stages = {
            k: v for k, v in present.items()
            if v.get("finished_at") is not None and v["finished_at"] > last_letter_at
        }
    else:
        unacknowledged = False
        cycle_stages = present

    st1 = cycle_stages.get("stage1")
    st2 = cycle_stages.get("stage2")
    st3 = cycle_stages.get("stage3")

    all_three_completed = st1 is not None and st2 is not None and st3 is not None
    levels = [st["level"] for st in (st1, st2, st3) if st is not None]

    if not all_three_completed or any(lv == "fail" for lv in levels):
        outcome = "fail"
        category_label = None
    elif all(lv == "bc" for lv in levels):
        outcome = "pass_bc"
        category_label = "B/C კატეგორიის"
    else:
        outcome = "pass_a"
        category_label = "A კატეგორიის"

    lines: list[str] = ["თქვენი გამოცდის შედეგები:"]
    if st1:
        chapters = st1.get("chapters") or []
        if chapters:
            lines.append("• ეტაპი 1 — თეორიული გამოცდა:")
            for ch in chapters:
                lines.append(
                    f"  - {ch['title']}: {ch['total']} კითხვიდან {ch['correct']} სწორი — {_format_pct(ch['percent'])}%"
                )
        else:
            lines.append(f"• ეტაპი 1 — თეორიული გამოცდა: {_format_pct(st1.get('score_percent'))}%")
    else:
        lines.append("• ეტაპი 1 — თეორიული გამოცდა: გამოტოვებულია")

    if st2:
        lines.append(
            f"• ეტაპი 2 — მრავალბინიანი შენობის პროექტის შეფასება: {_format_pct(st2['percentage'])}%, არასწორი პასუხები: {st2['wrong_count']}"
        )
    else:
        lines.append("• ეტაპი 2 — მრავალბინიანი შენობის პროექტის შეფასება: გამოტოვებულია")

    if st3:
        lines.append(
            f"• ეტაპი 3 — მრავალფუნქციური შენობის პროექტის შეფასება: {_format_pct(st3['percentage'])}%, არასწორი პასუხები: {st3['wrong_count']}"
        )
    else:
        lines.append("• ეტაპი 3 — მრავალფუნქციური შენობის პროექტის შეფასება: გამოტოვებულია")

    results_text = "\n".join(lines) if len(lines) > 1 else ""

    return {
        "has_results": True,
        "unacknowledged": unacknowledged,
        "outcome": outcome,
        "category_label": category_label,
        "results_text": results_text,
        "latest_exam_at": latest_exam_at.isoformat() if latest_exam_at else None,
        "completed_stages": len(cycle_stages),
    }


def _compute_exam_outcomes_for_users(db: Session, users: list[User]) -> dict[int, dict]:
    if not users:
        return {}
    user_ids = [u.id for u in users]
    code_to_user_id: dict[str, int] = {}
    for u in users:
        if u.code:
            code_to_user_id[u.code.strip().lower()] = u.id

    latest_s1_by_user: dict[int, dict] = {}
    s1_conds = [ExamSession.user_id.in_(user_ids)]
    if code_to_user_id:
        s1_conds.append(func.lower(ExamSession.candidate_code).in_(list(code_to_user_id.keys())))
    s1_rows = db.scalars(
        select(ExamSession)
        .where(ExamSession.finished_at.is_not(None), or_(*s1_conds))
        .order_by(ExamSession.finished_at.desc(), ExamSession.id.desc())
    ).all()
    for s in s1_rows:
        uid = s.user_id
        if uid not in user_ids and s.candidate_code:
            uid = code_to_user_id.get(s.candidate_code.strip().lower())
        if uid is not None and uid not in latest_s1_by_user:
            latest_s1_by_user[uid] = _extract_theory_stage_summary(s)

    latest_s2_by_user: dict[int, dict] = {}
    s2_rows = db.scalars(
        select(MultiApartmentEvaluation)
        .where(MultiApartmentEvaluation.user_id.in_(user_ids))
        .order_by(MultiApartmentEvaluation.finished_at.desc(), MultiApartmentEvaluation.id.desc())
    ).all()
    for e2 in s2_rows:
        if e2.user_id not in latest_s2_by_user:
            latest_s2_by_user[e2.user_id] = _extract_practical_stage_summary(e2)

    latest_s3_by_user: dict[int, dict] = {}
    s3_rows = db.scalars(
        select(MultiFunctionalEvaluation)
        .where(MultiFunctionalEvaluation.user_id.in_(user_ids))
        .order_by(MultiFunctionalEvaluation.finished_at.desc(), MultiFunctionalEvaluation.id.desc())
    ).all()
    for e3 in s3_rows:
        if e3.user_id not in latest_s3_by_user:
            latest_s3_by_user[e3.user_id] = _extract_practical_stage_summary(e3)

    last_letter_by_user: dict[int, datetime] = {}
    letter_rows = db.execute(
        select(
            PlanningLetter.user_id,
            func.max(func.coalesce(PlanningLetter.sent_at, PlanningLetter.created_at)),
        )
        .where(
            PlanningLetter.user_id.in_(user_ids),
            or_(
                (PlanningLetter.kind == "certificate")
                & or_(
                    PlanningLetter.period.is_(None),
                    ~PlanningLetter.period.in_(NON_PASS_CERT_PERIODS),
                ),
                PlanningLetter.period.in_(("exam_fail", "fail_send_only")),
            ),
        )
        .group_by(PlanningLetter.user_id)
    ).all()
    for uid, max_dt in letter_rows:
        if max_dt is not None:
            if isinstance(max_dt, str):
                try:
                    max_dt = datetime.fromisoformat(max_dt.replace("Z", ""))
                except Exception:
                    max_dt = None
            if max_dt is not None:
                last_letter_by_user[int(uid)] = max_dt

    return {
        u.id: _build_exam_outcome_payload(
            latest_s1_by_user.get(u.id),
            latest_s2_by_user.get(u.id),
            latest_s3_by_user.get(u.id),
            last_letter_by_user.get(u.id),
        )
        for u in users
    }


def _exam_dt_to_tbilisi_date(dt: datetime) -> date:
    return (dt + timedelta(hours=4)).date()


def _compute_all_exam_histories(db: Session) -> dict[int, dict]:
    s1_rows = db.scalars(
        select(ExamSession)
        .where(ExamSession.finished_at.is_not(None))
        .order_by(ExamSession.finished_at.asc(), ExamSession.id.asc())
    ).all()
    s2_rows = db.scalars(
        select(MultiApartmentEvaluation)
        .order_by(MultiApartmentEvaluation.finished_at.asc(), MultiApartmentEvaluation.id.asc())
    ).all()
    s3_rows = db.scalars(
        select(MultiFunctionalEvaluation)
        .order_by(MultiFunctionalEvaluation.finished_at.asc(), MultiFunctionalEvaluation.id.asc())
    ).all()

    if not s1_rows and not s2_rows and not s3_rows:
        return {}

    all_s1_codes = {
        s.candidate_code.strip().lower()
        for s in s1_rows
        if s.candidate_code and s.candidate_code.strip()
    }
    code_to_user_id: dict[str, int] = {}
    if all_s1_codes:
        for uid, code in db.execute(
            select(User.id, User.code).where(func.lower(User.code).in_(list(all_s1_codes)))
        ).all():
            if code:
                code_to_user_id[code.strip().lower()] = int(uid)

    attempts_by_user: dict[int, list[tuple[str, dict]]] = {}
    latest_s1_by_user: dict[int, dict] = {}
    latest_s2_by_user: dict[int, dict] = {}
    latest_s3_by_user: dict[int, dict] = {}

    for s in s1_rows:
        uid = s.user_id
        if s.candidate_code:
            code_uid = code_to_user_id.get(s.candidate_code.strip().lower())
            if uid is None or (code_uid is not None and uid != code_uid):
                uid = code_uid
        if uid is not None:
            summary = _extract_theory_stage_summary(s)
            latest_s1_by_user[uid] = summary
            attempts_by_user.setdefault(uid, []).append(("stage1", summary))

    for e2 in s2_rows:
        if e2.user_id is not None:
            summary = _extract_practical_stage_summary(e2)
            latest_s2_by_user[e2.user_id] = summary
            attempts_by_user.setdefault(e2.user_id, []).append(("stage2", summary))

    for e3 in s3_rows:
        if e3.user_id is not None:
            summary = _extract_practical_stage_summary(e3)
            latest_s3_by_user[e3.user_id] = summary
            attempts_by_user.setdefault(e3.user_id, []).append(("stage3", summary))

    if not attempts_by_user:
        return {}

    candidate_uids = list(attempts_by_user.keys())
    existing_uids = {
        int(uid)
        for uid in db.scalars(select(User.id).where(User.id.in_(candidate_uids))).all()
    }
    if not existing_uids:
        return {}

    letter_dts_by_user: dict[int, list[datetime]] = {}
    last_letter_by_user: dict[int, datetime] = {}
    letter_rows = db.execute(
        select(
            PlanningLetter.user_id,
            func.coalesce(PlanningLetter.sent_at, PlanningLetter.created_at),
        ).where(
            PlanningLetter.user_id.in_(list(existing_uids)),
            or_(
                (PlanningLetter.kind == "certificate")
                & or_(
                    PlanningLetter.period.is_(None),
                    ~PlanningLetter.period.in_(NON_PASS_CERT_PERIODS),
                ),
                PlanningLetter.period.in_(("exam_fail", "fail_send_only")),
            ),
        )
    ).all()
    for uid, raw_dt in letter_rows:
        if raw_dt is None:
            continue
        dt = raw_dt
        if isinstance(dt, str):
            try:
                dt = datetime.fromisoformat(dt.replace("Z", ""))
            except Exception:
                dt = None
        if dt is not None:
            uid_int = int(uid)
            letter_dts_by_user.setdefault(uid_int, []).append(dt)
            if uid_int not in last_letter_by_user or dt > last_letter_by_user[uid_int]:
                last_letter_by_user[uid_int] = dt

    stage_order = {"stage1": 1, "stage2": 2, "stage3": 3}
    histories: dict[int, dict] = {}
    for uid in existing_uids:
        user_attempts = attempts_by_user.get(uid, [])
        user_attempts.sort(
            key=lambda pair: (
                pair[1].get("finished_at") or datetime.min,
                stage_order.get(pair[0], 9),
            )
        )
        letter_dts = sorted(letter_dts_by_user.get(uid, []))
        sittings: list[dict] = []
        for stage_key, summary in user_attempts:
            dt = summary.get("finished_at")
            if sittings:
                curr = sittings[-1]
                prev_dt = curr["latest_at"]
                same_window = (
                    dt is None
                    or prev_dt is None
                    or (dt - prev_dt) <= timedelta(days=2)
                )
                letter_between = (
                    dt is not None
                    and prev_dt is not None
                    and any(prev_dt <= l_dt < dt for l_dt in letter_dts)
                )
                stage_already_in_sitting = stage_key in curr["stages"]
                same_day = (
                    dt is not None
                    and prev_dt is not None
                    and _exam_dt_to_tbilisi_date(dt) == _exam_dt_to_tbilisi_date(prev_dt)
                )
                if same_window and not letter_between and (not stage_already_in_sitting or same_day):
                    curr["stages"][stage_key] = summary
                    if dt is not None:
                        if curr["latest_at"] is None or dt > curr["latest_at"]:
                            curr["latest_at"] = dt
                        curr["dates"].add(_exam_dt_to_tbilisi_date(dt))
                        curr["dates"].add(dt.date())
                    continue
            new_dates: set[date] = set()
            if dt is not None:
                new_dates.add(_exam_dt_to_tbilisi_date(dt))
                new_dates.add(dt.date())
            sittings.append({
                "stages": {stage_key: summary},
                "latest_at": dt,
                "dates": new_dates,
            })

        for sitting in sittings:
            st1 = sitting["stages"].get("stage1")
            st2 = sitting["stages"].get("stage2")
            st3 = sitting["stages"].get("stage3")
            all_three = st1 is not None and st2 is not None and st3 is not None
            levels = [st["level"] for st in (st1, st2, st3) if st is not None]
            if not all_three or any(lv == "fail" for lv in levels):
                sitting["outcome"] = "fail"
            elif all(lv == "bc" for lv in levels):
                sitting["outcome"] = "pass_bc"
            else:
                sitting["outcome"] = "pass_a"

        latest_outcome = _build_exam_outcome_payload(
            latest_s1_by_user.get(uid),
            latest_s2_by_user.get(uid),
            latest_s3_by_user.get(uid),
            last_letter_by_user.get(uid),
        )
        histories[uid] = {
            "latest_outcome": latest_outcome,
            "sittings": sittings,
        }

    return histories


@router.get("/users/{user_id}/exam-outcome")
def admin_user_exam_outcome(
    user_id: int,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    auto_close_expired_sessions(db)
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    outcomes = _compute_exam_outcomes_for_users(db, [user])
    payload = dict(outcomes.get(user.id) or _build_exam_outcome_payload(None, None, None, None))
    payload["candidate_status"] = user.candidate_status
    payload["candidate_category"] = user.candidate_category
    payload["requested_category"] = get_user_latest_requested_category(db, user.id)
    return payload


@router.get("/users", response_model=None)
def admin_users(
    page: int = 1,
    size: int = 1000000,
    search: str | None = None,
    only_admins: bool = False,
    sort: str = "date_desc",  # date_desc|date_asc|name_asc|name_desc
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
    statement_date: date | None = None,
    exam_date: date | None = None,
    exam_morning: bool = False,
    exam_evening: bool = False,
    certificate_handover: bool = False,
    paginated: bool = False,
    live: bool = False,
    new_statements: bool = False,
    pending_statements: bool = False,
    all_statements: bool = False,
    qualification: str | None = None,
    exam_passed: bool = False,
    exam_failed: bool = False,
    exam_result_date: date | None = None,
    pending_pass_letter: bool = False,
    pending_fail_letter: bool = False,
    exam_candidate: bool = False,
    cert_candidate: bool = False,
    sent_exam_letter: bool = False,
    sent_rejection_letter: bool = False,
    sent_certificate_letter: bool = False,
    sent_fail_letter: bool = False,
    sent_custom_letter: bool = False,
    sent_letter_date: date | None = None,
):
    _require_admin(db, authorization)
    settings = get_settings()

    exam_histories = _compute_all_exam_histories(db)
    requested_categories = sync_all_user_candidates(db, exam_histories)

    stmt = select(User)
    if search:
        q = f"%{search.strip().lower()}%"
        stmt = stmt.where(
            or_(
                User.first_name.ilike(q),
                User.last_name.ilike(q),
                User.email.ilike(q),
                User.phone.ilike(q),
                User.personal_id.ilike(q),
                User.code.ilike(q),
                User.id.in_(select(Statement.user_id).where(Statement.doc_number.ilike(q))),
                User.id.in_(select(PlanningLetter.user_id).where(PlanningLetter.doc_number.ilike(q))),
            )
        )
    if only_admins:
        stmt = stmt.where(User.is_admin == True)  # noqa: E712

    # Optional website filters run before LIMIT/OFFSET. Legacy callers keep the
    # existing complete-list response unless they explicitly request pagination.
    qualification_levels = {
        "architect": ("architect", "architect_expert"),
        "expert": ("expert",),
        "municipal": ("municipal",),
        "certified": ("architect", "expert", "municipal"),
    }
    if qualification:
        if qualification == "suspended_expired":
            stmt = stmt.where(User.id.in_(select(Certificate.user_id).where(
                Certificate.status.in_(("suspended", "expired"))
            )))
        elif qualification == "exam_candidate":
            stmt = stmt.where(User.candidate_status == "exam_candidate")
        elif qualification == "cert_candidate":
            stmt = stmt.where(User.candidate_status == "cert_candidate")
        elif qualification in qualification_levels:
            stmt = stmt.where(User.id.in_(select(Certificate.user_id).where(
                Certificate.level.in_(qualification_levels[qualification])
            )))
        else:
            raise HTTPException(status_code=422, detail="Unknown qualification filter")

    if exam_candidate or cert_candidate:
        cand_statuses = []
        if exam_candidate:
            cand_statuses.append("exam_candidate")
        if cert_candidate:
            cand_statuses.append("cert_candidate")
        stmt = stmt.where(User.candidate_status.in_(cand_statuses))

    stmt_action_cond = None
    if statement_date is None and (new_statements or pending_statements or all_statements):
        if all_statements:
            stmt_action_cond = select(Statement.id).where(Statement.user_id == User.id).exists()
        else:
            has_new = select(Statement.id).where(
                Statement.user_id == User.id, Statement.seen_at.is_(None)
            ).exists()
            has_pending = select(Statement.id).where(
                Statement.user_id == User.id, Statement.seen_at.is_not(None),
                Statement.answered_at.is_(None),
            ).exists()
            colors = []
            if new_statements:
                colors.append(has_new)
            if pending_statements:
                colors.append(~has_new & has_pending)
            stmt_action_cond = or_(*colors)

    if exam_date is not None or exam_morning or exam_evening or certificate_handover:
        target_schedule_date = exam_date if exam_date is not None else _today_in_tbilisi()
        target_date_str = target_schedule_date.isoformat()
        schedule_conditions = []
        if exam_morning or exam_evening or not certificate_handover:
            schedule_query = select(ExamSchedule.user_id).where(
                ExamSchedule.exam_date == target_schedule_date
            )
            # Both selected, or a date alone, includes both groups without duplicates.
            if exam_morning and not exam_evening:
                schedule_query = schedule_query.where(ExamSchedule.period == "morning")
            elif exam_evening and not exam_morning:
                schedule_query = schedule_query.where(ExamSchedule.period == "evening")
            schedule_conditions.append(User.id.in_(schedule_query))
        if certificate_handover:
            if exam_date is not None:
                booking_query = select(CertBooking.user_id).where(
                    CertBooking.status == "active",
                    CertBooking.booking_date == target_date_str,
                )
                cert_handover_query = select(PlanningLetter.user_id).where(
                    PlanningLetter.kind == "certificate",
                    PlanningLetter.event_date == target_schedule_date,
                    PlanningLetter.period.in_(("morning", "evening", "cert_am_send", "cert_pm_send")),
                )
                schedule_conditions.append(User.id.in_(booking_query))
                schedule_conditions.append(User.id.in_(cert_handover_query))
            else:
                booking_query = select(CertBooking.user_id).where(
                    CertBooking.status == "active",
                    CertBooking.booking_date >= target_date_str,
                )
                schedule_conditions.append(User.id.in_(booking_query))
        stmt = stmt.where(or_(*schedule_conditions))

    if statement_date is not None:
        # Statements are stored in naive UTC; the selected day is in Georgia.
        try:
            day_start = datetime.combine(
                statement_date, time.min, tzinfo=timezone(timedelta(hours=4))
            ).astimezone(timezone.utc).replace(tzinfo=None)
            day_end = day_start + timedelta(days=1)
        except OverflowError:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="statement_date is outside the supported range",
            )
        stmt = stmt.where(
            User.id.in_(
                select(Statement.user_id).where(
                    Statement.created_at >= day_start,
                    Statement.created_at < day_end,
                )
            )
        )

    has_sent_type_filter = (
        sent_exam_letter
        or sent_rejection_letter
        or sent_certificate_letter
        or sent_fail_letter
        or sent_custom_letter
    )
    letter_match_cond = None
    letter_ts_expr = func.coalesce(PlanningLetter.sent_at, PlanningLetter.created_at)
    if has_sent_type_filter or sent_letter_date is not None:
        rej_periods = ("rejection", "rej_send_only", "rejection_send_only")
        fail_periods = ("exam_fail", "fail_send_only")
        custom_periods = ("custom", "cust_send_only")
        non_exam_periods = rej_periods + fail_periods + custom_periods
        type_conds = []
        if sent_exam_letter:
            type_conds.append(
                (PlanningLetter.kind == "exam")
                & or_(
                    PlanningLetter.period.is_(None),
                    ~PlanningLetter.period.in_(non_exam_periods),
                )
            )
        if sent_rejection_letter:
            type_conds.append(PlanningLetter.period.in_(rej_periods))
        if sent_certificate_letter:
            type_conds.append(
                (PlanningLetter.kind == "certificate")
                & or_(
                    PlanningLetter.period.is_(None),
                    ~PlanningLetter.period.in_(NON_PASS_CERT_PERIODS),
                )
            )
        if sent_fail_letter:
            type_conds.append(PlanningLetter.period.in_(fail_periods))
        if sent_custom_letter:
            type_conds.append(PlanningLetter.period.in_(custom_periods))
        if not type_conds:
            type_conds.append(
                or_(
                    PlanningLetter.period.is_(None),
                    PlanningLetter.period != "cert_issued",
                )
            )

        letter_match_cond = or_(*type_conds)
        if sent_letter_date is not None:
            try:
                sent_day_start = datetime.combine(
                    sent_letter_date, time.min, tzinfo=timezone(timedelta(hours=4))
                ).astimezone(timezone.utc).replace(tzinfo=None)
                sent_day_end = sent_day_start + timedelta(days=1)
            except OverflowError:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="sent_letter_date is outside the supported range",
                )
            letter_match_cond = letter_match_cond & (letter_ts_expr >= sent_day_start) & (letter_ts_expr < sent_day_end)

        stmt = stmt.where(
            User.id.in_(
                select(PlanningLetter.user_id).where(letter_match_cond)
            )
        )

    global_pending_pass_users = sum(
        1
        for h in exam_histories.values()
        if h["latest_outcome"].get("unacknowledged")
        and h["latest_outcome"].get("outcome") in ("pass_bc", "pass_a")
    )
    global_pending_fail_users = sum(
        1
        for h in exam_histories.values()
        if h["latest_outcome"].get("unacknowledged")
        and h["latest_outcome"].get("outcome") == "fail"
    )

    if (
        exam_passed
        or exam_failed
        or exam_result_date is not None
        or pending_pass_letter
        or pending_fail_letter
    ):
        matching_uids: list[int] = []
        has_outcome_filter = exam_passed or exam_failed
        has_pending_filter = pending_pass_letter or pending_fail_letter
        for uid, h in exam_histories.items():
            sittings = h.get("sittings") or []
            latest = h.get("latest_outcome") or {}
            if not sittings:
                continue
            outcome_ok = True
            if has_outcome_filter:
                outcome_ok = False
                for sitting in sittings:
                    if exam_result_date is not None and exam_result_date not in sitting["dates"]:
                        continue
                    if exam_passed and sitting["outcome"] in ("pass_bc", "pass_a"):
                        outcome_ok = True
                        break
                    if exam_failed and sitting["outcome"] == "fail":
                        outcome_ok = True
                        break
            elif exam_result_date is not None and not has_pending_filter:
                outcome_ok = any(exam_result_date in sitting["dates"] for sitting in sittings)

            pending_ok = True
            if has_pending_filter:
                pending_ok = False
                if latest.get("unacknowledged"):
                    latest_sitting = sittings[-1]
                    date_ok = exam_result_date is None or exam_result_date in latest_sitting["dates"]
                    if date_ok:
                        if pending_pass_letter and latest.get("outcome") in ("pass_bc", "pass_a"):
                            pending_ok = True
                        if pending_fail_letter and latest.get("outcome") == "fail":
                            pending_ok = True

            if outcome_ok and pending_ok:
                matching_uids.append(uid)

        outcome_cond = User.id.in_(matching_uids) if matching_uids else (User.id == -1)
        if stmt_action_cond is not None and not has_outcome_filter and exam_result_date is None:
            stmt = stmt.where(or_(stmt_action_cond, outcome_cond))
        else:
            if stmt_action_cond is not None:
                stmt = stmt.where(stmt_action_cond)
            stmt = stmt.where(outcome_cond)
    elif stmt_action_cond is not None:
        stmt = stmt.where(stmt_action_cond)

    if letter_match_cond is not None and sort in ("date_desc", "date_asc"):
        sent_ts_subq = (
            select(func.max(letter_ts_expr))
            .where(PlanningLetter.user_id == User.id, letter_match_cond)
            .scalar_subquery()
        )
        if sort == "date_asc":
            stmt = stmt.order_by(sent_ts_subq.asc(), User.created_at.asc())
        else:
            stmt = stmt.order_by(sent_ts_subq.desc(), User.created_at.desc())
    elif all_statements and sort in ("date_desc", "date_asc"):
        stmt_ts_query = select(func.max(Statement.created_at)).where(Statement.user_id == User.id)
        if statement_date is not None:
            stmt_ts_query = stmt_ts_query.where(
                Statement.created_at >= day_start,
                Statement.created_at < day_end,
            )
        stmt_ts_subq = stmt_ts_query.scalar_subquery()
        if sort == "date_asc":
            stmt = stmt.order_by(stmt_ts_subq.asc(), User.created_at.asc())
        else:
            stmt = stmt.order_by(stmt_ts_subq.desc(), User.created_at.desc())
    elif sort == "date_asc":
        stmt = stmt.order_by(User.created_at.asc())
    elif sort == "name_asc":
        stmt = stmt.order_by(User.last_name.asc(), User.first_name.asc())
    elif sort == "name_desc":
        stmt = stmt.order_by(User.last_name.desc(), User.first_name.desc())
    else:
        stmt = stmt.order_by(User.created_at.desc())

    # Stable tie-breaks prevent duplicated/skipped people at page boundaries.
    stmt = stmt.order_by(User.id.asc() if sort in ("date_asc", "name_asc") else User.id.desc())
    total = None
    if paginated:
        size = min(100, max(1, size if size != 1000000 else 50))
        total = int(db.scalar(select(func.count()).select_from(
            stmt.with_only_columns(User.id).order_by(None).subquery()
        )) or 0)
        page = min(max(1, page), max(1, (total + size - 1) // size))
        stmt = stmt.limit(size).offset((page - 1) * size)

    stmt = stmt.options(selectinload(User.certificate))
    users = db.scalars(stmt).all()
    founder_email = (settings.founder_admin_email or "").lower()

    user_ids = [u.id for u in users]
    unseen_counts: dict[int, int] = {}
    pending_counts: dict[int, int] = {}
    if user_ids:
        stmt = (
            select(
                Statement.user_id,
                func.sum(case((Statement.seen_at.is_(None), 1), else_=0)),
                func.sum(case((
                    Statement.seen_at.is_not(None) & Statement.answered_at.is_(None), 1
                ), else_=0)),
            )
            .where(Statement.user_id.in_(user_ids))
            .group_by(Statement.user_id)
        )
        for user_id, unseen_count, pending_count in db.execute(stmt):
            unseen_counts[int(user_id)] = int(unseen_count)
            pending_counts[int(user_id)] = int(pending_count)

    empty_outcome = _build_exam_outcome_payload(None, None, None, None)
    exam_outcomes = {
        u.id: (
            exam_histories[u.id]["latest_outcome"]
            if u.id in exam_histories
            else empty_outcome
        )
        for u in users
    }
    items = []
    stage_expired_changed = False
    for u in users:
        unseen_count = unseen_counts.get(u.id, 0)
        pending_count = pending_counts.get(u.id, 0)
        cert_data = None
        if u.certificate:
            cert_data = {
                'unique_code': u.certificate.unique_code,
                'level': u.certificate.level,
                'status': u.certificate.status,
                'issue_date': u.certificate.issue_date,
                'validity_term': u.certificate.validity_term,
                'valid_until': u.certificate.valid_until,
            }
        is_founder_user = (u.email.lower() == founder_email)
        is_admin_user = is_founder_user or bool(u.is_admin)
        # მთავარ ადმინს ყოველთვის exam_permission = true
        # სხვა ადმინებს exam_permission = true (როცა is_admin = true, exam_permission-იც ავტომატურად true ხდება)
        # არა-ადმინებს exam_permission = u.exam_permission (რაც ბაზაშია)
        if is_founder_user:
            exam_perm = True
        elif is_admin_user:
            exam_perm = True  # ადმინებს exam_permission ყოველთვის true
        else:
            if expire_unused_stage_permissions(db, u):
                stage_expired_changed = True
            exam_perm = bool(u.exam_permission)  # არა-ადმინებს რაც ბაზაშია

        exam_state = exam_state_with_permissions(db, u, is_admin_user=is_admin_user)
        user_dict = {
            'id': u.id,
            'personal_id': u.personal_id,
            'first_name': u.first_name,
            'last_name': u.last_name,
            'phone': u.phone,
            'email': u.email,
            'code': u.code,
            'is_admin': is_admin_user,
            'is_founder': is_founder_user,
            'exam_permission': bool(exam_state.get("exam_permission", exam_perm)),
            'exam_stage': exam_state.get("exam_stage"),
            'exam_stage_expires_at': exam_state.get("exam_stage_expires_at"),
            'exam_stage_started_at': exam_state.get("exam_stage_started_at"),
            'exam_stage_status': exam_state.get("exam_stage_status"),
            'exam_stage_remaining_seconds': exam_state.get("exam_stage_remaining_seconds"),
            'exam_stage_permissions': exam_state.get("exam_stage_permissions", {}),
            'created_at': u.created_at,
            'has_unseen_statements': unseen_count > 0,
            'unseen_statement_count': unseen_count,
            'has_pending_statements': pending_count > 0,
            'pending_statement_count': pending_count,
            'photo_filename': u.photo_filename,
            'exam_outcome': exam_outcomes.get(u.id),
            'candidate_status': u.candidate_status,
            'candidate_category': u.candidate_category,
            'requested_category': requested_categories.get(u.id),
        }
        if cert_data:
            user_dict['certificate'] = cert_data
            user_dict['certificate_info'] = cert_data
        items.append(UserOut(**user_dict))
    if stage_expired_changed:
        db.commit()
    if paginated:
        has_unseen_stmt = select(Statement.id).where(
            Statement.user_id == User.id, Statement.seen_at.is_(None)
        ).exists()
        has_pending_stmt = select(Statement.id).where(
            Statement.user_id == User.id,
            Statement.seen_at.is_not(None),
            Statement.answered_at.is_(None),
        ).exists()
        has_any_stmt_count = select(Statement.id).where(
            Statement.user_id == User.id
        ).exists()
        global_unseen_users = int(db.scalar(
            select(func.count(User.id)).where(has_unseen_stmt)
        ) or 0)
        global_pending_users = int(db.scalar(
            select(func.count(User.id)).where(~has_unseen_stmt, has_pending_stmt)
        ) or 0)
        global_all_statement_users = int(db.scalar(
            select(func.count(User.id)).where(has_any_stmt_count)
        ) or 0)
        global_exam_candidates = int(db.scalar(
            select(func.count(User.id)).where(User.candidate_status == "exam_candidate")
        ) or 0)
        global_cert_candidates = int(db.scalar(
            select(func.count(User.id)).where(User.candidate_status == "cert_candidate")
        ) or 0)
        page_items = []
        for item in items:
            payload = item.model_dump(mode="json")
            # A display revision detects other-admin edits without transmitting
            # names/contact details/certificates on every five-second poll.
            display = {key: payload.get(key) for key in (
                "personal_id", "first_name", "last_name", "phone", "email",
                "code", "is_admin", "is_founder", "created_at", "certificate",
                "photo_filename", "exam_outcome",
                "candidate_status", "candidate_category", "requested_category",
            )}
            revision = sha256(_json.dumps(display, sort_keys=True).encode()).hexdigest()[:20]
            if live:
                payload = {key: payload[key] for key in (
                    "id", "exam_permission", "exam_stage", "exam_stage_expires_at",
                    "exam_stage_started_at", "exam_stage_status",
                    "exam_stage_remaining_seconds", "exam_stage_permissions",
                    "has_unseen_statements", "unseen_statement_count",
                    "has_pending_statements", "pending_statement_count",
                    "candidate_status", "candidate_category", "requested_category",
                )}
            payload["display_revision"] = revision
            page_items.append(payload)
        return {
            "items": page_items, "total": total, "page": page, "size": size,
            "paginated": True, "live": live,
            "global_unseen_users": global_unseen_users,
            "global_pending_users": global_pending_users,
            "global_all_statement_users": global_all_statement_users,
            "global_pending_pass_users": global_pending_pass_users,
            "global_pending_fail_users": global_pending_fail_users,
            "global_exam_candidates": global_exam_candidates,
            "global_cert_candidates": global_cert_candidates,
        }
    return UsersListResponse(items=items, total=len(items))


@router.patch("/users/{user_id}/admin", status_code=status.HTTP_204_NO_CONTENT)
def admin_toggle_user(
    user_id: int,
    payload: ToggleAdminRequest,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    settings = get_settings()
    if not _is_founder_actor(authorization, db):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only founder can modify admin status")

    u = db.get(User, user_id)
    if not u:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    if (settings.founder_admin_email or "").lower() == u.email.lower():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Founder admin cannot be modified")

    # Historical candidate grants must never reappear after a later demotion.
    reset_all_stage_permissions(db, u)
    u.is_admin = bool(payload.is_admin)
    # როცა ადმინი ხდება, exam_permission-იც ჩაირთოს
    # როცა ადმინი გაეთიშება, exam_permission-იც გაითიშოს
    if payload.is_admin:
        u.exam_permission = True
        u.exam_stage = "none"
        u.exam_stage_expires_at = None
        u.exam_stage_started_at = None
    else:
        u.exam_permission = False
        u.exam_stage = "none"
        u.exam_stage_expires_at = None
        u.exam_stage_started_at = None
    db.add(u)
    db.commit()
    return


@router.patch("/users/{user_id}/exam-permission", status_code=status.HTTP_204_NO_CONTENT)
def admin_toggle_exam_permission(
    user_id: int,
    payload: ToggleExamPermissionRequest,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    settings = get_settings()
    
    u = db.get(User, user_id)
    if not u:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    
    # მთავარ ადმინს exam_permission-ის შეცვლა არ შეიძლება
    if (settings.founder_admin_email or "").lower() == u.email.lower():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Founder admin exam permission cannot be modified")
    
    if payload.exam_permission:
        grant_stage_permission(db, u, STAGE_THEORY)
    else:
        reset_all_stage_permissions(db, u)
    db.add(u)
    db.commit()
    return


def _stage_permission_user_out(db: Session, user: User) -> UserOut:
    settings = get_settings()
    founder_email = (settings.founder_admin_email or "").lower()
    is_founder = (user.email or "").lower() == founder_email
    is_admin_user = is_founder or bool(user.is_admin)
    state = exam_state_with_permissions(db, user, is_admin_user=is_admin_user)
    req_cat = get_user_latest_requested_category(db, user.id)
    cert_data = None
    if user.certificate:
        cert_data = {
            "unique_code": user.certificate.unique_code,
            "level": user.certificate.level,
            "status": user.certificate.status,
            "issue_date": user.certificate.issue_date,
            "validity_term": user.certificate.validity_term,
            "valid_until": user.certificate.valid_until,
        }
    return UserOut(
        id=user.id,
        personal_id=user.personal_id,
        first_name=user.first_name,
        last_name=user.last_name,
        phone=user.phone,
        email=user.email,
        code=user.code,
        is_admin=is_admin_user,
        is_founder=is_founder,
        exam_permission=state["exam_permission"],
        exam_stage=state["exam_stage"],
        exam_stage_expires_at=state["exam_stage_expires_at"],
        exam_stage_started_at=state["exam_stage_started_at"],
        exam_stage_status=state["exam_stage_status"],
        exam_stage_remaining_seconds=state["exam_stage_remaining_seconds"],
        exam_stage_permissions=state["exam_stage_permissions"],
        created_at=user.created_at,
        photo_filename=user.photo_filename,
        certificate=cert_data,
        certificate_info=cert_data,
        candidate_status=user.candidate_status,
        candidate_category=user.candidate_category,
        requested_category=req_cat,
    )


@router.patch("/users/{user_id}/candidate-status", response_model=UserOut)
def admin_update_candidate_status(
    user_id: int,
    payload: UpdateCandidateStatusRequest,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    now = datetime.utcnow()
    if payload.candidate_status is None:
        user.candidate_status = None
        user.candidate_category = None
        user.candidate_updated_at = now
    else:
        user.candidate_status = payload.candidate_status
        req_cat = get_user_latest_requested_category(db, user.id)
        chosen_cat = payload.candidate_category or user.candidate_category or req_cat or "A"
        if payload.candidate_status == "cert_candidate" and payload.candidate_category is None:
            chosen_cat = normalize_cert_category(chosen_cat)
        user.candidate_category = chosen_cat
        user.candidate_updated_at = now

    if payload.candidate_status != "cert_candidate":
        _cancel_active_bookings_for_user(db, user.id, now)

    db.add(user)
    db.commit()
    db.refresh(user)
    return _stage_permission_user_out(db, user)


@router.patch(
    "/users/{user_id}/exam-stage-permissions/{stage}", response_model=UserOut
)
def admin_toggle_exam_stage_permission(
    user_id: int,
    stage: str,
    payload: ToggleExamStagePermissionRequest,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    settings = get_settings()
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    if (settings.founder_admin_email or "").lower() == (user.email or "").lower():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Founder admin exam permission cannot be modified",
        )

    if payload.granted:
        try:
            grant_stage_permission(
                db,
                user,
                stage,
                replace_started=payload.replace_started,
                expected_grant_id=payload.expected_grant_id,
            )
            db.commit()
        except IntegrityError:
            # The partial unique index is the final concurrency guard.  If a
            # concurrent identical request won, return that same live grant.
            db.rollback()
            user = db.get(User, user_id)
            if payload.replace_started:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="The running exam attempt changed; refresh and try again",
                )
            if user is None or current_open_grant(db, user, stage) is None:
                raise
    else:
        if payload.replace_started or payload.expected_grant_id is not None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Replacement fields require granted=true",
            )
        revoke_stage_permission(db, user, stage, allow_started=False)
        db.commit()
    db.refresh(user)
    return _stage_permission_user_out(db, user)


@router.patch("/users/{user_id}", response_model=UserOut)
def admin_update_user(
    user_id: int,
    payload: AdminUserUpdateRequest,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    if not _is_founder_actor(authorization, db):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only founder can modify user data")

    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    settings = get_settings()
    founder_email = (settings.founder_admin_email or "").lower()
    updates_made = False
    new_personal_id = None

    if payload.first_name is not None:
        first_name = (payload.first_name or "").strip()
        if not first_name:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="first_name must not be empty")
        if first_name != user.first_name:
            user.first_name = first_name
            updates_made = True

    if payload.last_name is not None:
        last_name = (payload.last_name or "").strip()
        if not last_name:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="last_name must not be empty")
        if last_name != user.last_name:
            user.last_name = last_name
            updates_made = True

    if payload.personal_id is not None:
        personal_id = (payload.personal_id or "").strip()
        if len(personal_id) != 11 or not personal_id.isdigit():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="personal_id must be 11 digits")
        exists_pid = db.scalar(
            select(User.id).where(
                User.personal_id == personal_id,
                User.id != user.id,
            )
        )
        if exists_pid:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="personal_id already registered")
        if personal_id != user.personal_id:
            new_personal_id = personal_id
            updates_made = True

    if payload.phone is not None:
        phone = (payload.phone or "").strip()
        if not phone:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="phone must not be empty")
        if phone != user.phone:
            user.phone = phone
            updates_made = True

    if payload.email is not None:
        email = (payload.email or "").strip().lower()
        if not email:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="email must not be empty")
        if user.email.lower() == founder_email and email != founder_email:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Founder email cannot be changed")
        existing_email = db.scalar(
            select(User.id).where(
                func.lower(User.email) == email,
                User.id != user.id,
            )
        )
        if existing_email:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="email already in use")
        if email != user.email.lower():
            user.email = email
            updates_made = True
        else:
            # Ensure canonical lowercase storage
            user.email = email

    if payload.code is not None:
        code_candidate = (payload.code or "").strip()
        if code_candidate != user.code:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="code cannot be modified")

    if new_personal_id is not None:
        try:
            move_user_code(db, user, new_personal_id)
        except (UserCodeConflict, IntegrityError):
            db.rollback()
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="ამ პირად ნომერზე კოდის გადაბმა შეუძლებელია: შენახულ კოდთან კონფლიქტია")
        user.personal_id = new_personal_id

    if updates_made:
        db.add(user)
        db.commit()
        db.refresh(user)
    else:
        db.refresh(user)

    unseen_count = db.scalar(
        select(func.count()).select_from(Statement).where(
            Statement.user_id == user.id,
            Statement.seen_at.is_(None),
        )
    ) or 0
    pending_count = db.scalar(
        select(func.count()).select_from(Statement).where(
            Statement.user_id == user.id,
            Statement.seen_at.is_not(None),
            Statement.answered_at.is_(None),
        )
    ) or 0

    is_founder_user = (user.email.lower() == founder_email)
    is_admin_user = is_founder_user or bool(user.is_admin)
    if not is_admin_user and expire_unused_stage_permissions(db, user, commit=True):
        db.refresh(user)
    exam_state = exam_state_with_permissions(
        db, user, is_admin_user=is_admin_user
    )

    return UserOut(
        id=user.id,
        personal_id=user.personal_id,
        first_name=user.first_name,
        last_name=user.last_name,
        phone=user.phone,
        email=user.email,
        code=user.code,
        is_admin=is_admin_user,
        is_founder=is_founder_user,
        exam_permission=exam_state["exam_permission"],
        exam_stage=exam_state["exam_stage"],
        exam_stage_expires_at=exam_state["exam_stage_expires_at"],
        exam_stage_started_at=exam_state["exam_stage_started_at"],
        exam_stage_status=exam_state["exam_stage_status"],
        exam_stage_remaining_seconds=exam_state["exam_stage_remaining_seconds"],
        exam_stage_permissions=exam_state["exam_stage_permissions"],
        created_at=user.created_at,
        has_unseen_statements=unseen_count > 0,
        unseen_statement_count=unseen_count,
        has_pending_statements=pending_count > 0,
        pending_statement_count=pending_count,
        candidate_status=user.candidate_status,
        candidate_category=user.candidate_category,
        requested_category=get_user_latest_requested_category(db, user.id),
    )

@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def admin_delete_user(
    user_id: int,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    settings = get_settings()
    if not _is_founder_actor(authorization, db):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only founder can delete")

    u = db.get(User, user_id)
    if not u:
        return
    if (settings.founder_admin_email or "").lower() == u.email.lower():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Founder admin cannot be deleted")

    # Preserve only the identifier mapping before deleting any account files.
    try:
        remember_user_code(db, u)
    except (UserCodeConflict, IntegrityError):
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="წაშლა ვერ შესრულდა: პირადი ნომრისა და კოდის კავშირი შესამოწმებელია")

    # Delete user photo file before cascade delete
    _delete_user_photo_file(u)

    # Delete statement attachment files before cascade delete
    statements = db.scalars(select(Statement).where(Statement.user_id == user_id)).all()
    for statement in statements:
        if statement.attachment_path:
            try:
                delete_storage_file(statement.attachment_path)
            except Exception:
                # Best-effort: continue even if file deletion fails
                pass

    # Delete expert upload files before cascade delete
    expert_uploads = db.scalars(select(ExpertUpload).where(ExpertUpload.user_id == user_id)).all()
    for upload in expert_uploads:
        if upload.expertise_path:
            try:
                delete_storage_file(upload.expertise_path)
            except Exception:
                pass
        if upload.project_path:
            try:
                delete_storage_file(upload.project_path)
            except Exception:
                pass

    # Delete certificate file and directories before cascade delete
    cert = db.scalar(select(Certificate).where(Certificate.user_id == user_id))
    if cert:
        # Delete file from disk if exists
        if cert.file_path:
            try:
                delete_storage_file(cert.file_path)
            except Exception:
                # Best-effort: continue even if file deletion fails
                pass

        # Delete certificate directory if it exists and is empty
        try:
            media_root = ensure_media_root()
            cert_dir = media_root / "certificates" / str(user_id)
            if cert_dir.exists() and cert_dir.is_dir():
                # Try to remove the directory (will only work if empty)
                try:
                    cert_dir.rmdir()
                except OSError:
                    # Directory not empty or other error, that's okay
                    pass
        except Exception:
            # Best-effort: continue even if directory deletion fails
            pass

        # Expert certificate cleanup treats the persisted code as untrusted.
        if cert.level and cert.level.lower() == "expert" and cert.unique_code:
            delete_expert_certificate_files(cert.unique_code)

    db.delete(u)
    db.commit()
    return


# Bulk delete all non-founder users
@router.delete("/users", status_code=status.HTTP_204_NO_CONTENT)
def admin_delete_all_users(
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    settings = get_settings()
    # Only founder can delete all users
    founder_email = (settings.founder_admin_email or "").lower()
    if not _is_founder_actor(authorization, db):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only founder can delete all users")

    # Do not delete founder
    users = db.scalars(select(User)).all()  # fetch all users
    # Validate/preserve every mapping before file cleanup starts, so a conflict
    # on a later account cannot partially delete earlier accounts' files.
    try:
        for u in users:
            if (u.email or "").lower() != founder_email:
                remember_user_code(db, u)
    except (UserCodeConflict, IntegrityError):
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="წაშლა ვერ შესრულდა: პირადი ნომრისა და კოდის კავშირი შესამოწმებელია")
    for u in users:
        if (u.email or "").lower() == founder_email:
            continue
        
        # Delete user photo file before cascade delete
        _delete_user_photo_file(u)

        # Delete statement attachment files before cascade delete
        statements = db.scalars(select(Statement).where(Statement.user_id == u.id)).all()
        for statement in statements:
            if statement.attachment_path:
                try:
                    delete_storage_file(statement.attachment_path)
                except Exception:
                    # Best-effort: continue even if file deletion fails
                    pass

        # Delete certificate file and directories before cascade delete
        cert = db.scalar(select(Certificate).where(Certificate.user_id == u.id))
        if cert:
            # Delete file from disk if exists
            if cert.file_path:
                try:
                    delete_storage_file(cert.file_path)
                except Exception:
                    # Best-effort: continue even if file deletion fails
                    pass

            # Delete certificate directory if it exists and is empty
            try:
                media_root = ensure_media_root()
                cert_dir = media_root / "certificates" / str(u.id)
                if cert_dir.exists() and cert_dir.is_dir():
                    # Try to remove the directory (will only work if empty)
                    try:
                        cert_dir.rmdir()
                    except OSError:
                        # Directory not empty or other error, that's okay
                        pass
            except Exception:
                # Best-effort: continue even if directory deletion fails
                pass

            # Expert certificate cleanup treats the persisted code as untrusted.
            if cert.level and cert.level.lower() == "expert" and cert.unique_code:
                delete_expert_certificate_files(cert.unique_code)

        db.delete(u)
    db.commit()
    return


def _admin_statement_payload(statement: Statement, user: User) -> AdminStatementOut:
    return AdminStatementOut(
        id=statement.id,
        doc_number=format_statement_doc_number(statement),
        user_id=user.id,
        user_first_name=user.first_name,
        user_last_name=user.last_name,
        user_email=user.email,
        message=statement.message,
        created_at=statement.created_at,
        seen_at=statement.seen_at,
        seen_by=statement.seen_by,
        answered_at=statement.answered_at,
        answered_by=statement.answered_by,
        attachment_filename=statement.attachment_filename,
        attachment_size_bytes=statement.attachment_size_bytes,
    )


@router.get("/users/{user_id}/statements", response_model=AdminStatementsResponse)
def admin_user_statements(
    user_id: int,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    statements = db.scalars(
        select(Statement)
        .where(Statement.user_id == user.id)
        .order_by(Statement.created_at.desc(), Statement.id.desc())
    ).all()
    items = [
        _admin_statement_payload(statement, user)
        for statement in statements
    ]
    return AdminStatementsResponse(items=items, total=len(items))


@router.patch("/statements/{statement_id}/answered", response_model=StatementAnsweredResponse)
def admin_set_statement_answered(
    statement_id: int,
    payload: StatementAnsweredRequest,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    actor = _require_admin(db, authorization)
    statement = db.get(Statement, statement_id)
    if not statement:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Statement not found")
    user = db.get(User, statement.user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    if payload.answered:
        now = datetime.utcnow()
        actor_email = actor.email.lower()
        # Conditional update preserves the first answer/reader even if requests
        # from two admin tabs overlap. Only this statement can be affected.
        db.execute(
            Statement.__table__.update()
            .where(Statement.id == statement_id, Statement.answered_at.is_(None))
            .values(
                answered_at=now,
                answered_by=actor_email,
                seen_at=case((Statement.seen_at.is_(None), now), else_=Statement.seen_at),
                seen_by=case((Statement.seen_at.is_(None), actor_email), else_=Statement.seen_by),
            )
        )
    else:
        db.execute(
            Statement.__table__.update()
            .where(Statement.id == statement_id)
            .values(answered_at=None, answered_by=None)
        )
    db.commit()
    db.refresh(statement)

    unseen_count = db.scalar(
        select(func.count()).select_from(Statement).where(
            Statement.user_id == statement.user_id,
            Statement.seen_at.is_(None),
        )
    ) or 0
    pending_count = db.scalar(
        select(func.count()).select_from(Statement).where(
            Statement.user_id == statement.user_id,
            Statement.seen_at.is_not(None),
            Statement.answered_at.is_(None),
        )
    ) or 0
    return StatementAnsweredResponse(
        statement=_admin_statement_payload(statement, user),
        user_id=statement.user_id,
        has_unseen_statements=unseen_count > 0,
        unseen_statement_count=unseen_count,
        has_pending_statements=pending_count > 0,
        pending_statement_count=pending_count,
    )


@router.delete("/statements/{statement_id}", status_code=status.HTTP_204_NO_CONTENT)
def admin_delete_statement(
    statement_id: int,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)

    statement = db.get(Statement, statement_id)
    if not statement:
        return
    user = db.get(User, statement.user_id)
    # Remove stored attachment if present
    if statement.attachment_path:
        delete_storage_file(statement.attachment_path)
    db.delete(statement)
    db.flush()
    reconcile_user_candidate_status_after_delete(db, user, deleted_kind="statement")
    db.commit()
    return


@router.get("/statements/summary")
def admin_statements_summary(
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    total_unseen = db.scalar(
        select(func.count()).select_from(Statement).where(Statement.seen_at.is_(None))
    ) or 0
    has_unseen_stmt = select(Statement.id).where(
        Statement.user_id == User.id, Statement.seen_at.is_(None)
    ).exists()
    has_pending_stmt = select(Statement.id).where(
        Statement.user_id == User.id,
        Statement.seen_at.is_not(None),
        Statement.answered_at.is_(None),
    ).exists()
    has_any_stmt = select(Statement.id).where(
        Statement.user_id == User.id
    ).exists()
    unseen_users = int(db.scalar(
        select(func.count(User.id)).where(has_unseen_stmt)
    ) or 0)
    pending_users = int(db.scalar(
        select(func.count(User.id)).where(~has_unseen_stmt, has_pending_stmt)
    ) or 0)
    all_statement_users = int(db.scalar(
        select(func.count(User.id)).where(has_any_stmt)
    ) or 0)
    exam_histories = _compute_all_exam_histories(db)
    sync_all_user_candidates(db, exam_histories)
    exam_candidates = int(db.scalar(
        select(func.count(User.id)).where(User.candidate_status == "exam_candidate")
    ) or 0)
    cert_candidates = int(db.scalar(
        select(func.count(User.id)).where(User.candidate_status == "cert_candidate")
    ) or 0)
    pending_pass_users = sum(
        1
        for h in exam_histories.values()
        if h["latest_outcome"].get("unacknowledged")
        and h["latest_outcome"].get("outcome") in ("pass_bc", "pass_a")
    )
    pending_fail_users = sum(
        1
        for h in exam_histories.values()
        if h["latest_outcome"].get("unacknowledged")
        and h["latest_outcome"].get("outcome") == "fail"
    )
    return {
        "has_unseen": total_unseen > 0,
        "unseen_total": total_unseen,
        "unseen_users": unseen_users,
        "pending_users": pending_users,
        "all_statement_users": all_statement_users,
        "pending_pass_users": pending_pass_users,
        "pending_fail_users": pending_fail_users,
        "exam_candidates": exam_candidates,
        "cert_candidates": cert_candidates,
    }


@router.post("/statements/mark-seen", status_code=status.HTTP_204_NO_CONTENT)
def admin_mark_statements_seen(
    payload: StatementSeenRequest,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    actor_email = _get_actor_email(authorization, db) or "admin"
    statement_ids = [sid for sid in payload.statement_ids if isinstance(sid, int)]
    if not statement_ids:
        return
    now = datetime.utcnow()
    db.execute(
        Statement.__table__.update()
        .where(Statement.id.in_(statement_ids), Statement.seen_at.is_(None))
        .values(seen_at=now, seen_by=actor_email)
    )
    db.commit()
    return


# ================= User Photo endpoints =================

ALLOWED_PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
ALLOWED_PHOTO_MIME_TYPES = {"image/jpeg", "image/png", "image/webp"}
PHOTO_UPLOAD_MAX_BYTES = DEFAULT_UPLOAD_MAX_BYTES


def _delete_user_photo_file(user: User) -> None:
    """Delete user photo file from disk if exists."""
    if user.photo_path:
        try:
            delete_storage_file(user.photo_path)
        except Exception:
            pass
    user.photo_path = None
    user.photo_filename = None


@router.post("/users/{user_id}/photo")
async def admin_upload_user_photo(
    user_id: int,
    file: UploadFile = File(...),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """Upload or replace user profile photo."""
    _require_admin(db, authorization)

    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    # Validate file extension
    original_filename = file.filename or "photo.jpg"
    ext = Path(original_filename).suffix.lower()
    if ext not in ALLOWED_PHOTO_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid file type. Allowed: {', '.join(ALLOWED_PHOTO_EXTENSIONS)}"
        )

    # Validate content type
    content_type = (file.content_type or "").lower()
    if content_type and content_type not in ALLOWED_PHOTO_MIME_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid content type"
        )

    # Generate unique filename
    unique_code = str(uuid.uuid4())[:12]
    new_filename = f"{unique_code}{ext}"

    # Save file
    previous_photo_path = user.photo_path
    file_path = None
    try:
        media_root = ensure_media_root()
        photos_dir = media_root / "photos"
        photos_dir.mkdir(parents=True, exist_ok=True)
        file_path = photos_dir / new_filename

        await save_async_upload(
            file,
            file_path,
            max_bytes=PHOTO_UPLOAD_MAX_BYTES,
        )

        # Store relative path
        user.photo_path = f"photos/{new_filename}"
        user.photo_filename = original_filename
        db.add(user)
        db.commit()
    except UploadTooLarge as exc:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="file too large (max 100MB)",
        ) from exc
    except Exception as exc:
        try:
            db.rollback()
        except Exception:
            pass
        if file_path is not None:
            try:
                file_path.unlink(missing_ok=True)
            except OSError:
                pass
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to save photo"
        ) from exc

    if previous_photo_path and previous_photo_path != user.photo_path:
        delete_storage_file(previous_photo_path)

    return {
        "photo_url": f"/admin/users/{user_id}/photo/file",
        "photo_filename": original_filename,
    }


@router.get("/users/{user_id}/photo/file")
def admin_get_user_photo(
    user_id: int,
    authorization: str | None = Header(None, alias="Authorization"),
    actor: str | None = Query(None, alias="actor"),
    db: Session = Depends(get_db),
):
    """Get user photo file."""
    _require_admin(db, authorization)

    user = db.get(User, user_id)
    if not user or not user.photo_path:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Photo not found")

    try:
        path = resolve_storage_path(user.photo_path)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Photo not found")

    if not path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Photo file missing")

    # Determine content type from extension
    ext = path.suffix.lower()
    content_type_map = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
    }
    content_type = content_type_map.get(ext, "image/jpeg")

    return FileResponse(
        path,
        media_type=content_type,
        filename=user.photo_filename or path.name,
    )


@router.delete("/users/{user_id}/photo", status_code=status.HTTP_204_NO_CONTENT)
def admin_delete_user_photo(
    user_id: int,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """Delete user profile photo."""
    _require_admin(db, authorization)

    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    _delete_user_photo_file(user)
    db.add(user)
    db.commit()
    return
