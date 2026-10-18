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
from ..models import Certificate, ExamSchedule, PlanningLetter, PlanningTemplate, User, format_letter_doc_number
from ..services.bounded_upload import UploadTooLarge, save_upload_stream
from ..services.candidate_status import (
    VALID_CANDIDATE_CATEGORIES,
    get_user_latest_requested_category,
    normalize_cert_category,
)
from ..services.media_storage import ensure_media_root, relative_storage_path, resolve_storage_path
from ..services.planning_email import ATTACHMENT_MAX_BYTES, deliver_letter
from .admin import _require_admin

router = APIRouter()
Kind = Literal["exam", "certificate"]
TemplateKind = Literal["exam", "certificate", "rejection", "exam_fail", "cert_issued"]
ActionMode = Literal["save_and_send", "save_only", "send_only"]
ALLOWED_EXTENSIONS = {".pdf", ".doc", ".docx", ".xls", ".xlsx", ".jpg", ".jpeg", ".png", ".zip", ".rar"}
DEFAULT_TEMPLATES = {
    "exam": {
        "subject": "გამოცდაზე დაშვება",
        "body": (
            "ადრესატი: {name}\n\n"
            "მოგესალმებით,\n\n"
            "გაცნობებთ, რომ თქვენი განაცხადი დადასტურდა და დაშვებული ხართ სერტიფიცირების გამოცდაზე. თქვენი გამოცდა დაიგეგმა {date}, {time}-ზე, მისამართზე: ქ. თბილისი, მირიან მეფის ქუჩა №98, მე-2 სართული, საოფისე ფართი №6.\n\n"
            "გამოცდაზე დასაშვებად აუცილებელია:\n"
            "- საგამოცდო მომსახურების ხელშეკრულებაზე ხელმოწერამდე გადაიხადოთ საგამოცდო საფასური (350 ლარი) უნაღდო ანგარიშსწორებით ანგარიშზე: GE33TB7313736080100014 (დანიშნულება: საგამოცდო საფასური, {name});\n"
            "- საგამოცდო ცენტრში გამოცხადდეთ გამოცდის დაწყებამდე 30 წუთით ადრე პირადობის დამადასტურებელი მოქმედი დოკუმენტით, ხელშეკრულებაზე ხელმოწერისა და რეგისტრაციის გავლის მიზნით.\n\n"
            "გთხოვთ წინასწარ გაეცნოთ შესაბამისი მომსახურების ხელშეკრულებას, რომელიც განთავსებულია საიტზე gipc.org.ge.\n\n"
            "პატივისცემით,\n"
            "საქართველოს პროფესიული სერტიფიცირების ინსტიტუტი"
        ),
    },
    "certificate": {
        "subject": "სერტიფიცირების გამოცდის წარმატებით ჩაბარება",
        "body": (
            "ადრესატი: {name}\n\n"
            "მოგესალმებით,\n\n"
            "გაცნობებთ, რომ თქვენ წარმატებით ჩააბარეთ სერტიფიცირების გამოცდა და მიღებულია გადაწყვეტილება თქვენთვის [კატეგორია] სერტიფიკატის მინიჭების შესახებ.\n\n"
            "სერტიფიკატის მისაღებად აუცილებელია წინამდებარე შეტყობინების მიღებიდან 1 თვის ვადაში:\n"
            "- სასერტიფიკაციო ხელშეკრულებაზე ხელმოწერამდე გადაიხადოთ სერტიფიკატის გაცემის საფასური (3 000 ლარი) უნაღდო ანგარიშსწორებით ანგარიშზე: GE33TB7313736080100014 (დანიშნულება: სერტიფიკატის გაცემის საფასური, {name});\n"
            "- გააფორმოთ სასერტიფიკაციო ხელშეკრულება ინსტიტუტის ოფისში (მისამართი: ქ. თბილისი, მირიან მეფის ქუჩა №98, მე-2 სართული, საოფისე ფართი №6) ან კვალიფიციური ელექტრონული ხელმოწერით.\n\n"
            "საფასურის გადახდისა და სასერტიფიკაციო ხელშეკრულების ხელმოწერიდან არაუმეტეს 10 სამუშაო დღის ვადაში გაიცემა სერტიფიკატი და გააქტიურდება საიტზე gipc.org.ge-ზე არსებულ საჯარო რეესტრში.\n\n"
            "გთხოვთ წინასწარ გაეცნოთ შესაბამის სასერტიფიკაციო ხელშეკრულებას, რომელიც განთავსებულია საიტზე gipc.org.ge.\n\n"
            "პატივისცემით,\n"
            "საქართველოს პროფესიული სერტიფიცირების ინსტიტუტი"
        ),
    },
}
CUSTOM_FILE_TEMPLATES = {
    "rejection": {
        "subject": "განაცხადის უარყოფა",
        "body": (
            "ადრესატი: {name}\n\n"
            "მოგესალმებით,\n\n"
            "გაცნობებთ, რომ თქვენი განაცხადი არ დაკმაყოფილდა, ვინაიდან ვერ აკმაყოფილებთ საქართველოს მთავრობის №134 დადგენილებითა და სერტიფიკაციის სქემით განსაზღვრულ სასერტიფიკაციო მოთხოვნებს.\n\n"
            "გადაწყვეტილების გასაჩივრების წესი და ვადები იხილეთ საიტზე gipc.org.ge-ზე გამოქვეყნებულ შესაბამის ოფიციალურ დოკუმენტებში.\n\n"
            "პატივისცემით,\n"
            "საქართველოს პროფესიული სერტიფიცირების ინსტიტუტი"
        ),
    },
    "exam_fail": {
        "subject": "სერტიფიცირების გამოცდის შედეგი",
        "body": (
            "ადრესატი: {name}\n\n"
            "მოგესალმებით,\n\n"
            "გაცნობებთ, რომ სერტიფიცირების გამოცდაზე ვერ დააკმაყოფილეთ სერტიფიცირების სქემით დადგენილი გამსვლელი ბარიერი.\n\n"
            "განმეორებით გამოცდაზე გასვლისა და შედეგის გასაჩივრების (აპელაციის) წესი განთავსებულია საიტზე gipc.org.ge.\n\n"
            "პატივისცემით,\n"
            "საქართველოს პროფესიული სერტიფიცირების ინსტიტუტი"
        ),
    },
    "cert_issued": {
        "subject": "სერტიფიკატის გაცემა და საჯარო რეესტრში ასახვა",
        "body": (
            "ადრესატი: {name}\n\n"
            "მოგესალმებით,\n\n"
            "გილოცავთ! თქვენზე გაიცა სერტიფიკატი.\n\n"
            "თქვენი სერტიფიკატი უკვე აისახა საიტზე gipc.org.ge-ზე არსებულ სერტიფიცირებულ პირთა საჯარო რეესტრში, ხოლო ელექტრონული სერტიფიკატი (PDF) ხელმისაწვდომია და შეგიძლიათ ჩამოტვირთოთ საიტზე თქვენს პირად გვერდზე („ჩემი გვერდი“).\n\n"
            "პატივისცემით,\n"
            "საქართველოს პროფესიული სერტიფიცირების ინსტიტუტი"
        ),
    },
}
DEFAULT_REJECTION_TEMPLATE = CUSTOM_FILE_TEMPLATES["rejection"]
DEFAULT_SCHEDULE_TIMES = {
    "morning": "10:00",
    "evening": "14:00",
}
_TIME_RE = re.compile(r"(?:[01]\d|2[0-3]):[0-5]\d")


def _iso(value):
    return value.isoformat() if value is not None else None


def _schedule_times_path() -> Path:
    return _directory("templates") / "schedule_times.json"


def _load_schedule_times() -> dict[str, str]:
    result = dict(DEFAULT_SCHEDULE_TIMES)
    path = _schedule_times_path()
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                for key in ("morning", "evening"):
                    val = str(data.get(key) or "").strip()
                    if _TIME_RE.fullmatch(val):
                        result[key] = val
        except Exception:
            pass
    return result


def _save_schedule_times(*, morning: str | None = None, evening: str | None = None) -> dict[str, str]:
    current = _load_schedule_times()
    if morning is not None:
        m_val = str(morning).strip()
        if not _TIME_RE.fullmatch(m_val):
            raise HTTPException(422, "დილის საათის ფორმატი არასწორია (მაგ.: 10:00).")
        current["morning"] = m_val
    if evening is not None:
        e_val = str(evening).strip()
        if not _TIME_RE.fullmatch(e_val):
            raise HTTPException(422, "საღამოს საათის ფორმატი არასწორია (მაგ.: 14:00).")
        current["evening"] = e_val
    try:
        _schedule_times_path().write_text(
            json.dumps(current, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception:
        pass
    return current


def _is_legacy_body(body: str | None) -> bool:
    raw = str(body or "").strip()
    return (
        not raw
        or raw.startswith("ბატონო/ქალბატონო")
        or raw.startswith("გამარჯობა,")
        or "GIPC-PRO-" in raw
        or "GIPC-CON-" in raw
        or "GIPC-FRM-" in raw
        or "შპს „საქართველოს პროფესიული სერტიფიცირების ინსტიტუტი“" in raw
        or 'შპს "საქართველოს პროფესიული სერტიფიცირების ინსტიტუტი"' in raw
    )


def _template_out(kind: str, template: PlanningTemplate | None):
    use_default = template is None or _is_legacy_body(template.body)
    return {
        "kind": kind,
        "subject": DEFAULT_TEMPLATES[kind]["subject"] if use_default else template.subject,
        "body": DEFAULT_TEMPLATES[kind]["body"] if use_default else template.body,
        "updated_at": _iso(template.updated_at) if template else None,
        "attachment_filename": template.attachment_filename if template else None,
        "attachment_size_bytes": template.attachment_size_bytes if template else None,
    }


def _custom_template_meta_path(kind: str) -> Path:
    return _directory(f"templates/{kind}") / "template.json"


def _load_custom_template_meta(kind: str) -> dict:
    path = _custom_template_meta_path(kind)
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except Exception:
            pass
    return {}


def _custom_template_out(kind: str, meta: dict | None = None) -> dict:
    meta = meta if meta is not None else _load_custom_template_meta(kind)
    defaults = CUSTOM_FILE_TEMPLATES[kind]
    use_default = _is_legacy_body(meta.get("body"))
    return {
        "kind": kind,
        "subject": defaults["subject"] if use_default else (meta.get("subject") or defaults["subject"]),
        "body": defaults["body"] if use_default else (meta.get("body") or defaults["body"]),
        "updated_at": meta.get("updated_at"),
        "attachment_filename": meta.get("attachment_filename"),
        "attachment_size_bytes": meta.get("attachment_size_bytes"),
    }


def _letter_out(letter: PlanningLetter):
    out = {
        key: _iso(getattr(letter, key)) if key in ("event_date", "created_at", "sent_at") else getattr(letter, key)
        for key in (
            "id", "user_id", "kind", "event_date", "event_time", "period", "exam_schedule_id",
            "request_id", "to_email", "subject", "body", "status", "error", "created_at", "sent_at",
            "attachment_filename", "attachment_size_bytes", "attempts",
        )
    }
    out["doc_number"] = format_letter_doc_number(letter)
    if letter.attempts == 0 and letter.sent_at is None:
        out["status"] = "saved"
    if letter.user is not None:
        out["user_candidate_status"] = letter.user.candidate_status
        out["user_candidate_category"] = letter.user.candidate_category
    return out


def _text(subject: str, body: str, *, final: bool):
    # Keep the exact preview text; do not silently rerender a confirmed letter.
    if not subject.strip() or len(subject) > 200 or any(char in subject for char in "\r\n\x00"):
        raise HTTPException(422, "წერილის სათაური აუცილებელია (მაქსიმუმ 200 სიმბოლო, ერთ ხაზზე).")
    if not body.strip() or len(body) > 10000 or "\x00" in body:
        raise HTTPException(422, "წერილის ტექსტი აუცილებელია (მაქსიმუმ 10000 სიმბოლო).")
    if final and re.search(
        r"\{(?:name|date|time|code|personal_id|period)\}|\[(?:სახელი და გვარი|გამოცდის თარიღი|საათი|უნიკალური კოდი|პირადი ნომერი|შეავსეთ[^\]]*|IBAN)\]",
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
    return {
        "items": [_template_out(kind, templates.get(kind)) for kind in DEFAULT_TEMPLATES],
        "rejection_template": _custom_template_out("rejection"),
        "exam_fail_template": _custom_template_out("exam_fail"),
        "cert_issued_template": _custom_template_out("cert_issued"),
        "schedule_times": _load_schedule_times(),
    }


@router.put("/planning-schedule-times")
def update_schedule_times(
    morning: str | None = Form(None),
    evening: str | None = Form(None),
    authorization: str | None = Header(None),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    saved = _save_schedule_times(morning=morning, evening=evening)
    return {"schedule_times": saved}


@router.put("/planning-templates/{kind}")
def save_template(
    kind: TemplateKind,
    subject: str = Form(...), body: str = Form(...),
    attachment: UploadFile | None = File(None), remove_attachment: bool = Form(False),
    expected_updated_at: str | None = Form(None),
    authorization: str | None = Header(None), db: Session = Depends(get_db),
):
    actor = _require_admin(db, authorization)
    _text(subject, body, final=False)
    _upload_digest(attachment)
    namespace = f"templates/{kind}"
    if kind in CUSTOM_FILE_TEMPLATES:
        meta = _load_custom_template_meta(kind)
        if expected_updated_at and expected_updated_at != meta.get("updated_at"):
            raise HTTPException(409, "შაბლონი უკვე შეიცვალა. განაახლეთ და გადაამოწმეთ.")
        old_path = meta.get("attachment_path")
        new_path = None
        try:
            if attachment:
                new_path, name, size = _store(attachment.file, _filename(attachment), namespace)
                meta["attachment_path"] = new_path
                meta["attachment_filename"] = name
                meta["attachment_size_bytes"] = size
            elif remove_attachment:
                meta["attachment_path"] = None
                meta["attachment_filename"] = None
                meta["attachment_size_bytes"] = None
            meta["subject"] = subject
            meta["body"] = body
            meta["updated_at"] = datetime.utcnow().isoformat()
            meta["updated_by"] = actor.email
            _custom_template_meta_path(kind).write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            _remove_file(new_path, namespace)
            raise
        if old_path and (attachment or remove_attachment):
            _remove_file(old_path, namespace)
        return _custom_template_out(kind, meta)

    template = db.get(PlanningTemplate, kind)
    if expected_updated_at and expected_updated_at != (_iso(template.updated_at) if template else None):
        raise HTTPException(409, "შაბლონი უკვე შეიცვალა. განაახლეთ და გადაამოწმეთ.")
    old_path = template.attachment_path if template else None
    if template is None:
        template = PlanningTemplate(kind=kind)
        db.add(template)
    new_path = None
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
def template_attachment(kind: TemplateKind, authorization: str | None = Header(None), db: Session = Depends(get_db)):
    _require_admin(db, authorization)
    if kind in CUSTOM_FILE_TEMPLATES:
        meta = _load_custom_template_meta(kind)
        if not meta:
            raise HTTPException(404, "შაბლონი ვერ მოიძებნა.")
        return _download(meta.get("attachment_path"), meta.get("attachment_filename"), f"templates/{kind}")
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
    user_id: int, kind: Kind = Form("exam"), event_date: str = Form(""), event_time: str = Form(""),
    subject: str = Form(...), body: str = Form(...), request_id: str = Form(...),
    expected_to_email: str = Form(...), confirmed: bool = Form(False),
    attachment: UploadFile | None = File(None), use_template_attachment: bool = Form(True),
    template_updated_at: str | None = Form(None),
    period: str | None = Form(None),
    action_mode: str = Form("save_and_send"),
    schedule_id: int | None = Form(None),
    edit_letter_id: int | None = Form(None),
    keep_existing_attachment: bool = Form(False),
    candidate_category: str | None = Form(None),
    authorization: str | None = Header(None), db: Session = Depends(get_db),
):
    actor = _require_admin(db, authorization)
    if not confirmed:
        raise HTTPException(422, "გაგზავნის დასადასტურებლად ჯერ გადაამოწმეთ წერილი.")
    if action_mode not in ("save_and_send", "save_only", "send_only"):
        raise HTTPException(422, "მოქმედების რეჟიმი არასწორია.")
    custom_kind = period if period in ("rejection", "exam_fail", "custom") else None
    if period is not None and period not in ("morning", "evening", "rejection", "exam_fail", "custom"):
        raise HTTPException(422, "ცვლა (დილით/საღამოს) არასწორია.")
    if custom_kind:
        if not event_date.strip():
            event_date = date.today().isoformat()
        if not event_time.strip():
            event_time = "00:00"
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
        "period": period, "action_mode": action_mode,
        "schedule_id": schedule_id, "edit_letter_id": edit_letter_id,
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
    template = None
    custom_meta = None
    if custom_kind in ("rejection", "exam_fail"):
        custom_meta = _load_custom_template_meta(custom_kind)
        if use_template_attachment and not attachment and not keep_existing_attachment:
            if template_updated_at and template_updated_at != custom_meta.get("updated_at"):
                raise HTTPException(409, "შაბლონი შეიცვალა. თავიდან გადაამოწმეთ წერილი და დანართი.")
    elif not custom_kind:
        template = db.get(PlanningTemplate, kind)
        if use_template_attachment and not attachment and not keep_existing_attachment:
            if template_updated_at != (_iso(template.updated_at) if template else None):
                raise HTTPException(409, "შაბლონი შეიცვალა. თავიდან გადაამოწმეთ წერილი და დანართი.")
    if custom_kind == "rejection":
        resolved_period = "rej_send_only" if action_mode == "send_only" else "rejection"
    elif custom_kind == "exam_fail":
        resolved_period = "fail_send_only" if action_mode == "send_only" else "exam_fail"
    elif custom_kind == "custom":
        resolved_period = "cust_send_only" if action_mode == "send_only" else "custom"
    elif kind == "certificate":
        base_p = period if period in ("morning", "evening") else ("morning" if event_time < "12:00" else "evening")
        if action_mode == "send_only":
            resolved_period = "cert_am_send" if base_p == "morning" else "cert_pm_send"
        else:
            resolved_period = base_p
    else:
        resolved_period = (period or ("morning" if event_time < "12:00" else "evening")) if kind == "exam" else None
    is_save_only = action_mode == "save_only"
    letter = PlanningLetter(
        user_id=user_id, kind=kind, event_date=day, event_time=event_time, period=resolved_period,
        request_id=request_id, request_fingerprint=fingerprint, to_email=user.email,
        subject=subject, body=body,
        status="simulated" if is_save_only else "sending",
        attempts=0 if is_save_only else 1,
        created_by=actor.email,
    )
    namespace = f"letters/{user_id}"
    new_path = None
    try:
        if kind == "exam" and not custom_kind:
            if action_mode in ("save_and_send", "save_only"):
                target_schedule = None
                if schedule_id is not None:
                    target_schedule = db.scalar(select(ExamSchedule).where(
                        ExamSchedule.id == schedule_id, ExamSchedule.user_id == user_id,
                    ))
                conflict_schedule = db.scalar(select(ExamSchedule).where(
                    ExamSchedule.user_id == user_id,
                    ExamSchedule.exam_date == day,
                    ExamSchedule.period == resolved_period,
                ))
                if target_schedule is not None:
                    if conflict_schedule is not None and conflict_schedule.id != target_schedule.id:
                        db.execute(
                            update(PlanningLetter)
                            .where(PlanningLetter.exam_schedule_id == target_schedule.id)
                            .values(exam_schedule_id=conflict_schedule.id)
                        )
                        db.delete(target_schedule)
                        db.flush()
                        schedule = conflict_schedule
                    else:
                        target_schedule.exam_date = day
                        target_schedule.period = resolved_period
                        db.add(target_schedule)
                        db.flush()
                        schedule = target_schedule
                elif conflict_schedule is not None:
                    schedule = conflict_schedule
                else:
                    schedule = ExamSchedule(user_id=user_id, exam_date=day, period=resolved_period)
                    db.add(schedule)
                    db.flush()
                letter.exam_schedule_id = schedule.id
            elif action_mode == "send_only" and schedule_id is not None:
                existing_sched = db.scalar(select(ExamSchedule).where(
                    ExamSchedule.id == schedule_id, ExamSchedule.user_id == user_id,
                ))
                if existing_sched is not None and existing_sched.exam_date == day and existing_sched.period == resolved_period:
                    letter.exam_schedule_id = existing_sched.id

        prior_edit_letter = None
        if edit_letter_id is not None:
            prior_edit_letter = db.scalar(select(PlanningLetter).where(
                PlanningLetter.id == edit_letter_id, PlanningLetter.user_id == user_id,
            ))

        if attachment:
            new_path, name, size = _store(attachment.file, _filename(attachment), namespace)
            letter.attachment_path, letter.attachment_filename, letter.attachment_size_bytes = new_path, name, size
        elif keep_existing_attachment and prior_edit_letter and prior_edit_letter.attachment_path:
            source = _checked_path(prior_edit_letter.attachment_path, namespace)
            if source.is_file():
                with source.open("rb") as stream:
                    new_path, name, size = _store(stream, prior_edit_letter.attachment_filename or source.name, namespace)
                letter.attachment_path, letter.attachment_filename, letter.attachment_size_bytes = new_path, name, size
        elif use_template_attachment and custom_kind and custom_meta and custom_meta.get("attachment_path"):
            source = _checked_path(custom_meta["attachment_path"], f"templates/{custom_kind}")
            if not source.is_file():
                raise HTTPException(409, "შაბლონის დანართი აღარ არის ხელმისაწვდომი. თავიდან გადაამოწმეთ.")
            with source.open("rb") as stream:
                new_path, name, size = _store(stream, custom_meta.get("attachment_filename") or source.name, namespace)
            letter.attachment_path, letter.attachment_filename, letter.attachment_size_bytes = new_path, name, size
        elif use_template_attachment and template and template.attachment_path:
            source = _checked_path(template.attachment_path, f"templates/{kind}")
            if not source.is_file():
                raise HTTPException(409, "შაბლონის დანართი აღარ არის ხელმისაწვდომი. თავიდან გადაამოწმეთ.")
            with source.open("rb") as stream:
                new_path, name, size = _store(stream, template.attachment_filename, namespace)
            letter.attachment_path, letter.attachment_filename, letter.attachment_size_bytes = new_path, name, size

        # If editing an existing record in save_only or save_and_send mode, remove superseded draft/letter
        if prior_edit_letter is not None and (
            prior_edit_letter.exam_schedule_id is None
            or prior_edit_letter.exam_schedule_id == letter.exam_schedule_id
            or (prior_edit_letter.attempts == 0 and prior_edit_letter.sent_at is None)
        ):
            if prior_edit_letter.doc_number:
                letter.doc_number = prior_edit_letter.doc_number
            old_letter_path = prior_edit_letter.attachment_path
            db.delete(prior_edit_letter)
            db.flush()
            if old_letter_path and old_letter_path != new_path:
                _remove_file(old_letter_path, namespace)

        # Update candidate status based on letter kind
        now = datetime.utcnow()
        clean_cat = (candidate_category or "").strip().upper()
        valid_cat = clean_cat if clean_cat in VALID_CANDIDATE_CATEGORIES else None
        has_cert = db.scalar(select(Certificate.id).where(Certificate.user_id == user_id)) is not None
        if custom_kind in ("rejection", "exam_fail") or has_cert:
            user.candidate_status = None
            user.candidate_category = None
            user.candidate_updated_at = now
            db.add(user)
        elif kind == "exam" and not custom_kind:
            req_cat = get_user_latest_requested_category(db, user_id)
            user.candidate_status = "exam_candidate"
            user.candidate_category = valid_cat or req_cat or user.candidate_category or "A"
            user.candidate_updated_at = now
            db.add(user)
        elif kind == "certificate" and not custom_kind:
            req_cat = get_user_latest_requested_category(db, user_id)
            user.candidate_status = "cert_candidate"
            user.candidate_category = normalize_cert_category(
                valid_cat or user.candidate_category or req_cat or "A"
            )
            user.candidate_updated_at = now
            db.add(user)

        db.add(letter)
        db.flush()
        if not letter.doc_number:
            letter.doc_number = format_letter_doc_number(letter)
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        _remove_file(new_path, namespace)
        prior = db.scalar(select(PlanningLetter).where(PlanningLetter.request_id == request_id))
        if prior and prior.user_id == user_id and prior.request_fingerprint != fingerprint:
            raise HTTPException(409, "ამ მოთხოვნის კოდით სხვა წერილი უკვე არსებობს. თავიდან გადაამოწმეთ.") from exc
        if prior and prior.user_id == user_id and prior.request_fingerprint == fingerprint:
            return _letter_out(prior)
        raise HTTPException(409, "დაგეგმვა უკვე შეიცვალა. განაახლეთ ისტორია და გადაამოწმეთ.") from exc
    except Exception:
        db.rollback()
        _remove_file(new_path, namespace)
        raise
    db.refresh(letter)
    if is_save_only:
        return _letter_out(letter)
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


@router.delete("/users/{user_id}/planning-letters/{letter_id}", status_code=204)
def delete_letter(user_id: int, letter_id: int, authorization: str | None = Header(None), db: Session = Depends(get_db)):
    _require_admin(db, authorization)
    letter = _user_letter(db, user_id, letter_id)
    old_path = letter.attachment_path
    db.delete(letter)
    db.commit()
    if old_path:
        _remove_file(old_path, f"letters/{user_id}")
    return None


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
