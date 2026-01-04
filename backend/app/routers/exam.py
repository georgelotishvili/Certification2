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
from sqlalchemy.orm import Session

from ..config import get_settings
from ..database import get_db
from ..models import Answer, Block, Exam, ExamMedia, Option, Question, Session as ExamSession, User
from ..schemas import (
    AnswerRequest,
    AnswerResponse,
    ExamConfigResponse,
    MediaUploadResponse,
    ExamGateVerifyRequest,
    ExamGateVerifyResponse,
    OptionOut,
    QuestionOut,
    QuestionsResponse,
    StartSessionRequest,
    StartSessionResponse,
)
from ..services.media_storage import (
    relative_storage_path,
    resolve_storage_path,
    write_chunk,
    ensure_file_path,
)


router = APIRouter()

MEDIA_TYPES = {"camera", "screen"}


@router.post("/gate/verify", response_model=ExamGateVerifyResponse)
def verify_gate_password(payload: ExamGateVerifyRequest, db: Session = Depends(get_db)):
    exam = db.get(Exam, payload.exam_id)
    if not exam:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Exam not found")
    valid = bool(exam.gate_password) and exam.gate_password == payload.password
    return ExamGateVerifyResponse(valid=valid)


@router.post("/session/start", response_model=StartSessionResponse)
def start_session(payload: StartSessionRequest, db: Session = Depends(get_db)):
    exam = db.get(Exam, payload.exam_id)
    if not exam:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Exam not found")
    now = datetime.now(timezone.utc)
    ends_at = now + timedelta(minutes=exam.duration_minutes)
    token = f"sess_{now.timestamp()}_{random.randint(1000,9999)}"
    session = ExamSession(
        exam_id=exam.id,
        token=token,
        started_at=now,
        ends_at=ends_at,
        active=True,
        candidate_first_name=payload.candidate_first_name,
        candidate_last_name=payload.candidate_last_name,
        candidate_code=payload.candidate_code,
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
    )


def _revoke_exam_permission_for_session_candidate(db: Session, session: ExamSession) -> bool:
    """
    Disable exam permission for the user referenced by session candidate_code.
    Returns True when a change occurs.
    """
    code = (session.candidate_code or "").strip()
    if not code:
        return False

    user = db.scalar(select(User).where(User.code == code))
    if not user:
        return False

    settings = get_settings()
    founder_email = (settings.founder_admin_email or "").lower()
    is_founder = (user.email or "").lower() == founder_email
    if is_founder or user.is_admin:
        return False

    if not user.exam_permission:
        return False

    user.exam_permission = False
    db.add(user)
    return True



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


@router.post("/{session_id}/consume-permission", status_code=status.HTTP_204_NO_CONTENT)
def consume_exam_permission(
    session_id: int = Path(...),
    authorization: Optional[str] = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """
    Allows an active exam session to mark its exam permission as used.
    """
    session = _get_session_or_401(session_id, db, authorization)
    _revoke_exam_permission_for_session_candidate(db, session)
    db.commit()
    return


@router.get("/{exam_id}/config", response_model=ExamConfigResponse)
def get_exam_config(exam_id: int = Path(...), db: Session = Depends(get_db)):
    exam = db.get(Exam, exam_id)
    if not exam:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Exam not found")

    blocks_stmt = select(Block).where(Block.exam_id == exam.id, Block.enabled == True).order_by(Block.order_index)  # noqa: E712
    blocks = db.scalars(blocks_stmt).all()
    return ExamConfigResponse(
        exam_id=exam.id,
        title=exam.title,
        duration_minutes=exam.duration_minutes,
        blocks=blocks,
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

    block = db.get(Block, block_id)
    if not block or block.exam_id != session.exam_id or not block.enabled:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Block not found")

    # Load or generate selected map
    selected_map: Dict[str, List[int]] = {}
    if session.selected_map:
        try:
            selected_map = json.loads(session.selected_map)
        except Exception:
            selected_map = {}

    key = str(block.id)
    if key not in selected_map:
        q_stmt = (
            select(Question)
            .where(Question.block_id == block.id, Question.enabled == True)  # noqa: E712
            .order_by(Question.order_index)
        )
        all_questions = db.scalars(q_stmt).all()
        if not all_questions:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No questions in block")
        choose_n = min(block.qty, len(all_questions))
        selected = random.sample(all_questions, k=choose_n)
        # shuffle for maximum randomness (both selection and order)
        random.shuffle(selected)
        selected_map[key] = [q.id for q in selected]
        session.selected_map = json.dumps(selected_map)
        db.add(session)
        db.commit()
        db.refresh(session)

    selected_ids = selected_map[key]
    q_stmt2 = (
        select(Question)
        .where(Question.id.in_(selected_ids))
    )
    questions_unsorted = db.scalars(q_stmt2).all()
    # Preserve the shuffled order from selected_ids
    id_to_question = {q.id: q for q in questions_unsorted}
    questions = [id_to_question[qid] for qid in selected_ids if qid in id_to_question]

    # Eager load options without correctness flag
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

    return QuestionsResponse(
        block_id=block.id,
        block_title=block.title,
        qty=block.qty,
        questions=out_questions,
    )


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
    now = datetime.utcnow()
    if not session.active or session.ends_at <= now:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Session inactive or expired")

    # Ensure question is part of selected set
    if not session.selected_map:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Questions not initialized")
    selected_map: Dict[str, List[int]] = json.loads(session.selected_map)
    allowed_qids = {qid for ids in selected_map.values() for qid in ids}
    if payload.question_id not in allowed_qids:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Question not allowed in this session")

    # Prevent multiple answers per question
    existing_stmt = select(Answer).where(
        Answer.session_id == session.id,
        Answer.question_id == payload.question_id,
    )
    existing = db.scalars(existing_stmt).first()
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Question already answered")

    # Validate option belongs to question
    opt = db.get(Option, payload.option_id)
    if not opt:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Option not found")
    if opt.question_id != payload.question_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Option does not belong to question")

    is_correct = bool(getattr(opt, "is_correct", False))
    ans = Answer(
        session_id=session.id,
        question_id=payload.question_id,
        option_id=payload.option_id,
        is_correct=is_correct,
    )
    db.add(ans)
    db.commit()
    return AnswerResponse(correct=is_correct)


@router.post("/{session_id}/finish")
def finish_exam(
    session_id: int = Path(...),
    authorization: Optional[str] = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    session = _get_session_or_401(session_id, db, authorization)
    now = datetime.utcnow()
    if not session.active:
        # idempotent
        session.active = False
    session.finished_at = now

    # Count
    selected_map: Dict[str, List[int]] = json.loads(session.selected_map or "{}")
    selected_qids = [qid for ids in selected_map.values() for qid in ids]
    total_questions = len(selected_qids)

    ans_stmt = select(Answer).where(Answer.session_id == session.id)
    answers = db.scalars(ans_stmt).all()
    answered = len(answers)
    correct = sum(1 for a in answers if a.is_correct)
    score_percent = float(correct) / total_questions * 100.0 if total_questions else 0.0

    # Build per-block stats
    block_stats: List[dict] = []
    for key, ids in selected_map.items():
        b_total = len(ids)
        if b_total == 0:
            block_stats.append({"block_id": int(key), "correct": 0, "total": 0, "percent": 0.0})
            continue
        ans_stmt_b = select(Answer).where(Answer.session_id == session.id, Answer.question_id.in_(ids))
        answers_b = db.scalars(ans_stmt_b).all()
        b_correct = sum(1 for a in answers_b if a.is_correct)
        b_pct = round((b_correct / b_total) * 100.0, 2)
        block_stats.append({"block_id": int(key), "correct": b_correct, "total": b_total, "percent": b_pct})

    session.active = False
    session.score_percent = round(score_percent, 2)
    session.block_stats = json.dumps(block_stats)
    db.add(session)
    _revoke_exam_permission_for_session_candidate(db, session)
    db.commit()

    return {
        "total_questions": total_questions,
        "answered": answered,
        "correct": correct,
        "score_percent": session.score_percent,
        "block_stats": block_stats,
    }


