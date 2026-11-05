"""Versioned registration notice and its transactional acceptance receipt.

The receipt records the server's notice, not client-supplied legal text. It is
inserted in the same transaction as the new account and uses the existing
append-only audit journal. No additional contact, password, OTP or IP data is
copied into the receipt.
"""
from __future__ import annotations

import hashlib
import json

from ..models import AuditEvent


REGISTRATION_NOTICE_VERSION = "20261105-registration-privacy2"
REGISTRATION_NOTICE_TITLE = "ინფორმაცია პერსონალური მონაცემების დამუშავების შესახებ"
REGISTRATION_NOTICE_PARAGRAPHS = (
    "დამუშავებისთვის პასუხისმგებელი პირი: შპს „საქართველოს პროფესიული სერტიფიცირების ინსტიტუტი“ (ს/კ: 405773854; მის.: ქ. თბილისი, მირიან მეფის ქ. №98; ელფოსტა: info@gipc.ge).",
    "მიზანი და მონაცემები: თქვენს მიერ მოწოდებული პერსონალური მონაცემები და დოკუმენტები (სახელი, გვარი, პირადი ნომერი, საკონტაქტო მონაცემები, განათლებისა და გამოცდილების დამადასტურებელი საბუთები, საგამოცდო შედეგები და აუდიო-ვიდეო/ეკრანის ჩანაწერები) მუშავდება პირის იდენტიფიცირების, საკვალიფიკაციო წინაპირობების შემოწმების, სასერტიფიკაციო გამოცდის ჩატარების, სერტიფიცირებისა და კანონმდებლობით სავალდებულო საჯარო რეესტრის წარმოების მიზნით („პერსონალურ მონაცემთა დაცვის შესახებ“ საქართველოს კანონის, საქართველოს მთავრობის №134 დადგენილებისა და სსტ ისო/იეკ 17024 სტანდარტის შესაბამისად).",
    "ხელოვნური ინტელექტის (AI) გამოყენება: ინსტიტუტის ადმინისტრაციულ პანელში რეგისტრირებული მონაცემების, განცხადებებისა და თანდართული დოკუმენტების წინასწარი ტექნიკური ანალიზისა და სარეკომენდაციო/საინფორმაციო წერილების პროექტების მოსამზადებლად დამხმარე საშუალებად გამოიყენება ხელოვნური ინტელექტის (AI) მოდული (Google Gemini / OpenAI). AI არ იღებს დამოუკიდებელ გადაწყვეტილებას და არ ითვლის საგამოცდო ქულებს — ნებისმიერ გადაწყვეტილებას იღებს და წერილს ადასტურებს მხოლოდ ინსტიტუტის უფლებამოსილი პირი.",
    "დეტალური ინფორმაცია მონაცემთა შენახვის ვადებისა და თქვენი უფლებების შესახებ იხილეთ სრულ დოკუმენტში: კონფიდენციალურობის პოლიტიკა (GIPC-POL-002).",
)
REGISTRATION_CONSENT_LABEL = "გავეცანი კონფიდენციალურობის პოლიტიკასა და სერტიფიცირების პირობებს და ვეთანხმები ჩემი პერსონალური მონაცემების დამუშავებას (მათ შორის, დამხმარე ადმინისტრაციული ანალიზისთვის ხელოვნური ინტელექტის — AI გამოყენებით) სერტიფიცირების მიზნებისთვის."


def registration_notice_snapshot() -> dict:
    return {
        "title": REGISTRATION_NOTICE_TITLE,
        "paragraphs": list(REGISTRATION_NOTICE_PARAGRAPHS),
        "checkbox_label": REGISTRATION_CONSENT_LABEL,
    }


def record_registration_consent(db, user) -> None:
    """Add one acceptance to the caller's account-creation transaction."""
    notice = registration_notice_snapshot()
    canonical = json.dumps(notice, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    details = {
        "accepted": True,
        "notice_version": REGISTRATION_NOTICE_VERSION,
        "notice": notice,
        "notice_sha256": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
    }
    db.add(AuditEvent(
        category="registration",
        action="registration.notice_accepted",
        actor_id=user.id,
        actor_label=f"მომხმარებელი #{user.id}",
        target_type="users",
        target_id=user.id,
        target_label=f"მომხმარებელი #{user.id}",
        details=json.dumps(details, ensure_ascii=False, separators=(",", ":")),
    ))
