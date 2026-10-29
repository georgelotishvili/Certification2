"""Candidate lifecycle service for Exam Candidate and Certificate Candidate statuses."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import json
from pathlib import Path
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..models import Certificate, ExamSchedule, PlanningLetter, Statement, User
from .media_storage import ensure_media_root

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


def _extract_exam_statement_header(message: str | None) -> str:
    """Return only the structured header part of an exam statement before free-text sections."""
    if not message:
        return ""
    text = str(message).replace("\r\n", "\n").replace("\r", "\n")
    for marker in (
        "\n2. თანდართული დოკუმენტები",
        "\n3. დამატებითი ინფორმაცია",
        "\nდამატებითი ინფორმაცია",
        "\n4. განმცხადებლის დადასტურება",
    ):
        idx = text.find(marker)
        if idx != -1:
            text = text[:idx]
    return text


def _match_category_in_line(line: str) -> str | None:
    if "2) კატეგორია C ან A" in line or "კატეგორია C ან A" in line:
        return "C_A"
    if "3) კატეგორია B ან A" in line or "კატეგორია B ან A" in line:
        return "B_A"
    if "4) კატეგორია B" in line or "კატეგორია B —" in line or "კატეგორია B -" in line:
        return "B"
    if "5) კატეგორია C" in line or "კატეგორია C —" in line or "კატეგორია C -" in line:
        return "C"
    if "1) კატეგორია A" in line or "კატეგორია A —" in line or "კატეგორია A -" in line:
        return "A"
    return None


def parse_statement_category(message: str | None) -> str | None:
    """Extract requested certificate category code from an exam admission statement."""
    header = _extract_exam_statement_header(message)
    if not header:
        return None
    lines = [ln.strip() for ln in header.splitlines() if ln.strip()]
    # 1. Prefer explicitly checked (☑) option lines first
    for ln in lines:
        if "☑" in ln:
            matched = _match_category_in_line(ln)
            if matched:
                return matched
    # 2. Otherwise check structured option lines (numbered 1)..5) or em-dash/hyphen title)
    is_structured_app = (
        "სერტიფიცირების განაცხადი" in header
        or "ვითხოვ სასერტიფიკაციო გამოცდაზე დაშვებას" in header
        or any(
            any(prefix in ln for prefix in ("1) კატეგორია", "2) კატეგორია", "3) კატეგორია", "4) კატეგორია", "5) კატეგორია", "კატეგორია A —", "კატეგორია B —", "კატეგორია C —", "კატეგორია A -", "კატეგორია B -", "კატეგორია C -"))
            for ln in lines
        )
    )
    if not is_structured_app:
        return None
    for ln in lines:
        matched = _match_category_in_line(ln)
        if matched:
            return matched
    return _match_category_in_line(header)


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


def parse_statement_regime(message: str | None) -> str | None:
    """Extract admission regime ('standard' or 'transitional') from an exam admission statement."""
    header = _extract_exam_statement_header(message)
    if not header:
        return None
    cat = parse_statement_category(header)
    if cat == "C":
        return "standard"
    for line in header.splitlines():
        s = line.strip()
        if "☑" in s or "დაშვების რეჟიმი" in s:
            if "გარდამავალი" in s or "საგამონაკლისო" in s or "უდიპლომოდ" in s:
                return "transitional"
            if "სტანდარტული" in s:
                return "standard"
    if cat or "დაშვების რეჟიმი" in header or "სერტიფიცირების განაცხადი" in header:
        if "გარდამავალი / საგამონაკლისო რეჟიმი" in header or "საგამონაკლისო რეჟიმი" in header:
            return "transitional"
        if "სტანდარტული რეჟიმი" in header:
            return "standard"
    if cat:
        return "standard"
    return None


def get_latest_admission_regimes(db: Session, user_ids: list[int] | None = None) -> dict[int, str]:
    """Return mapping of user_id -> latest parsed exam statement admission regime ('standard' or 'transitional')."""
    q = select(Statement.user_id, Statement.message)
    if user_ids is not None:
        if not user_ids:
            return {}
        q = q.where(Statement.user_id.in_(user_ids))
    stmt_rows = db.execute(
        q.order_by(Statement.created_at.desc(), Statement.id.desc())
    ).all()
    result: dict[int, str] = {}
    for uid, msg in stmt_rows:
        if uid in result:
            continue
        cat = parse_statement_category(msg)
        if not cat:
            continue
        parsed = parse_statement_regime(msg) or "standard"
        result[uid] = parsed
    return result


def get_user_latest_admission_regime(db: Session, user_id: int) -> str | None:
    """Return the latest parsed exam statement admission regime for a single user."""
    stmt_messages = db.scalars(
        select(Statement.message)
        .where(Statement.user_id == user_id)
        .order_by(Statement.created_at.desc(), Statement.id.desc())
    ).all()
    for msg in stmt_messages:
        cat = parse_statement_category(msg)
        if not cat:
            continue
        return parse_statement_regime(msg) or "standard"
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

    passed_sitting_uids: set[int] = set()
    for uid, hist in (exam_histories or {}).items():
        sittings = (hist or {}).get("sittings") or []
        if not sittings:
            continue
        latest_sitting = sittings[-1]
        stages = latest_sitting.get("stages") or {}
        if (
            stages.get("stage1") is not None
            and stages.get("stage2") is not None
            and stages.get("stage3") is not None
            and latest_sitting.get("outcome") in ("pass_bc", "pass_a")
        ):
            passed_sitting_uids.add(int(uid))

    if passed_sitting_uids:
        candidate_users = db.scalars(
            select(User).where(
                or_(
                    User.candidate_status.is_not(None),
                    User.id.in_(passed_sitting_uids),
                )
            )
        ).all()
    else:
        candidate_users = db.scalars(
            select(User).where(User.candidate_status.is_not(None))
        ).all()
    if not candidate_users:
        return requested_by_user

    candidate_user_ids = [u.id for u in candidate_users]

    # Users who already have a certificate and its latest timestamp
    cert_rows = db.execute(
        select(
            Certificate.user_id,
            func.coalesce(Certificate.updated_at, Certificate.created_at),
        ).where(Certificate.user_id.in_(candidate_user_ids))
    ).all()
    cert_dt_by_uid: dict[int, datetime] = {}
    for uid, raw_cert_dt in cert_rows:
        dt = raw_cert_dt
        if isinstance(dt, str):
            try:
                dt = datetime.fromisoformat(dt.replace("Z", ""))
            except Exception:
                dt = None
        if dt is not None:
            cert_dt_by_uid[int(uid)] = dt

    # Latest certificate handover letter per user (kind='certificate', excluding non-pass periods)
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
            PlanningLetter.status.in_(("sent", "simulated")),
        )
        .order_by(PlanningLetter.created_at.desc(), PlanningLetter.id.desc())
    ).all()
    latest_cert_letter_dt: dict[int, datetime] = {}
    for uid, sent_at, created_at, period in cert_letters:
        if period in NON_PASS_CERT_PERIODS:
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
        # Rule 1: Certified users no longer hold candidate status unless a new pass letter
        # or candidate activation occurred AFTER the certificate was issued/updated
        if u.id in cert_dt_by_uid:
            cert_dt = cert_dt_by_uid[u.id]
            letter_dt = latest_cert_letter_dt.get(u.id)
            cand_dt = u.candidate_updated_at
            newer_activity = (
                (letter_dt is not None and letter_dt > (cert_dt + timedelta(seconds=5)))
                or (cand_dt is not None and cand_dt > (cert_dt + timedelta(seconds=5)))
            )
            if not newer_activity:
                if u.candidate_status is not None or u.candidate_category is not None:
                    u.candidate_status = None
                    u.candidate_category = None
                    u.candidate_updated_at = now
                    dirty = True
                continue

        if u.candidate_status in ("exam_candidate", None):
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
                    if is_fresh and u.id in cert_dt_by_uid and sitting_dt:
                        if sitting_dt <= (cert_dt_by_uid[u.id] + timedelta(seconds=5)):
                            is_fresh = False
                    if is_fresh and u.candidate_status is None:
                        if sitting_dt is None or (now - sitting_dt) > timedelta(days=30):
                            is_fresh = False
                        else:
                            letter_dt = latest_cert_letter_dt.get(u.id)
                            if letter_dt is not None and now >= (letter_dt + timedelta(days=30)):
                                is_fresh = False
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


NON_EXAM_LETTER_PERIODS = (
    "rejection",
    "rej_send_only",
    "rejection_send_only",
    "exam_fail",
    "fail_send_only",
    "custom",
    "cust_send_only",
)

NON_PASS_CERT_PERIODS = (
    "cert_issued",
    "exam_fail",
    "fail_send_only",
    "rejection",
    "rej_send_only",
    "rejection_send_only",
    "custom",
    "cust_send_only",
)


def reconcile_user_candidate_status_after_delete(
    db: Session,
    user: User | int | None,
    deleted_kind: str = "any",
) -> bool:
    """
    Reconcile a user's candidate_status and candidate_category after deleting
    a statement, exam schedule, or planning letter.
    Returns True if user candidate fields were modified.
    """
    if isinstance(user, int):
        user = db.get(User, user)
    if user is None:
        return False

    now = datetime.utcnow()
    if user.candidate_status is None:
        return False

    user_statements = db.execute(
        select(Statement.message, Statement.attachment2_path, Statement.attachment3_path)
        .where(Statement.user_id == user.id)
    ).all()
    exam_stmt_count = sum(
        1
        for msg, att2, att3 in user_statements
        if parse_statement_category(msg) is not None or bool(att2) or bool(att3)
    )
    sched_count = int(
        db.scalar(select(func.count(ExamSchedule.id)).where(ExamSchedule.user_id == user.id)) or 0
    )
    upcoming_sched_count = int(
        db.scalar(
            select(func.count(ExamSchedule.id)).where(
                ExamSchedule.user_id == user.id,
                ExamSchedule.exam_date >= now.date(),
            )
        )
        or 0
    )
    exam_letter_count = int(
        db.scalar(
            select(func.count(PlanningLetter.id)).where(
                PlanningLetter.user_id == user.id,
                PlanningLetter.kind == "exam",
                or_(
                    PlanningLetter.period.is_(None),
                    ~PlanningLetter.period.in_(NON_EXAM_LETTER_PERIODS),
                ),
            )
        )
        or 0
    )
    cert_letter_count = int(
        db.scalar(
            select(func.count(PlanningLetter.id)).where(
                PlanningLetter.user_id == user.id,
                PlanningLetter.kind == "certificate",
                or_(
                    PlanningLetter.period.is_(None),
                    ~PlanningLetter.period.in_(NON_PASS_CERT_PERIODS),
                ),
            )
        )
        or 0
    )

    has_any_exam_activity = (sched_count > 0) or (exam_letter_count > 0)

    # Rule 1: Deleting the last exam statement clears status only if no active schedule / cert letter remains
    if deleted_kind == "statement" and exam_stmt_count == 0:
        if user.candidate_status == "exam_candidate" and upcoming_sched_count == 0:
            user.candidate_status = None
            user.candidate_category = None
            user.candidate_updated_at = now
            db.add(user)
            return True
        if user.candidate_status == "cert_candidate" and cert_letter_count == 0:
            user.candidate_status = None
            user.candidate_category = None
            user.candidate_updated_at = now
            db.add(user)
            return True
    elif exam_stmt_count == 0 and not has_any_exam_activity and cert_letter_count == 0:
        user.candidate_status = None
        user.candidate_category = None
        user.candidate_updated_at = now
        db.add(user)
        return True

    # Rule 2: Deleting the last certificate handover letter
    if deleted_kind == "certificate_letter" and cert_letter_count == 0:
        if user.candidate_status == "cert_candidate":
            if upcoming_sched_count > 0 or exam_stmt_count > 0:
                req_cat = get_user_latest_requested_category(db, user.id)
                user.candidate_status = "exam_candidate"
                user.candidate_category = req_cat or user.candidate_category or "A"
            else:
                user.candidate_status = None
                user.candidate_category = None
            user.candidate_updated_at = now
            db.add(user)
            return True

    # Rule 3: Deleting the last exam schedule or exam admission letter
    if deleted_kind in ("exam_schedule", "exam_letter") and not has_any_exam_activity:
        if user.candidate_status == "exam_candidate" or (
            user.candidate_status == "cert_candidate" and cert_letter_count == 0
        ):
            user.candidate_status = None
            user.candidate_category = None
            user.candidate_updated_at = now
            db.add(user)
            return True

    # Rule 4: If a statement was deleted but other exam statements remain, keep category in sync
    if deleted_kind == "statement" and exam_stmt_count > 0 and user.candidate_status == "exam_candidate":
        req_cat = get_user_latest_requested_category(db, user.id)
        if req_cat and user.candidate_category != req_cat:
            user.candidate_category = req_cat
            user.candidate_updated_at = now
            db.add(user)
            return True

    return False


# ================= Transitional (Exception Term) Certificate Helpers =================

DEFAULT_TRANSITIONAL_DEADLINE = date(2029, 12, 20)


def today_in_tbilisi() -> date:
    return datetime.now(timezone(timedelta(hours=4))).date()


def is_transitional_eligible_level(level: str | None) -> bool:
    """Exception term (without diploma) applies only to Architect (A) and Municipal Specialist (B), never Expert (C)."""
    norm = (level or "").strip().lower()
    if norm in (
        "expert",
        "architect_expert",
        "არქიტექტორი ექსპერტი",
        "არქიტექტურული პროექტის ექსპერტი",
    ):
        return False
    return True


def _transitional_settings_path() -> Path:
    root = ensure_media_root().resolve()
    folder = root / "certificates"
    folder.mkdir(parents=True, exist_ok=True)
    return folder / "transitional_settings.json"


def get_transitional_deadline_date(db: Session | None = None) -> date:
    try:
        path = _transitional_settings_path()
        if path.is_file():
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                raw = str(data.get("deadline_date") or "").strip()
                if raw == "2029-01-01" and data.get("schema_version") != 2:
                    return DEFAULT_TRANSITIONAL_DEADLINE
                if raw:
                    return date.fromisoformat(raw[:10])
    except Exception:
        pass
    return DEFAULT_TRANSITIONAL_DEADLINE


def is_five_year_term_expired(
    cert: Certificate,
    today_tb: date | None = None,
) -> bool:
    """Check whether the certificate's 5-year cycle (valid_until) has expired."""
    if cert.valid_until is None:
        return False
    ref_day = today_tb or today_in_tbilisi()
    vu_date = cert.valid_until.date() if isinstance(cert.valid_until, datetime) else cert.valid_until
    return ref_day > vu_date


def compute_effective_certificate_status(
    cert: Certificate,
    deadline_date: date | None = None,
) -> str:
    """
    Dual-deadline rule:
    1) 5-year cycle (valid_until): expires after valid_until date.
    2) Exception deadline (deadline_date, default 01/01/2029): for transitional certificates,
       expires on/after deadline_date.
    Whichever deadline is reached first makes the certificate 'expired'.
    """
    raw_status = (cert.status or "active").strip().lower()
    if raw_status == "suspended":
        return "suspended"
    if raw_status == "expired":
        return "expired"
    today_tb = today_in_tbilisi()
    if is_five_year_term_expired(cert, today_tb):
        return "expired"
    if bool(getattr(cert, "is_transitional", False)) and is_transitional_eligible_level(cert.level):
        dl = deadline_date or get_transitional_deadline_date()
        if today_tb >= dl:
            return "expired"
    return "active"


def sync_transitional_certificates(
    db: Session,
    deadline_date: date | None = None,
) -> date:
    """
    Synchronize all active certificates against the dual-deadline rule:
    - Any active certificate whose 5-year valid_until has expired is marked 'expired'.
    - Any active transitional certificate whose global exception deadline has been reached
      is marked 'expired'.
    Returns the active global exception deadline date.
    """
    dl = deadline_date or get_transitional_deadline_date()
    today_tb = today_in_tbilisi()
    now_utc = datetime.utcnow()
    active_certs = db.scalars(
        select(Certificate).where(Certificate.status == "active")
    ).all()
    dirty = False
    for c in active_certs:
        expired_by_five_year = is_five_year_term_expired(c, today_tb)
        expired_by_exception = (
            bool(getattr(c, "is_transitional", False))
            and is_transitional_eligible_level(c.level)
            and today_tb >= dl
        )
        if expired_by_five_year or expired_by_exception:
            c.status = "expired"
            c.updated_at = now_utc
            db.add(c)
            dirty = True
    if dirty:
        db.commit()
    return dl


def set_transitional_deadline_date(
    db: Session,
    new_deadline: date,
    actor_email: str | None = None,
) -> dict[str, Any]:
    """
    Update the global exception deadline date and synchronize all transitional certificates
    according to the dual-deadline rule (whichever comes earlier: 5-year valid_until or new_deadline):
    - If today < new_deadline AND 5-year valid_until has NOT expired: any 'expired' transitional
      certificate is automatically restored to 'active'.
    - If today >= new_deadline OR 5-year valid_until HAS expired: any 'active' transitional
      certificate is marked 'expired'.
    """
    path = _transitional_settings_path()
    now_utc = datetime.utcnow()
    payload = {
        "deadline_date": new_deadline.isoformat(),
        "updated_at": now_utc.isoformat(),
        "updated_by": actor_email or "admin",
        "schema_version": 2,
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    today_tb = today_in_tbilisi()
    trans_certs = db.scalars(
        select(Certificate).where(Certificate.is_transitional == True)  # noqa: E712
    ).all()
    eligible_certs = [c for c in trans_certs if is_transitional_eligible_level(c.level)]

    reactivated_count = 0
    expired_count = 0
    dirty = False

    for c in eligible_certs:
        status_norm = (c.status or "active").strip().lower()
        if status_norm == "suspended":
            continue
        vu_expired = is_five_year_term_expired(c, today_tb)
        if today_tb < new_deadline and not vu_expired:
            if status_norm != "active":
                c.status = "active"
                c.updated_at = now_utc
                db.add(c)
                reactivated_count += 1
                dirty = True
        else:
            if status_norm == "active":
                c.status = "expired"
                c.updated_at = now_utc
                db.add(c)
                expired_count += 1
                dirty = True

    if dirty:
        db.commit()

    return {
        "transitional_deadline": new_deadline,
        "deadline_date": new_deadline,
        "transitional_count": len(eligible_certs),
        "reactivated_count": reactivated_count,
        "expired_count": expired_count,
    }

