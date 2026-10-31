"""Server-only grading versions. Correctness is never sent at authorization."""
from __future__ import annotations

from datetime import datetime
import hashlib
import json
from pathlib import Path
import random
import shutil
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import select, update

from ..models import (
    Answer,
    Block,
    Exam,
    MultiApartmentEvaluation,
    MultiFunctionalEvaluation,
    OfflineExamAttempt,
    OfflineExamContent,
    Option,
    PreparedExamMaterial,
    Question,
    Session as ExamSession,
    UserExamStageGrant,
)
from . import media_storage
from .exam_stage import STAGE_PROJECT_1


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


def _snapshot_project_pdf(project) -> dict:
    pdf_rel = getattr(project, "pdf_path", None)
    pdf_filename = getattr(project, "pdf_filename", None)
    if not pdf_rel:
        return {}
    try:
        src_path = media_storage.resolve_storage_path(pdf_rel)
        if not src_path.is_file():
            return {}
        stat = src_path.stat()
        digest_hasher = hashlib.sha256()
        with src_path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(65536), b""):
                digest_hasher.update(chunk)
        sha256 = digest_hasher.hexdigest()
        pdf_version = f"{stat.st_mtime_ns}_{stat.st_size}_{sha256[:12]}"
        dest_dir = (media_storage.ensure_media_root().resolve() / "prepared_pdfs").resolve()
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest_path = dest_dir / f"{sha256}.pdf"
        if not dest_path.is_file() or dest_path.stat().st_size != stat.st_size:
            tmp_path = dest_dir / f"{sha256}.{uuid4().hex}.tmp"
            try:
                shutil.copyfile(src_path, tmp_path)
                tmp_path.replace(dest_path)
            finally:
                tmp_path.unlink(missing_ok=True)
        return {
            "pdf_storage_path": media_storage.relative_storage_path(dest_path),
            "pdf_filename": pdf_filename or "project.pdf",
            "pdf_version": pdf_version,
            "pdf_sha256": sha256,
        }
    except Exception:
        return {}


def _is_prepared_row_active(db, stage: str, row: PreparedExamMaterial) -> bool:
    if row.stage_grant_id is not None:
        grant = db.get(UserExamStageGrant, row.stage_grant_id)
        return (
            grant is not None
            and grant.consumed_at is None
            and grant.revoked_at is None
            and grant.expired_at is None
        )
    eval_model = (
        MultiApartmentEvaluation
        if stage == STAGE_PROJECT_1
        else MultiFunctionalEvaluation
    )
    if row.user_id is not None and row.project_id is not None and row.prepared_at is not None:
        done = db.scalar(
            select(eval_model.id).where(
                eval_model.user_id == row.user_id,
                eval_model.project_id == row.project_id,
                eval_model.created_at >= row.prepared_at,
            )
        )
        return done is None
    return True


def resolve_prepared_project_pdf(
    db,
    stage: str,
    code: str,
    version: str | None = None,
    user_id: int | None = None,
    allow_historical_fallback: bool = False,
) -> tuple[Path, str | None] | None:
    clean_code = (code or "").strip()
    if not clean_code:
        return None
    stmt = (
        select(PreparedExamMaterial)
        .where(
            PreparedExamMaterial.stage == stage,
            PreparedExamMaterial.project_code == clean_code,
        )
        .order_by(PreparedExamMaterial.id.desc())
    )
    rows = list(db.scalars(stmt).all())
    if not rows:
        return None
    if user_id is not None:
        rows.sort(key=lambda r: (0 if r.user_id == user_id else 1, -r.id))

    def _extract_valid_pdf(row: PreparedExamMaterial) -> tuple[Path, str | None, dict] | None:
        try:
            snap = json.loads(row.snapshot or "{}")
        except Exception:
            return None
        rel = snap.get("pdf_storage_path")
        if not rel:
            return None
        try:
            path = media_storage.resolve_storage_path(rel)
            if path.is_file():
                return path, snap.get("pdf_filename"), snap
        except Exception:
            return None
        return None

    if version:
        for row in rows:
            extracted = _extract_valid_pdf(row)
            if not extracted:
                continue
            path, filename, snap = extracted
            snap_ver = str(snap.get("pdf_version") or "")
            if snap_ver and (snap_ver == version or snap_ver.startswith(f"{version}_")):
                return path, filename

    for row in rows:
        if user_id is not None and row.user_id == user_id:
            extracted = _extract_valid_pdf(row)
            if extracted:
                return extracted[0], extracted[1]
        if _is_prepared_row_active(db, stage, row):
            extracted = _extract_valid_pdf(row)
            if extracted:
                return extracted[0], extracted[1]

    if allow_historical_fallback:
        for row in rows:
            extracted = _extract_valid_pdf(row)
            if extracted:
                return extracted[0], extracted[1]
    return None


def prepare_project_content(db, user_id: int, stage: str, stage_grant_id: int | None, project) -> dict:
    if stage_grant_id is not None:
        existing = get_prepared_project_material(db, user_id, stage, stage_grant_id)
        if existing is not None:
            snap = json.loads(existing.snapshot)
            if not snap.get("pdf_storage_path") and project is not None:
                pdf_meta = _snapshot_project_pdf(project)
                if pdf_meta:
                    snap.update(pdf_meta)
                    existing.snapshot = json.dumps(snap, ensure_ascii=False)
                    db.add(existing)
                    db.flush()
            return snap
    lock_project_content(db, project.__class__, project.id)
    db.refresh(project)
    pdf_meta = _snapshot_project_pdf(project)
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
        **pdf_meta,
    }
    raw = json.dumps(snapshot, ensure_ascii=False)
    if stage_grant_id is None:
        existing = get_prepared_project_material(db, user_id, stage, None)
        if existing is not None:
            existing.project_id = project.id
            existing.project_code = project.code
            existing.snapshot = raw
            existing.prepared_at = datetime.utcnow()
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
        prepared_at=datetime.utcnow(),
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
        snapshot.pop("recorded_answers", None)
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


def ensure_prepared_theory_block(db, session, block_id: int) -> tuple[dict, bool]:
    existing = get_prepared_theory_material(db, session.id)
    if existing is not None:
        snapshot = json.loads(existing.snapshot)
        found = next((item for item in theory_blocks(snapshot) if item["id"] == block_id), None)
        if found is not None:
            return found, False

    block = db.get(Block, block_id)
    if not block or block.exam_id != session.exam_id or not block.enabled:
        raise HTTPException(404, "Block not found")

    selected_map: dict[str, list[int]] = {}
    if session.selected_map:
        try:
            selected_map = json.loads(session.selected_map)
        except Exception:
            selected_map = {}

    blocks = db.scalars(
        select(Block)
        .where(Block.exam_id == session.exam_id, Block.enabled == True)  # noqa: E712
        .order_by(Block.order_index)
    ).all()
    map_changed = False
    for blk in blocks:
        key = str(blk.id)
        if key not in selected_map:
            all_questions = db.scalars(
                select(Question)
                .where(Question.block_id == blk.id, Question.enabled == True)  # noqa: E712
                .order_by(Question.order_index)
            ).all()
            if not all_questions:
                if blk.id == block_id:
                    raise HTTPException(404, "No questions in block")
                continue
            choose_n = min(blk.qty, len(all_questions))
            selected = random.sample(all_questions, k=choose_n)
            random.shuffle(selected)
            selected_map[key] = [q.id for q in selected]
            map_changed = True

    if str(block_id) not in selected_map or not selected_map[str(block_id)]:
        raise HTTPException(404, "No questions in block")

    if map_changed or not session.selected_map:
        session.selected_map = json.dumps(selected_map)
        db.add(session)
        db.flush()

    if existing is not None:
        from .exam_lifecycle import build_exam_snapshot
        old_snap = json.loads(existing.snapshot)
        recorded = old_snap.get("recorded_answers")
        snapshot, _ = build_exam_snapshot(db, session, finished_at=session.started_at)
        if recorded:
            snapshot["recorded_answers"] = recorded
        existing.snapshot = json.dumps(snapshot, ensure_ascii=False)
        db.add(existing)
        db.flush()
    else:
        snapshot = prepare_theory_content(db, session)

    found = next((item for item in theory_blocks(snapshot) if item["id"] == block_id), None)
    if found is None:
        raise HTTPException(404, "Block not found")
    return found, True


def record_legacy_theory_answers(
    db,
    session,
    items: list[tuple[int, int]],
    *,
    strict: bool,
) -> int:
    from .exam_lifecycle import _iso

    if not session.selected_map:
        raise HTTPException(400, "Questions not initialized")

    prepared = get_prepared_theory_material(db, session.id)
    if prepared is None:
        try:
            prepare_theory_content(db, session)
            prepared = get_prepared_theory_material(db, session.id)
        except HTTPException:
            prepared = None

    if prepared is not None:
        snapshot = json.loads(prepared.snapshot)
        questions_by_id = {
            q["id"]: q
            for b in theory_blocks(snapshot)
            for q in b.get("questions", [])
        }
        all_snapshot_options = {
            o["id"]: q["id"]
            for q in questions_by_id.values()
            for o in q.get("options", [])
        }
        recorded = dict(snapshot.get("recorded_answers") or {})
        now_dt = datetime.utcnow()
        now_iso = _iso(now_dt)
        saved_count = 0

        for question_id, option_id in items:
            q_snap = questions_by_id.get(question_id)
            if q_snap is None:
                if strict:
                    raise HTTPException(400, "Question not allowed in this session")
                continue

            opt_snap = next(
                (o for o in q_snap.get("options", []) if o["id"] == option_id),
                None,
            )
            if opt_snap is None:
                if strict:
                    if option_id in all_snapshot_options:
                        raise HTTPException(400, "Option does not belong to question")
                    live_opt = db.get(Option, option_id)
                    if live_opt is None:
                        raise HTTPException(404, "Option not found")
                    raise HTTPException(400, "Option does not belong to question")
                continue

            is_correct = bool(opt_snap.get("is_correct", False))
            recorded[str(question_id)] = {
                "option_id": option_id,
                "is_correct": is_correct,
                "answered_at": now_iso,
            }

            live_q = db.get(Question, question_id)
            live_opt = db.get(Option, option_id)
            if live_q is not None and live_opt is not None and live_opt.question_id == question_id:
                existing_ans = db.scalar(
                    select(Answer).where(
                        Answer.session_id == session.id,
                        Answer.question_id == question_id,
                    )
                )
                if existing_ans is not None:
                    existing_ans.option_id = option_id
                    existing_ans.is_correct = is_correct
                    existing_ans.answered_at = now_dt
                else:
                    db.add(
                        Answer(
                            session_id=session.id,
                            question_id=question_id,
                            option_id=option_id,
                            is_correct=is_correct,
                            answered_at=now_dt,
                        )
                    )
            saved_count += 1

        snapshot["recorded_answers"] = recorded
        prepared.snapshot = json.dumps(snapshot, ensure_ascii=False)
        db.add(prepared)
        return saved_count

    selected_map: dict[str, list[int]] = json.loads(session.selected_map)
    allowed_qids = {qid for ids in selected_map.values() for qid in ids}
    saved_count = 0
    for question_id, option_id in items:
        if question_id not in allowed_qids:
            if strict:
                raise HTTPException(400, "Question not allowed in this session")
            continue
        opt = db.get(Option, option_id)
        if not opt:
            if strict:
                raise HTTPException(404, "Option not found")
            continue
        if opt.question_id != question_id:
            if strict:
                raise HTTPException(400, "Option does not belong to question")
            continue
        is_correct = bool(getattr(opt, "is_correct", False))
        existing_ans = db.scalar(
            select(Answer).where(
                Answer.session_id == session.id,
                Answer.question_id == question_id,
            )
        )
        if existing_ans is not None:
            existing_ans.option_id = option_id
            existing_ans.is_correct = is_correct
        else:
            db.add(
                Answer(
                    session_id=session.id,
                    question_id=question_id,
                    option_id=option_id,
                    is_correct=is_correct,
                )
            )
        saved_count += 1
    return saved_count


def grade_prepared_theory_session(
    db,
    session,
    *,
    finished_at=None,
    auto_closed: bool = False,
    auto_close_reason: str | None = None,
) -> dict | None:
    from .exam_lifecycle import _iso, _stats, _sum_stats, utcnow

    prepared = get_prepared_theory_material(db, session.id)
    if prepared is None:
        return None

    snapshot = json.loads(prepared.snapshot)
    recorded = dict(snapshot.pop("recorded_answers", None) or {})
    live_answers = list(
        db.scalars(select(Answer).where(Answer.session_id == session.id)).all()
    )
    live_by_qid = {ans.question_id: ans for ans in live_answers}

    blocks = theory_blocks(snapshot)
    block_stats = []
    for block in blocks:
        answered = correct = 0
        for question in block.get("questions", []):
            qid = question["id"]
            rec = recorded.get(str(qid))
            option_id = rec.get("option_id") if isinstance(rec, dict) else None
            answered_at_iso = rec.get("answered_at") if isinstance(rec, dict) else None

            if option_id is None and qid in live_by_qid:
                live_ans = live_by_qid[qid]
                option_id = live_ans.option_id
                answered_at_iso = _iso(live_ans.answered_at) or _iso(finished_at)

            selected = next(
                (item for item in question.get("options", []) if item["id"] == option_id),
                None,
            )
            if selected is None:
                option_id = None
                is_correct = False
            else:
                is_correct = bool(selected.get("is_correct", False))

            question.update(
                selected_option_id=option_id,
                selected_option={"id": selected["id"], "text": selected["text"]} if selected else None,
                is_correct=is_correct if selected else None,
                answered_at=(answered_at_iso or _iso(finished_at)) if selected else None,
            )
            for option in question.get("options", []):
                option["is_selected"] = option["id"] == option_id

            answered += int(selected is not None)
            correct += int(is_correct)

            if qid in live_by_qid:
                live_ans = live_by_qid[qid]
                if selected is not None:
                    live_ans.is_correct = is_correct
                    db.add(live_ans)

        block["stats"] = _stats(len(block.get("questions", [])), answered, correct)
        block_stats.append(
            {
                "block_id": block["id"],
                "correct": correct,
                "total": len(block.get("questions", [])),
                "percent": block["stats"]["percent"],
            }
        )

    for chapter in snapshot.get("chapters", []):
        for subchapter in chapter.get("subchapters", []):
            subchapter["stats"] = _sum_stats(block["stats"] for block in subchapter.get("blocks", []))
        chapter["stats"] = _sum_stats(subchapter["stats"] for subchapter in chapter.get("subchapters", []))

    summary = _sum_stats(block["stats"] for block in blocks)
    if isinstance(snapshot.get("session"), dict):
        snapshot["session"]["started_at"] = _iso(session.started_at)
        snapshot["session"]["ends_at"] = _iso(session.ends_at)
        snapshot["session"]["finished_at"] = _iso(finished_at)

    snapshot.update(
        summary=summary,
        block_stats=block_stats,
        status="auto_closed" if auto_closed else "completed",
        auto_closed=auto_closed,
        auto_closed_no_submission=bool(auto_closed and summary["answered"] == 0),
        auto_close_reason=auto_close_reason,
        generated_at=_iso(utcnow()),
    )
    return snapshot


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
