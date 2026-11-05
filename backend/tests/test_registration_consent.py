"""Registration-notice tests using only temporary in-memory accounts and OTPs."""
from __future__ import annotations

from contextlib import ExitStack
from datetime import datetime
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import create_engine, event, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from backend.app.models import AuditEvent, Base, User, UserCodeReservation, UserSession
from backend.app.routers import users
from backend.app.schemas import SendVerificationCodeRequest, UserCreateWithVerification
from backend.app.services.audit_log import enable_audit, protect_audit_table
from backend.app.services.registration_notice import (
    REGISTRATION_CONSENT_LABEL,
    REGISTRATION_NOTICE_PARAGRAPHS,
    REGISTRATION_NOTICE_TITLE,
    REGISTRATION_NOTICE_VERSION,
    registration_notice_snapshot,
)


class NoticeParser(HTMLParser):
    """Extract the actual displayed text without markup or formatting spaces."""

    def __init__(self):
        super().__init__()
        self.inside = False
        self.capture = None
        self.parts = []
        self.paragraphs = []
        self.title = None
        self.checkbox_label = None
        self.choice = False
        self.version = None
        self.checkboxes = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "section" and attrs.get("id") == "registrationConsentView":
            self.inside = True
            self.version = attrs.get("data-notice-version")
        if not self.inside:
            return
        if tag == "label" and attrs.get("for") == "registrationConsentCheckbox":
            self.choice = True
        if tag == "input" and attrs.get("type") == "checkbox":
            self.checkboxes.append(attrs)
        if tag == "p" or (tag == "h3" and attrs.get("id") == "registrationConsentTitle") or (tag == "span" and self.choice):
            self.capture = tag
            self.parts = []

    def handle_data(self, data):
        if self.inside and self.capture:
            self.parts.append(data)

    def handle_endtag(self, tag):
        if not self.inside:
            return
        if tag == self.capture:
            value = " ".join("".join(self.parts).split())
            if tag == "p":
                self.paragraphs.append(value)
            elif tag == "h3":
                self.title = value
            else:
                self.checkbox_label = value
            self.capture = None
        if tag == "label":
            self.choice = False
        if tag == "section":
            self.inside = False


class RegistrationConsentTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        self.addCleanup(self.engine.dispose)

        @event.listens_for(self.engine, "connect")
        def foreign_keys(connection, _record):
            connection.execute("PRAGMA foreign_keys=ON")

        Base.metadata.create_all(self.engine)
        with self.engine.begin() as connection:
            protect_audit_table(connection)
        self.db = Session(self.engine)
        self.addCleanup(self.db.close)
        enable_audit(self.db)
        self.patches = ExitStack()
        self.addCleanup(self.patches.close)
        self.otp = self.patches.enter_context(patch.object(users.email_verification, "verify_code", return_value=True))
        self.patches.enter_context(patch.object(users, "get_settings", return_value=SimpleNamespace(founder_admin_email="")))
        self.patches.enter_context(patch.object(users, "hash_code", return_value="synthetic-password-hash"))
        self.patches.enter_context(patch.object(users, "generate_session_token", return_value="synthetic-consent-token"))
        self.patches.enter_context(patch.object(users, "exam_state_with_permissions", return_value={
            "exam_permission": False, "exam_stage": "none", "exam_stage_expires_at": None,
            "exam_stage_started_at": None, "exam_stage_status": "none",
            "exam_stage_remaining_seconds": None, "exam_stage_permissions": {},
        }))
        for name in ("smtplib.SMTP", "smtplib.SMTP_SSL"):
            self.patches.enter_context(patch(name, side_effect=AssertionError("Real mail is forbidden")))

    def values(self, **overrides):
        result = dict(
            personal_id="99900990001", first_name="საცდელი", last_name="მომხმარებელი",
            phone="555000999", email="consent@example.com", password="Synthetic-Consent-123!",
            verification_code="1234", registration_consent_accepted=True,
            registration_notice_version=REGISTRATION_NOTICE_VERSION,
        )
        result.update(overrides)
        return result

    def register(self, **overrides):
        return users.register(UserCreateWithVerification(**self.values(**overrides)), db=self.db)

    def receipts(self):
        return list(self.db.scalars(select(AuditEvent).where(AuditEvent.action == "registration.notice_accepted")))

    def assert_empty_registration(self):
        for model in (User, UserCodeReservation, UserSession, AuditEvent):
            self.assertEqual(self.db.query(model).count(), 0, model.__name__)

    def test_missing_false_or_stale_consent_rejected_before_otp(self):
        cases = [
            {"registration_consent_accepted": False},
            {"registration_notice_version": ""},
            {"registration_notice_version": "outdated-notice"},
        ]
        missing = self.values()
        del missing["registration_consent_accepted"]
        del missing["registration_notice_version"]
        payloads = [missing] + [self.values(**case) for case in cases]
        for values in payloads:
            with self.subTest(values=values.get("registration_notice_version", "missing")):
                with self.assertRaises(HTTPException) as caught:
                    users.register(UserCreateWithVerification(**values), db=self.db)
                self.assertEqual(caught.exception.status_code, 400)
                self.otp.assert_not_called()
                self.assert_empty_registration()

    def test_checkbox_acceptance_must_be_a_real_boolean(self):
        for value in ("true", "false", 1, 0, None, [], {}):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                UserCreateWithVerification(**self.values(registration_consent_accepted=value))
        self.otp.assert_not_called()
        self.assert_empty_registration()

    def test_version_is_bounded(self):
        with self.assertRaises(ValidationError):
            UserCreateWithVerification(**self.values(registration_notice_version="x" * 81))

    def test_success_records_exactly_one_server_text_and_version_receipt(self):
        before = datetime.utcnow()
        result = self.register()
        after = datetime.utcnow()
        receipts = self.receipts()
        self.assertEqual(len(receipts), 1)
        receipt = receipts[0]
        self.assertEqual(receipt.actor_id, result.id)
        self.assertEqual(receipt.target_id, result.id)
        self.assertEqual(receipt.target_type, "users")
        self.assertEqual(receipt.category, "registration")
        self.assertLessEqual(before, receipt.occurred_at)
        self.assertLessEqual(receipt.occurred_at, after)
        data = json.loads(receipt.details)
        self.assertEqual(set(data), {"accepted", "notice_version", "notice", "notice_sha256"})
        self.assertIs(data["accepted"], True)
        self.assertEqual(data["notice_version"], REGISTRATION_NOTICE_VERSION)
        self.assertEqual(data["notice"], registration_notice_snapshot())
        encoded = json.dumps(data["notice"], ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        self.assertEqual(data["notice_sha256"], hashlib.sha256(encoded).hexdigest())
        for private_value in (result.personal_id, result.email, result.phone, "Synthetic-Consent-123!", "1234"):
            self.assertNotIn(private_value, receipt.details)
        self.assertEqual(self.db.query(User).count(), 1)
        self.assertEqual(self.db.query(UserSession).count(), 1)
        self.otp.assert_called_once_with("consent@example.com", "1234", "register")

    def test_audit_snapshot_matches_the_single_checkbox_notice_shown_in_html(self):
        path = Path(__file__).resolve().parents[2] / "frontend/partials/header.html"
        parser = NoticeParser()
        parser.feed(path.read_text(encoding="utf-8"))
        self.assertEqual(parser.version, REGISTRATION_NOTICE_VERSION)
        self.assertEqual(parser.title, REGISTRATION_NOTICE_TITLE)
        self.assertEqual(parser.paragraphs, list(REGISTRATION_NOTICE_PARAGRAPHS))
        self.assertEqual(parser.checkbox_label, REGISTRATION_CONSENT_LABEL)
        self.assertEqual(len(parser.checkboxes), 1)
        self.assertNotIn("checked", parser.checkboxes[0])
        self.assertIn("required", parser.checkboxes[0])

    def test_invalid_otp_never_creates_acceptance(self):
        self.otp.return_value = False
        with self.assertRaises(HTTPException) as caught:
            self.register()
        self.assertEqual(caught.exception.status_code, 400)
        self.assert_empty_registration()

    def test_account_commit_failure_rolls_back_account_reservation_and_receipt(self):
        with patch.object(self.db, "commit", side_effect=RuntimeError("synthetic commit failure")):
            with self.assertRaisesRegex(RuntimeError, "synthetic commit failure"):
                self.register()
        self.assert_empty_registration()

    def test_audit_write_failure_cannot_leave_account_without_receipt(self):
        with self.engine.begin() as connection:
            connection.exec_driver_sql("""CREATE TRIGGER reject_synthetic_consent BEFORE INSERT ON audit_events
                WHEN NEW.action = 'registration.notice_accepted'
                BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END""")
        with self.assertRaises(HTTPException) as caught:
            self.register()
        self.assertEqual(caught.exception.status_code, 503)
        self.otp.assert_called_once()
        self.assert_empty_registration()

    def test_integrity_retry_does_not_duplicate_receipt_or_consume_otp_twice(self):
        original_commit = self.db.commit
        calls = 0

        def fail_first_commit():
            nonlocal calls
            calls += 1
            if calls == 1:
                raise IntegrityError("synthetic collision", {}, RuntimeError("synthetic"))
            return original_commit()

        with patch.object(self.db, "commit", side_effect=fail_first_commit):
            self.register()
        self.assertEqual(len(self.receipts()), 1)
        self.assertEqual(self.db.query(User).count(), 1)
        self.assertEqual(self.db.query(UserCodeReservation).count(), 1)
        self.otp.assert_called_once()

    def test_auto_login_failure_preserves_successfully_created_account_and_receipt(self):
        original_commit = self.db.commit
        calls = 0

        def fail_auto_login_commit():
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError("synthetic auto-login failure")
            return original_commit()

        with patch.object(self.db, "commit", side_effect=fail_auto_login_commit):
            result = self.register()
        self.assertIsNone(result.token)
        self.assertEqual(self.db.query(User).count(), 1)
        self.assertEqual(self.db.query(UserSession).count(), 0)
        self.assertEqual(len(self.receipts()), 1)

    def test_duplicate_account_does_not_create_another_acceptance(self):
        self.register()
        with self.assertRaises(HTTPException) as caught:
            self.register()
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(len(self.receipts()), 1)

    def test_existing_append_only_journal_protects_receipt(self):
        self.register()
        receipt_id = self.receipts()[0].id
        for sql in ("UPDATE audit_events SET details='{}' WHERE id=:id", "DELETE FROM audit_events WHERE id=:id"):
            with self.subTest(sql=sql), self.assertRaises(IntegrityError):
                self.db.execute(text(sql), {"id": receipt_id})
            self.db.rollback()
        self.assertEqual(len(self.receipts()), 1)

    def test_receipt_is_not_cascade_deleted_with_account(self):
        result = self.register()
        self.db.delete(self.db.get(User, result.id))
        self.db.commit()
        self.assertEqual(self.db.query(User).count(), 0)
        self.assertEqual(len(self.receipts()), 1)

    def test_other_otp_request_schemas_do_not_gain_consent_requirement(self):
        for purpose in ("register", "reset_password", "change_email"):
            payload = SendVerificationCodeRequest(email="consent@example.com", purpose=purpose)
            self.assertNotIn("registration_consent_accepted", payload.model_dump())


if __name__ == "__main__":
    unittest.main()
