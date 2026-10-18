from __future__ import annotations

import base64
from datetime import date, datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import (
    Certificate,
    ExamSchedule,
    PlanningLetter,
    PlanningTemplate,
    Statement,
    User,
    format_letter_doc_number,
    format_statement_doc_number,
)
from ..services.candidate_status import (
    CATEGORY_DISPLAY_LABELS,
    VALID_CANDIDATE_CATEGORIES,
    get_user_latest_requested_category,
    parse_statement_category,
    sync_all_user_candidates,
)
from ..services.media_storage import ensure_media_root, resolve_storage_path
from .admin import _compute_all_exam_histories, _require_admin, _today_in_tbilisi
from .planning_letters import (
    CUSTOM_FILE_TEMPLATES,
    DEFAULT_TEMPLATES,
    _custom_template_out,
    _load_schedule_times,
    _template_out,
)

router = APIRouter()

MODEL_CATALOG = {
    "gemini-4-argon": {
        "id": "gemini-4-argon",
        "label": "Gemini 4 Argon",
        "provider": "gemini",
        "provider_label": "Google Gemini",
        "badge": "Gemini 4 Argon",
    },
    "chatgpt-sol": {
        "id": "chatgpt-sol",
        "label": "ChatGPT Sol",
        "provider": "openai",
        "provider_label": "OpenAI ChatGPT",
        "badge": "ChatGPT Sol",
    },
    "chatgpt-astra": {
        "id": "chatgpt-astra",
        "label": "ChatGPT Astra",
        "provider": "openai",
        "provider_label": "OpenAI ChatGPT",
        "badge": "ChatGPT Astra",
    },
}

ALLOWED_MODELS = tuple(MODEL_CATALOG.keys())
DEFAULT_MODEL = "gemini-4-argon"

REASONING_LEVELS = {
    "standard": {
        "id": "standard",
        "label": "Standard (სწრაფი)",
        "short_label": "Standard",
        "temperature": 0.3,
        "max_tokens": 3072,
        "openai_effort": "low",
        "prompt_directive": "აზროვნების დონე: STANDARD — უპასუხე სწრაფად, ლაკონიურად და მხოლოდ მთავარ საკითხებზე.",
    },
    "medium": {
        "id": "medium",
        "label": "Medium (დაბალანსებული)",
        "short_label": "Medium",
        "temperature": 0.25,
        "max_tokens": 4096,
        "openai_effort": "medium",
        "prompt_directive": "აზროვნების დონე: MEDIUM — ჩაატარე დაბალანსებული ანალიზი და მოამზადე მკაფიო რეკომენდაციები.",
    },
    "high": {
        "id": "high",
        "label": "High (მაღალი / ღრმა ანალიზი)",
        "short_label": "High",
        "temperature": 0.2,
        "max_tokens": 6144,
        "openai_effort": "high",
        "prompt_directive": (
            "აზროვნების დონე: HIGH — ჩაატარე ღრმა, მრავალმხრივი ანალიზი: დეტალურად შეამოწმე თითოეული დოკუმენტი, "
            "თარიღი, კატეგორიის შესაბამისობა და მოამზადე სრულყოფილი სამოქმედო გეგმა."
        ),
    },
    "ultra": {
        "id": "ultra",
        "label": "Ultra (ულტრა / მაქსიმალური ინტელექტი)",
        "short_label": "Ultra",
        "temperature": 0.15,
        "max_tokens": 8192,
        "openai_effort": "high",
        "prompt_directive": (
            "აზროვნების დონე: ULTRA — იმუშავე მაქსიმალური ანალიტიკური სიღრმითა და სიზუსტით: "
            "გადაამოწმე ყველა დეტალი, შეადარე განმცხადებლის ისტორია, დოკუმენტები, გამოცდის ქულები, "
            "ვადები და მოამზადე ამომწურავი ექსპერტული დასკვნა და რეკომენდაციები."
        ),
    },
}
ALLOWED_REASONING_LEVELS = tuple(REASONING_LEVELS.keys())
DEFAULT_REASONING_LEVEL = "high"

CATEGORY_LABELS_KA = dict(CATEGORY_DISPLAY_LABELS)

DEFAULT_SYSTEM_PROMPT = """შენ ხარ საქართველოს პროფესიული სერტიფიცირების ინსტიტუტის (gipc.org.ge) ადმინისტრატორის ოფიციალური ხელოვნური ინტელექტის ასისტენტი და ოპერატიული მრჩეველი.

შენი მთავარი დანიშნულებაა:
1. შეისწავლო საიტზე არსებული მონაცემები: რეგისტრირებული პირები, შემოსული განცხადებები, განცხადებებზე მიბმული დოკუმენტები (PDF, სურათები, Word ფაილები), დაგეგმილი გამოცდები, გამოცდების შედეგები, კანდიდატების სტატუსები და გაგზავნილი წერილები.
2. მიბმული დოკუმენტების (დიპლომი, პირადობის მოწმობა, პორტფოლიო/ნამუშევრები, ცნობა, განაცხადის ფორმა) დეტალური წაკითხვა და შეფასება:
   - ემთხვევა თუ არა დოკუმენტში მითითებული სახელი/გვარი/პირადი ნომერი განმცხადებლის მონაცემებს;
   - რა განათლება, კვალიფიკაცია ან სამუშაო გამოცდილება ჩანს დოკუმენტში;
   - შეესაბამება თუ არა წარმოდგენილი საბუთები მოთხოვნილ სასერტიფიკაციო კატეგორიას.
3. მოუმზადო ადმინისტრატორს მკაფიო, დინჯი და პრაქტიკული სარეკომენდაციო სამოქმედო გეგმა ქართულ ენაზე.

სასერტიფიკაციო კატეგორიები:
- A: A კატეგორიის სერტიფიკატი (არქიტექტურული პროექტირება / მუნიციპალური)
- B: B კატეგორიის სერტიფიკატი (არქიტექტურული პროექტების ექსპერტიზა)
- C: C კატეგორიის სერტიფიკატი (მთავარი არქიტექტორი)
- B_A: B ან A კატეგორიის
- C_A: C ან A კატეგორიის

⚠️ უმკაცრესი უსაფრთხოების წესი წერილების გაგზავნაზე:
- შენ თვითონ, დამოუკიდებლად და ადმინისტრატორის პირდაპირი დადასტურების გარეშე წერილს არასდროს აგზავნი!
- როდესაც რეკომენდაციას უწევ წერილის გაგზავნას ან როდესაც ადმინისტრატორი გთხოვს პასუხის/წერილის მომზადებას ან გაგზავნას:
  1) პასუხის ტექსტში აუცილებლად დაწერე მოკლე და მკაფიო აღწერა:
     - **სად იგზავნება:** მიმღების სახელი, გვარი, პირადი ნომერი და ელფოსტა;
     - **რატომ იგზავნება:** კონკრეტული მიზეზი და დასაბუთება (განცხადების, დოკუმენტის ან გამოცდის შედეგის მიხედვით);
     - **რა იგზავნება:** წერილის ტიპი, კატეგორია, თარიღი/საათი და მოკლე შინაარსი;
     - სთხოვე ადმინისტრატორს გადახედოს და დაადასტუროს გაგზავნა ქვემოთ მოცემულ ბარათზე.
  2) ტექსტის ბოლოს აუცილებლად დაურთე სტრუქტურირებული ბლოკი ზუსტად ამ ტეგებში (თითოეული შეთავაზებული წერილისთვის):
<PROPOSED_LETTER>
{
  "user_id": 123,
  "statement_id": 45,
  "template_mode": "exam",
  "period": "morning",
  "event_date": "2026-10-20",
  "event_time": "10:00",
  "candidate_category": "A",
  "reason": "განმცხადებელმა წარმოადგინა არქიტექტურის დიპლომი და ითხოვს გამოცდაზე დაშვებას.",
  "subject": "გამოცდაზე დაშვება",
  "body": "ადრესატი: სახელი გვარი\\n\\nმოგესალმებით,..."
}
</PROPOSED_LETTER>

განმარტება <PROPOSED_LETTER> ველებისთვის:
- "template_mode" უნდა იყოს ერთ-ერთი ამ 5 ტიპიდან:
  - "exam" (გამოცდის დაგეგმვა / დადებითი პასუხი)
  - "rejection" (განაცხადის უარყოფა / უარყოფითი პასუხი)
  - "certificate" (სერტიფიკატის გადაცემა / გამოცდის წარმატებით ჩაბარება)
  - "exam_fail" (გამოცდაზე ჩაჭრის შეტყობინება)
  - "custom" (სხვა თავისუფალი შეტყობინება)
- "period": "morning" (დილის ცვლა) ან "evening" (საღამოს ცვლა) როცა template_mode არის "exam" ან "certificate"; სხვა შემთხვევაში იგივე რაც template_mode ("rejection", "exam_fail", "custom").
- "candidate_category": "A", "B", "C", "B_A" ან "C_A".
- "subject" და "body": სრულად შევსებული ქართული ოფიციალური ტექსტი (ყველა ცვლადი {name}, {date}, {time} და [კატეგორია] ჩანაცვლებული უნდა იყოს რეალური მონაცემებით!).
"""


class AISettingsPayload(BaseModel):
    api_key: str | None = Field(default=None)  # Backward-compatible alias for gemini_api_key
    gemini_api_key: str | None = Field(default=None)
    openai_api_key: str | None = Field(default=None)
    model: str | None = Field(default=None)
    reasoning_level: str | None = Field(default=None)
    custom_system_prompt: str | None = Field(default=None)


class AIChatMessage(BaseModel):
    role: str
    content: str


class AIChatRequest(BaseModel):
    messages: list[AIChatMessage] = Field(default_factory=list)
    mode: str = Field(default="chat")  # "chat", "site_analysis", "statements_analysis", "exam_analysis"
    statement_id: int | None = Field(default=None)
    user_id: int | None = Field(default=None)


def _ai_settings_path() -> Path:
    folder = ensure_media_root() / "ai_assistant"
    folder.mkdir(parents=True, exist_ok=True)
    return folder / "settings.json"


def _load_ai_settings() -> dict[str, Any]:
    path = _ai_settings_path()
    data: dict[str, Any] = {}
    if path.is_file():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                data = raw
        except Exception:
            data = {}

    env_gemini_key = os.environ.get("GEMINI_API_KEY", "").strip()
    env_openai_key = os.environ.get("OPENAI_API_KEY", "").strip()

    stored_gemini_key = str(data.get("gemini_api_key") or data.get("api_key") or "").strip()
    stored_openai_key = str(data.get("openai_api_key") or "").strip()

    gemini_key = stored_gemini_key or env_gemini_key
    openai_key = stored_openai_key or env_openai_key

    model = str(data.get("model") or DEFAULT_MODEL).strip()
    if model not in MODEL_CATALOG:
        model = DEFAULT_MODEL

    reasoning_level = str(data.get("reasoning_level") or DEFAULT_REASONING_LEVEL).strip().lower()
    if reasoning_level not in REASONING_LEVELS:
        reasoning_level = DEFAULT_REASONING_LEVEL

    custom_prompt = str(data.get("custom_system_prompt") or "").strip()
    provider = MODEL_CATALOG[model]["provider"]
    active_key = openai_key if provider == "openai" else gemini_key

    return {
        "api_key": active_key,
        "gemini_api_key": gemini_key,
        "openai_api_key": openai_key,
        "model": model,
        "provider": provider,
        "reasoning_level": reasoning_level,
        "custom_system_prompt": custom_prompt,
    }


def _save_ai_settings(
    *,
    api_key: str | None = None,
    gemini_api_key: str | None = None,
    openai_api_key: str | None = None,
    model: str | None = None,
    reasoning_level: str | None = None,
    custom_system_prompt: str | None = None,
) -> dict[str, Any]:
    current = _load_ai_settings()

    effective_gemini_key = gemini_api_key if gemini_api_key is not None else api_key
    if effective_gemini_key is not None:
        cleaned = effective_gemini_key.strip()
        if cleaned:
            current["gemini_api_key"] = cleaned

    if openai_api_key is not None:
        cleaned_oa = openai_api_key.strip()
        if cleaned_oa:
            current["openai_api_key"] = cleaned_oa

    if model is not None:
        cleaned_model = model.strip()
        if cleaned_model in MODEL_CATALOG:
            current["model"] = cleaned_model

    if reasoning_level is not None:
        cleaned_level = reasoning_level.strip().lower()
        if cleaned_level in REASONING_LEVELS:
            current["reasoning_level"] = cleaned_level

    if custom_system_prompt is not None:
        current["custom_system_prompt"] = custom_system_prompt.strip()

    path = _ai_settings_path()
    path.write_text(
        json.dumps(
            {
                "api_key": current["gemini_api_key"],
                "gemini_api_key": current["gemini_api_key"],
                "openai_api_key": current["openai_api_key"],
                "model": current["model"],
                "reasoning_level": current["reasoning_level"],
                "custom_system_prompt": current["custom_system_prompt"],
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return _load_ai_settings()


def _mask_key(key: str) -> str | None:
    if not key:
        return None
    if len(key) <= 10:
        return key[:3] + "***"
    return f"{key[:6]}...{key[-4:]}"


def _build_status_response(cfg: dict[str, Any], quick_stats: dict[str, int] | None = None) -> dict[str, Any]:
    model_info = MODEL_CATALOG.get(cfg["model"], MODEL_CATALOG[DEFAULT_MODEL])
    level_info = REASONING_LEVELS.get(cfg["reasoning_level"], REASONING_LEVELS[DEFAULT_REASONING_LEVEL])
    out = {
        "configured": bool(cfg["api_key"]),
        "gemini_configured": bool(cfg["gemini_api_key"]),
        "openai_configured": bool(cfg["openai_api_key"]),
        "masked_key": _mask_key(cfg["api_key"]),
        "masked_gemini_key": _mask_key(cfg["gemini_api_key"]),
        "masked_openai_key": _mask_key(cfg["openai_api_key"]),
        "model": cfg["model"],
        "model_label": model_info["label"],
        "provider": cfg["provider"],
        "reasoning_level": cfg["reasoning_level"],
        "reasoning_level_label": level_info["label"],
        "reasoning_level_short": level_info["short_label"],
        "allowed_models": list(ALLOWED_MODELS),
        "model_catalog": list(MODEL_CATALOG.values()),
        "reasoning_levels": list(REASONING_LEVELS.values()),
        "custom_system_prompt": cfg["custom_system_prompt"],
        "default_system_prompt": DEFAULT_SYSTEM_PROMPT,
    }
    if quick_stats is not None:
        out["quick_stats"] = quick_stats
    return out


def _extract_docx_text(file_bytes: bytes, max_chars: int = 12000) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(file_bytes)) as zf:
            if "word/document.xml" not in zf.namelist():
                return ""
            xml_bytes = zf.read("word/document.xml")
        root = ET.fromstring(xml_bytes)
        paragraphs: list[str] = []
        for elem in root.iter():
            tag = elem.tag.rsplit("}", 1)[-1]
            if tag == "p":
                texts = [
                    node.text
                    for node in elem.iter()
                    if node.tag.rsplit("}", 1)[-1] == "t" and node.text
                ]
                line = "".join(texts).strip()
                if line:
                    paragraphs.append(line)
        joined = "\n".join(paragraphs)
        return joined[:max_chars]
    except Exception:
        return ""


def _read_statement_attachment_parts(
    statement: Statement,
    user: User | None,
    *,
    budget_bytes: int,
) -> tuple[list[dict[str, Any]], int, str | None]:
    """Read a statement attachment and return content parts + bytes used + description."""
    if not statement.attachment_path:
        return [], 0, None
    try:
        path = resolve_storage_path(statement.attachment_path)
    except Exception:
        return [], 0, None
    if not path.is_file():
        return [], 0, None

    filename = statement.attachment_filename or path.name
    suffix = Path(filename).suffix.lower()
    doc_num = format_statement_doc_number(statement) or f"ID-{statement.id}"
    user_label = f"{user.first_name} {user.last_name}".strip() if user else f"User#{statement.user_id}"

    try:
        size = path.stat().st_size
    except OSError:
        return [], 0, None

    if size <= 0 or size > budget_bytes:
        return (
            [
                {
                    "text": (
                        f"[განცხადება {doc_num} ({user_label}) — მიბმულია ფაილი '{filename}' "
                        f"({size} ბაიტი), რომელიც ზომის ლიმიტის გამო პირდაპირ არ ჩაიტვირთა.]"
                    )
                }
            ],
            0,
            None,
        )

    try:
        raw_bytes = path.read_bytes()
    except OSError:
        return [], 0, None

    mime_map = {
        ".pdf": "application/pdf",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
    }

    parts: list[dict[str, Any]] = []
    if suffix in mime_map:
        parts.append(
            {
                "text": (
                    f"📎 ქვემოთ მოცემულია განცხადებაზე ({doc_num}, ავტორი: {user_label}) "
                    f"მიბმული დოკუმენტი: '{filename}'. გთხოვ დეტალურად წაიკითხო და გააანალიზო მისი შინაარსი:"
                )
            }
        )
        parts.append(
            {
                "inline_data": {
                    "mime_type": mime_map[suffix],
                    "data": base64.b64encode(raw_bytes).decode("ascii"),
                    "filename": filename,
                }
            }
        )
        return parts, len(raw_bytes), f"{doc_num}: {filename}"

    if suffix == ".docx":
        extracted = _extract_docx_text(raw_bytes)
        if extracted:
            parts.append(
                {
                    "text": (
                        f"📎 განცხადებაზე ({doc_num}, ავტორი: {user_label}) მიბმული Word დოკუმენტის "
                        f"('{filename}') ამოღებული ტექსტი:\n---\n{extracted}\n---"
                    )
                }
            )
            return parts, len(extracted.encode("utf-8")), f"{doc_num}: {filename}"

    if suffix == ".zip":
        try:
            with zipfile.ZipFile(io.BytesIO(raw_bytes)) as zf:
                names = [n for n in zf.namelist() if not n.endswith("/")]
                parts.append(
                    {
                        "text": (
                            f"📎 განცხადებაზე ({doc_num}, ავტორი: {user_label}) მიბმულია ZIP არქივი "
                            f"'{filename}', რომელიც შეიცავს ფაილებს: {', '.join(names[:20])}"
                        )
                    }
                )
                used = 0
                for inner_name in names[:3]:
                    inner_suffix = Path(inner_name).suffix.lower()
                    if inner_suffix in mime_map:
                        inner_bytes = zf.read(inner_name)
                        if 0 < len(inner_bytes) <= (budget_bytes - used):
                            parts.append(
                                {
                                    "text": f"📄 ფაილი ZIP არქივიდან ({doc_num}): '{inner_name}'"
                                }
                            )
                            parts.append(
                                {
                                    "inline_data": {
                                        "mime_type": mime_map[inner_suffix],
                                        "data": base64.b64encode(inner_bytes).decode("ascii"),
                                        "filename": inner_name,
                                    }
                                }
                            )
                            used += len(inner_bytes)
                    elif inner_suffix == ".docx":
                        inner_bytes = zf.read(inner_name)
                        txt = _extract_docx_text(inner_bytes)
                        if txt:
                            parts.append(
                                {
                                    "text": f"📄 Word ფაილი ZIP არქივიდან ({doc_num} / '{inner_name}'):\n{txt}"
                                }
                            )
                return parts, used, f"{doc_num}: {filename}"
        except Exception:
            pass

    return (
        [
            {
                "text": (
                    f"[განცხადებაზე {doc_num} ({user_label}) მიბმულია ფაილი '{filename}' ({size} ბაიტი).]"
                )
            }
        ],
        0,
        f"{doc_num}: {filename}",
    )


def _next_workday(today: date) -> date:
    candidate = today + timedelta(days=1)
    while candidate.weekday() >= 5:
        candidate += timedelta(days=1)
    return candidate


def _fill_template_preview(
    template_mode: str,
    *,
    user: User,
    event_date: str,
    event_time: str,
    candidate_category: str,
    templates_map: dict[str, dict[str, Any]],
) -> tuple[str, str]:
    tpl = templates_map.get(template_mode) or templates_map.get("exam") or {}
    subject = str(tpl.get("subject") or "შეტყობინება")
    body = str(tpl.get("body") or "")
    full_name = f"{user.first_name or ''} {user.last_name or ''}".strip()
    cat_label = CATEGORY_LABELS_KA.get(candidate_category, CATEGORY_LABELS_KA["A"])
    replacements = {
        "{name}": full_name,
        "{date}": event_date,
        "{time}": event_time,
        "{code}": user.code or "",
        "{personal_id}": user.personal_id or "",
        "[სახელი და გვარი]": full_name,
        "[გამოცდის თარიღი]": event_date,
        "[საათი]": event_time,
        "[კატეგორია]": cat_label,
    }
    for k, v in replacements.items():
        subject = subject.replace(k, v)
        body = body.replace(k, v)
    return subject, body


def _build_site_context_and_attachments(
    db: Session,
    *,
    mode: str,
    focus_statement_id: int | None = None,
    focus_user_id: int | None = None,
    last_user_message: str = "",
) -> tuple[str, list[dict[str, Any]], list[str], dict[int, User], dict[str, dict[str, Any]]]:
    today = _today_in_tbilisi()
    default_next_date = _next_workday(today).isoformat()
    schedule_times = _load_schedule_times()

    exam_histories = _compute_all_exam_histories(db)
    requested_categories = sync_all_user_candidates(db, exam_histories)

    users = db.scalars(select(User).order_by(User.created_at.desc(), User.id.desc())).all()
    users_by_id = {u.id: u for u in users}

    certs = db.scalars(select(Certificate)).all()
    certs_by_user = {c.user_id: c for c in certs}

    statements = db.scalars(
        select(Statement).order_by(Statement.created_at.desc(), Statement.id.desc())
    ).all()
    schedules = db.scalars(
        select(ExamSchedule).order_by(ExamSchedule.exam_date.desc(), ExamSchedule.id.desc())
    ).all()
    letters = db.scalars(
        select(PlanningLetter).order_by(PlanningLetter.created_at.desc(), PlanningLetter.id.desc())
    ).all()

    templates_map: dict[str, dict[str, Any]] = {
        "exam": _template_out("exam", db.get(PlanningTemplate, "exam")),
        "certificate": _template_out("certificate", db.get(PlanningTemplate, "certificate")),
        "rejection": _custom_template_out("rejection"),
        "exam_fail": _custom_template_out("exam_fail"),
        "cert_issued": _custom_template_out("cert_issued"),
        "custom": {
            "subject": "შეტყობინება — საქართველოს პროფესიული სერტიფიცირების ინსტიტუტი",
            "body": (
                "ადრესატი: {name}\n\n"
                "მოგესალმებით,\n\n"
                "\n\n"
                "პატივისცემით,\n"
                "საქართველოს პროფესიული სერტიფიცირების ინსტიტუტი"
            ),
        },
    }

    unseen_stmts = [s for s in statements if s.seen_at is None]
    pending_stmts = [s for s in statements if s.answered_at is None]
    exam_candidates = [u for u in users if u.candidate_status == "exam_candidate"]
    cert_candidates = [u for u in users if u.candidate_status == "cert_candidate"]

    active_certs = [c for c in certs if c.status == "active"]
    suspended_or_expired_certs = [c for c in certs if c.status in ("suspended", "expired")]

    pending_pass_users: list[dict[str, Any]] = []
    pending_fail_users: list[dict[str, Any]] = []
    for uid, hist in exam_histories.items():
        u = users_by_id.get(uid)
        if not u:
            continue
        if hist.get("pending_pass_letter"):
            pending_pass_users.append(
                {
                    "user_id": u.id,
                    "name": f"{u.first_name} {u.last_name}".strip(),
                    "personal_id": u.personal_id,
                    "email": u.email,
                    "requested_category": requested_categories.get(u.id) or u.candidate_category or "A",
                    "summary": hist.get("summary_text"),
                }
            )
        elif hist.get("pending_fail_letter"):
            pending_fail_users.append(
                {
                    "user_id": u.id,
                    "name": f"{u.first_name} {u.last_name}".strip(),
                    "personal_id": u.personal_id,
                    "email": u.email,
                    "requested_category": requested_categories.get(u.id) or u.candidate_category or "A",
                    "summary": hist.get("summary_text"),
                }
            )

    now_utc = datetime.utcnow()
    cert_candidates_info: list[dict[str, Any]] = []
    for u in cert_candidates:
        days_elapsed = (
            (now_utc - u.candidate_updated_at).days if u.candidate_updated_at else 0
        )
        days_left = max(0, 30 - days_elapsed)
        cert_candidates_info.append(
            {
                "user_id": u.id,
                "name": f"{u.first_name} {u.last_name}".strip(),
                "personal_id": u.personal_id,
                "email": u.email,
                "category": u.candidate_category or "A",
                "days_elapsed": days_elapsed,
                "days_left_of_30": days_left,
            }
        )

    statements_summary: list[dict[str, Any]] = []
    for s in statements[:30]:
        u = users_by_id.get(s.user_id)
        req_cat = (
            parse_statement_category(s.message)
            or requested_categories.get(s.user_id)
            or (u.candidate_category if u else None)
            or "A"
        )
        statements_summary.append(
            {
                "statement_id": s.id,
                "doc_number": format_statement_doc_number(s),
                "user_id": s.user_id,
                "user_name": f"{u.first_name} {u.last_name}".strip() if u else "",
                "personal_id": u.personal_id if u else "",
                "email": u.email if u else "",
                "phone": u.phone if u else "",
                "user_code": u.code if u else "",
                "candidate_status": u.candidate_status if u else None,
                "requested_category": req_cat,
                "requested_category_label": CATEGORY_LABELS_KA.get(req_cat, req_cat),
                "created_at": s.created_at.isoformat() if s.created_at else None,
                "status": (
                    "წაუკითხავი და უპასუხო"
                    if s.seen_at is None
                    else ("ნანახი, მაგრამ უპასუხო" if s.answered_at is None else "პასუხი გაცემულია")
                ),
                "message": s.message,
                "has_attachment": bool(s.attachment_path),
                "attachment_filename": s.attachment_filename,
                "attachment_size_bytes": s.attachment_size_bytes,
            }
        )

    recent_letters_summary: list[dict[str, Any]] = []
    for l in letters[:20]:
        u = users_by_id.get(l.user_id)
        recent_letters_summary.append(
            {
                "letter_id": l.id,
                "doc_number": format_letter_doc_number(l),
                "user_id": l.user_id,
                "user_name": f"{u.first_name} {u.last_name}".strip() if u else "",
                "to_email": l.to_email,
                "kind": l.kind,
                "period": l.period,
                "event_date": l.event_date.isoformat() if l.event_date else None,
                "event_time": l.event_time,
                "subject": l.subject,
                "sent_at": l.sent_at.isoformat() if l.sent_at else None,
                "status": l.status,
            }
        )

    focus_context: dict[str, Any] = {}
    if focus_statement_id is not None:
        st_obj = next((s for s in statements if s.id == focus_statement_id), None)
        if st_obj:
            focus_user_id = st_obj.user_id
            focus_context["focused_statement"] = {
                "statement_id": st_obj.id,
                "doc_number": format_statement_doc_number(st_obj),
                "created_at": st_obj.created_at.isoformat() if st_obj.created_at else None,
                "message": st_obj.message,
                "attachment_filename": st_obj.attachment_filename,
                "answered_at": st_obj.answered_at.isoformat() if st_obj.answered_at else None,
            }
    if focus_user_id is not None and focus_user_id in users_by_id:
        u = users_by_id[focus_user_id]
        cert = certs_by_user.get(u.id)
        u_stmts = [s for s in statements if s.user_id == u.id]
        u_letters = [l for l in letters if l.user_id == u.id]
        u_scheds = [sc for sc in schedules if sc.user_id == u.id]
        focus_context["focused_user"] = {
            "user_id": u.id,
            "name": f"{u.first_name} {u.last_name}".strip(),
            "personal_id": u.personal_id,
            "email": u.email,
            "phone": u.phone,
            "code": u.code,
            "candidate_status": u.candidate_status,
            "candidate_category": u.candidate_category,
            "requested_category": requested_categories.get(u.id),
            "certificate": (
                {
                    "unique_code": cert.unique_code,
                    "level": cert.level,
                    "status": cert.status,
                    "valid_until": cert.valid_until.isoformat() if cert.valid_until else None,
                }
                if cert
                else None
            ),
            "exam_history": exam_histories.get(u.id),
            "statements_count": len(u_stmts),
            "letters_count": len(u_letters),
            "schedules": [
                {"exam_date": sc.exam_date.isoformat(), "period": sc.period}
                for sc in u_scheds[:5]
            ],
        }

    attachments_to_load: list[Statement] = []
    if focus_statement_id is not None:
        st_obj = next((s for s in statements if s.id == focus_statement_id), None)
        if st_obj and st_obj.attachment_path:
            attachments_to_load.append(st_obj)
    elif focus_user_id is not None:
        for s in statements:
            if s.user_id == focus_user_id and s.attachment_path:
                attachments_to_load.append(s)
                if len(attachments_to_load) >= 3:
                    break
    else:
        msg_lower = last_user_message.lower()
        for s in statements:
            if not s.attachment_path:
                continue
            doc_num = (format_statement_doc_number(s) or "").lower()
            u = users_by_id.get(s.user_id)
            u_name = f"{u.first_name} {u.last_name}".lower() if u else ""
            if (doc_num and doc_num in msg_lower) or (u and u.personal_id in msg_lower) or (
                u_name and any(part in msg_lower for part in u_name.split() if len(part) >= 3)
            ):
                attachments_to_load.append(s)
                if len(attachments_to_load) >= 4:
                    break

        if not attachments_to_load and (
            mode in ("site_analysis", "statements_analysis")
            or any(
                kw in msg_lower
                for kw in ("განცხად", "დოკუმენტ", "ფაილ", "დიპლომ", "საბუთ", "ანალიზ", "შემოწმ")
            )
        ):
            for s in pending_stmts:
                if s.attachment_path:
                    attachments_to_load.append(s)
                    if len(attachments_to_load) >= 4:
                        break
            if not attachments_to_load:
                for s in statements[:5]:
                    if s.attachment_path:
                        attachments_to_load.append(s)
                        if len(attachments_to_load) >= 3:
                            break

    attachment_parts: list[dict[str, Any]] = []
    inspected_labels: list[str] = []
    remaining_budget = 12 * 1024 * 1024
    for st_item in attachments_to_load:
        u = users_by_id.get(st_item.user_id)
        parts, used_bytes, label = _read_statement_attachment_parts(
            st_item, u, budget_bytes=remaining_budget
        )
        if parts:
            attachment_parts.extend(parts)
            remaining_budget = max(0, remaining_budget - used_bytes)
        if label:
            inspected_labels.append(label)

    context_payload = {
        "current_date_tbilisi": today.isoformat(),
        "default_next_exam_date": default_next_date,
        "default_schedule_times": schedule_times,
        "statistics": {
            "total_registered_users": len(users),
            "unseen_statements_count": len(unseen_stmts),
            "unanswered_statements_count": len(pending_stmts),
            "total_statements_count": len(statements),
            "exam_candidates_count": len(exam_candidates),
            "certificate_candidates_count": len(cert_candidates),
            "active_certificates_count": len(active_certs),
            "suspended_or_expired_certificates_count": len(suspended_or_expired_certs),
            "users_needing_exam_pass_letter_count": len(pending_pass_users),
            "users_needing_exam_fail_letter_count": len(pending_fail_users),
        },
        "official_letter_templates": {
            k: {"subject": v.get("subject"), "body": v.get("body")}
            for k, v in templates_map.items()
        },
        "focused_context": focus_context,
        "statements": statements_summary,
        "users_needing_pass_letter": pending_pass_users,
        "users_needing_fail_letter": pending_fail_users,
        "certificate_candidates_30_day_tracker": cert_candidates_info,
        "recent_sent_letters": recent_letters_summary,
    }

    context_str = (
        "=== საიტის (gipc.org.ge) მიმდინარე ბაზის მონაცემები ===\n"
        + json.dumps(context_payload, ensure_ascii=False, indent=2)
    )
    return context_str, attachment_parts, inspected_labels, users_by_id, templates_map


_PROPOSED_LETTER_RE = re.compile(
    r"<PROPOSED_LETTER>\s*(\{.*?\})\s*</PROPOSED_LETTER>",
    re.DOTALL | re.IGNORECASE,
)


def _parse_proposed_letters(
    raw_text: str,
    *,
    users_by_id: dict[int, User],
    templates_map: dict[str, dict[str, Any]],
    default_date: str,
    schedule_times: dict[str, str],
) -> tuple[str, list[dict[str, Any]]]:
    proposals: list[dict[str, Any]] = []

    def _replace(match: re.Match) -> str:
        block = match.group(1).strip()
        try:
            data = json.loads(block)
        except Exception:
            return ""
        if not isinstance(data, dict):
            return ""
        try:
            uid = int(data.get("user_id"))
        except (TypeError, ValueError):
            return ""
        user = users_by_id.get(uid)
        if not user:
            return ""

        template_mode = str(data.get("template_mode") or "exam").strip().lower()
        if template_mode not in ("exam", "rejection", "certificate", "exam_fail", "custom"):
            template_mode = "exam"

        period = str(data.get("period") or "").strip().lower()
        if template_mode in ("exam", "certificate"):
            if period not in ("morning", "evening"):
                period = "morning"
            kind = template_mode
        else:
            period = template_mode
            kind = "exam"

        ev_date = str(data.get("event_date") or default_date).strip()
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", ev_date):
            ev_date = default_date

        default_time = schedule_times.get(period, "10:00")
        ev_time = str(data.get("event_time") or default_time).strip()
        if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", ev_time):
            ev_time = default_time if template_mode in ("exam", "certificate") else "00:00"

        cat = str(data.get("candidate_category") or user.candidate_category or "A").strip().upper()
        if cat not in CATEGORY_LABELS_KA:
            cat = "A"

        fallback_subject, fallback_body = _fill_template_preview(
            template_mode,
            user=user,
            event_date=ev_date,
            event_time=ev_time,
            candidate_category=cat,
            templates_map=templates_map,
        )
        subject = str(data.get("subject") or fallback_subject).strip() or fallback_subject
        body = str(data.get("body") or fallback_body).strip() or fallback_body

        full_name = f"{user.first_name or ''} {user.last_name or ''}".strip()
        cat_label = CATEGORY_LABELS_KA.get(cat, CATEGORY_LABELS_KA["A"])
        for placeholder, val in (
            ("{name}", full_name),
            ("{date}", ev_date),
            ("{time}", ev_time),
            ("{code}", user.code or ""),
            ("{personal_id}", user.personal_id or ""),
            ("[კატეგორია]", cat_label),
        ):
            subject = subject.replace(placeholder, val)
            body = body.replace(placeholder, val)

        stmt_id = data.get("statement_id")
        try:
            stmt_id = int(stmt_id) if stmt_id is not None else None
        except (TypeError, ValueError):
            stmt_id = None

        tpl_meta = templates_map.get(template_mode) or {}
        proposals.append(
            {
                "user_id": user.id,
                "user_name": full_name,
                "personal_id": user.personal_id,
                "to_email": user.email,
                "statement_id": stmt_id,
                "template_mode": template_mode,
                "kind": kind,
                "period": period,
                "event_date": ev_date,
                "event_time": ev_time,
                "candidate_category": cat,
                "candidate_category_label": cat_label,
                "reason": str(data.get("reason") or "AI ასისტენტის რეკომენდაციით მომზადებული წერილი.").strip(),
                "subject": subject,
                "body": body,
                "template_updated_at": tpl_meta.get("updated_at"),
                "attachment_filename": tpl_meta.get("attachment_filename"),
            }
        )
        return ""

    cleaned = _PROPOSED_LETTER_RE.sub(_replace, raw_text).strip()
    return cleaned, proposals


def _discover_available_gemini_model(api_key: str, preferred: str = "gemini-4-argon") -> str:
    url = f"https://generativelanguage.googleapis.com/v1beta/models?key={urllib.parse.quote(api_key)}"
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        models = data.get("models") or []
        names: list[str] = []
        for m in models:
            methods = m.get("supportedGenerationMethods") or []
            if "generateContent" not in methods:
                continue
            raw_name = str(m.get("name") or "")
            short_name = raw_name.split("/", 1)[-1] if "/" in raw_name else raw_name
            if short_name:
                names.append(short_name)
        for n in names:
            if "argon" in n.lower() or "gemini-4" in n.lower():
                return n
        if names:
            return names[0]
    except Exception:
        pass
    return preferred


def _call_gemini_api(
    *,
    api_key: str,
    model: str,
    system_instruction: str,
    contents: list[dict[str, Any]],
    reasoning_level: str = DEFAULT_REASONING_LEVEL,
) -> str:
    level_cfg = REASONING_LEVELS.get(reasoning_level, REASONING_LEVELS[DEFAULT_REASONING_LEVEL])
    cleaned_contents: list[dict[str, Any]] = []
    for turn in contents:
        cleaned_parts: list[dict[str, Any]] = []
        for p in turn.get("parts") or []:
            if "inline_data" in p:
                inl = p["inline_data"]
                cleaned_parts.append(
                    {
                        "inline_data": {
                            "mime_type": inl["mime_type"],
                            "data": inl["data"],
                        }
                    }
                )
            elif "text" in p:
                cleaned_parts.append({"text": p["text"]})
        cleaned_contents.append({"role": turn.get("role", "user"), "parts": cleaned_parts})

    payload = {
        "systemInstruction": {
            "parts": [{"text": system_instruction}],
        },
        "contents": cleaned_contents,
        "generationConfig": {
            "temperature": level_cfg["temperature"],
            "maxOutputTokens": level_cfg["max_tokens"],
        },
    }
    body_bytes = json.dumps(payload).encode("utf-8")

    def _send_for_model(target_model: str) -> dict[str, Any]:
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{urllib.parse.quote(target_model)}:generateContent?key={urllib.parse.quote(api_key)}"
        )
        req = urllib.request.Request(
            url,
            data=body_bytes,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))

    try:
        resp_data = _send_for_model(model)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            resolved_model = _discover_available_gemini_model(api_key, preferred=model)
            if resolved_model and resolved_model != model:
                try:
                    resp_data = _send_for_model(resolved_model)
                except urllib.error.HTTPError as retry_exc:
                    exc = retry_exc
                else:
                    candidates = resp_data.get("candidates") or []
                    if not candidates:
                        raise HTTPException(502, "Gemini 4 Argon-მა ცარიელი პასუხი დააბრუნა.")
                    parts = candidates[0].get("content", {}).get("parts") or []
                    text_chunks = [str(p.get("text") or "") for p in parts if "text" in p]
                    return "\n".join(text_chunks).strip()
        err_body = ""
        try:
            err_body = exc.read().decode("utf-8", errors="replace")
            err_json = json.loads(err_body)
            err_msg = err_json.get("error", {}).get("message") or err_body
        except Exception:
            err_msg = err_body or str(exc)
        if exc.code in (400, 401, 403) and "API key" in err_msg:
            raise HTTPException(400, "Gemini API Key არასწორია ან არააქტიურია. გადაამოწმეთ გასაღები პარამეტრებში.")
        raise HTTPException(502, f"Gemini 4 Argon API შეცდომა ({exc.code}): {err_msg[:300]}")
    except Exception as exc:
        raise HTTPException(502, f"Gemini 4 Argon-თან დაკავშირება ვერ მოხერხდა: {exc}")

    candidates = resp_data.get("candidates") or []
    if not candidates:
        raise HTTPException(502, "Gemini 4 Argon-მა ცარიელი პასუხი დააბრუნა.")
    parts = candidates[0].get("content", {}).get("parts") or []
    text_chunks = [str(p.get("text") or "") for p in parts if "text" in p]
    return "\n".join(text_chunks).strip()


def _discover_available_openai_model(api_key: str, preferred: str) -> str:
    url = "https://api.openai.com/v1/models"
    try:
        req = urllib.request.Request(
            url,
            headers={"Authorization": f"Bearer {api_key}"},
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        items = data.get("data") or []
        ids = [str(it.get("id") or "") for it in items if it.get("id")]
        keyword = "sol" if "sol" in preferred.lower() else ("astra" if "astra" in preferred.lower() else preferred)
        for mid in ids:
            if keyword.lower() in mid.lower():
                return mid
        for fallback_prefix in ("gpt-5", "o3", "o4", "gpt-4o"):
            for mid in ids:
                if mid.startswith(fallback_prefix):
                    return mid
    except Exception:
        pass
    return preferred


def _call_openai_api(
    *,
    api_key: str,
    model: str,
    system_instruction: str,
    contents: list[dict[str, Any]],
    reasoning_level: str = DEFAULT_REASONING_LEVEL,
) -> str:
    level_cfg = REASONING_LEVELS.get(reasoning_level, REASONING_LEVELS[DEFAULT_REASONING_LEVEL])
    oa_messages: list[dict[str, Any]] = [
        {"role": "system", "content": system_instruction},
    ]
    for turn in contents:
        role = "assistant" if turn.get("role") == "model" else "user"
        parts = turn.get("parts") or []
        content_blocks: list[dict[str, Any]] = []
        for p in parts:
            if "text" in p:
                content_blocks.append({"type": "text", "text": p["text"]})
            elif "inline_data" in p:
                inl = p["inline_data"]
                mime = inl.get("mime_type") or ""
                b64 = inl.get("data") or ""
                fname = inl.get("filename") or "document.pdf"
                if mime.startswith("image/"):
                    content_blocks.append(
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:{mime};base64,{b64}"},
                        }
                    )
                elif mime == "application/pdf":
                    content_blocks.append(
                        {
                            "type": "file",
                            "file": {
                                "filename": fname,
                                "file_data": f"data:{mime};base64,{b64}",
                            },
                        }
                    )
        if len(content_blocks) == 1 and content_blocks[0].get("type") == "text":
            oa_messages.append({"role": role, "content": content_blocks[0]["text"]})
        elif content_blocks:
            oa_messages.append({"role": role, "content": content_blocks})

    def _send_oa(target_model: str, include_effort: bool = True) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": target_model,
            "messages": oa_messages,
        }
        if include_effort:
            payload["reasoning_effort"] = level_cfg["openai_effort"]
        else:
            payload["temperature"] = level_cfg["temperature"]
        req = urllib.request.Request(
            "https://api.openai.com/v1/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))

    try:
        resp_data = _send_oa(model, include_effort=True)
    except urllib.error.HTTPError as exc:
        err_body = ""
        try:
            err_body = exc.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        if exc.code == 400 and "reasoning_effort" in err_body:
            try:
                resp_data = _send_oa(model, include_effort=False)
            except urllib.error.HTTPError as exc2:
                exc = exc2
                try:
                    err_body = exc2.read().decode("utf-8", errors="replace")
                except Exception:
                    pass
            else:
                choices = resp_data.get("choices") or []
                return str(choices[0].get("message", {}).get("content") or "").strip() if choices else ""
        if exc.code in (400, 404) and ("model" in err_body.lower() or exc.code == 404):
            resolved = _discover_available_openai_model(api_key, preferred=model)
            if resolved and resolved != model:
                try:
                    resp_data = _send_oa(resolved, include_effort=False)
                except urllib.error.HTTPError as exc3:
                    exc = exc3
                    try:
                        err_body = exc3.read().decode("utf-8", errors="replace")
                    except Exception:
                        pass
                else:
                    choices = resp_data.get("choices") or []
                    return str(choices[0].get("message", {}).get("content") or "").strip() if choices else ""
        try:
            err_json = json.loads(err_body)
            err_msg = err_json.get("error", {}).get("message") or err_body
        except Exception:
            err_msg = err_body or str(exc)
        if exc.code in (401, 403):
            raise HTTPException(400, "OpenAI (ChatGPT) API Key არასწორია ან არააქტიურია. გადაამოწმეთ გასაღები პარამეტრებში.")
        raise HTTPException(502, f"ChatGPT API შეცდომა ({exc.code}): {err_msg[:300]}")
    except Exception as exc:
        raise HTTPException(502, f"ChatGPT-სთან დაკავშირება ვერ მოხერხდა: {exc}")

    choices = resp_data.get("choices") or []
    if not choices:
        raise HTTPException(502, "ChatGPT-მ ცარიელი პასუხი დააბრუნა.")
    return str(choices[0].get("message", {}).get("content") or "").strip()


@router.get("/ai/status")
def get_ai_status(
    authorization: str | None = Header(None),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    cfg = _load_ai_settings()
    unseen_count = len(db.scalars(select(Statement.id).where(Statement.seen_at.is_(None))).all())
    pending_count = len(db.scalars(select(Statement.id).where(Statement.answered_at.is_(None))).all())
    return _build_status_response(
        cfg,
        quick_stats={
            "unseen_statements": unseen_count,
            "pending_statements": pending_count,
        },
    )


@router.put("/ai/settings")
def update_ai_settings(
    payload: AISettingsPayload,
    authorization: str | None = Header(None),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    cfg = _save_ai_settings(
        api_key=payload.api_key,
        gemini_api_key=payload.gemini_api_key,
        openai_api_key=payload.openai_api_key,
        model=payload.model,
        reasoning_level=payload.reasoning_level,
        custom_system_prompt=payload.custom_system_prompt,
    )
    return _build_status_response(cfg)


@router.post("/ai/chat")
def ai_chat(
    payload: AIChatRequest,
    authorization: str | None = Header(None),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    cfg = _load_ai_settings()
    model_info = MODEL_CATALOG.get(cfg["model"], MODEL_CATALOG[DEFAULT_MODEL])
    level_info = REASONING_LEVELS.get(cfg["reasoning_level"], REASONING_LEVELS[DEFAULT_REASONING_LEVEL])

    if not cfg["api_key"]:
        key_label = "OpenAI (ChatGPT) API Key" if cfg["provider"] == "openai" else "Gemini API Key"
        raise HTTPException(
            400,
            f"{model_info['label']}-ისთვის საჭიროა {key_label}. დააჭირეთ ჩატის თავში მოდელის/დონის ღილაკს და შეიყვანეთ API Key.",
        )

    mode = (payload.mode or "chat").strip().lower()
    last_user_msg = ""
    for m in reversed(payload.messages):
        if m.role == "user" and m.content.strip():
            last_user_msg = m.content.strip()
            break

    if not last_user_msg:
        if mode == "site_analysis":
            last_user_msg = (
                "ჩაატარე საიტის მიმდინარე მდგომარეობის სრული ოპერატიული ანალიზი: "
                "შემოსული/უპასუხო განცხადებები, მიბმული დოკუმენტები, გამოცდის შედეგები, "
                "კანდიდატების ვადები და მოამზადე დღევანდელი სამოქმედო გეგმა და სარეკომენდაციო წერილები."
            )
        elif mode == "statements_analysis":
            last_user_msg = (
                "დეტალურად შეისწავლე ყველა უპასუხო განცხადება და მათზე მიბმული დოკუმენტები. "
                "თითოეულ განცხადებაზე დაწერე დასკვნა და მოამზადე შესაბამისი სარეკომენდაციო საპასუხო წერილი დასადასტურებლად."
            )
        elif mode == "exam_analysis":
            last_user_msg = (
                "გააანალიზე გამოცდების შედეგები, გამოცდისა და სერტიფიკატის კანდიდატები (მათ შორის 30-დღიანი ვადები) "
                "და მოამზადე შესაბამისი სარეკომენდაციო წერილები იმ პირებისთვის, ვისაც პასუხი ჯერ არ გაგზავნია."
            )
        else:
            raise HTTPException(422, "შეტყობინება ცარიელია.")

    context_str, attachment_parts, inspected_labels, users_by_id, templates_map = (
        _build_site_context_and_attachments(
            db,
            mode=mode,
            focus_statement_id=payload.statement_id,
            focus_user_id=payload.user_id,
            last_user_message=last_user_msg,
        )
    )

    system_instruction = (
        DEFAULT_SYSTEM_PROMPT
        + f"\n\nაქტიური მოდელი: {model_info['label']} | {level_info['prompt_directive']}"
    )
    if cfg["custom_system_prompt"]:
        system_instruction += "\n\nდამატებითი ინსტრუქცია ადმინისტრატორისგან:\n" + cfg["custom_system_prompt"]

    contents: list[dict[str, Any]] = []
    prior_messages = payload.messages[:-1] if payload.messages else []
    for m in prior_messages[-10:]:
        role = "model" if m.role in ("assistant", "model") else "user"
        text = m.content.strip()
        if text:
            contents.append({"role": role, "parts": [{"text": text}]})

    final_parts: list[dict[str, Any]] = [{"text": context_str}]
    if attachment_parts:
        final_parts.extend(attachment_parts)
    final_parts.append({"text": f"ადმინისტრატორის მოთხოვნა:\n{last_user_msg}"})
    contents.append({"role": "user", "parts": final_parts})

    if cfg["provider"] == "openai":
        raw_reply = _call_openai_api(
            api_key=cfg["api_key"],
            model=cfg["model"],
            system_instruction=system_instruction,
            contents=contents,
            reasoning_level=cfg["reasoning_level"],
        )
    else:
        raw_reply = _call_gemini_api(
            api_key=cfg["api_key"],
            model=cfg["model"],
            system_instruction=system_instruction,
            contents=contents,
            reasoning_level=cfg["reasoning_level"],
        )

    today = _today_in_tbilisi()
    default_date = _next_workday(today).isoformat()
    schedule_times = _load_schedule_times()
    clean_reply, proposed_letters = _parse_proposed_letters(
        raw_reply,
        users_by_id=users_by_id,
        templates_map=templates_map,
        default_date=default_date,
        schedule_times=schedule_times,
    )

    return {
        "reply": clean_reply,
        "proposed_letters": proposed_letters,
        "inspected_attachments": inspected_labels,
        "model": cfg["model"],
        "model_label": model_info["label"],
        "reasoning_level": cfg["reasoning_level"],
        "reasoning_level_label": level_info["short_label"],
    }
