from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import json
import re
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import (
    CertBooking,
    CertBookingDay,
    Certificate,
    PlanningLetter,
    User,
)
from ..services.candidate_status import (
    NON_PASS_CERT_PERIODS,
    get_user_latest_requested_category,
    normalize_cert_category,
)
from ..services.planning_email import deliver_letter
from .admin import _require_admin
from .users import _require_auth

admin_router = APIRouter()
user_router = APIRouter()

TBILISI_TZ = timezone(timedelta(hours=4))
TEMPLATE_ROW_KEY = "__TEMPLATE__"
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# 11:00-დან 16:00-მდე 20-წუთიანი შუალედებით (სულ 15 სლოტი)
ALL_CERT_SLOTS: list[str] = [
    "11:00",
    "11:20",
    "11:40",
    "12:00",
    "12:20",
    "12:40",
    "13:00",
    "13:20",
    "13:40",
    "14:00",
    "14:20",
    "14:40",
    "15:00",
    "15:20",
    "15:40",
]
ALL_CERT_SLOTS_SET = set(ALL_CERT_SLOTS)

CATEGORY_FULL_LABELS = {
    "A": "კატეგორია A — შენობა-ნაგებობის არქიტექტორი",
    "B": "კატეგორია B — არქიტექტურული პროექტის შემსწავლელი სპეციალისტი",
    "C": "კატეგორია C — არქიტექტურული პროექტის ექსპერტი",
}


def _now_tbilisi() -> datetime:
    return datetime.now(timezone.utc).astimezone(TBILISI_TZ).replace(tzinfo=None)


def _to_tbilisi(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is not None:
        return dt.astimezone(TBILISI_TZ).replace(tzinfo=None)
    return dt + timedelta(hours=4)


def _slot_end_time(slot_time: str) -> str:
    try:
        hh, mm = map(int, slot_time.split(":"))
        total = hh * 60 + mm + 20
        return f"{total // 60:02d}:{total % 60:02d}"
    except Exception:
        return slot_time


def _format_date_ka(date_str: str | None) -> str:
    if not date_str or not DATE_RE.match(date_str):
        return date_str or "—"
    yyyy, mm, dd = date_str.split("-")
    return f"{dd}.{mm}.{yyyy}"


def _format_dt_ka(dt: datetime | None) -> str | None:
    tb = _to_tbilisi(dt)
    if tb is None:
        return None
    return tb.strftime("%d.%m.%Y %H:%M")


def _parse_slots_json(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
        if not isinstance(parsed, list):
            return []
        valid = [str(s).strip() for s in parsed if str(s).strip() in ALL_CERT_SLOTS_SET]
        return sorted(set(valid), key=lambda x: ALL_CERT_SLOTS.index(x))
    except Exception:
        return []


def _load_weekday_template(db: Session) -> dict[str, Any]:
    default_tpl = {
        "weekdays": [0, 1, 2, 3, 4],  # ორშ–პარ
        "slots": list(ALL_CERT_SLOTS),
    }
    row = db.get(CertBookingDay, TEMPLATE_ROW_KEY)
    if not row or not row.slots_json:
        return default_tpl
    try:
        data = json.loads(row.slots_json)
        if not isinstance(data, dict):
            return default_tpl
        raw_days = data.get("weekdays")
        if isinstance(raw_days, list):
            weekdays = sorted({int(d) for d in raw_days if isinstance(d, int) and 0 <= int(d) <= 4})
        else:
            weekdays = [0, 1, 2, 3, 4]
        raw_slots = data.get("slots")
        if isinstance(raw_slots, list):
            slots = [
                str(s).strip()
                for s in raw_slots
                if str(s).strip() in ALL_CERT_SLOTS_SET
            ]
            slots = sorted(set(slots), key=lambda x: ALL_CERT_SLOTS.index(x))
        else:
            slots = list(ALL_CERT_SLOTS)
        return {"weekdays": weekdays, "slots": slots}
    except Exception:
        return default_tpl


def _save_weekday_template(db: Session, weekdays: list[int], slots: list[str], actor_email: str) -> None:
    row = db.get(CertBookingDay, TEMPLATE_ROW_KEY)
    payload = json.dumps({"weekdays": weekdays, "slots": slots}, ensure_ascii=False)
    if row is None:
        row = CertBookingDay(
            date_str=TEMPLATE_ROW_KEY,
            slots_json=payload,
            updated_at=datetime.utcnow(),
            updated_by=actor_email,
        )
        db.add(row)
    else:
        row.slots_json = payload
        row.updated_at = datetime.utcnow()
        row.updated_by = actor_email
        db.add(row)


def _has_booking_flag(booking: CertBooking, flag: str) -> bool:
    raw = booking.cancelled_by or ""
    return f"|{flag}|" in raw


def _add_booking_flag(booking: CertBooking, flag: str) -> None:
    token = f"|{flag}|"
    raw = booking.cancelled_by or ""
    if token not in raw:
        booking.cancelled_by = f"{raw}{token}"


def _set_cancelled_by_preserving_flags(booking: CertBooking, actor_email: str) -> None:
    raw = booking.cancelled_by or ""
    flags = "".join(
        token
        for token in ("|hide_user|", "|hide_admin|")
        if token in raw
    )
    booking.cancelled_by = f"{actor_email or ''}{flags}"


def _effective_booking_status(booking: CertBooking, now_tb_str: str) -> tuple[str, str, bool]:
    """Return (effective_status, status_label_ka, is_past)."""
    is_past = f"{booking.booking_date} {booking.slot_time}" <= now_tb_str
    if booking.status == "cancelled":
        return "cancelled", "გაუქმებული", is_past
    if booking.status == "completed":
        return "completed", "სერტიფიკატი გაცემულია / დასრულებული", True
    if is_past:
        return "completed", "დრო გავიდა / დასრულებული", True
    return "active", "აქტიური", False


def _resolve_user_eligibility(db: Session, user: User) -> dict[str, Any]:
    now_tb = _now_tbilisi()
    today_tb = now_tb.date()

    cert_row = db.scalar(select(Certificate).where(Certificate.user_id == user.id))

    pass_letter = db.scalar(
        select(PlanningLetter)
        .where(
            PlanningLetter.user_id == user.id,
            PlanningLetter.kind == "certificate",
            or_(
                PlanningLetter.period.is_(None),
                ~PlanningLetter.period.in_(NON_PASS_CERT_PERIODS),
            ),
            PlanningLetter.status != "failed",
        )
        .order_by(PlanningLetter.created_at.desc(), PlanningLetter.id.desc())
    )

    letter_dt_utc: datetime | None = None
    letter_id: int | None = None
    if pass_letter is not None:
        revoked_after_letter = (
            user.candidate_status != "cert_candidate"
            and user.candidate_updated_at is not None
            and pass_letter.created_at is not None
            and user.candidate_updated_at > (pass_letter.created_at + timedelta(seconds=5))
            and (
                cert_row is None
                or (cert_row.updated_at or cert_row.created_at or datetime.min)
                <= (pass_letter.created_at + timedelta(seconds=5))
            )
        )
        if not revoked_after_letter:
            letter_dt_utc = pass_letter.sent_at or pass_letter.created_at
            letter_id = pass_letter.id

    if user.candidate_status == "cert_candidate":
        if letter_dt_utc is None or (
            user.candidate_updated_at is not None
            and user.candidate_updated_at > (letter_dt_utc + timedelta(days=30))
        ):
            letter_dt_utc = user.candidate_updated_at or datetime.utcnow()

    if cert_row is None:
        has_certificate = False
    elif letter_dt_utc is None:
        has_certificate = True
    else:
        cert_dt = cert_row.updated_at or cert_row.created_at
        has_certificate = bool(
            cert_dt is not None
            and cert_dt > (letter_dt_utc + timedelta(seconds=5))
            and user.candidate_status != "cert_candidate"
        )

    raw_cat = user.candidate_category or get_user_latest_requested_category(db, user.id) or "A"
    category = normalize_cert_category(raw_cat)

    if letter_dt_utc is None:
        return {
            "has_pass_letter": False,
            "has_certificate": has_certificate,
            "eligible_to_book": False,
            "within_30_days": False,
            "letter_id": None,
            "letter_dt_utc": None,
            "letter_sent_date": None,
            "letter_sent_date_ka": None,
            "window_start": None,
            "window_end": None,
            "window_start_ka": None,
            "window_end_ka": None,
            "days_remaining": 0,
            "category": category,
            "category_label": CATEGORY_FULL_LABELS.get(category, f"კატეგორია {category}"),
        }

    letter_tb = _to_tbilisi(letter_dt_utc) or now_tb
    letter_date = letter_tb.date()
    deadline_date = letter_date + timedelta(days=30)
    window_start = max(today_tb, letter_date)
    window_end = deadline_date
    within_30_days = today_tb <= deadline_date
    days_remaining = max(0, (deadline_date - today_tb).days)
    eligible_to_book = (not has_certificate) and within_30_days

    return {
        "has_pass_letter": True,
        "has_certificate": has_certificate,
        "eligible_to_book": eligible_to_book,
        "within_30_days": within_30_days,
        "letter_id": letter_id,
        "letter_dt_utc": letter_dt_utc,
        "letter_sent_date": letter_date.isoformat(),
        "letter_sent_date_ka": _format_date_ka(letter_date.isoformat()),
        "window_start": window_start.isoformat(),
        "window_end": window_end.isoformat(),
        "window_start_ka": _format_date_ka(window_start.isoformat()),
        "window_end_ka": _format_date_ka(window_end.isoformat()),
        "days_remaining": days_remaining,
        "category": category,
        "category_label": CATEGORY_FULL_LABELS.get(category, f"კატეგორია {category}"),
    }


def _serialize_booking_for_user(booking: CertBooking, now_tb_str: str) -> dict[str, Any]:
    eff_status, status_label, is_past = _effective_booking_status(booking, now_tb_str)
    end_time = _slot_end_time(booking.slot_time)
    return {
        "id": booking.id,
        "booking_date": booking.booking_date,
        "booking_date_ka": _format_date_ka(booking.booking_date),
        "slot_time": booking.slot_time,
        "end_time": end_time,
        "time_range": f"{booking.slot_time}–{end_time}",
        "status": eff_status,
        "raw_status": booking.status,
        "status_label": status_label,
        "is_past": is_past,
        "category": booking.category,
        "created_at": _format_dt_ka(booking.created_at),
        "cancelled_at": _format_dt_ka(booking.cancelled_at),
    }


def _build_user_booking_payload(db: Session, user: User) -> dict[str, Any]:
    now_tb = _now_tbilisi()
    now_tb_str = now_tb.strftime("%Y-%m-%d %H:%M")
    today_str = now_tb.strftime("%Y-%m-%d")
    now_time_str = now_tb.strftime("%H:%M")

    elig = _resolve_user_eligibility(db, user)

    user_bookings = db.scalars(
        select(CertBooking)
        .where(CertBooking.user_id == user.id)
        .order_by(CertBooking.booking_date.desc(), CertBooking.slot_time.desc(), CertBooking.id.desc())
    ).all()

    history: list[dict[str, Any]] = []
    active_booking: dict[str, Any] | None = None
    has_expired_booking_for_current_letter = False
    letter_dt_utc = elig.get("letter_dt_utc")

    for b in user_bookings:
        serialized = _serialize_booking_for_user(b, now_tb_str)
        if not _has_booking_flag(b, "hide_user"):
            history.append(serialized)
        if serialized["status"] == "active" and active_booking is None:
            active_booking = serialized
        elif serialized["status"] == "completed":
            if letter_dt_utc is None or (
                b.created_at is not None and b.created_at >= (letter_dt_utc - timedelta(minutes=5))
            ):
                has_expired_booking_for_current_letter = True

    # Central header button visibility logic:
    # - Only for eligible candidates within their 30-day window without a certificate
    # - Unbooked -> pulsing green button "სერტიფიკატის აღების დაჯავშნა"
    # - Booked (upcoming) -> solid green button with booked date & time
    # - Once the booked appointment time passes -> disappears from the header
    if not elig["eligible_to_book"]:
        show_header_button = False
        header_state = "hidden"
    elif active_booking is not None:
        show_header_button = True
        header_state = "booked"
    elif has_expired_booking_for_current_letter:
        show_header_button = False
        header_state = "hidden"
    else:
        show_header_button = True
        header_state = "unbooked"

    available_days: dict[str, dict[str, Any]] = {}
    if elig["eligible_to_book"] and elig["window_start"] and elig["window_end"]:
        w_start = elig["window_start"]
        w_end = elig["window_end"]
        day_rows = db.scalars(
            select(CertBookingDay).where(
                CertBookingDay.date_str >= w_start,
                CertBookingDay.date_str <= w_end,
            )
        ).all()

        occupied_rows = db.scalars(
            select(CertBooking).where(
                CertBooking.booking_date >= w_start,
                CertBooking.booking_date <= w_end,
                CertBooking.status == "active",
            )
        ).all()
        occupied_map: dict[tuple[str, str], int] = {}
        for occ in occupied_rows:
            occupied_map[(occ.booking_date, occ.slot_time)] = occ.user_id

        for dr in day_rows:
            if not DATE_RE.match(dr.date_str):
                continue
            try:
                d_obj = date.fromisoformat(dr.date_str)
            except ValueError:
                continue
            if d_obj.weekday() >= 5:
                continue
            enabled_slots = _parse_slots_json(dr.slots_json)
            if not enabled_slots:
                continue
            free_slots: list[str] = []
            slots_detail: list[dict[str, Any]] = []
            for st in enabled_slots:
                if dr.date_str == today_str and st <= now_time_str:
                    continue
                holder_uid = occupied_map.get((dr.date_str, st))
                is_mine = holder_uid == user.id
                is_taken = holder_uid is not None and not is_mine
                if not is_taken:
                    free_slots.append(st)
                slots_detail.append({
                    "slot_time": st,
                    "end_time": _slot_end_time(st),
                    "is_free": not is_taken,
                    "is_mine": is_mine,
                    "is_taken": is_taken,
                })
            if slots_detail:
                available_days[dr.date_str] = {
                    "date_str": dr.date_str,
                    "date_ka": _format_date_ka(dr.date_str),
                    "free_count": len(free_slots),
                    "free_slots": free_slots,
                    "slots": slots_detail,
                }

    return {
        "today": today_str,
        "now_time": now_time_str,
        "all_slots": ALL_CERT_SLOTS,
        "eligible_to_book": elig["eligible_to_book"],
        "has_pass_letter": elig["has_pass_letter"],
        "has_certificate": elig["has_certificate"],
        "within_30_days": elig["within_30_days"],
        "letter_sent_date": elig["letter_sent_date"],
        "letter_sent_date_ka": elig["letter_sent_date_ka"],
        "window_start": elig["window_start"],
        "window_end": elig["window_end"],
        "window_start_ka": elig["window_start_ka"],
        "window_end_ka": elig["window_end_ka"],
        "days_remaining": elig["days_remaining"],
        "category": elig["category"],
        "category_label": elig["category_label"],
        "show_header_button": show_header_button,
        "header_state": header_state,
        "active_booking": active_booking,
        "available_days": available_days,
        "history": history,
    }


# ==================== CANDIDATE / USER ENDPOINTS ====================


class CreateCertBookingRequest(BaseModel):
    booking_date: str = Field(..., min_length=10, max_length=10)
    slot_time: str = Field(..., min_length=5, max_length=5)


@user_router.get("/me/cert-booking")
def get_my_cert_booking(
    authorization: str | None = Header(None),
    db: Session = Depends(get_db),
):
    user = _require_auth(db, authorization)
    return _build_user_booking_payload(db, user)


@user_router.post("/me/cert-booking")
def create_or_update_my_cert_booking(
    payload: CreateCertBookingRequest,
    authorization: str | None = Header(None),
    db: Session = Depends(get_db),
):
    user = _require_auth(db, authorization)
    booking_date = (payload.booking_date or "").strip()
    slot_time = (payload.slot_time or "").strip()

    if not DATE_RE.match(booking_date):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="თარიღის ფორმატი არასწორია")
    if slot_time not in ALL_CERT_SLOTS_SET:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="არჩეული დროის შუალედი არასწორია")

    try:
        target_date = date.fromisoformat(booking_date)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="თარიღი არასწორია") from exc

    if target_date.weekday() >= 5:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="შაბათ-კვირას დაჯავშნა დაუშვებელია")

    elig = _resolve_user_eligibility(db, user)
    if not elig["eligible_to_book"] or not elig["window_start"] or not elig["window_end"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="სერტიფიკატის აღების დაჯავშნა ხელმისაწვდომია ჩაბარების წერილის მიღებიდან 30 კალენდარული დღის განმავლობაში",
        )

    if booking_date < elig["window_start"] or booking_date > elig["window_end"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"დაჯავშნა შესაძლებელია მხოლოდ თქვენს 30-დღიან ვადაში ({elig['window_start_ka']} – {elig['window_end_ka']})",
        )

    now_tb = _now_tbilisi()
    now_tb_str = now_tb.strftime("%Y-%m-%d %H:%M")
    if f"{booking_date} {slot_time}" <= now_tb_str:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="გასული დროის დაჯავშნა შეუძლებელია, გთხოვთ აირჩიოთ მომავალი დრო",
        )

    day_row = db.get(CertBookingDay, booking_date)
    enabled_slots = _parse_slots_json(day_row.slots_json if day_row else None)
    if slot_time not in enabled_slots:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="არჩეული დღე ან საათი მიუწვდომელია, გთხოვთ აირჩიოთ სხვა დრო",
        )

    existing_slot_booking = db.scalar(
        select(CertBooking).where(
            CertBooking.booking_date == booking_date,
            CertBooking.slot_time == slot_time,
            CertBooking.status == "active",
        )
    )
    if existing_slot_booking is not None and existing_slot_booking.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="ეს დრო უკვე დაჯავშნილია სხვა კანდიდატის მიერ. გთხოვთ აირჩიოთ სხვა საათი",
        )

    if existing_slot_booking is not None and existing_slot_booking.user_id == user.id:
        return _build_user_booking_payload(db, user)

    now_utc = datetime.utcnow()
    # If user already has another active upcoming booking, cancel it first so history is preserved
    user_active_rows = db.scalars(
        select(CertBooking).where(
            CertBooking.user_id == user.id,
            CertBooking.status == "active",
        )
    ).all()
    for prev in user_active_rows:
        if f"{prev.booking_date} {prev.slot_time}" > now_tb_str:
            prev.status = "cancelled"
            prev.cancelled_at = now_utc
            prev.cancelled_by = user.email
            prev.updated_at = now_utc
            db.add(prev)

    new_booking = CertBooking(
        user_id=user.id,
        letter_id=elig.get("letter_id"),
        booking_date=booking_date,
        slot_time=slot_time,
        status="active",
        category=elig.get("category"),
        created_at=now_utc,
        updated_at=now_utc,
    )
    db.add(new_booking)
    db.commit()

    return _build_user_booking_payload(db, user)


@user_router.delete("/me/cert-booking/{booking_id}")
def cancel_my_cert_booking(
    booking_id: int,
    dismiss: bool = False,
    authorization: str | None = Header(None),
    db: Session = Depends(get_db),
):
    user = _require_auth(db, authorization)
    booking = db.scalar(
        select(CertBooking).where(
            CertBooking.id == booking_id,
            CertBooking.user_id == user.id,
        )
    )
    if booking is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="ჯავშანი ვერ მოიძებნა")

    now_tb_str = _now_tbilisi().strftime("%Y-%m-%d %H:%M")
    _, _, is_past = _effective_booking_status(booking, now_tb_str)
    now_utc = datetime.utcnow()
    changed = False

    if booking.status == "active" and not is_past:
        booking.status = "cancelled"
        booking.cancelled_at = now_utc
        _set_cancelled_by_preserving_flags(booking, user.email)
        booking.updated_at = now_utc
        changed = True

    if dismiss and not _has_booking_flag(booking, "hide_user"):
        _add_booking_flag(booking, "hide_user")
        booking.updated_at = now_utc
        changed = True

    if changed:
        db.add(booking)
        db.commit()

    return _build_user_booking_payload(db, user)


# ==================== ADMIN / DIRECTOR ENDPOINTS ====================


class AdminBulkAvailabilityRequest(BaseModel):
    mode: str = Field(..., description="apply_year | apply_month | clear_year | clear_month")
    weekdays: list[int] = Field(default_factory=lambda: [0, 1, 2, 3, 4])
    slots: list[str] | None = None
    year: int | None = None
    month: int | None = None


class AdminDayAvailabilityRequest(BaseModel):
    slots: list[str] = Field(default_factory=list)


def _build_admin_overview(db: Session) -> dict[str, Any]:
    now_tb = _now_tbilisi()
    today_tb = now_tb.date()
    today_str = today_tb.isoformat()
    now_time_str = now_tb.strftime("%H:%M")
    now_tb_str = now_tb.strftime("%Y-%m-%d %H:%M")

    horizon_start = (today_tb - timedelta(days=31)).isoformat()
    horizon_end_date = today_tb + timedelta(days=365)
    horizon_end = horizon_end_date.isoformat()

    weekday_template = _load_weekday_template(db)

    day_rows = db.scalars(
        select(CertBookingDay).where(
            CertBookingDay.date_str >= horizon_start,
            CertBookingDay.date_str <= horizon_end,
        )
    ).all()
    availability: dict[str, list[str]] = {}
    enabled_days_count = 0
    for dr in day_rows:
        if not DATE_RE.match(dr.date_str):
            continue
        try:
            d_obj = date.fromisoformat(dr.date_str)
        except ValueError:
            continue
        if d_obj.weekday() >= 5:
            continue
        slots = _parse_slots_json(dr.slots_json)
        if slots:
            availability[dr.date_str] = slots
            if dr.date_str >= today_str:
                enabled_days_count += 1

    booking_rows = db.scalars(
        select(CertBooking)
        .order_by(CertBooking.booking_date.asc(), CertBooking.slot_time.asc(), CertBooking.id.desc())
    ).all()

    user_ids = sorted({b.user_id for b in booking_rows})
    users_by_id: dict[int, User] = {}
    if user_ids:
        for u in db.scalars(select(User).where(User.id.in_(user_ids))).all():
            users_by_id[u.id] = u

    certs_by_uid: set[int] = set()
    if user_ids:
        certs_by_uid = set(
            db.scalars(select(Certificate.user_id).where(Certificate.user_id.in_(user_ids))).all()
        )

    pass_letters_by_uid: dict[int, PlanningLetter] = {}
    if user_ids:
        p_letters = db.scalars(
            select(PlanningLetter)
            .where(
                PlanningLetter.user_id.in_(user_ids),
                PlanningLetter.kind == "certificate",
                or_(
                    PlanningLetter.period.is_(None),
                    ~PlanningLetter.period.in_(NON_PASS_CERT_PERIODS),
                ),
                PlanningLetter.status != "failed",
            )
            .order_by(PlanningLetter.created_at.desc(), PlanningLetter.id.desc())
        ).all()
        for pl in p_letters:
            if pl.user_id not in pass_letters_by_uid:
                pass_letters_by_uid[pl.user_id] = pl

    bookings_out: list[dict[str, Any]] = []
    upcoming_active_count = 0
    today_active_count = 0

    for b in booking_rows:
        u = users_by_id.get(b.user_id)
        if u is None:
            continue
        eff_status, status_label, is_past = _effective_booking_status(b, now_tb_str)
        if _has_booking_flag(b, "hide_admin") and eff_status != "active":
            continue
        if eff_status == "active":
            upcoming_active_count += 1
            if b.booking_date == today_str:
                today_active_count += 1
        elif b.status == "active" and b.booking_date == today_str:
            today_active_count += 1

        pl = pass_letters_by_uid.get(u.id)
        letter_sent_ka = None
        deadline_ka = None
        if pl is not None:
            l_dt = _to_tbilisi(pl.sent_at or pl.created_at)
            if l_dt is not None:
                letter_sent_ka = l_dt.strftime("%d.%m.%Y")
                deadline_ka = (l_dt.date() + timedelta(days=30)).strftime("%d.%m.%Y")

        cat = normalize_cert_category(b.category or u.candidate_category or "A")
        end_time = _slot_end_time(b.slot_time)
        full_name = f"{(u.first_name or '').strip()} {(u.last_name or '').strip()}".strip() or "—"

        bookings_out.append({
            "id": b.id,
            "user_id": u.id,
            "booking_date": b.booking_date,
            "booking_date_ka": _format_date_ka(b.booking_date),
            "slot_time": b.slot_time,
            "end_time": end_time,
            "time_range": f"{b.slot_time}–{end_time}",
            "status": eff_status,
            "raw_status": b.status,
            "status_label": status_label,
            "is_past": is_past,
            "created_at": _format_dt_ka(b.created_at),
            "cancelled_at": _format_dt_ka(b.cancelled_at),
            "letter_sent_ka": letter_sent_ka,
            "deadline_ka": deadline_ka,
            "user": {
                "id": u.id,
                "full_name": full_name,
                "first_name": u.first_name,
                "last_name": u.last_name,
                "personal_id": u.personal_id or "—",
                "phone": u.phone or "—",
                "email": u.email or "—",
                "code": u.code or "—",
                "category": cat,
                "category_label": CATEGORY_FULL_LABELS.get(cat, f"კატეგორია {cat}"),
                "has_certificate": u.id in certs_by_uid,
            },
        })

    return {
        "today": today_str,
        "now_time": now_time_str,
        "horizon_end": horizon_end,
        "all_slots": ALL_CERT_SLOTS,
        "weekday_template": weekday_template,
        "availability": availability,
        "bookings": bookings_out,
        "summary": {
            "upcoming_active_count": upcoming_active_count,
            "today_active_count": today_active_count,
            "enabled_days_count": enabled_days_count,
        },
    }


@admin_router.get("/cert-bookings/overview")
def admin_get_cert_bookings_overview(
    authorization: str | None = Header(None),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    return _build_admin_overview(db)


@admin_router.post("/cert-bookings/availability/bulk")
def admin_bulk_update_cert_booking_availability(
    payload: AdminBulkAvailabilityRequest,
    authorization: str | None = Header(None),
    db: Session = Depends(get_db),
):
    actor = _require_admin(db, authorization)
    mode = (payload.mode or "").strip().lower()
    if mode not in ("apply_year", "apply_month", "clear_year", "clear_month"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="უცნობი ოპერაციის რეჟიმი")

    weekdays = sorted({int(d) for d in (payload.weekdays or []) if isinstance(d, int) and 0 <= int(d) <= 4})
    raw_slots = payload.slots if payload.slots is not None else ALL_CERT_SLOTS
    slots = sorted(
        {str(s).strip() for s in raw_slots if str(s).strip() in ALL_CERT_SLOTS_SET},
        key=lambda x: ALL_CERT_SLOTS.index(x),
    )

    today_tb = _now_tbilisi().date()
    horizon_end_date = today_tb + timedelta(days=365)

    if mode in ("apply_year", "clear_year"):
        start_d = today_tb
        end_d = horizon_end_date
        if mode == "apply_year":
            _save_weekday_template(db, weekdays, slots, actor.email)
    else:
        if not payload.year or not payload.month or not (1 <= int(payload.month) <= 12):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="წელი და თვე სავალდებულოა")
        y, m = int(payload.year), int(payload.month)
        first_of_month = date(y, m, 1)
        if m == 12:
            last_of_month = date(y + 1, 1, 1) - timedelta(days=1)
        else:
            last_of_month = date(y, m + 1, 1) - timedelta(days=1)
        start_d = max(today_tb, first_of_month)
        end_d = min(horizon_end_date, last_of_month)

    if start_d <= end_d:
        existing_rows = {
            r.date_str: r
            for r in db.scalars(
                select(CertBookingDay).where(
                    CertBookingDay.date_str >= start_d.isoformat(),
                    CertBookingDay.date_str <= end_d.isoformat(),
                )
            ).all()
        }
        now_tb_str = _now_tbilisi().strftime("%Y-%m-%d %H:%M")
        booked_slots_by_date: dict[str, set[str]] = {}
        active_in_range = db.scalars(
            select(CertBooking).where(
                CertBooking.booking_date >= start_d.isoformat(),
                CertBooking.booking_date <= end_d.isoformat(),
                CertBooking.status == "active",
            )
        ).all()
        for ab in active_in_range:
            if ab.slot_time in ALL_CERT_SLOTS_SET and f"{ab.booking_date} {ab.slot_time}" > now_tb_str:
                booked_slots_by_date.setdefault(ab.booking_date, set()).add(ab.slot_time)

        now_utc = datetime.utcnow()
        cur = start_d
        while cur <= end_d:
            if cur.weekday() < 5:  # მხოლოდ სამუშაო დღეები (ორშ–პარ)
                d_str = cur.isoformat()
                preserved = booked_slots_by_date.get(d_str, set())
                if mode in ("clear_year", "clear_month"):
                    merged_slots = set(preserved)
                else:
                    base_slots = slots if cur.weekday() in weekdays else []
                    merged_slots = set(base_slots) | set(preserved)
                target_slots = sorted(merged_slots, key=lambda x: ALL_CERT_SLOTS.index(x))
                slots_str = json.dumps(target_slots)
                row = existing_rows.get(d_str)
                if row is None:
                    if target_slots:
                        db.add(
                            CertBookingDay(
                                date_str=d_str,
                                slots_json=slots_str,
                                updated_at=now_utc,
                                updated_by=actor.email,
                            )
                        )
                else:
                    row.slots_json = slots_str
                    row.updated_at = now_utc
                    row.updated_by = actor.email
                    db.add(row)
            cur += timedelta(days=1)

    db.commit()
    return _build_admin_overview(db)


@admin_router.put("/cert-bookings/availability/{date_str}")
def admin_set_day_cert_booking_availability(
    date_str: str,
    payload: AdminDayAvailabilityRequest,
    authorization: str | None = Header(None),
    db: Session = Depends(get_db),
):
    actor = _require_admin(db, authorization)
    clean_date = (date_str or "").strip()
    if not DATE_RE.match(clean_date):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="თარიღის ფორმატი არასწორია")

    try:
        d_obj = date.fromisoformat(clean_date)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="თარიღი არასწორია") from exc

    if d_obj.weekday() >= 5:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="შაბათ-კვირის მონიშვნა დაუშვებელია")

    now_tb_str = _now_tbilisi().strftime("%Y-%m-%d %H:%M")
    active_day_bookings = db.scalars(
        select(CertBooking).where(
            CertBooking.booking_date == clean_date,
            CertBooking.status == "active",
        )
    ).all()
    preserved_day_slots = {
        b.slot_time
        for b in active_day_bookings
        if b.slot_time in ALL_CERT_SLOTS_SET and f"{b.booking_date} {b.slot_time}" > now_tb_str
    }

    valid_slots = sorted(
        ({str(s).strip() for s in (payload.slots or []) if str(s).strip() in ALL_CERT_SLOTS_SET} | preserved_day_slots),
        key=lambda x: ALL_CERT_SLOTS.index(x),
    )

    row = db.get(CertBookingDay, clean_date)
    now_utc = datetime.utcnow()
    if row is None:
        row = CertBookingDay(
            date_str=clean_date,
            slots_json=json.dumps(valid_slots),
            updated_at=now_utc,
            updated_by=actor.email,
        )
    else:
        row.slots_json = json.dumps(valid_slots)
        row.updated_at = now_utc
        row.updated_by = actor.email
    db.add(row)
    db.commit()

    return _build_admin_overview(db)


class _SimpleBookingEmailPayload:
    def __init__(self, to_email: str, subject: str, body: str, request_id: str) -> None:
        self.to_email = to_email
        self.subject = subject
        self.body = body
        self.request_id = request_id
        self.doc_number = None
        self.attachment_path = None
        self.attachment_filename = None


@admin_router.delete("/cert-bookings/{booking_id}")
def admin_cancel_cert_booking(
    booking_id: int,
    dismiss: bool = False,
    authorization: str | None = Header(None),
    db: Session = Depends(get_db),
):
    actor = _require_admin(db, authorization)
    booking = db.get(CertBooking, booking_id)
    if booking is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="ჯავშანი ვერ მოიძებნა")

    now_tb_str = _now_tbilisi().strftime("%Y-%m-%d %H:%M")
    eff_status, _, is_past = _effective_booking_status(booking, now_tb_str)
    now_utc = datetime.utcnow()

    should_cancel = (booking.status == "active") and (not dismiss or not is_past)
    changed = False

    if should_cancel:
        booking.status = "cancelled"
        booking.cancelled_at = now_utc
        _set_cancelled_by_preserving_flags(booking, actor.email)
        booking.updated_at = now_utc
        changed = True

    if dismiss and not _has_booking_flag(booking, "hide_admin"):
        _add_booking_flag(booking, "hide_admin")
        booking.updated_at = now_utc
        changed = True

    if changed:
        db.add(booking)
        db.commit()

    if should_cancel:
        user = db.get(User, booking.user_id)
        if user and user.email:
            full_name = f"{(user.first_name or '').strip()} {(user.last_name or '').strip()}".strip() or user.email
            date_ka = _format_date_ka(booking.booking_date)
            time_range = f"{booking.slot_time}–{_slot_end_time(booking.slot_time)}"
            subject = "სერტიფიკატის აღების ჯავშნის გაუქმება — GIPC"
            body = (
                f"ადრესატი: {full_name}\n\n"
                "მოგესალმებით,\n\n"
                f"გაცნობებთ, რომ სერტიფიკატის მისაღებად თქვენ მიერ დაჯავშნილი ვიზიტი ({date_ka}, {time_range}) გაუქმდა ადმინისტრაციის მიერ.\n\n"
                "ახალი თარიღისა და დროის ასარჩევად, გთხოვთ ეწვიოთ საიტს gipc.org.ge, გაიაროთ ავტორიზაცია და ზედა პანელზე დააჭიროთ ღილაკს „სერტიფიკატის აღების დაჯავშნა“.\n\n"
                "პატივისცემით,\n"
                "საქართველოს პროფესიული სერტიფიცირების ინსტიტუტი"
            )
            try:
                deliver_letter(
                    _SimpleBookingEmailPayload(
                        to_email=user.email,
                        subject=subject,
                        body=body,
                        request_id=f"booking-cancel-{booking.id}-{int(now_utc.timestamp())}",
                    )
                )
            except Exception:
                pass
    return _build_admin_overview(db)
