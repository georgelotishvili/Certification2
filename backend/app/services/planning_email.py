"""Bounded private attachments and honest SMTP delivery outcomes for planning."""
from __future__ import annotations

from email.message import EmailMessage
from email.utils import formataddr
import mimetypes
import smtplib
import ssl

from ..config import get_settings
from .email_verification import _get_smtp_config, _is_console_mode, _is_smtp_mode
from .media_storage import resolve_storage_path

ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024


def deliver_letter(letter) -> tuple[str, str | None]:
    """No hidden retries: after an ambiguous SMTP disconnect, require review."""
    settings = get_settings()
    if not _is_smtp_mode(settings):
        if _is_console_mode(settings):
            # Do not log a candidate's private letter or pretend it was delivered.
            return "simulated", None
        return "failed", "ელფოსტის გაგზავნა არ არის გამართული."
    config = _get_smtp_config(settings)
    if not all(config.get(key) for key in ("host", "user", "password", "from_address")):
        return "failed", "ოფიციალური ელფოსტის პარამეტრები შესავსებია."
    if config["encryption"] not in ("ssl", "tls", "starttls"):
        return "failed", "ელფოსტის უსაფრთხო კავშირი არ არის გამართული."

    try:
        msg = EmailMessage()
        msg["From"] = formataddr((config["from_name"], config["from_address"]))
        msg["To"] = letter.to_email
        msg["Subject"] = letter.subject
        # Stable identity is useful for reconciliation; it is not a claim that
        # SMTP recipients will deduplicate messages automatically.
        sender_domain = str(config["from_address"]).rsplit("@", 1)[-1]
        msg["Message-ID"] = f"<planning-{letter.request_id}@{sender_domain}>"
        doc_num = (getattr(letter, "doc_number", None) or "").strip()
        email_body = letter.body or ""
        if doc_num and doc_num not in email_body:
            email_body = f"დოკუმენტის №: {doc_num}\n\n{email_body}"
        msg.set_content(email_body, charset="utf-8")
        if letter.attachment_path:
            path = resolve_storage_path(letter.attachment_path)
            with path.open("rb") as source:
                data = source.read(ATTACHMENT_MAX_BYTES + 1)
            if not data or len(data) > ATTACHMENT_MAX_BYTES:
                return "failed", "მიმაგრებული ფაილი ვერ მომზადდა."
            mime = mimetypes.guess_type(letter.attachment_filename or "")[0] or "application/octet-stream"
            major, minor = mime.split("/", 1)
            msg.add_attachment(data, maintype=major, subtype=minor, filename=letter.attachment_filename)
    except Exception:
        return "failed", "წერილი ან მიმაგრებული ფაილი ვერ მომზადდა."

    server = None
    submitting = False
    try:
        context = ssl.create_default_context()
        if config["encryption"] == "ssl" or config["port"] == 465:
            server = smtplib.SMTP_SSL(config["host"], config["port"], timeout=20, context=context)
        else:
            server = smtplib.SMTP(config["host"], config["port"], timeout=20)
            server.starttls(context=context)
        server.login(config["user"], config["password"])
        submitting = True
        refused = server.send_message(msg)
        if refused:
            return "failed", "ელფოსტის სერვერმა მიმღები არ მიიღო."
        return "sent", None
    except (smtplib.SMTPRecipientsRefused, smtplib.SMTPSenderRefused, smtplib.SMTPDataError):
        return "failed", "ელფოსტის სერვერმა წერილი არ მიიღო."
    except Exception:
        if submitting:
            return "uncertain", "გაგზავნის შედეგი დაუდასტურებელია; გამეორებამდე გადაამოწმეთ ოფიციალური ელფოსტა."
        return "failed", "ელფოსტასთან კავშირი ვერ დამყარდა. სცადეთ ხელახლა."
    finally:
        if server is not None:
            try:
                server.quit()
            except Exception:
                pass
