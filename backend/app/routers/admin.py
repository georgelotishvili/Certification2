from __future__ import annotations

from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, status, Path as FPath, Response, Query, UploadFile, File
from fastapi.responses import FileResponse
import uuid
from sqlalchemy import func, select, or_, delete
from sqlalchemy.orm import Session, selectinload

from ..config import get_settings
from ..database import get_db
from ..models import Block, ExamMedia, Question, Session as ExamSession, Answer, Option, Question as Q, User, Exam, Statement, Certificate, ExpertUpload, UserSession, _generate_gate_password
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
    AdminUserUpdateRequest,
    AdminStatementsResponse,
    AdminStatementOut,
    StatementSeenRequest,
)
from ..services.media_storage import resolve_storage_path, ensure_media_root, delete_storage_file


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
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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

    for block_index, block_payload in enumerate(payload.blocks or [], start=1):
        questions_payload = block_payload.questions or []
        qty = max(0, min(block_payload.qty, len(questions_payload)))

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
    personal_id_value: str | None = None
    if s.candidate_code:
        personal_id_value = db.scalar(
            select(User.personal_id)
            .where(func.lower(User.code) == func.lower(s.candidate_code))
            .limit(1)
        )

    exam_title: str | None = None
    if s.exam_id:
        exam = db.get(Exam, s.exam_id)
        if exam:
            exam_title = exam.title

    answers = db.scalars(select(Answer).where(Answer.session_id == s.id)).all()
    answer_by_question = {ans.question_id: ans for ans in answers}

    import json as _json

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

@router.get("/users", response_model=UsersListResponse)
def admin_users(
    page: int = 1,
    size: int = 1000000,
    search: str | None = None,
    only_admins: bool = False,
    sort: str = "date_desc",  # date_desc|date_asc|name_asc|name_desc
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    settings = get_settings()

    stmt = select(User)
    if search:
        q = f"%{search.lower()}%"
        stmt = stmt.where(
            or_(
                User.first_name.ilike(q),
                User.last_name.ilike(q),
                User.email.ilike(q),
                User.phone.ilike(q),
                User.personal_id.ilike(q),
                User.code.ilike(q),
            )
        )
    if only_admins:
        stmt = stmt.where(User.is_admin == True)  # noqa: E712

    if sort == "date_asc":
        stmt = stmt.order_by(User.created_at.asc())
    elif sort == "name_asc":
        stmt = stmt.order_by(User.last_name.asc(), User.first_name.asc())
    elif sort == "name_desc":
        stmt = stmt.order_by(User.last_name.desc(), User.first_name.desc())
    else:
        stmt = stmt.order_by(User.created_at.desc())

    # Paging not used effectively (size very large) as per spec: show all
    stmt = stmt.options(selectinload(User.certificate))
    users = db.scalars(stmt).all()
    founder_email = (settings.founder_admin_email or "").lower()

    user_ids = [u.id for u in users]
    unseen_counts: dict[int, int] = {}
    if user_ids:
        stmt = (
            select(Statement.user_id, func.count())
            .where(
                Statement.user_id.in_(user_ids),
                Statement.seen_at.is_(None),
            )
            .group_by(Statement.user_id)
        )
        for user_id, count in db.execute(stmt):
            unseen_counts[int(user_id)] = int(count)

    items = []
    for u in users:
        unseen_count = unseen_counts.get(u.id, 0)
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
            exam_perm = bool(u.exam_permission)  # არა-ადმინებს რაც ბაზაშია
        
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
            'exam_permission': exam_perm,
            'created_at': u.created_at,
            'has_unseen_statements': unseen_count > 0,
            'unseen_statement_count': unseen_count,
            'photo_filename': u.photo_filename,
        }
        if cert_data:
            user_dict['certificate'] = cert_data
            user_dict['certificate_info'] = cert_data
        items.append(UserOut(**user_dict))
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

    u.is_admin = bool(payload.is_admin)
    # როცა ადმინი ხდება, exam_permission-იც ჩაირთოს
    # როცა ადმინი გაეთიშება, exam_permission-იც გაითიშოს
    if payload.is_admin:
        u.exam_permission = True
    else:
        u.exam_permission = False
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
    
    u.exam_permission = bool(payload.exam_permission)
    db.add(u)
    db.commit()
    return


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
            user.personal_id = personal_id
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

    return UserOut(
        id=user.id,
        personal_id=user.personal_id,
        first_name=user.first_name,
        last_name=user.last_name,
        phone=user.phone,
        email=user.email,
        code=user.code,
        is_admin=(user.email.lower() == founder_email) or bool(user.is_admin),
        is_founder=(user.email.lower() == founder_email),
        created_at=user.created_at,
        has_unseen_statements=unseen_count > 0,
        unseen_statement_count=unseen_count,
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

        # For expert certificates, also delete the expert directory if it exists
        # Check if this is an expert certificate with EX-... unique_code
        if cert.level and (cert.level.lower() == "expert") and cert.unique_code:
            unique_code = cert.unique_code.strip()
            # Check if unique_code matches EX-... pattern
            if unique_code.startswith("EX-"):
                try:
                    media_root = ensure_media_root()
                    expert_dir = media_root / "expert" / unique_code
                    if expert_dir.exists() and expert_dir.is_dir():
                        # Delete all certificate PDF files in the expert directory
                        # Look for files that start with "certificate" and end with ".pdf"
                        for pdf_file in expert_dir.glob("certificate*.pdf"):
                            try:
                                if pdf_file.is_file():
                                    pdf_file.unlink()
                            except OSError:
                                # Best-effort: continue if file deletion fails
                                pass
                        
                        # Try to remove the directory if it's now empty
                        try:
                            # Check if directory is empty (no files or only empty subdirectories)
                            if not any(expert_dir.iterdir()):
                                expert_dir.rmdir()
                            else:
                                # Directory still has files, try to remove empty subdirectories
                                for item in expert_dir.iterdir():
                                    if item.is_dir():
                                        try:
                                            if not any(item.iterdir()):
                                                item.rmdir()
                                        except OSError:
                                            pass
                                # Try to remove the directory again if it's now empty
                                try:
                                    if not any(expert_dir.iterdir()):
                                        expert_dir.rmdir()
                                except OSError:
                                    pass
                        except OSError:
                            # Directory not empty or other error, that's okay
                            pass
                except Exception:
                    # Best-effort: continue even if expert directory deletion fails
                    pass

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

            # For expert certificates, also delete the expert directory if it exists
            # Check if this is an expert certificate with EX-... unique_code
            if cert.level and (cert.level.lower() == "expert") and cert.unique_code:
                unique_code = cert.unique_code.strip()
                # Check if unique_code matches EX-... pattern
                if unique_code.startswith("EX-"):
                    try:
                        media_root = ensure_media_root()
                        expert_dir = media_root / "expert" / unique_code
                        if expert_dir.exists() and expert_dir.is_dir():
                            # Delete all certificate PDF files in the expert directory
                            # Look for files that start with "certificate" and end with ".pdf"
                            for pdf_file in expert_dir.glob("certificate*.pdf"):
                                try:
                                    if pdf_file.is_file():
                                        pdf_file.unlink()
                                except OSError:
                                    # Best-effort: continue if file deletion fails
                                    pass
                            
                            # Try to remove the directory if it's now empty
                            try:
                                # Check if directory is empty (no files or only empty subdirectories)
                                if not any(expert_dir.iterdir()):
                                    expert_dir.rmdir()
                                else:
                                    # Directory still has files, try to remove empty subdirectories
                                    for item in expert_dir.iterdir():
                                        if item.is_dir():
                                            try:
                                                if not any(item.iterdir()):
                                                    item.rmdir()
                                            except OSError:
                                                pass
                                    # Try to remove the directory again if it's now empty
                                    try:
                                        if not any(expert_dir.iterdir()):
                                            expert_dir.rmdir()
                                    except OSError:
                                        pass
                            except OSError:
                                # Directory not empty or other error, that's okay
                                pass
                    except Exception:
                        # Best-effort: continue even if expert directory deletion fails
                        pass
        
        db.delete(u)
    db.commit()
    return


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
        AdminStatementOut(
            id=statement.id,
            user_id=user.id,
            user_first_name=user.first_name,
            user_last_name=user.last_name,
            user_email=user.email,
            message=statement.message,
            created_at=statement.created_at,
            seen_at=statement.seen_at,
            seen_by=statement.seen_by,
            attachment_filename=statement.attachment_filename,
            attachment_size_bytes=statement.attachment_size_bytes,
        )
        for statement in statements
    ]
    return AdminStatementsResponse(items=items, total=len(items))


@router.delete("/statements/{statement_id}", status_code=status.HTTP_204_NO_CONTENT)
def admin_delete_statement(
    statement_id: int,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    if not _is_founder_actor(authorization, db):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only founder can delete statements")

    statement = db.get(Statement, statement_id)
    if not statement:
        return
    # Remove stored attachment if present
    if statement.attachment_path:
        delete_storage_file(statement.attachment_path)
    db.delete(statement)
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
    return {"has_unseen": total_unseen > 0, "unseen_total": total_unseen}


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
        .where(Statement.id.in_(statement_ids))
        .values(seen_at=now, seen_by=actor_email)
    )
    db.commit()
    return


# ================= User Photo endpoints =================

ALLOWED_PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
ALLOWED_PHOTO_MIME_TYPES = {"image/jpeg", "image/png", "image/webp"}


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

    # Delete old photo if exists
    _delete_user_photo_file(user)

    # Generate unique filename
    unique_code = str(uuid.uuid4())[:12]
    new_filename = f"{unique_code}{ext}"

    # Save file
    try:
        media_root = ensure_media_root()
        photos_dir = media_root / "photos"
        photos_dir.mkdir(parents=True, exist_ok=True)
        file_path = photos_dir / new_filename

        content = await file.read()
        file_path.write_bytes(content)

        # Store relative path
        user.photo_path = f"photos/{new_filename}"
        user.photo_filename = original_filename
        db.add(user)
        db.commit()

        return {
            "photo_url": f"/admin/users/{user_id}/photo/file",
            "photo_filename": original_filename,
        }
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to save photo"
        ) from exc


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