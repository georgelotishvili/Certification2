"""Candidate lifecycle service for Exam Candidate and Certificate Candidate statuses."""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Certificate, PlanningLetter, Statement, User

VALID_CANDIDATE_STATUSES = ("exam_candidate", "cert_candidate")
VALID_CANDIDATE_CATEGORIES = ("A", "B", "C", "B_A", "C_A")
VALID_CERT_CATEGORIES = ("A", "B", "C")

CATEGORY_DISPLAY_LABELS = {
    "A": "A კატეგორიის",
    "B": "B კატეგორიის",
    "C": "C კატეგორიის",
    "B_A": "B ან A კატეგორიის",
    "C_A": "C ან A კატეგორიის",
}


def parse_statement_category(message: str | None) -> str | None:
    """Extract requested certificate category code from an exam admission statement."""
    if not message:
        return None
    text = str(message)
    # Check composite categories first because their descriptions also mention "(კატეგორია A)"
    if "2) კატეგორია C ან A" in text or "კატეგორია C ან A" in text:
        return "C_A"
    if "3) კატეგორია B ან A" in text or "კატეგორია B ან A" in text:
        return "B_A"
    if "4) კატეგორია B" in text or "კატეგორია B —" in text or "კატეგორია B -" in text:
        return "B"
    if "5) კატეგორია C" in text or "კატეგორია C —" in text or "კატეგორია C -" in text:
        return "C"
    if "1) კატეგორია A" in text or "კატეგორია A —" in text or "კატეგორია A -" in text:
        return "A"
    return None


def resolve_passed_category(requested_category: str | None, outcome: str | None) -> str | None:
    """
    Given a user's requested exam category ('A', 'B', 'C', 'B_A', 'C_A') and
    their 3-stage exam sitting outcome ('pass_bc', 'pass_a', 'fail', 'incomplete'),
    return the earned certificate category ('A', 'B', 'C') or None if not passed.
    """
    if outcome not in ("pass_bc", "pass_a"):
        return None
    cat = (requested_category or "A").strip().upper()
    if cat == "A":
        return "A"
    if cat == "B":
        return "B" if outcome == "pass_bc" else None
    if cat == "C":
        return "C" if outcome == "pass_bc" else None
    if cat == "B_A":
        return "B" if outcome == "pass_bc" else "A"
    if cat == "C_A":
        return "C" if outcome == "pass_bc" else "A"
    return "A" if outcome in ("pass_bc", "pass_a") else None


def normalize_cert_category(category: str | None, outcome: str | None = None) -> str:
    """Resolve any candidate category to a final certificate category ('A', 'B', or 'C')."""
    cat = (category or "").strip().upper()
    if cat in VALID_CERT_CATEGORIES:
        return cat
    if cat == "B_A":
        return "A" if outcome == "pass_a" else "B"
    if cat == "C_A":
        return "A" if outcome == "pass_a" else "C"
    return "A"


def get_latest_requested_categories(db: Session) -> dict[int, str]:
    """Return mapping of user_id -> latest parsed exam statement category."""
    stmt_rows = db.execute(
        select(Statement.user_id, Statement.message)
        .order_by(Statement.created_at.desc(), Statement.id.desc())
    ).all()
    result: dict[int, str] = {}
    for uid, msg in stmt_rows:
        if uid in result:
            continue
        parsed = parse_statement_category(msg)
        if parsed:
            result[uid] = parsed
    return result


def get_user_latest_requested_category(db: Session, user_id: int) -> str | None:
    """Return the latest parsed exam statement category for a single user."""
    stmt_messages = db.scalars(
        select(Statement.message)
        .where(Statement.user_id == user_id)
        .order_by(Statement.created_at.desc(), Statement.id.desc())
    ).all()
    for msg in stmt_messages:
        parsed = parse_statement_category(msg)
        if parsed:
            return parsed
    return None


def sync_all_user_candidates(
    db: Session,
    exam_histories: dict[int, dict[str, Any]],
) -> dict[int, str]:
    """
    Synchronize automatic candidate status transitions for all users:
    1. If a user has a Certificate, clear any candidate_status.
    2. If a user is 'exam_candidate' and has completed a 3-stage exam sitting
       at or after becoming an exam candidate that satisfies their category,
       transition them to 'cert_candidate' with the resolved category ('A', 'B', 'C').
    3. If a user is 'cert_candidate' and 30 days have passed since their latest
       Certificate Handover notification (kind='certificate', period!='cert_issued')
       without obtaining a Certificate (and without manual admin re-activation
       after the 30-day mark), clear their candidate_status.
    Returns mapping of user_id -> latest requested category from statements.
    """
    requested_by_user = get_latest_requested_categories(db)

    candidate_users = db.scalars(
        select(User).where(User.candidate_status.is_not(None))
    ).all()
    if not candidate_users:
        return requested_by_user

    candidate_user_ids = [u.id for u in candidate_users]

    # Users who already have a certificate
    cert_user_ids = set(
        db.scalars(
            select(Certificate.user_id).where(Certificate.user_id.in_(candidate_user_ids))
        ).all()
    )

    # Latest certificate handover letter per user (kind='certificate', period != 'cert_issued')
    cert_letters = db.execute(
        select(
            PlanningLetter.user_id,
            PlanningLetter.sent_at,
            PlanningLetter.created_at,
            PlanningLetter.period,
        )
        .where(
            PlanningLetter.user_id.in_(candidate_user_ids),
            PlanningLetter.kind == "certificate",
        )
        .order_by(PlanningLetter.created_at.desc(), PlanningLetter.id.desc())
    ).all()
    latest_cert_letter_dt: dict[int, datetime] = {}
    for uid, sent_at, created_at, period in cert_letters:
        if period == "cert_issued":
            continue
        if uid not in latest_cert_letter_dt:
            dt = sent_at or created_at
            if isinstance(dt, str):
                try:
                    dt = datetime.fromisoformat(dt.replace("Z", ""))
                except Exception:
                    dt = None
            if dt is not None:
                latest_cert_letter_dt[int(uid)] = dt

    now = datetime.utcnow()
    dirty = False

    for u in candidate_users:
        # Rule 1: Certified users no longer hold candidate status
        if u.id in cert_user_ids:
            u.candidate_status = None
            u.candidate_category = None
            u.candidate_updated_at = now
            dirty = True
            continue

        if u.candidate_status == "exam_candidate":
            hist = exam_histories.get(u.id)
            sittings = (hist or {}).get("sittings") or []
            if sittings:
                latest_sitting = sittings[-1]
                stages = latest_sitting.get("stages") or {}
                all_three = (
                    stages.get("stage1") is not None
                    and stages.get("stage2") is not None
                    and stages.get("stage3") is not None
                )
                if all_three:
                    sitting_dt = latest_sitting.get("latest_at")
                    if isinstance(sitting_dt, str):
                        try:
                            sitting_dt = datetime.fromisoformat(sitting_dt.replace("Z", ""))
                        except ValueError:
                            sitting_dt = None
                    # Transition if sitting finished at/after candidate_updated_at (with 5s grace)
                    is_fresh = True
                    if u.candidate_updated_at and sitting_dt:
                        is_fresh = sitting_dt >= (u.candidate_updated_at - timedelta(seconds=5))
                    if is_fresh:
                        req_cat = u.candidate_category or requested_by_user.get(u.id) or "A"
                        passed_cat = resolve_passed_category(req_cat, latest_sitting.get("outcome"))
                        if passed_cat:
                            u.candidate_status = "cert_candidate"
                            u.candidate_category = passed_cat
                            u.candidate_updated_at = now
                            dirty = True

        if u.candidate_status == "cert_candidate":
            letter_dt = latest_cert_letter_dt.get(u.id)
            if letter_dt is not None:
                expiry_dt = letter_dt + timedelta(days=30)
                if now >= expiry_dt:
                    # Only expire if admin hasn't manually re-enabled after expiry_dt
                    manually_renewed = (
                        u.candidate_updated_at is not None and u.candidate_updated_at > expiry_dt
                    )
                    if not manually_renewed:
                        u.candidate_status = None
                        u.candidate_category = None
                        u.candidate_updated_at = now
                        dirty = True

    if dirty:
        db.commit()

    return requested_by_user
