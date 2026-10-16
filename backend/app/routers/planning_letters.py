from __future__ import annotations

from datetime import date, datetime
import hashlib
import json
from pathlib import Path
import re
from typing import Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import ExamSchedule, PlanningLetter, PlanningTemplate, User
from ..services.bounded_upload import UploadTooLarge, save_upload_stream
from ..services.media_storage import ensure_media_root, relative_storage_path, resolve_storage_path
from ..services.planning_email import ATTACHMENT_MAX_BYTES, deliver_letter
from .admin import _require_admin

router = APIRouter()
Kind = Literal["exam", "certificate"]
ALLOWED_EXTENSIONS = {".pdf", ".doc", ".docx", ".xls", ".xlsx", ".jpg", ".jpeg", ".png", ".zip", ".rar"}
DEFAULT_TEMPLATES = {
    "exam": {
        "subject": "გამოცდის დაგეგმვა — {date}, {time}",
        "body": "გამარჯობა, {name},\n\nთქვენი გამოცდა დაგეგმილია {date}, {time} საათზე (თბილისის დროით).\n\nგამოცდაზე მოსვლამდე გთხოვთ:\n1. გაეცნოთ ჩვენს საიტზე განთავსებულ საგამოცდო ინფორმაციას: [შეავსეთ ინფორმაციის ბმული].\n2. გადაიხადოთ გამოცდის საფასური — 350 ლარი.\n\nმიმღები: [შეავსეთ ორგანიზაციის დასახელება]\nანგარიშის ნომერი: [შეავსეთ ანგარიშის ნომერი]\nგადახდის დანიშნულება: გამოცდის საფასური — {name}, კოდი {code}.\n\nგამოცდაზე დაშვებისთვის საფასური წინასწარ უნდა იყოს დაფარული.\n\nპატივისცემით,\nGIPC",
    },
    "certificate": {
        "subject": "სერტიფიკატის გადაცემა — {date}, {time}",
        "body": "გამარჯობა, {name},\n\nთქვენი სერტიფიკატის გადაცემა დაგეგმილია {date}, {time} საათზე (თბილისის დროით).\n\nთქვენი უნიკალური კოდი: {code}.\n\nპატივისცემით,\nGIPC",
    },
}


def _iso(value):
    return value.isoformat() if value is not None else None


def _template_out(kind: str, template: PlanningTemplate | None):
    return {
        "kind": kind,
        "subject": template.subject if template else DEFAULT_TEMPLATES[kind]["subject"],
        "body": template.body if template else DEFAULT_TEMPLATES[kind]["body"],
        "updated_at": _iso(template.updated_at) if template else None,
        "attachment_filename": template.attachment_filename if template else None,
        "attachment_size_bytes": template.attachment_size_bytes if template else None,
    }


def _letter_out(letter: PlanningLetter):
    return {
        key: _iso(getattr(letter, key)) if key in ("event_date", "created_at", "sent_at") else getattr(letter, key)
        for key in (
            "id", "user_id", "kind", "event_date", "event_time", "period", "exam_schedule_id",
            "request_id", "to_email", "subject", "body", "status", "error", "created_at", "sent_at",
            "attachment_filename", "attachment_size_bytes", "attempts",
        )
    }


def _text(subject: str, body: str, *, final: bool):
    # Keep the exact preview text; do not silently rerender a confirmed letter.
    if not subject.strip() or len(subject) > 200 or any(char in subject for char in "\r\n\x00"):
        raise HTTPException(422, "წერილის სათაური აუცილებელია (მაქსიმუმ 200 სიმბოლო, ერთ ხაზზე).")
    if not body.strip() or len(body) > 10000 or "\x00" in body:
        raise HTTPException(422, "წერილის ტექსტი აუცილებელია (მაქსიმუმ 10000 სიმბოლო).")
    if final and re.search(
        r"\{(?:name|date|time|code)\}|\[(?:სახელი და გვარი|გამოცდის თარიღი|საათი|უნიკალური კოდი|შეავსეთ[^\]]*|IBAN)\]",
        subject + "\n" + body,
        re.IGNORECASE,
    ):
        raise HTTPException(422, "გაგზავნამდე შეავსეთ წერილის ყველა ცვლადი, ანგარიშის ნომერი და ინფორმაციის ბმული.")


def _filename(upload: UploadFile) -> str:
    name = str(upload.filename or "").replace("\\", "/").rsplit("/", 1)[-1]
    if not name or len(name) > 200 or any(ord(char) < 32 or ord(char) == 127 for char in name):
        raise HTTPException(422, "ფაილის სახელი არასწორია.")
    if Path(name).suffix.lower() not in ALLOWED_EXTENSIONS:
        raise HTTPException(422, "დასაშვებია PDF, Word, Excel, JPEG, PNG, ZIP ან RAR ფაილი.")
    return name


def _upload_digest(upload: UploadFile | None) -> str | None:
    if upload is None:
        return None
    _filename(upload)
    digest = hashlib.sha256()
    total = 0
    while True:
        chunk = upload.file.read(min(1024 * 1024, ATTACHMENT_MAX_BYTES - total + 1))
        if not chunk:
            break
        total += len(chunk)
        if total > ATTACHMENT_MAX_BYTES:
            raise HTTPException(413, "ფაილის მაქსიმალური ზომაა 10 MB.")
        digest.update(chunk)
    upload.file.seek(0)
    if not total:
        raise HTTPException(422, "ცარიელი ფაილის მიმაგრება შეუძლებელია.")
    return digest.hexdigest()


def _directory(namespace: str) -> Path:
    root = ensure_media_root().resolve()
    directory = (root / "planning" / namespace).resolve()
    if not directory.is_relative_to(root / "planning"):
        raise HTTPException(500, "ფაილის საცავი მიუწვდომელია.")
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _checked_path(storage_path: str, namespace: str) -> Path:
    try:
        path = resolve_storage_path(storage_path)
        if path.parent != _directory(namespace):
            raise ValueError("Wrong planning attachment owner")
        return path
    except ValueError as exc:
        raise HTTPException(404, "ფაილი ვერ მოიძებნა.") from exc


def _remove_file(storage_path: str | None, namespace: str):
    if not storage_path:
        return
    try:
        _checked_path(storage_path, namespace).unlink(missing_ok=True)
    except (HTTPException, OSError):
        pass


def _store(stream, filename: str, namespace: str):
    path = _directory(namespace) / f"{uuid4().hex}{Path(filename).suffix.lower()}"
    try:
        size = save_upload_stream(stream, path, max_bytes=ATTACHMENT_MAX_BYTES)
    except UploadTooLarge as exc:
        raise HTTPException(413, "ფაილის მაქსიმალური ზომაა 10 MB.") from exc
    if not size:
        path.unlink(missing_ok=True)
        raise HTTPException(422, "ცარიელი ფაილის მიმაგრება შეუძლებელია.")
    return relative_storage_path(path), filename, size


def _download(storage_path, filename, namespace):
    if not storage_path:
        raise HTTPException(404, "მიმაგრებული ფაილი არ არის.")
    path = _checked_path(storage_path, namespace)
    if not path.is_file():
        raise HTTPException(404, "ფაილი ვერ მოიძებნა.")
    return FileResponse(path, filename=filename, media_type="application/octet-stream", headers={
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    })


@router.get("/planning-templates")
def list_templates(authorization: str | None = Header(None), db: Session = Depends(get_db)):
    _require_admin(db, authorization)
    templates = {item.kind: item for item in db.scalars(select(PlanningTemplate)).all()}
    return {"items": [_template_out(kind, templates.get(kind)) for kind in DEFAULT_TEMPLATES]}


@router.put("/planning-templates/{kind}")
def save_template(
    kind: Kind,
    subject: str = Form(...), body: str = Form(...),
    attachment: UploadFile | None = File(None), remove_attachment: bool = Form(False),
    expected_updated_at: str | None = Form(None),
    authorization: str | None = Header(None), db: Session = Depends(get_db),
):
    actor = _require_admin(db, authorization)
    _text(subject, body, final=False)
    _upload_digest(attachment)
    template = db.get(PlanningTemplate, kind)
    if expected_updated_at and expected_updated_at != (_iso(template.updated_at) if template else None):
        raise HTTPException(409, "შაბლონი უკვე შეიცვალა. განაახლეთ და გადაამოწმეთ.")
    old_path = template.attachment_path if template else None
    if template is None:
        template = PlanningTemplate(kind=kind)
        db.add(template)
    new_path = None
    namespace = f"templates/{kind}"
    try:
        if attachment:
            new_path, name, size = _store(attachment.file, _filename(attachment), namespace)
            template.attachment_path, template.attachment_filename, template.attachment_size_bytes = new_path, name, size
        elif remove_attachment:
            template.attachment_path = template.attachment_filename = template.attachment_size_bytes = None
        template.subject, template.body = subject, body
        template.updated_at, template.updated_by = datetime.utcnow(), actor.email
        db.commit()
    except Exception:
        db.rollback()
        _remove_file(new_path, namespace)
        raise
    if old_path and (attachment or remove_attachment):
        _remove_file(old_path, namespace)
    db.refresh(template)
    return _template_out(kind, template)


@router.get("/planning-templates/{kind}/attachment")
def template_attachment(kind: Kind, authorization: str | None = Header(None), db: Session = Depends(get_db)):
    _require_admin(db, authorization)
    template = db.get(PlanningTemplate, kind)
    if template is None:
        raise HTTPException(404, "შაბლონი ვერ მოიძებნა.")
    return _download(template.attachment_path, template.attachment_filename, f"templates/{kind}")


@router.get("/users/{user_id}/planning-letters")
def list_letters(user_id: int, authorization: str | None = Header(None), db: Session = Depends(get_db)):
    _require_admin(db, authorization)
    if db.get(User, user_id) is None:
        raise HTTPException(404, "პირი ვერ მოიძებნა.")
    letters = db.scalars(select(PlanningLetter).where(PlanningLetter.user_id == user_id).order_by(PlanningLetter.id.desc())).all()
    return {"items": [_letter_out(letter) for letter in letters]}


def _deliver(db: Session, letter: PlanningLetter):
    # The committed sending state is the durable claim. Duplicate requests and
    # simultaneous retries see it and cannot submit this letter a second time.
    try:
        delivery_status, error = deliver_letter(letter)
        if delivery_status not in ("sent", "failed", "simulated", "uncertain"):
            raise ValueError("Invalid delivery result")
    except Exception:
        delivery_status, error = "uncertain", "გაგზავნის შედეგი დაუდასტურებელია. გადაამოწმეთ ოფიციალური ელფოსტა."
    letter.status, letter.error = delivery_status, error
    if delivery_status == "sent":
        letter.sent_at = datetime.utcnow()
    db.commit()
    db.refresh(letter)
    return _letter_out(letter)


@router.post("/users/{user_id}/planning-letters")
def send_letter(
    user_id: int, kind: Kind = Form(...), event_date: str = Form(...), event_time: str = Form(...),
    subject: str = Form(...), body: str = Form(...), request_id: str = Form(...),
    expected_to_email: str = Form(...), confirmed: bool = Form(False),
    attachment: UploadFile | None = File(None), use_template_attachment: bool = Form(True),
    template_updated_at: str | None = Form(None),
    authorization: str | None = Header(None), db: Session = Depends(get_db),
):
    actor = _require_admin(db, authorization)
    if not confirmed:
        raise HTTPException(422, "გაგზავნის დასადასტურებლად ჯერ გადაამოწმეთ წერილი.")
    _text(subject, body, final=True)
    try:
        request_id = str(UUID(request_id))
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", event_date) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", event_time):
            raise ValueError("Invalid date/time")
        day = date.fromisoformat(event_date)
    except ValueError as exc:
        raise HTTPException(422, "თარიღი, საათი ან მოთხოვნის კოდი არასწორია.") from exc
    digest = _upload_digest(attachment)
    fingerprint = hashlib.sha256(json.dumps({
        "user_id": user_id, "kind": kind, "date": event_date, "time": event_time,
        "subject": subject, "body": body, "to": expected_to_email, "file": digest,
        "filename": _filename(attachment) if attachment else None,
        "template_file": use_template_attachment, "template_version": template_updated_at,
    }, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
    prior = db.scalar(select(PlanningLetter).where(PlanningLetter.request_id == request_id))
    if prior:
        if prior.user_id != user_id or prior.request_fingerprint != fingerprint:
            raise HTTPException(409, "ამ მოთხოვნის კოდით სხვა წერილი უკვე არსებობს. თავიდან გადაამოწმეთ.")
        return _letter_out(prior)
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(404, "პირი ვერ მოიძებნა.")
    if user.email != expected_to_email:
        raise HTTPException(409, "მიმღების ელფოსტა შეიცვალა. თავიდან გადაამოწმეთ წერილი.")
    template = db.get(PlanningTemplate, kind)
    if use_template_attachment and not attachment:
        if template_updated_at != (_iso(template.updated_at) if template else None):
            raise HTTPException(409, "შაბლონი შეიცვალა. თავიდან გადაამოწმეთ წერილი და დანართი.")
    period = ("morning" if event_time < "12:00" else "evening") if kind == "exam" else None
    letter = PlanningLetter(
        user_id=user_id, kind=kind, event_date=day, event_time=event_time, period=period,
        request_id=request_id, request_fingerprint=fingerprint, to_email=user.email,
        subject=subject, body=body, status="sending", attempts=1, created_by=actor.email,
    )
    namespace = f"letters/{user_id}"
    new_path = None
    try:
        if kind == "exam":
            schedule = db.scalar(select(ExamSchedule).where(
                ExamSchedule.user_id == user_id, ExamSchedule.exam_date == day, ExamSchedule.period == period,
            ))
            if schedule:
                existing_letter = db.scalar(select(PlanningLetter).where(PlanningLetter.exam_schedule_id == schedule.id))
                if existing_letter:
                    raise HTTPException(409, "ამ თარიღისა და ჯგუფისთვის წერილი უკვე არსებობს. გამოიყენეთ ისტორია.")
            else:
                schedule = ExamSchedule(user_id=user_id, exam_date=day, period=period)
                db.add(schedule)
                db.flush()
            letter.exam_schedule_id = schedule.id
        if attachment:
            new_path, name, size = _store(attachment.file, _filename(attachment), namespace)
            letter.attachment_path, letter.attachment_filename, letter.attachment_size_bytes = new_path, name, size
        elif use_template_attachment and template and template.attachment_path:
            source = _checked_path(template.attachment_path, f"templates/{kind}")
            if not source.is_file():
                raise HTTPException(409, "შაბლონის დანართი აღარ არის ხელმისაწვდომი. თავიდან გადაამოწმეთ.")
            with source.open("rb") as stream:
                new_path, name, size = _store(stream, template.attachment_filename, namespace)
            letter.attachment_path, letter.attachment_filename, letter.attachment_size_bytes = new_path, name, size
        db.add(letter)
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        _remove_file(new_path, namespace)
        prior = db.scalar(select(PlanningLetter).where(PlanningLetter.request_id == request_id))
        if prior and prior.user_id == user_id and prior.request_fingerprint == fingerprint:
            return _letter_out(prior)
        raise HTTPException(409, "დაგეგმვა უკვე შეიცვალა. განაახლეთ ისტორია და გადაამოწმეთ.") from exc
    except Exception:
        db.rollback()
        _remove_file(new_path, namespace)
        raise
    db.refresh(letter)
    return _deliver(db, letter)


def _user_letter(db, user_id, letter_id):
    letter = db.scalar(select(PlanningLetter).where(PlanningLetter.id == letter_id, PlanningLetter.user_id == user_id))
    if letter is None:
        raise HTTPException(404, "წერილი ვერ მოიძებნა.")
    return letter


@router.get("/users/{user_id}/planning-letters/{letter_id}/attachment")
def letter_attachment(user_id: int, letter_id: int, authorization: str | None = Header(None), db: Session = Depends(get_db)):
    _require_admin(db, authorization)
    letter = _user_letter(db, user_id, letter_id)
    return _download(letter.attachment_path, letter.attachment_filename, f"letters/{user_id}")


@router.post("/users/{user_id}/planning-letters/{letter_id}/retry")
def retry_letter(user_id: int, letter_id: int, authorization: str | None = Header(None), db: Session = Depends(get_db)):
    _require_admin(db, authorization)
    letter = _user_letter(db, user_id, letter_id)
    user = db.get(User, user_id)
    if user is None or user.email != letter.to_email:
        raise HTTPException(409, "მიმღების ელფოსტა შეიცვალა. ამ წერილის გამეორება შეუძლებელია.")
    # Simulated is deliberately not retryable: a local test must never be sent
    # accidentally after switching the environment to SMTP.
    claimed = db.execute(update(PlanningLetter).where(
        PlanningLetter.id == letter_id, PlanningLetter.status == "failed",
    ).values(status="sending", error=None, attempts=PlanningLetter.attempts + 1))
    db.commit()
    db.refresh(letter)
    if not claimed.rowcount:
        return _letter_out(letter)
    return _deliver(db, letter)
