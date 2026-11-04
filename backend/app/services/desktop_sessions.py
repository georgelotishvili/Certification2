"""Desktop ownership, not device attestation or an exam/network watchdog.

Installation UUIDs distinguish legitimate retries. They are not passwords and
do not authenticate a binary. Active attempts keep their owner across logout;
the short-lived Home lease never terminates an ongoing/offline exam.
"""
from datetime import datetime, timedelta
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select

from ..models import OfflineExamAttempt, Session as ExamSession, UserSession

DESKTOP_LEASE_SECONDS = 120


def request_device_id(request) -> str | None:
    raw = request.headers.get("x-gipc-device-id") if request is not None else None
    if raw is None:
        return None  # Compatibility with already installed clients.
    try:
        if len(raw) != 36:
            raise ValueError()
        return str(UUID(raw))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(400, "Invalid desktop device identifier")


def is_desktop_request(request) -> bool:
    if request is None:
        return False
    ua = (request.headers.get("user-agent") or "").lower()
    return bool(request_device_id(request) or "certification-exam-app" in ua or "electron/" in ua)


def require_matching_device(owner_device: str | None, device_id: str | None) -> None:
    # Bound resources cannot be recovered simply by removing the header/UA.
    if owner_device is not None and owner_device != device_id:
        raise HTTPException(409, "ეს საგამოცდო მცდელობა სხვა მოწყობილობას ეკუთვნის.")


def require_login_available(db, user, device_id: str | None, now: datetime) -> None:
    """Caller holds the per-user transition lock until session commit."""
    active_owners = list(db.scalars(select(ExamSession.device_id).where(
        ExamSession.user_id == user.id, ExamSession.finished_at.is_(None),
        ExamSession.active.is_(True), ExamSession.ends_at > now,
    ))) + list(db.scalars(select(OfflineExamAttempt.device_id).where(
        OfflineExamAttempt.user_id == user.id, OfflineExamAttempt.submitted_at.is_(None),
        OfflineExamAttempt.ends_at > now,
    )))
    if any(owner is None or device_id is None or owner != device_id for owner in active_owners):
        raise HTTPException(409, "ამ მომხმარებლის გამოცდა სხვა ან ძველ აპში მიმდინარეობს. მიმართეთ ადმინისტრატორს.")
    sessions = db.scalars(select(UserSession).where(
        UserSession.user_id == user.id, UserSession.client_type == "desktop",
        UserSession.expires_at > now,
        UserSession.last_used_at >= now - timedelta(seconds=DESKTOP_LEASE_SECONDS),
    ))
    if any(device_id is None or session.device_id != device_id for session in sessions):
        raise HTTPException(409, "ეს მომხმარებელი უკვე შესულია სხვა საგამოცდო მოწყობილობაზე.")


def authenticated_device(db, authorization: str | None, request) -> str | None:
    """Validate a bound login on preparation/start, retaining unbound legacy calls."""
    device_id = request_device_id(request)
    token = authorization.split(" ", 1)[1].strip() if authorization and " " in authorization else None
    session = db.scalar(select(UserSession).where(UserSession.token == token)) if token else None
    if session is not None:
        require_matching_device(session.device_id, device_id)
    return device_id
