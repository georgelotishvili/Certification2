from __future__ import annotations

import asyncio
import contextlib
import json
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Optional

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession, selectinload

from ..database import SessionLocal
from ..models import Answer, Block, Exam, Option, Question, Session as ExamSession, User


SUBMISSION_GRACE_MINUTES = 5
AUTO_CLOSE_INTERVAL_SECONDS = 300


def utcnow() -> datetime:
    return datetime.utcnow()


def _naive_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def _iso(value: datetime | None) -> str | None:
    value = _naive_utc(value)
    if value is None:
        return None
    return value.replace(microsecond=0).isoformat() + "Z"


def submission_deadline(session: ExamSession) -> datetime:
    ends_at = _naive_utc(session.ends_at) or utcnow()
    return ends_at + timedelta(minutes=SUBMISSION_GRACE_MINUTES)


def _parse_selected_map(raw: str | None) -> OrderedDict[str, list[int]]:
    selected: OrderedDict[str, list[int]] = OrderedDict()
    if not raw:
        return selected
    try:
        payload = json.loads(raw)
    except Exception:
        return selected
    if not isinstance(payload, dict):
        return selected
    for key, value in payload.items():
        try:
            block_id = str(int(key))
        except (TypeError, ValueError):
            continue
        qids: list[int] = []
        for item in value or []:
            try:
                qids.append(int(item))
            except (TypeError, ValueError):
                continue
        selected[block_id] = qids
    return selected


def _percent(correct: int, total: int) -> float:
    return round((correct / total) * 100.0, 2) if total else 0.0


def _stats(total: int, answered: int, correct: int) -> dict[str, Any]:
    incorrect = max(0, answered - correct)
    return {
        "total": total,
        "answered": answered,
        "correct": correct,
        "incorrect": incorrect,
        "unanswered": max(0, total - answered),
        "percent": _percent(correct, total),
    }


def _sum_stats(items: Iterable[dict[str, Any]]) -> dict[str, Any]:
    items = list(items)
    total = sum(int(item.get("total", 0) or 0) for item in items)
    answered = sum(int(item.get("answered", 0) or 0) for item in items)
    correct = sum(int(item.get("correct", 0) or 0) for item in items)
    return _stats(total, answered, correct)


def _option_payload(option: Option, selected_option_id: int | None) -> dict[str, Any]:
    return {
        "id": option.id,
        "text": option.text,
        "is_correct": bool(option.is_correct),
        "is_selected": option.id == selected_option_id,
    }


def _compact_option(option: Option | None) -> dict[str, Any] | None:
    if not option:
        return None
    return {"id": option.id, "text": option.text}


def build_exam_snapshot(
    db: DbSession,
    session: ExamSession,
    *,
    finished_at: datetime | None = None,
    auto_closed: bool = False,
    auto_close_reason: str | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    finished_at = _naive_utc(finished_at) or utcnow()
    selected_map = _parse_selected_map(session.selected_map)

    selected_question_ids: list[int] = []
    for qids in selected_map.values():
        for qid in qids:
            if qid not in selected_question_ids:
                selected_question_ids.append(qid)

    answers = db.scalars(select(Answer).where(Answer.session_id == session.id)).all()
    answer_by_question = {answer.question_id: answer for answer in answers}
    for answer in answers:
        if answer.question_id not in selected_question_ids:
            selected_question_ids.append(answer.question_id)

    questions = (
        db.scalars(
            select(Question)
            .where(Question.id.in_(selected_question_ids))
            .options(selectinload(Question.options))
        ).all()
        if selected_question_ids
        else []
    )
    question_by_id = {question.id: question for question in questions}

    block_ids: list[int] = []
    for key in selected_map.keys():
        try:
            block_id = int(key)
        except (TypeError, ValueError):
            continue
        if block_id not in block_ids:
            block_ids.append(block_id)
    for question in questions:
        if question.block_id not in block_ids:
            block_ids.append(question.block_id)

    blocks = (
        db.scalars(
            select(Block)
            .where(Block.id.in_(block_ids))
            .options(selectinload(Block.chapter), selectinload(Block.subchapter))
        ).all()
        if block_ids
        else []
    )
    block_by_id = {block.id: block for block in blocks}

    exam = db.get(Exam, session.exam_id) if session.exam_id else None
    candidate_personal_id = session.user.personal_id if session.user else None
    if not candidate_personal_id and session.candidate_code:
        candidate_personal_id = db.scalar(
            select(User.personal_id).where(User.code == session.candidate_code).limit(1)
        )

    block_stats: list[dict[str, Any]] = []
    chapters: OrderedDict[int, dict[str, Any]] = OrderedDict()
    untagged_blocks: list[dict[str, Any]] = []

    for block_id in block_ids:
        block = block_by_id.get(block_id)
        block_question_ids = selected_map.get(str(block_id), [])
        if not block_question_ids:
            block_question_ids = [
                question.id for question in questions if question.block_id == block_id
            ]

        question_payloads: list[dict[str, Any]] = []
        answered = 0
        correct = 0
        for question_id in block_question_ids:
            question = question_by_id.get(question_id)
            if not question:
                continue
            answer = answer_by_question.get(question.id)
            selected_option_id = answer.option_id if answer else None
            options = sorted(question.options, key=lambda option: option.id)
            correct_option = next((option for option in options if option.is_correct), None)
            selected_option = next((option for option in options if option.id == selected_option_id), None)
            is_correct = bool(answer and answer.is_correct)
            if answer:
                answered += 1
                if is_correct:
                    correct += 1
            question_payloads.append(
                {
                    "id": question.id,
                    "code": question.code,
                    "text": question.text,
                    "selected_option": _compact_option(selected_option),
                    "correct_option": _compact_option(correct_option),
                    "selected_option_id": selected_option.id if selected_option else None,
                    "correct_option_id": correct_option.id if correct_option else None,
                    "is_correct": is_correct if answer else None,
                    "answered_at": _iso(answer.answered_at) if answer else None,
                    "options": [_option_payload(option, selected_option_id) for option in options],
                }
            )

        block_total = len(block_question_ids)
        block_stat = _stats(block_total, answered, correct)
        block_payload = {
            "id": block_id,
            "title": block.title if block else None,
            "order_index": block.order_index if block else None,
            "chapter_id": block.chapter_id if block else None,
            "chapter_name": block.chapter.name if block and block.chapter else None,
            "subchapter_id": block.subchapter_id if block else None,
            "subchapter_name": block.subchapter.name if block and block.subchapter else None,
            "stats": block_stat,
            "questions": question_payloads,
        }
        block_stats.append(
            {
                "block_id": block_id,
                "correct": block_stat["correct"],
                "total": block_stat["total"],
                "percent": block_stat["percent"],
            }
        )

        if block and block.chapter_id and block.subchapter_id and block.chapter and block.subchapter:
            chapter = chapters.setdefault(
                block.chapter_id,
                {
                    "id": block.chapter_id,
                    "name": block.chapter.name,
                    "order_index": block.chapter.order_index,
                    "stats": {},
                    "subchapters": OrderedDict(),
                },
            )
            subchapters = chapter["subchapters"]
            subchapter = subchapters.setdefault(
                block.subchapter_id,
                {
                    "id": block.subchapter_id,
                    "name": block.subchapter.name,
                    "order_index": block.subchapter.order_index,
                    "stats": {},
                    "blocks": [],
                },
            )
            subchapter["blocks"].append(block_payload)
        else:
            untagged_blocks.append(block_payload)

    chapter_payloads: list[dict[str, Any]] = []
    for chapter in chapters.values():
        subchapter_payloads: list[dict[str, Any]] = []
        for subchapter in chapter["subchapters"].values():
            subchapter["stats"] = _sum_stats(block["stats"] for block in subchapter["blocks"])
            subchapter_payloads.append(subchapter)
        subchapter_payloads.sort(key=lambda item: ((item.get("order_index") or 0), item.get("id") or 0))
        chapter["subchapters"] = subchapter_payloads
        chapter["stats"] = _sum_stats(item["stats"] for item in subchapter_payloads)
        chapter_payloads.append(chapter)

    chapter_payloads.sort(key=lambda item: ((item.get("order_index") or 0), item.get("id") or 0))
    untagged_blocks.sort(key=lambda item: ((item.get("order_index") or 0), item.get("id") or 0))

    all_block_stats = [block["stats"] for chapter in chapter_payloads for sub in chapter["subchapters"] for block in sub["blocks"]]
    all_block_stats.extend(block["stats"] for block in untagged_blocks)
    summary = _sum_stats(all_block_stats)

    snapshot = {
        "version": 1,
        "status": "auto_closed" if auto_closed else "completed",
        "auto_closed": auto_closed,
        "auto_closed_no_submission": bool(auto_closed and summary["answered"] == 0),
        "auto_close_reason": auto_close_reason,
        "generated_at": _iso(utcnow()),
        "exam": {
            "id": exam.id if exam else session.exam_id,
            "title": exam.title if exam else None,
            "duration_minutes": exam.duration_minutes if exam else None,
        },
        "session": {
            "id": session.id,
            "started_at": _iso(session.started_at),
            "ends_at": _iso(session.ends_at),
            "finished_at": _iso(finished_at),
        },
        "candidate": {
            "first_name": session.candidate_first_name,
            "last_name": session.candidate_last_name,
            "code": session.candidate_code,
            "personal_id": candidate_personal_id,
        },
        "summary": summary,
        "chapters": chapter_payloads,
        "untagged_blocks": untagged_blocks,
        "block_stats": block_stats,
    }
    return snapshot, block_stats


def finish_response_from_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    summary = snapshot.get("summary") or {}
    return {
        "total_questions": int(summary.get("total", 0) or 0),
        "answered": int(summary.get("answered", 0) or 0),
        "correct": int(summary.get("correct", 0) or 0),
        "score_percent": float(summary.get("percent", 0.0) or 0.0),
        "block_stats": snapshot.get("block_stats") or [],
    }


def finish_response_from_session(session: ExamSession) -> dict[str, Any] | None:
    if not session.exam_snapshot:
        return None
    try:
        snapshot = json.loads(session.exam_snapshot)
    except Exception:
        return None
    if not isinstance(snapshot, dict):
        return None
    return finish_response_from_snapshot(snapshot)


def finalize_exam_session(
    db: DbSession,
    session: ExamSession,
    *,
    finished_at: datetime | None = None,
    auto_closed: bool = False,
    auto_close_reason: str | None = None,
    revoke_permission: bool = False,
) -> dict[str, Any]:
    finished_at = _naive_utc(finished_at) or utcnow()
    snapshot, block_stats = build_exam_snapshot(
        db,
        session,
        finished_at=finished_at,
        auto_closed=auto_closed,
        auto_close_reason=auto_close_reason,
    )
    response = finish_response_from_snapshot(snapshot)
    session.finished_at = finished_at
    session.active = False
    session.score_percent = response["score_percent"]
    session.block_stats = json.dumps(block_stats, ensure_ascii=False)
    session.exam_snapshot = json.dumps(snapshot, ensure_ascii=False)

    if revoke_permission:
        code = (session.candidate_code or "").strip()
        if code:
            user = db.scalar(select(User).where(User.code == code))
            if user and not user.is_admin and user.exam_permission:
                user.exam_permission = False
                db.add(user)

    db.add(session)
    return response


def ensure_submission_window(session: ExamSession, *, now: datetime | None = None) -> None:
    now = _naive_utc(now) or utcnow()
    if not session.active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Session inactive or expired")
    if now > submission_deadline(session):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Session inactive or expired")


def auto_close_session_if_expired(
    db: DbSession,
    session: ExamSession,
    *,
    now: datetime | None = None,
) -> bool:
    now = _naive_utc(now) or utcnow()
    if not session.active or session.finished_at:
        return False
    if now <= submission_deadline(session):
        return False
    finalize_exam_session(
        db,
        session,
        finished_at=submission_deadline(session),
        auto_closed=True,
        auto_close_reason="submission_grace_expired",
        revoke_permission=False,
    )
    return True


def auto_close_expired_sessions(db: DbSession, *, now: datetime | None = None) -> int:
    now = _naive_utc(now) or utcnow()
    cutoff = now - timedelta(minutes=SUBMISSION_GRACE_MINUTES)
    sessions = db.scalars(
        select(ExamSession).where(
            ExamSession.active == True,  # noqa: E712
            ExamSession.finished_at.is_(None),
            ExamSession.ends_at < cutoff,
        )
    ).all()
    closed = 0
    for session in sessions:
        if auto_close_session_if_expired(db, session, now=now):
            closed += 1
    if closed:
        db.commit()
    return closed


async def _watch_expired_sessions() -> None:
    while True:
        await asyncio.sleep(AUTO_CLOSE_INTERVAL_SECONDS)
        with SessionLocal() as db:
            auto_close_expired_sessions(db)


def register_expired_session_tasks(app: Any) -> None:
    @app.on_event("startup")
    async def _startup_auto_close_expired_sessions() -> None:
        with SessionLocal() as db:
            auto_close_expired_sessions(db)
        app.state.expired_session_task = asyncio.create_task(_watch_expired_sessions())

    @app.on_event("shutdown")
    async def _shutdown_auto_close_expired_sessions() -> None:
        task = getattr(app.state, "expired_session_task", None)
        if task:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
