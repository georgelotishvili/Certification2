"""Server-only grading versions. Correctness is never sent at authorization."""
from __future__ import annotations

import json

from fastapi import HTTPException
from sqlalchemy import select, update

from ..models import Exam, OfflineExamAttempt, OfflineExamContent, PreparedExamMaterial, Session as ExamSession


def lock_exam_content(db, exam_id):
    db.execute(update(Exam).where(Exam.id == exam_id).values(title=Exam.title)
               .execution_options(synchronize_session=False))


def lock_project_content(db, model, project_id):
    db.execute(update(model).where(model.id == project_id).values(code=model.code)
               .execution_options(synchronize_session=False))


def get_prepared_theory_material(db, session_id: int) -> PreparedExamMaterial | None:
    return db.scalar(
        select(PreparedExamMaterial).where(PreparedExamMaterial.session_id == session_id)
    )


def prepare_theory_content(db, session) -> dict:
    existing = get_prepared_theory_material(db, session.id)
    if existing is not None:
        return json.loads(existing.snapshot)
    from .exam_lifecycle import build_exam_snapshot
    lock_exam_content(db, session.exam_id)
    snapshot, _ = build_exam_snapshot(db, session, finished_at=session.started_at)
    selected = {qid for ids in json.loads(session.selected_map or "{}").values() for qid in ids}
    captured = {question["id"] for block in theory_blocks(snapshot) for question in block["questions"]}
    if not selected or selected != captured:
        raise HTTPException(409, "Prepared exam content changed; download the materials again")
    row = PreparedExamMaterial(
        user_id=session.user_id,
        stage="theory",
        session_id=session.id,
        stage_grant_id=None,
        snapshot=json.dumps(snapshot, ensure_ascii=False),
    )
    db.add(row)
    db.flush()
    return snapshot


def get_prepared_project_material(db, user_id: int, stage: str, stage_grant_id: int | None) -> PreparedExamMaterial | None:
    if stage_grant_id is not None:
        return db.scalar(
            select(PreparedExamMaterial).where(PreparedExamMaterial.stage_grant_id == stage_grant_id)
        )
    return db.scalar(
        select(PreparedExamMaterial).where(
            PreparedExamMaterial.user_id == user_id,
            PreparedExamMaterial.stage == stage,
            PreparedExamMaterial.stage_grant_id.is_(None),
        )
    )


def prepare_project_content(db, user_id: int, stage: str, stage_grant_id: int | None, project) -> dict:
    if stage_grant_id is not None:
        existing = get_prepared_project_material(db, user_id, stage, stage_grant_id)
        if existing is not None:
            return json.loads(existing.snapshot)
    snapshot = {
        "version": 1,
        "stage": stage,
        "project_id": project.id,
        "code": project.code,
        "number": project.number,
        "answers": [
            {"id": answer.id, "text": answer.text, "is_correct": bool(answer.is_correct)}
            for answer in sorted(project.answers, key=lambda item: (item.order_index, item.id))
        ],
    }
    raw = json.dumps(snapshot, ensure_ascii=False)
    if stage_grant_id is None:
        existing = get_prepared_project_material(db, user_id, stage, None)
        if existing is not None:
            existing.project_id = project.id
            existing.project_code = project.code
            existing.snapshot = raw
            db.add(existing)
            db.flush()
            return snapshot
    row = PreparedExamMaterial(
        user_id=user_id,
        stage=stage,
        session_id=None,
        stage_grant_id=stage_grant_id,
        project_id=project.id,
        project_code=project.code,
        snapshot=raw,
    )
    db.add(row)
    db.flush()
    return snapshot


def grade_project_snapshot_data(snapshot: dict, selected_ids) -> tuple[float, int, int, int]:
    allowed = {answer["id"] for answer in snapshot["answers"]}
    selected = set(selected_ids)
    if len(selected) != len(selected_ids) or not selected <= allowed:
        raise HTTPException(400, "Unknown or duplicate answer in offline final")
    correct = {answer["id"] for answer in snapshot["answers"] if answer["is_correct"]}
    count = len(selected & correct)
    return (round(count / len(correct) * 100, 2) if correct else 0,
            count, len(selected - correct), len(correct))


def capture_theory_content(db, attempt, session):
    from .exam_lifecycle import _iso, build_exam_snapshot
    lock_exam_content(db, session.exam_id)
    prepared = get_prepared_theory_material(db, session.id)
    if prepared is not None:
        snapshot = json.loads(prepared.snapshot)
        if isinstance(snapshot.get("session"), dict):
            snapshot["session"]["started_at"] = _iso(attempt.started_at)
            snapshot["session"]["ends_at"] = _iso(attempt.ends_at)
    else:
        snapshot, _ = build_exam_snapshot(db, session, finished_at=attempt.started_at)
    selected = {qid for ids in json.loads(session.selected_map or "{}").values() for qid in ids}
    captured = {question["id"] for block in theory_blocks(snapshot) for question in block["questions"]}
    if not selected or selected != captured:
        raise HTTPException(409, "Prepared exam content changed; download the materials again")
    db.add(OfflineExamContent(attempt_id=attempt.id, snapshot=json.dumps(snapshot, ensure_ascii=False)))


def capture_project_content(db, attempt, project, prepared_snapshot: str | None = None):
    if prepared_snapshot is not None:
        db.add(OfflineExamContent(attempt_id=attempt.id, snapshot=prepared_snapshot))
        return
    snapshot = {"version": 1, "stage": attempt.stage, "project_id": project.id,
                "code": project.code, "number": project.number,
                "answers": [{"id": answer.id, "text": answer.text, "is_correct": bool(answer.is_correct)}
                            for answer in sorted(project.answers, key=lambda item: (item.order_index, item.id))]}
    db.add(OfflineExamContent(attempt_id=attempt.id, snapshot=json.dumps(snapshot, ensure_ascii=False)))


def content_for_attempt(db, attempt):
    content = db.get(OfflineExamContent, attempt.id)
    if content is None:
        # Never silently grade an authorized offline exam against a new live key.
        raise HTTPException(409, "The original offline grading snapshot is unavailable")
    return json.loads(content.snapshot)


def theory_blocks(snapshot):
    return [block for chapter in snapshot.get("chapters", [])
            for subchapter in chapter["subchapters"] for block in subchapter["blocks"]] + snapshot.get("untagged_blocks", [])


def grade_theory_snapshot(db, attempt, answers, finished_at):
    from .exam_lifecycle import _iso, _stats, _sum_stats, utcnow
    snapshot = content_for_attempt(db, attempt)
    blocks = theory_blocks(snapshot)
    questions = {question["id"]: question for block in blocks for question in block["questions"]}
    supplied = {}
    for answer in answers:
        question = questions.get(answer.question_id)
        if question is None or answer.question_id in supplied:
            raise HTTPException(400, "Unknown or duplicate question in offline final")
        if not any(option["id"] == answer.option_id for option in question["options"]):
            raise HTTPException(400, "Option does not belong to the original selected question")
        supplied[answer.question_id] = answer.option_id
    block_stats = []
    correctness = {}
    for block in blocks:
        answered = correct = 0
        for question in block["questions"]:
            option_id = supplied.get(question["id"])
            selected = next((item for item in question["options"] if item["id"] == option_id), None)
            is_correct = bool(selected and selected["is_correct"])
            question.update(selected_option_id=option_id,
                            selected_option={"id": selected["id"], "text": selected["text"]} if selected else None,
                            is_correct=is_correct if selected else None,
                            answered_at=_iso(finished_at) if selected else None)
            for option in question["options"]:
                option["is_selected"] = option["id"] == option_id
            answered += int(selected is not None)
            correct += int(is_correct)
            correctness[question["id"]] = is_correct
        block["stats"] = _stats(len(block["questions"]), answered, correct)
        block_stats.append({"block_id": block["id"], "correct": correct,
                            "total": len(block["questions"]), "percent": block["stats"]["percent"]})
    for chapter in snapshot.get("chapters", []):
        for subchapter in chapter["subchapters"]:
            subchapter["stats"] = _sum_stats(block["stats"] for block in subchapter["blocks"])
        chapter["stats"] = _sum_stats(subchapter["stats"] for subchapter in chapter["subchapters"])
    snapshot.update(summary=_sum_stats(block["stats"] for block in blocks), block_stats=block_stats,
                    status="completed", auto_closed=False, auto_closed_no_submission=False,
                    auto_close_reason=None, generated_at=_iso(utcnow()))
    snapshot["session"]["finished_at"] = _iso(finished_at)
    return snapshot, correctness


def grade_project_snapshot(db, attempt, selected_ids):
    snapshot = content_for_attempt(db, attempt)
    allowed = {answer["id"] for answer in snapshot["answers"]}
    selected = set(selected_ids)
    if len(selected) != len(selected_ids) or not selected <= allowed:
        raise HTTPException(400, "Unknown or duplicate answer in offline final")
    correct = {answer["id"] for answer in snapshot["answers"] if answer["is_correct"]}
    count = len(selected & correct)
    return (round(count / len(correct) * 100, 2) if correct else 0,
            count, len(selected - correct), len(correct))


def bind_evaluation_snapshot(db, attempt, evaluation_id):
    content = db.get(OfflineExamContent, attempt.id)
    if content is None:
        raise HTTPException(409, "The original offline grading snapshot is unavailable")
    content.evaluation_id = evaluation_id
    db.add(content)


def project_report_answers(db, stage, evaluation):
    content = db.scalar(select(OfflineExamContent).join(OfflineExamAttempt)
                        .where(OfflineExamAttempt.stage == stage,
                               OfflineExamAttempt.user_id == evaluation.user_id,
                               OfflineExamContent.evaluation_id == evaluation.id))
    return json.loads(content.snapshot)["answers"] if content else None


def guard_pending_project_delete(db, model, stage, project_id):
    lock_project_content(db, model, project_id)
    pending = db.scalar(select(OfflineExamAttempt.id).where(
        OfflineExamAttempt.stage == stage, OfflineExamAttempt.project_id == project_id,
        OfflineExamAttempt.submitted_at.is_(None)))
    if pending is not None:
        raise HTTPException(409, "This project has an offline attempt awaiting its final upload")
    # Whole-project deletion cascades its results. Do not let a subsequently
    # reused SQLite result ID pick up a deleted result's historical template.
    for content in db.scalars(select(OfflineExamContent).join(OfflineExamAttempt).where(
        OfflineExamAttempt.stage == stage, OfflineExamAttempt.project_id == project_id)):
        content.evaluation_id = None
        db.add(content)


def detach_evaluation_snapshot(db, stage, evaluation):
    for content in db.scalars(select(OfflineExamContent).join(OfflineExamAttempt).where(
        OfflineExamAttempt.stage == stage, OfflineExamAttempt.user_id == evaluation.user_id,
        OfflineExamContent.evaluation_id == evaluation.id)):
        content.evaluation_id = None
        db.add(content)


def guard_pending_session_delete(db, session_id):
    db.execute(update(ExamSession).where(ExamSession.id == session_id).values(token=ExamSession.token)
               .execution_options(synchronize_session=False))
    pending = db.scalar(select(OfflineExamAttempt.id).where(
        OfflineExamAttempt.session_id == session_id, OfflineExamAttempt.submitted_at.is_(None)))
    if pending is not None:
        raise HTTPException(409, "This exam attempt is awaiting its offline final upload")
