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
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import (
    AppFile,
    Certificate,
    Comment,
    ExamSchedule,
    ExpertUpload,
    GuideVideo,
    PlanningLetter,
    PlanningTemplate,
    Rating,
    Regulation,
    SiteDocument,
    Statement,
    User,
    format_letter_doc_number,
    format_statement_doc_number,
)
from ..services.candidate_status import (
    CATEGORY_DISPLAY_LABELS,
    VALID_CANDIDATE_CATEGORIES,
    parse_statement_category,
)
from ..services.media_storage import ensure_media_root, resolve_storage_path
from .admin import _require_admin, _today_in_tbilisi
from .app_files import _get_application_form_path
from .documents import _resolve_document_path
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
            "გადაამოწმე ყველა დეტალი, შეადარე განმცხადებლის ისტორია, დოკუმენტები, "
            "ვადები და მოამზადე ამომწურავი ექსპერტული დასკვნა და რეკომენდაციები."
        ),
    },
}
ALLOWED_REASONING_LEVELS = tuple(REASONING_LEVELS.keys())
DEFAULT_REASONING_LEVEL = "high"

CATEGORY_LABELS_KA = dict(CATEGORY_DISPLAY_LABELS)

DEFAULT_SYSTEM_PROMPT = """შენ ხარ საქართველოს პროფესიული სერტიფიცირების ინსტიტუტის (gipc.org.ge) ადმინისტრატორის ოფიციალური ხელოვნური ინტელექტის ასისტენტი და ოპერატიული მრჩეველი.

🚫 მკაცრი აკრძალვა საგამოცდო და პროექტების სისტემაზე:
- შენ არ გაქვს და კატეგორიულად გეკრძალება ნებისმიერი კავშირი ან წვდომა მხოლოდ საგამოცდო და საგამოცდო პროექტების სისტემასთან („გამოცდა“, „მრავალბინიანი“, „მრავალფუნქციური“ განყოფილებების შიგთავსი, საგამოცდო ბლოკები, ტესტის კითხვები, სწორი პასუხები, მრავალბინიანი/მრავალფუნქციური პროექტების დავალებები, ტაქსონომია, საგამოცდო პაროლები, დროის ლიმიტები და საგამოცდო სესიები).

✅ სრული წვდომა საიტის ყველა დანარჩენ ნაწილსა და ბაზაზე:
შენ გაქვს სრული წვდომა საიტის ყველა დანარჩენ განყოფილებასთან და მონაცემთა ბაზასთან:
1. `registered_users`: ყველა რეგისტრირებული პირი (სახელი, გვარი, პირადი ნომერი, ელფოსტა, ტელეფონი, კოდი, კანდიდატის სტატუსი და კატეგორია, სერტიფიკატის სტატუსი).
2. `certificates_registry`: სერტიფიცირებულ პირთა საჯარო და ადმინისტრაციული რეესტრი (სერტიფიკატის კოდი, დონე/კვალიფიკაცია, სტატუსი, გაცემის თარიღი, მოქმედების ვადა, მიბმული PDF ფაილი).
3. `statements`: შემოსული განცხადებები (წაუკითხავი, უპასუხო, პასუხგაცემული) და მათზე მიბმული დოკუმენტები (PDF, სურათები, Word ფაილები).
4. `exam_schedules_calendar`: დაგეგმილი ვიზიტების/გამოცდების ადმინისტრაციული განრიგი (დილის/საღამოს ცვლები).
5. `recent_sent_letters` და `official_letter_templates`: გაგზავნილი ოფიციალური წერილები და წერილების შაბლონები.
6. `public_reviews_and_ratings`: სერტიფიცირებულ პირთა საჯარო პროფილებზე (`my.html`) დაწერილი შეფასებები (5 კრიტერიუმით) და კომენტარები.
7. `expert_portfolio_uploads`: სერტიფიცირებული ექსპერტების მიერ პირად გვერდზე ატვირთული პროექტები და ექსპერტიზის დასკვნები.
8. `site_documents`: საიტის საინფორმაციო დოკუმენტები („დოკუმენტები / დამატება“ და „ინფორმაცია“ მენიუ — ტექსტები და Word/PDF ფაილები).
9. `regulations`: რეგულაციები და დადგენილებები (`regulations`).
10. `guide_videos`: გზამკვლევის ვიდეოები (`guide_videos`).
11. `app_files_and_forms`: განაცხადის ფორმა (`application_form`) და აპლიკაციის ფაილები (`app_files`).
12. ადმინისტრატორის მიერ ჩატში პირდაპირ ჩასმული სკრინშოტები (სურათები), ფაილები და კომპიუტერის დაკავშირებული საქაღალდის ფაილები (`local_computer_files`).

💻 ადმინისტრატორის კომპიუტერთან წვდომა (ძებნა, წაკითხვა, ჩამოწერა და განაცხადზე/წერილზე მიბმა):
- თუ კონტექსტში მოცემულია `local_computer_files`, ეს არის ადმინისტრატორის კომპიუტერში არსებული ფაილების სია (`path`, `name`, `size_bytes`, `mime_type`).
- შენ შეგიძლია მოძებნო ფაილები ადმინისტრატორის კომპიუტერში, გააანალიზო მათი შინაარსი (როცა ფაილი მოწოდებულია `attachments`-ით) და პირდაპირ მიაბა კომპიუტერში არსებული ფაილი გასაგზავნ წერილს (`"computer_attachment_path": "ფაილის_path_ან_სახელი"` `<PROPOSED_LETTER>` ბლოკში) ან მიაბა საიტის ბაზაში არსებული ფაილი (`"stored_attachment": {"source_type": "certificate", "source_id": 5}`)!

🌐 ვებში გასვლა, საჯარო რეესტრებში/საიტებზე შესვლა და დოკუმენტების სანდოობის გადამოწმება (კანონმდებლობის ფარგლებში):
- შენ ჩართული გაქვს პირდაპირი ვებ-ძებნა (Google Search Grounding) და საჯარო ვებ-გვერდების წაკითხვის შესაძლებლობა!
- როდესაც განმცხადებელი ან ადმინისტრატორი მიაბამს დოკუმენტს (დიპლომი, სერტიფიკატი, აკრედიტაციის ცნობა, სამუშაო გამოცდილების/სტაჟის ცნობა, ამონაწერი მეწარმეთა და არასამეწარმეო იურიდიულ პირთა რეესტრიდან, საკადასტრო კოდი, პროექტი, ექსპერტიზის დასკვნა და ა.შ.), შენ ვალდებული ხარ კანონმდებლობით დასაშვებ ფარგლებში გადაამოწმო მისი სანდოობა და ნამდვილობა:
  1) გადაამოწმო ვებში სასწავლებლის/უნივერსიტეტის/კოლეჯის არსებობა და აკრედიტაცია (მაგ. `eqe.ge`, უნივერსიტეტების ოფიციალური საიტები);
  2) გადაამოწმო დამსაქმებელი კომპანიის/ორგანიზაციის საიდენტიფიკაციო კოდი, სტატუსი და საქმიანობა საჯარო წყაროებში (`napr.gov.ge`, `my.gov.ge`, `rs.ge`, კომპანიის ვებ-გვერდი);
  3) გადაამოწმო დოკუმენტზე დატანილი სერიული ნომრები, თარიღების ლოგიკურობა, QR/ვერიფიკაციის ბმულები, ბეჭდები, ხელმოწერები და მოქმედი სამშენებლო/საკანონმდებლო ნორმები (`matsne.gov.ge`, დადგენილება №41, სივრცითი დაგეგმარებისა და სამშენებლო საქმიანობის კოდექსი);
  4) დასკვნაში მკაფიოდ დაწერო: რა გადამოწმდა ვებში, რომელი საჯარო წყაროებით დასტურდება დოკუმენტის სანდოობა ან რა საეჭვო/შეუსაბამო დეტალი გამოვლინდა.

⬇️ ფაილების ჩამოწერა ადმინისტრატორის კომპიუტერში (`<DOWNLOAD_FILE>`):
შენ შეგიძლია ადმინისტრატორს პირდაპირ კომპიუტერში ჩამოუწერო როგორც შენ მიერ შექმნილი ფაილი (ანგარიში, სია, ცხრილი, წერილი, დასკვნა — `.doc`, `.csv`, `.txt`, `.html`, `.json`), ისე საიტის ბაზაში არსებული ნებისმიერი ფაილი!
როდესაც ადმინისტრატორი გთხოვს ფაილის კომპიუტერში ჩამოწერას / შენახვას / ამოღებას:
1) თუ ქმნი ახალ ფაილს (მაგ. სია, ცხრილი, ანგარიში, დოკუმენტი), პასუხის ბოლოს დაურთე:
<DOWNLOAD_FILE>
{
  "mode": "generated",
  "filename": "angarishi.doc",
  "mime_type": "application/msword",
  "title": "საიტის ანალიტიკური ანგარიში",
  "auto_download": true,
  "content": "აქ ჩაწერე ფაილის სრული ტექსტი ან ცხრილი"
}
</DOWNLOAD_FILE>
(ცხრილებისთვის Excel-ში გასახსნელად გამოიყენე `.csv` და `"mime_type": "text/csv"`, Word-ისთვის `.doc` და `"mime_type": "application/msword"`, ტექსტისთვის `.txt`).

2) თუ ადმინისტრატორი გთხოვს საიტზე უკვე ატვირთული ფაილის ჩამოწერას კომპიუტერში (მაგ. განცხადების დანართი, სერტიფიკატის PDF, საიტის დოკუმენტი, რეგულაცია, ექსპერტის ფაილი ან განაცხადის ფორმა), პასუხის ბოლოს დაურთე:
<DOWNLOAD_FILE>
{
  "mode": "stored",
  "source_type": "statement",
  "source_id": 4,
  "title": "განცხადებაზე მიბმული ფაილი",
  "auto_download": true
}
</DOWNLOAD_FILE>
სადაც `source_type` შეიძლება იყოს: `"statement"`, `"certificate"`, `"site_document"`, `"regulation"`, `"expert_expertise"`, `"expert_project"`, `"letter"`, `"application_form"`, `"app_file"`, ხოლო `source_id` არის შესაბამისი ჩანაწერის ID (განაცხადის ფორმისთვის `1`).

⚠️ უმკაცრესი უსაფრთხოების წესი წერილების გაგზავნაზე და ადრესატის სიზუსტეზე:
- შენ თვითონ, დამოუკიდებლად და ადმინისტრატორის პირდაპირი დადასტურების გარეშე წერილს არასდროს აგზავნი!
- კატეგორიულად გეკრძალება სხვადასხვა პირის მონაცემების არევა! წერილის მომზადებისას ადრესატი აუცილებლად მოძებნე `registered_users` სიაში სახელით, გვარით, პირადი ნომრით ან ელფოსტით და გადაამოწმე, რომ `user_id`, `user_name`, `personal_id`, `to_email` და წერილის ტექსტში (`body`) ჩაწერილი სახელი/გვარი ეკუთვნის ზუსტად იმავე ერთ კონკრეტულ პირს!
- როდესაც რეკომენდაციას უწევ წერილის გაგზავნას ან როდესაც ადმინისტრატორი გთხოვს პასუხის/წერილის მომზადებას ან გაგზავნას (მათ შორის ფაილის მიბმით):
  1) პასუხის ტექსტში აუცილებლად დაწერე მოკლე და მკაფიო აღწერა:
     - **სად იგზავნება:** მიმღების სახელი, გვარი, პირადი ნომერი და ელფოსტა;
     - **რატომ იგზავნება:** კონკრეტული მიზეზი და დასაბუთება;
     - **რა იგზავნება (და რა ფაილი ებმება):** წერილის ტიპი, კატეგორია, თარიღი/საათი, მიბმული ფაილი და მოკლე შინაარსი;
     - სთხოვე ადმინისტრატორს გადახედოს და დაადასტუროს გაგზავნა ქვემოთ მოცემულ ბარათზე.
  2) ტექსტის ბოლოს აუცილებლად დაურთე სტრუქტურირებული ბლოკი ზუსტად ამ ტეგებში (თითოეული შეთავაზებული წერილისთვის):
<PROPOSED_LETTER>
{
  "user_id": 51,
  "user_name": "სახელი გვარი",
  "personal_id": "01001011111",
  "to_email": "user@example.com",
  "statement_id": null,
  "template_mode": "exam",
  "period": "morning",
  "event_date": "2026-10-20",
  "event_time": "10:00",
  "candidate_category": "A",
  "reason": "განმცხადებელმა წარმოადგინა არქიტექტურის დიპლომი და ითხოვს გამოცდაზე დაშვებას.",
  "subject": "გამოცდაზე დაშვება",
  "body": "ადრესატი: სახელი გვარი\\n\\nმოგესალმებით,...",
  "computer_attachment_path": null,
  "stored_attachment": null
}
</PROPOSED_LETTER>

განმარტება <PROPOSED_LETTER> ველებისთვის:
- "user_id", "user_name", "personal_id", "to_email": აუცილებლად უნდა აიღო ზუსტად იმ პირის ჩანაწერიდან `registered_users` სიაში, ვისაც ეგზავნება წერილი!
- "template_mode" უნდა იყოს ერთ-ერთი ამ 5 ტიპიდან:
  - "exam" (გამოცდის დაგეგმვა / დადებითი პასუხი)
  - "rejection" (განაცხადის უარყოფა / უარყოფითი პასუხი)
  - "certificate" (სერტიფიკატის გადაცემა / გამოცდის წარმატებით ჩაბარება)
  - "exam_fail" (გამოცდაზე ჩაჭრის შეტყობინება)
  - "custom" (სხვა თავისუფალი შეტყობინება)
- "period": "morning" (დილის ცვლა) ან "evening" (საღამოს ცვლა) როცა template_mode არის "exam" ან "certificate"; სხვა შემთხვევაში იგივე რაც template_mode ("rejection", "exam_fail", "custom").
- "candidate_category": "A", "B", "C", "B_A" ან "C_A".
- "subject" და "body": სრულად შევსებული ქართული ოფიციალური ტექსტი (ყველა ცვლადი {name}, {date}, {time} და [კატეგორია] ჩანაცვლებული უნდა იყოს ზუსტად ამ მიმღების რეალური მონაცემებით!).
- "computer_attachment_path": თუ წერილს უნდა მიებას ფაილი ადმინისტრატორის კომპიუტერიდან (`local_computer_files` ან ჩატში ატვირთული ფაილი), ჩაწერე მისი ზუსტი `path` ან `name` (წინააღმდეგ შემთხვევაში `null`).
- "stored_attachment": თუ წერილს უნდა მიებას ფაილი საიტის ბაზიდან (მაგ. სერტიფიკატი `{"source_type": "certificate", "source_id": 5}`, რეგულაცია, საიტის დოკუმენტი და ა.შ.), მიუთითე ეს ობიექტი (წინააღმდეგ შემთხვევაში `null`).
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


class AIChatAttachment(BaseModel):
    filename: str = Field(default="screenshot.png")
    mime_type: str = Field(default="image/png")
    data_base64: str


class AIComputerFileEntry(BaseModel):
    path: str
    name: str
    size_bytes: int = 0
    mime_type: str = ""


class AIChatRequest(BaseModel):
    messages: list[AIChatMessage] = Field(default_factory=list)
    mode: str = Field(default="chat")  # "chat", "site_analysis", "statements_analysis", "exam_analysis"
    statement_id: int | None = Field(default=None)
    user_id: int | None = Field(default=None)
    attachments: list[AIChatAttachment] = Field(default_factory=list)
    computer_files: list[AIComputerFileEntry] = Field(default_factory=list)


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

    users = db.scalars(select(User).order_by(User.created_at.desc(), User.id.desc())).all()
    users_by_id = {u.id: u for u in users}

    certs = db.scalars(select(Certificate).order_by(Certificate.created_at.desc(), Certificate.id.desc())).all()
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
    ratings = db.scalars(
        select(Rating).order_by(Rating.updated_at.desc(), Rating.id.desc())
    ).all()
    comments = db.scalars(
        select(Comment).order_by(Comment.created_at.desc(), Comment.id.desc())
    ).all()
    expert_uploads = db.scalars(
        select(ExpertUpload).order_by(ExpertUpload.created_at.desc(), ExpertUpload.id.desc())
    ).all()
    site_documents = db.scalars(
        select(SiteDocument).order_by(SiteDocument.order_index.asc(), SiteDocument.id.asc())
    ).all()
    regulations = db.scalars(
        select(Regulation).order_by(Regulation.order_index.asc(), Regulation.id.asc())
    ).all()
    guide_videos = db.scalars(
        select(GuideVideo).order_by(GuideVideo.order_index.asc(), GuideVideo.id.asc())
    ).all()
    app_files = db.scalars(
        select(AppFile).order_by(AppFile.created_at.desc(), AppFile.id.desc())
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
    for s in statements[:60]:
        u = users_by_id.get(s.user_id)
        req_cat = (
            parse_statement_category(s.message)
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
                "download_source": (
                    {"source_type": "statement", "source_id": s.id}
                    if s.attachment_path
                    else None
                ),
            }
        )

    recent_letters_summary: list[dict[str, Any]] = []
    for l in letters[:40]:
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
                "has_attachment": bool(l.attachment_path),
                "attachment_filename": l.attachment_filename,
                "download_source": (
                    {"source_type": "letter", "source_id": l.id}
                    if l.attachment_path
                    else None
                ),
            }
        )

    certificates_registry_summary: list[dict[str, Any]] = []
    for c in certs:
        u = users_by_id.get(c.user_id)
        certificates_registry_summary.append(
            {
                "certificate_id": c.id,
                "user_id": c.user_id,
                "user_name": f"{u.first_name or ''} {u.last_name or ''}".strip() if u else "",
                "personal_id": u.personal_id if u else "",
                "email": u.email if u else "",
                "phone": u.phone if u else "",
                "unique_code": c.unique_code,
                "level": c.level,
                "status": c.status,
                "exam_score": c.exam_score,
                "issue_date": c.issue_date.isoformat() if c.issue_date else None,
                "valid_until": c.valid_until.isoformat() if c.valid_until else None,
                "has_file": bool(c.file_path),
                "file_filename": c.filename,
                "download_source": (
                    {"source_type": "certificate", "source_id": c.id}
                    if c.file_path
                    else None
                ),
            }
        )

    schedules_summary: list[dict[str, Any]] = []
    for sc in schedules[:100]:
        u = users_by_id.get(sc.user_id)
        schedules_summary.append(
            {
                "schedule_id": sc.id,
                "user_id": sc.user_id,
                "user_name": f"{u.first_name or ''} {u.last_name or ''}".strip() if u else "",
                "personal_id": u.personal_id if u else "",
                "exam_date": sc.exam_date.isoformat() if sc.exam_date else None,
                "period": sc.period,
                "created_at": sc.created_at.isoformat() if sc.created_at else None,
            }
        )

    ratings_by_target: dict[int, list[float]] = {}
    for r in ratings:
        ratings_by_target.setdefault(r.target_user_id, []).append(float(r.score))

    ratings_summary: list[dict[str, Any]] = []
    for target_uid, scores in ratings_by_target.items():
        tu = users_by_id.get(target_uid)
        ratings_summary.append(
            {
                "target_user_id": target_uid,
                "target_user_name": f"{tu.first_name or ''} {tu.last_name or ''}".strip() if tu else "",
                "average_score": round(sum(scores) / len(scores), 2) if scores else 0.0,
                "ratings_count": len(scores),
            }
        )

    comments_summary: list[dict[str, Any]] = []
    for cm in comments[:50]:
        tu = users_by_id.get(cm.target_user_id)
        au = users_by_id.get(cm.author_user_id) if cm.author_user_id else None
        comments_summary.append(
            {
                "comment_id": cm.id,
                "target_user_id": cm.target_user_id,
                "target_user_name": f"{tu.first_name or ''} {tu.last_name or ''}".strip() if tu else "",
                "author_user_id": cm.author_user_id,
                "author_name": f"{au.first_name or ''} {au.last_name or ''}".strip() if au else "უცნობი",
                "author_email": au.email if au else None,
                "message": cm.message,
                "created_at": cm.created_at.isoformat() if cm.created_at else None,
            }
        )

    expert_uploads_summary: list[dict[str, Any]] = []
    for eu in expert_uploads[:80]:
        u = users_by_id.get(eu.user_id)
        expert_uploads_summary.append(
            {
                "upload_id": eu.id,
                "user_id": eu.user_id,
                "user_name": f"{u.first_name or ''} {u.last_name or ''}".strip() if u else "",
                "unique_code": eu.unique_code,
                "building_function": eu.building_function,
                "cadastral_code": eu.cadastral_code,
                "project_address": eu.project_address,
                "expertise_filename": eu.expertise_filename,
                "has_expertise_file": bool(eu.expertise_path),
                "expertise_download_source": (
                    {"source_type": "expert_expertise", "source_id": eu.id}
                    if eu.expertise_path
                    else None
                ),
                "project_filename": eu.project_filename,
                "has_project_file": bool(eu.project_path),
                "project_download_source": (
                    {"source_type": "expert_project", "source_id": eu.id}
                    if eu.project_path
                    else None
                ),
                "created_at": eu.created_at.isoformat() if eu.created_at else None,
            }
        )

    site_documents_summary: list[dict[str, Any]] = []
    for sd in site_documents:
        raw_content = re.sub(r"<[^>]+>", " ", str(sd.content or ""))
        clean_excerpt = re.sub(r"\s+", " ", raw_content).strip()[:600]
        site_documents_summary.append(
            {
                "document_id": sd.id,
                "title": sd.title,
                "content_excerpt": clean_excerpt,
                "filename": sd.filename,
                "file_size_bytes": sd.file_size_bytes,
                "has_file": bool(sd.file_path),
                "download_source": (
                    {"source_type": "site_document", "source_id": sd.id}
                    if sd.file_path
                    else None
                ),
            }
        )

    regulations_summary: list[dict[str, Any]] = []
    for reg in regulations:
        regulations_summary.append(
            {
                "regulation_id": reg.id,
                "title": reg.title,
                "filename": reg.filename,
                "order_index": reg.order_index,
                "has_file": bool(reg.file_path),
                "download_source": (
                    {"source_type": "regulation", "source_id": reg.id}
                    if reg.file_path
                    else None
                ),
            }
        )

    guide_videos_summary: list[dict[str, Any]] = []
    for gv in guide_videos:
        guide_videos_summary.append(
            {
                "video_id": gv.id,
                "title": gv.title,
                "url": gv.url,
                "order_index": gv.order_index,
            }
        )

    app_form_path = _get_application_form_path()
    app_files_and_forms_summary = {
        "application_form": {
            "available": bool(app_form_path),
            "filename": app_form_path.name if app_form_path else None,
            "download_source": (
                {"source_type": "application_form", "source_id": 1}
                if app_form_path
                else None
            ),
        },
        "app_files": [
            {
                "app_file_id": af.id,
                "filename": af.filename,
                "size_bytes": af.size_bytes,
                "mime_type": af.mime_type,
                "download_source": {"source_type": "app_file", "source_id": af.id},
            }
            for af in app_files
        ],
    }

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
                "download_source": (
                    {"source_type": "statement", "source_id": st_obj.id}
                    if st_obj.attachment_path
                    else None
                ),
            }
    if focus_user_id is None and last_user_message:
        inferred_user = _match_user_from_text(last_user_message, users)
        if inferred_user is not None:
            focus_user_id = inferred_user.id

    if focus_user_id is not None and focus_user_id in users_by_id:
        u = users_by_id[focus_user_id]
        cert = certs_by_user.get(u.id)
        u_stmts = [s for s in statements if s.user_id == u.id]
        u_letters = [l for l in letters if l.user_id == u.id]
        u_scheds = [sc for sc in schedules if sc.user_id == u.id]
        u_uploads = [eu for eu in expert_uploads if eu.user_id == u.id]
        u_comments = [cm for cm in comments if cm.target_user_id == u.id]
        u_scores = ratings_by_target.get(u.id) or []
        focus_context["focused_user"] = {
            "user_id": u.id,
            "name": f"{u.first_name} {u.last_name}".strip(),
            "personal_id": u.personal_id,
            "email": u.email,
            "phone": u.phone,
            "code": u.code,
            "candidate_status": u.candidate_status,
            "candidate_category": u.candidate_category,
            "certificate": (
                {
                    "certificate_id": cert.id,
                    "unique_code": cert.unique_code,
                    "level": cert.level,
                    "status": cert.status,
                    "exam_score": cert.exam_score,
                    "issue_date": cert.issue_date.isoformat() if cert.issue_date else None,
                    "valid_until": cert.valid_until.isoformat() if cert.valid_until else None,
                    "file_filename": cert.filename,
                    "download_source": (
                        {"source_type": "certificate", "source_id": cert.id}
                        if cert.file_path
                        else None
                    ),
                }
                if cert
                else None
            ),
            "statements_count": len(u_stmts),
            "letters_count": len(u_letters),
            "expert_uploads_count": len(u_uploads),
            "average_rating": round(sum(u_scores) / len(u_scores), 2) if u_scores else None,
            "comments_count": len(u_comments),
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

    registered_users_summary: list[dict[str, Any]] = []
    for u in users[:300]:
        cert = certs_by_user.get(u.id)
        registered_users_summary.append(
            {
                "user_id": u.id,
                "full_name": f"{u.first_name or ''} {u.last_name or ''}".strip(),
                "personal_id": u.personal_id,
                "email": u.email,
                "phone": u.phone,
                "code": u.code,
                "candidate_status": u.candidate_status,
                "candidate_category": u.candidate_category,
                "certificate_status": cert.status if cert else None,
                "certificate_level": cert.level if cert else None,
                "certificate_unique_code": cert.unique_code if cert else None,
            }
        )

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
            "scheduled_exams_count": len(schedules),
            "expert_portfolio_uploads_count": len(expert_uploads),
            "site_documents_count": len(site_documents),
            "regulations_count": len(regulations),
            "guide_videos_count": len(guide_videos),
            "public_ratings_count": len(ratings),
            "public_comments_count": len(comments),
        },
        "official_letter_templates": {
            k: {"subject": v.get("subject"), "body": v.get("body")}
            for k, v in templates_map.items()
        },
        "focused_context": focus_context,
        "registered_users": registered_users_summary,
        "certificates_registry": certificates_registry_summary,
        "statements": statements_summary,
        "exam_schedules_calendar": schedules_summary,
        "certificate_candidates_30_day_tracker": cert_candidates_info,
        "recent_sent_letters": recent_letters_summary,
        "public_reviews_and_ratings": {
            "ratings_by_expert": ratings_summary,
            "recent_comments": comments_summary,
        },
        "expert_portfolio_uploads": expert_uploads_summary,
        "site_documents": site_documents_summary,
        "regulations": regulations_summary,
        "guide_videos": guide_videos_summary,
        "app_files_and_forms": app_files_and_forms_summary,
    }

    context_str = (
        "=== საიტის (gipc.org.ge) სრული ბაზის მონაცემები (გარდა საგამოცდო ტესტებისა და მრავალბინიანი/მრავალფუნქციური პროექტებისა) ===\n"
        + json.dumps(context_payload, ensure_ascii=False, indent=2)
    )
    return context_str, attachment_parts, inspected_labels, users_by_id, templates_map


_PROPOSED_LETTER_RE = re.compile(
    r"<PROPOSED_LETTER>\s*(\{.*?\})\s*</PROPOSED_LETTER>",
    re.DOTALL | re.IGNORECASE,
)


def _ka_stem(word: str) -> str:
    w = (word or "").strip().lower()
    if len(w) >= 4 and w[-1] in ("ი", "ე", "ა", "ო", "უ"):
        return w[:-1]
    return w


def _match_user_from_text(text: str, users: list[User]) -> User | None:
    if not text or not users:
        return None
    t_lower = text.lower()
    # 1. Exact personal_id or email match
    for u in users:
        pid = (u.personal_id or "").strip()
        if len(pid) >= 9 and pid in t_lower:
            return u
        em = (u.email or "").strip().lower()
        if len(em) >= 5 and "@" in em and em in t_lower:
            return u

    # 2. Full name stem match (both first_name and last_name stems present)
    both_matches: list[User] = []
    last_only_matches: list[User] = []
    for u in users:
        f_stem = _ka_stem(u.first_name or "")
        l_stem = _ka_stem(u.last_name or "")
        if len(l_stem) >= 4 and l_stem in t_lower:
            if len(f_stem) >= 3 and f_stem in t_lower:
                both_matches.append(u)
            else:
                last_only_matches.append(u)

    if len(both_matches) == 1:
        return both_matches[0]
    if not both_matches and len(last_only_matches) == 1:
        return last_only_matches[0]
    return None


def _resolve_target_user_for_proposal(
    data: dict[str, Any],
    users_by_id: dict[int, User],
    last_user_message: str = "",
) -> User | None:
    all_users = list(users_by_id.values())
    raw_pid = str(data.get("personal_id") or "").strip()
    raw_email = str(data.get("to_email") or data.get("email") or "").strip().lower()
    raw_name = str(data.get("user_name") or data.get("name") or "").strip()
    raw_body = str(data.get("body") or "")

    # Extract "ადრესატი: სახელი გვარი" from body if present
    adresati_match = re.search(r"ადრესატი\s*:\s*([^\r\n]+)", raw_body)
    body_recipient_name = adresati_match.group(1).strip() if adresati_match else ""

    def _norm_name(val: str) -> str:
        return " ".join(val.lower().split())

    by_id: User | None = None
    try:
        if data.get("user_id") is not None:
            by_id = users_by_id.get(int(data.get("user_id")))
    except (TypeError, ValueError):
        by_id = None

    by_pid: User | None = None
    if raw_pid:
        by_pid = next((u for u in all_users if (u.personal_id or "").strip() == raw_pid), None)

    by_email: User | None = None
    if raw_email and "@" in raw_email and "example.com" not in raw_email:
        by_email = next((u for u in all_users if (u.email or "").strip().lower() == raw_email), None)

    by_name: User | None = None
    target_name_norm = _norm_name(raw_name)
    if target_name_norm and target_name_norm != "სახელი გვარი":
        matches = [
            u
            for u in all_users
            if _norm_name(f"{u.first_name or ''} {u.last_name or ''}") == target_name_norm
        ]
        if len(matches) == 1:
            by_name = matches[0]
        else:
            by_name = _match_user_from_text(raw_name, all_users)

    by_body_name: User | None = None
    body_name_norm = _norm_name(body_recipient_name)
    if body_name_norm and body_name_norm not in ("სახელი გვარი", "{name}", "[სახელი და გვარი]"):
        matches = [
            u
            for u in all_users
            if _norm_name(f"{u.first_name or ''} {u.last_name or ''}") == body_name_norm
        ]
        if len(matches) == 1:
            by_body_name = matches[0]
        else:
            by_body_name = _match_user_from_text(body_recipient_name, all_users)

    by_msg: User | None = _match_user_from_text(last_user_message, all_users) if last_user_message else None

    # Priority: user explicitly named in admin message > personal_id > email > explicit name > body recipient > user_id
    for candidate in (by_msg, by_pid, by_email, by_name, by_body_name, by_id):
        if candidate is not None:
            return candidate
    return None


def _parse_proposed_letters(
    raw_text: str,
    *,
    users_by_id: dict[int, User],
    templates_map: dict[str, dict[str, Any]],
    default_date: str,
    schedule_times: dict[str, str],
    last_user_message: str = "",
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
        user = _resolve_target_user_for_proposal(data, users_by_id, last_user_message=last_user_message)
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

        full_name = f"{user.first_name or ''} {user.last_name or ''}".strip()
        cat_label = CATEGORY_LABELS_KA.get(cat, CATEGORY_LABELS_KA["A"])

        if template_mode in ("exam", "certificate", "exam_fail"):
            # Always use the official template filled with the verified recipient's exact data
            subject = fallback_subject
            body = fallback_body
        else:
            subject = str(data.get("subject") or fallback_subject).strip() or fallback_subject
            body = str(data.get("body") or fallback_body).strip() or fallback_body
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
            # Ensure "ადრესატი:" line always has the verified recipient's full_name
            body = re.sub(
                r"^ადრესატი\s*:\s*[^\r\n]+",
                f"ადრესატი: {full_name}",
                body,
                count=1,
                flags=re.MULTILINE,
            )

        stmt_id = data.get("statement_id")
        try:
            stmt_id = int(stmt_id) if stmt_id is not None else None
        except (TypeError, ValueError):
            stmt_id = None

        tpl_meta = templates_map.get(template_mode) or {}
        comp_att_path = (
            str(data.get("computer_attachment_path") or data.get("computer_attachment_filename") or "").strip()
            or None
        )
        stored_att = data.get("stored_attachment")
        if not isinstance(stored_att, dict) or not stored_att.get("source_type"):
            stored_att = None

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
                "computer_attachment_path": comp_att_path,
                "stored_attachment": stored_att,
            }
        )
        return ""

    cleaned = _PROPOSED_LETTER_RE.sub(_replace, raw_text).strip()
    return cleaned, proposals


_DOWNLOAD_FILE_RE = re.compile(
    r"<DOWNLOAD_FILE>\s*(\{.*?\})\s*</DOWNLOAD_FILE>",
    re.DOTALL | re.IGNORECASE,
)


def _resolve_stored_file(
    db: Session, source_type: str, source_id: int
) -> tuple[Path, str, str] | None:
    st = (source_type or "").strip().lower()
    if st == "statement":
        rec = db.get(Statement, source_id)
        if not rec or not rec.attachment_path:
            return None
        try:
            p = resolve_storage_path(rec.attachment_path)
        except Exception:
            return None
        if not p or not p.exists():
            return None
        fname = rec.attachment_filename or p.name
        mtype = mimetypes.guess_type(fname)[0] or "application/octet-stream"
        return p, fname, mtype
    if st == "certificate":
        rec = db.get(Certificate, source_id)
        if not rec or not rec.file_path:
            return None
        try:
            p = resolve_storage_path(rec.file_path)
        except Exception:
            return None
        if not p or not p.exists():
            return None
        return p, rec.filename or p.name, rec.mime_type or "application/pdf"
    if st == "site_document":
        rec = db.get(SiteDocument, source_id)
        if not rec or not rec.file_path:
            return None
        p = _resolve_document_path(rec.file_path)
        if not p or not p.exists():
            return None
        fname = rec.filename or p.name
        mtype = mimetypes.guess_type(fname)[0] or "application/octet-stream"
        return p, fname, mtype
    if st == "regulation":
        rec = db.get(Regulation, source_id)
        if not rec or not rec.file_path:
            return None
        try:
            p = resolve_storage_path(rec.file_path)
        except Exception:
            return None
        if not p or not p.exists():
            return None
        fname = rec.filename or p.name
        mtype = mimetypes.guess_type(fname)[0] or "application/octet-stream"
        return p, fname, mtype
    if st == "expert_expertise":
        rec = db.get(ExpertUpload, source_id)
        if not rec or not rec.expertise_path:
            return None
        try:
            p = resolve_storage_path(rec.expertise_path)
        except Exception:
            return None
        if not p or not p.exists():
            return None
        return p, rec.expertise_filename or p.name, "application/pdf"
    if st == "expert_project":
        rec = db.get(ExpertUpload, source_id)
        if not rec or not rec.project_path:
            return None
        try:
            p = resolve_storage_path(rec.project_path)
        except Exception:
            return None
        if not p or not p.exists():
            return None
        fname = rec.project_filename or p.name
        mtype = mimetypes.guess_type(fname)[0] or "application/octet-stream"
        return p, fname, mtype
    if st == "letter":
        rec = db.get(PlanningLetter, source_id)
        if not rec or not rec.attachment_path:
            return None
        try:
            p = resolve_storage_path(rec.attachment_path)
        except Exception:
            return None
        if not p or not p.exists():
            return None
        fname = rec.attachment_filename or p.name
        mtype = mimetypes.guess_type(fname)[0] or "application/octet-stream"
        return p, fname, mtype
    if st == "application_form":
        p = _get_application_form_path()
        if not p or not p.exists():
            return None
        return p, p.name, "application/octet-stream"
    if st == "app_file":
        rec = db.get(AppFile, source_id)
        if not rec or not rec.storage_path:
            return None
        try:
            p = resolve_storage_path(rec.storage_path)
        except Exception:
            return None
        if not p or not p.exists():
            return None
        return p, rec.filename or p.name, rec.mime_type or "application/octet-stream"
    return None


def _parse_download_files(
    raw_text: str,
    *,
    db: Session,
) -> tuple[str, list[dict[str, Any]]]:
    downloads: list[dict[str, Any]] = []

    def _replace(match: re.Match) -> str:
        block = match.group(1).strip()
        try:
            data = json.loads(block)
        except Exception:
            return ""
        if not isinstance(data, dict):
            return ""
        mode = str(data.get("mode") or "generated").strip().lower()
        title = str(data.get("title") or "ფაილის ჩამოწერა კომპიუტერში").strip()
        auto_dl = bool(data.get("auto_download", True))

        if mode == "stored":
            source_type = str(data.get("source_type") or "").strip().lower()
            try:
                source_id = int(data.get("source_id") or 0)
            except (TypeError, ValueError):
                source_id = 0
            resolved = _resolve_stored_file(db, source_type, source_id)
            if not resolved:
                return ""
            path, filename, mime_type = resolved
            downloads.append(
                {
                    "mode": "stored",
                    "source_type": source_type,
                    "source_id": source_id,
                    "filename": filename,
                    "mime_type": mime_type,
                    "title": title,
                    "auto_download": auto_dl,
                    "download_url": f"/admin/ai/files/{source_type}/{source_id}",
                }
            )
            return ""

        filename = str(data.get("filename") or "document.txt").strip() or "document.txt"
        mime_type = str(data.get("mime_type") or "text/plain;charset=utf-8").strip()
        content = str(data.get("content") or "")
        if not content:
            return ""
        raw_bytes = content.encode("utf-8-sig") if filename.lower().endswith(".csv") else content.encode("utf-8")
        downloads.append(
            {
                "mode": "generated",
                "filename": filename,
                "mime_type": mime_type,
                "title": title,
                "auto_download": auto_dl,
                "data_base64": base64.b64encode(raw_bytes).decode("ascii"),
            }
        )
        return ""

    cleaned = _DOWNLOAD_FILE_RE.sub(_replace, raw_text).strip()
    return cleaned, downloads


_PUBLIC_URL_RE = re.compile(
    r"https?://[a-zA-Z0-9.\-_~:/?#\[\]@!$&'()*+,;=%]+",
    re.IGNORECASE,
)


def _is_safe_public_url(url: str) -> bool:
    try:
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ("http", "https"):
            return False
        host = (parsed.hostname or "").lower().strip()
        if not host or host in ("localhost", "0.0.0.0", "::1"):
            return False
        if (
            host.startswith("127.")
            or host.startswith("10.")
            or host.startswith("192.168.")
            or host.startswith("169.254.")
            or host.endswith(".local")
            or host.endswith(".internal")
        ):
            return False
        return True
    except Exception:
        return False


def _fetch_public_web_pages_for_context(
    texts: list[str],
) -> tuple[list[dict[str, Any]], list[str]]:
    seen_urls: list[str] = []
    for txt in texts:
        if not txt:
            continue
        for match in _PUBLIC_URL_RE.findall(txt):
            cleaned_url = match.rstrip(".,;:)>]\"'")
            if _is_safe_public_url(cleaned_url) and cleaned_url not in seen_urls:
                seen_urls.append(cleaned_url)
                if len(seen_urls) >= 4:
                    break
        if len(seen_urls) >= 4:
            break

    web_parts: list[dict[str, Any]] = []
    web_labels: list[str] = []
    for url in seen_urls:
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": (
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
                    ),
                    "Accept": "text/html,application/xhtml+xml,text/plain,*/*;q=0.8",
                },
                method="GET",
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                ctype = (resp.headers.get("Content-Type") or "").lower()
                raw_bytes = resp.read(512 * 1024)
            if "application/pdf" in ctype or url.lower().endswith(".pdf"):
                web_parts.append(
                    {"text": f"🌐 ვებ-ბმულიდან ჩატვირთული PDF დოკუმენტი: {url}"}
                )
                web_parts.append(
                    {
                        "inline_data": {
                            "mime_type": "application/pdf",
                            "data": base64.b64encode(raw_bytes).decode("ascii"),
                            "filename": "web_document.pdf",
                        }
                    }
                )
                web_labels.append(f"🌐 ვებ-გვერდი: {url[:60]}")
                continue

            html_str = raw_bytes.decode("utf-8", errors="replace")
            html_str = re.sub(r"(?is)<(script|style|noscript).*?>.*?</\1>", " ", html_str)
            text_only = re.sub(r"(?s)<[^>]+>", " ", html_str)
            text_only = re.sub(r"\s+", " ", text_only).strip()[:18000]
            if text_only:
                web_parts.append(
                    {
                        "text": (
                            f"🌐 ვებ-გვერდის ({url}) პირდაპირ წაკითხული შინაარსი:\n"
                            f"---\n{text_only}\n---"
                        )
                    }
                )
                web_labels.append(f"🌐 ვებ-გვერდი: {url[:60]}")
        except Exception:
            pass

    return web_parts, web_labels


def _call_gemini_api(
    *,
    api_key: str,
    model: str,
    system_instruction: str,
    contents: list[dict[str, Any]],
    reasoning_level: str = DEFAULT_REASONING_LEVEL,
    out_web_sources: list[str] | None = None,
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

    # Strictly use ONLY gemini-4-argon — never fall back to any 3.x or lite model
    strict_model = "gemini-4-argon"
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{urllib.parse.quote(strict_model)}:generateContent?key={urllib.parse.quote(api_key)}"
    )

    def _send_gemini(enable_search_tool: bool) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "systemInstruction": {
                "parts": [{"text": system_instruction}],
            },
            "contents": cleaned_contents,
            "generationConfig": {
                "temperature": level_cfg["temperature"],
                "maxOutputTokens": level_cfg["max_tokens"],
            },
        }
        if enable_search_tool:
            payload["tools"] = [{"google_search": {}}]
        body_bytes = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=body_bytes,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))

    try:
        resp_data = _send_gemini(enable_search_tool=True)
    except urllib.error.HTTPError as exc:
        err_body = ""
        try:
            err_body = exc.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        if exc.code in (400, 404, 500, 501) and "API key" not in err_body:
            try:
                resp_data = _send_gemini(enable_search_tool=False)
            except urllib.error.HTTPError as exc2:
                exc = exc2
                try:
                    err_body = exc2.read().decode("utf-8", errors="replace")
                except Exception:
                    pass
            else:
                candidates = resp_data.get("candidates") or []
                if not candidates:
                    raise HTTPException(502, "Gemini 4 Argon-მა ცარიელი პასუხი დააბრუნა.")
                parts = candidates[0].get("content", {}).get("parts") or []
                non_thought = [
                    str(p.get("text") or "")
                    for p in parts
                    if "text" in p
                    and not p.get("thought")
                    and not str(p.get("text") or "").lstrip().startswith("thought\n")
                ]
                return "\n".join(non_thought or [str(p.get("text") or "") for p in parts if "text" in p]).strip()
        try:
            err_json = json.loads(err_body)
            err_msg = err_json.get("error", {}).get("message") or err_body
        except Exception:
            err_msg = err_body or str(exc)
        if exc.code in (400, 401, 403) and "API key" in err_msg:
            raise HTTPException(
                400,
                "Gemini API Key არასწორია ან არააქტიურია. გადაამოწმეთ გასაღები პარამეტრებში.",
            )
        if exc.code == 429:
            raise HTTPException(
                429,
                "Google AI Studio-ში ამ API გასაღებზე (My First Project) ჩართულია 'Free tier', სადაც ნამდვილი Gemini 4 Argon (models/gemini-4-argon) დაბლოკილია (ლიმიტი: 0). "
                "ძველ მოდელზე გადართვა სრულად გათიშულია. ნამდვილი Gemini 4 Argon-ის გასახსნელად aistudio.google.com/apikey გვერდზე დააჭირეთ 'Set up prepay' ღილაკს.",
            )
        raise HTTPException(502, f"Gemini 4 Argon API შეცდომა ({exc.code}): {err_msg[:300]}")
    except Exception as exc:
        raise HTTPException(502, f"Gemini 4 Argon-თან დაკავშირება ვერ მოხერხდა: {exc}")

    candidates = resp_data.get("candidates") or []
    if not candidates:
        raise HTTPException(502, "Gemini 4 Argon-მა ცარიელი პასუხი დააბრუნა.")

    if out_web_sources is not None:
        gm = candidates[0].get("groundingMetadata") or {}
        queries = gm.get("webSearchQueries") or []
        for q in queries[:3]:
            if q:
                out_web_sources.append(f"🌐 ვებ-ძიება: {q}")
        chunks = gm.get("groundingChunks") or []
        for ch in chunks[:4]:
            web_info = ch.get("web") if isinstance(ch, dict) else None
            if isinstance(web_info, dict):
                title = str(web_info.get("title") or web_info.get("uri") or "").strip()
                if title and f"🌐 წყარო: {title}" not in out_web_sources:
                    out_web_sources.append(f"🌐 წყარო: {title}")

    parts = candidates[0].get("content", {}).get("parts") or []
    text_chunks = [
        str(p.get("text") or "")
        for p in parts
        if "text" in p
        and not p.get("thought")
        and not str(p.get("text") or "").lstrip().startswith("thought\n")
    ]
    if not text_chunks:
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


@router.get("/ai/files/{source_type}/{source_id}")
def download_ai_stored_file(
    source_type: str,
    source_id: int,
    authorization: str | None = Header(None),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    resolved = _resolve_stored_file(db, source_type, source_id)
    if not resolved:
        raise HTTPException(404, "ფაილი ვერ მოიძებნა.")
    path, filename, mime_type = resolved
    return FileResponse(path=path, media_type=mime_type, filename=filename)


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
        elif payload.attachments:
            last_user_msg = "გთხოვ დეტალურად გააანალიზო მიბმული სკრინი / ფაილი."
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

    if payload.computer_files:
        comp_list = [
            {
                "path": cf.path,
                "name": cf.name,
                "size_bytes": cf.size_bytes,
                "mime_type": cf.mime_type,
            }
            for cf in payload.computer_files[:400]
        ]
        context_str += (
            "\n\n=== ადმინისტრატორის კომპიუტერის დაკავშირებულ საქაღალდეში არსებული ფაილები (local_computer_files) ===\n"
            + json.dumps(comp_list, ensure_ascii=False, indent=2)
        )

    user_uploaded_parts: list[dict[str, Any]] = []
    for att in (payload.attachments or [])[:6]:
        fname = (att.filename or "screenshot.png").strip()
        mime = (att.mime_type or "image/png").strip().lower()
        b64_raw = (att.data_base64 or "").strip()
        if "," in b64_raw and b64_raw.startswith("data:"):
            b64_raw = b64_raw.split(",", 1)[1].strip()
        if not b64_raw:
            continue
        suffix = Path(fname).suffix.lower()
        if mime.startswith("image/") or mime == "application/pdf":
            user_uploaded_parts.append(
                {
                    "text": f"🖼️/📄 ადმინისტრატორის კომპიუტერიდან ჩატში მიბმული ფაილი / სკრინი: '{fname}'"
                }
            )
            user_uploaded_parts.append(
                {
                    "inline_data": {
                        "mime_type": mime,
                        "data": b64_raw,
                        "filename": fname,
                    }
                }
            )
            inspected_labels.append(f"კომპიუტერიდან: {fname}")
        elif suffix == ".docx" or "wordprocessingml" in mime:
            try:
                raw_b = base64.b64decode(b64_raw)
                extracted = _extract_docx_text(raw_b)
                if extracted:
                    user_uploaded_parts.append(
                        {
                            "text": f"📄 ადმინისტრატორის კომპიუტერიდან მიბმული Word ფაილი ('{fname}'):\n---\n{extracted}\n---"
                        }
                    )
                    inspected_labels.append(f"კომპიუტერიდან: {fname}")
            except Exception:
                pass
        else:
            try:
                raw_b = base64.b64decode(b64_raw)
                txt = raw_b.decode("utf-8", errors="replace")[:30000]
                user_uploaded_parts.append(
                    {
                        "text": f"📄 ადმინისტრატორის კომპიუტერიდან მიბმული ფაილი ('{fname}'):\n---\n{txt}\n---"
                    }
                )
                inspected_labels.append(f"კომპიუტერიდან: {fname}")
            except Exception:
                pass

    texts_for_url_scan = [last_user_msg] + [
        str(p.get("text") or "")
        for p in (attachment_parts + user_uploaded_parts)
        if "text" in p
    ]
    web_parts, web_labels = _fetch_public_web_pages_for_context(texts_for_url_scan)
    if web_labels:
        inspected_labels.extend(web_labels)

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
    if user_uploaded_parts:
        final_parts.extend(user_uploaded_parts)
    if web_parts:
        final_parts.extend(web_parts)
    final_parts.append({"text": f"ადმინისტრატორის მოთხოვნა:\n{last_user_msg}"})
    contents.append({"role": "user", "parts": final_parts})

    grounded_web_sources: list[str] = []
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
            out_web_sources=grounded_web_sources,
        )
    if grounded_web_sources:
        inspected_labels.extend(grounded_web_sources)

    today = _today_in_tbilisi()
    default_date = _next_workday(today).isoformat()
    schedule_times = _load_schedule_times()
    clean_reply, proposed_letters = _parse_proposed_letters(
        raw_reply,
        users_by_id=users_by_id,
        templates_map=templates_map,
        default_date=default_date,
        schedule_times=schedule_times,
        last_user_message=last_user_msg,
    )
    clean_reply, download_files = _parse_download_files(
        clean_reply,
        db=db,
    )

    return {
        "reply": clean_reply,
        "proposed_letters": proposed_letters,
        "download_files": download_files,
        "inspected_attachments": inspected_labels,
        "model": cfg["model"],
        "model_label": model_info["label"],
        "reasoning_level": cfg["reasoning_level"],
        "reasoning_level_label": level_info["short_label"],
    }
