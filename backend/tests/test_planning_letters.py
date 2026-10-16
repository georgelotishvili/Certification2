"""Local-only planning-letter regression coverage: no real SMTP or media writes."""
from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

try:
    from backend.app.database import get_db
    from backend.app.models import Base, ExamSchedule, PlanningLetter, User, UserSession
    from backend.app.routers import admin, exam_schedules, planning_letters
    from backend.app.services import media_storage, planning_email
except ModuleNotFoundError:
    from app.database import get_db
    from app.models import Base, ExamSchedule, PlanningLetter, User, UserSession
    from app.routers import admin, exam_schedules, planning_letters
    from app.services import media_storage, planning_email


class PlanningLetterTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine(
            "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool,
        )
        event.listen(self.engine, "connect", lambda connection, _: connection.execute("PRAGMA foreign_keys=ON"))
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.addCleanup(self.engine.dispose)
        self.addCleanup(self.db.close)
        self.directory = TemporaryDirectory(prefix="gipc-planning-tests-")
        self.addCleanup(self.directory.cleanup)
        self.media = Path(self.directory.name)
        settings = patch.object(admin, "get_settings", return_value=SimpleNamespace(
            founder_admin_email="founder@example.test",
        ))
        settings.start()
        self.addCleanup(settings.stop)
        self.smtp = patch("smtplib.SMTP", side_effect=AssertionError("Real SMTP is forbidden in tests"))
        self.smtp_ssl = patch("smtplib.SMTP_SSL", side_effect=AssertionError("Real SMTP is forbidden in tests"))
        self.smtp.start()
        self.smtp_ssl.start()
        self.addCleanup(self.smtp.stop)
        self.addCleanup(self.smtp_ssl.stop)
        self.delivery_patch = patch.object(planning_letters, "deliver_letter", return_value=("simulated", None))
        self.delivery = self.delivery_patch.start()
        self.addCleanup(self.delivery_patch.stop)
        self.storage_patch = patch.object(media_storage, "_MEDIA_ROOT_CACHE", self.media)
        self.storage_patch.start()
        self.addCleanup(self.storage_patch.stop)
        self.candidate = self.add_user(1)
        self.staff = self.add_user(2, is_admin=True)
        self.other_candidate = self.add_user(3)
        self.auth = {"Authorization": "Bearer token-2"}
        app = FastAPI()
        app.include_router(planning_letters.router, prefix="/admin")
        app.include_router(exam_schedules.router, prefix="/admin")
        app.dependency_overrides[get_db] = lambda: self.db
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def add_user(self, number, **overrides):
        values = dict(
            id=number, personal_id=f"{number:011d}", first_name=f"Person{number}",
            last_name="Family", phone=f"555{number:06d}", email=f"person{number}@example.test",
            password_hash="unused-test-hash", code=f"{number:010d}",
        )
        values.update(overrides)
        user = User(**values)
        self.db.add(user)
        self.db.flush()
        self.db.add(UserSession(
            user_id=user.id, token=f"token-{number}", expires_at=datetime.utcnow() + timedelta(hours=1),
        ))
        self.db.commit()
        return user

    def form(self, **overrides):
        result = dict(
            kind="exam", event_date="2027-03-20", event_time="10:30", subject="Exam invitation",
            body="Please attend the exam at the confirmed time.", request_id=str(uuid4()),
            confirmed="true", expected_to_email=self.candidate.email,
            use_template_attachment="false",
        )
        result.update(overrides)
        return result

    def send(self, data=None, user_id=None, files=None, headers=None):
        return self.client.post(
            f"/admin/users/{user_id or self.candidate.id}/planning-letters",
            data=data or self.form(), files=files, headers=self.auth if headers is None else headers,
        )

    def saved(self, response):
        self.assertIn(response.status_code, (200, 201), response.text)
        return response.json()

    def history(self, user_id=None):
        result = self.client.get(
            f"/admin/users/{user_id or self.candidate.id}/planning-letters", headers=self.auth,
        )
        self.assertEqual(result.status_code, 200, result.text)
        return result.json()["items"]

    def save_template(self, kind="exam", **overrides):
        values = dict(subject="An invitation for {name}", body="Your appointment: {date}, {time}. Code: {code}.")
        values.update(overrides)
        result = self.client.put(f"/admin/planning-templates/{kind}", headers=self.auth, data=values)
        return self.saved(result)

    def test_templates_and_history_are_admin_only(self):
        for headers in ({}, {"Authorization": "Bearer token-1"}, {"Authorization": "Bearer missing"}):
            for path in ("/admin/planning-templates", "/admin/users/1/planning-letters"):
                with self.subTest(headers=headers, path=path):
                    response = self.client.get(path, headers=headers)
                    self.assertIn(response.status_code, (401, 403))
            self.assertIn(self.send(headers=headers).status_code, (401, 403))
            response = self.client.put(
                "/admin/planning-templates/exam", headers=headers, data={"subject": "S", "body": "B"},
            )
            self.assertIn(response.status_code, (401, 403))
        self.delivery.assert_not_called()
        self.assertEqual(self.history(), [])

    def test_saving_templates_does_not_send_or_schedule(self):
        self.save_template()
        self.save_template("certificate", body="Certificate appointment: {date} {time}")
        result = self.client.get("/admin/planning-templates", headers=self.auth)
        self.assertEqual(result.status_code, 200)
        self.assertEqual({item["kind"] for item in result.json()["items"]}, {"exam", "certificate"})
        self.delivery.assert_not_called()
        self.assertEqual(self.db.scalars(select(ExamSchedule)).all(), [])
        self.assertEqual(self.history(), [])

    def test_confirmation_is_required_before_sending_or_scheduling(self):
        for value in ("false", ""):
            response = self.send(self.form(confirmed=value))
            self.assertIn(response.status_code, (400, 422), response.text)
        values = self.form()
        del values["confirmed"]
        self.assertIn(self.send(values).status_code, (400, 422))
        self.delivery.assert_not_called()
        self.assertEqual(self.db.scalars(select(ExamSchedule)).all(), [])

    def test_noon_boundary_is_automatic_and_exam_permission_stays_unchanged(self):
        for day, time, period in (("2027-03-20", "11:59", "morning"), ("2027-03-21", "12:00", "evening"), ("2027-03-22", "00:00", "morning")):
            letter = self.saved(self.send(self.form(event_date=day, event_time=time)))
            schedule = self.db.get(ExamSchedule, letter["exam_schedule_id"])
            self.assertEqual(schedule.period, period)
            self.assertEqual(letter["event_time"], time)
            self.assertEqual(letter["status"], "simulated")
        self.db.refresh(self.candidate)
        self.assertFalse(self.candidate.exam_permission)
        self.assertEqual(self.candidate.exam_stage, "none")

    def test_certificate_letter_does_not_schedule_exam_or_issue_certificate(self):
        letter = self.saved(self.send(self.form(kind="certificate")))
        self.assertIsNone(letter["exam_schedule_id"])
        self.assertEqual(self.db.scalars(select(ExamSchedule)).all(), [])
        self.db.refresh(self.candidate)
        self.assertIsNone(self.candidate.certificate)

    def test_repeated_request_id_returns_same_letter_without_resending(self):
        values = self.form()
        first = self.saved(self.send(values))
        second = self.saved(self.send(values))
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(len(self.history()), 1)
        self.assertEqual(len(self.db.scalars(select(ExamSchedule)).all()), 1)
        self.delivery.assert_called_once()

    def test_request_id_cannot_be_reused_for_another_candidate(self):
        values = self.form()
        self.saved(self.send(values))
        values["expected_to_email"] = self.other_candidate.email
        response = self.send(values, user_id=self.other_candidate.id)
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(self.history(self.other_candidate.id), [])
        self.delivery.assert_called_once()

    def test_request_id_cannot_silently_reuse_different_letter_content(self):
        values = self.form()
        self.saved(self.send(values))
        values["body"] = "A different letter requires a fresh confirmation and request id."
        response = self.send(values)
        self.assertEqual(response.status_code, 409, response.text)
        self.delivery.assert_called_once()

    def test_retry_requires_admin_and_cannot_target_another_person(self):
        self.delivery.return_value = ("failed", "Delivery unavailable")
        letter = self.saved(self.send())
        for headers in ({}, {"Authorization": "Bearer token-1"}):
            response = self.client.post(
                f"/admin/users/1/planning-letters/{letter['id']}/retry", headers=headers,
                data={"confirmed": "true", "expected_to_email": self.candidate.email},
            )
            self.assertIn(response.status_code, (401, 403))
        response = self.client.post(
            f"/admin/users/3/planning-letters/{letter['id']}/retry", headers=self.auth,
            data={"confirmed": "true", "expected_to_email": self.other_candidate.email},
        )
        self.assertEqual(response.status_code, 404, response.text)
        self.delivery.assert_called_once()

    def test_missing_user_and_stale_recipient_do_not_send(self):
        self.assertEqual(self.send(user_id=9999).status_code, 404)
        response = self.send(self.form(expected_to_email="stale@example.test"))
        self.assertEqual(response.status_code, 409, response.text)
        self.delivery.assert_not_called()
        self.assertEqual(self.history(), [])

    def test_invalid_dates_times_kinds_and_uuid_are_rejected(self):
        for overrides in (
            {"event_date": "2027-02-30"}, {"event_time": "24:00"}, {"event_time": "10:60"},
            {"event_time": "10:00:59"}, {"kind": "unknown"}, {"request_id": "not-a-uuid"},
            {"subject": ""}, {"body": ""}, {"subject": "a" * 201}, {"body": "a" * 10001},
            {"subject": "Header\r\nBcc: someone@example.test"},
        ):
            with self.subTest(overrides=overrides):
                response = self.send(self.form(**overrides))
                self.assertIn(response.status_code, (400, 422), response.text)
        self.delivery.assert_not_called()
        self.assertEqual(self.history(), [])

    def test_unrendered_placeholders_are_rejected_without_sending(self):
        for token in ("{name}", "{date}", "{time}", "{code}"):
            with self.subTest(token=token):
                response = self.send(self.form(body=f"Dear {token}"))
                self.assertIn(response.status_code, (400, 422), response.text)
        self.delivery.assert_not_called()

    def test_history_keeps_original_subject_body_and_recipient_after_edits(self):
        self.save_template()
        values = self.form()
        letter = self.saved(self.send(values))
        self.save_template(subject="Changed subject", body="Changed common text")
        self.candidate.email = "new-address@example.test"
        self.db.commit()
        row = self.history()[0]
        self.assertEqual(row["id"], letter["id"])
        self.assertEqual(row["subject"], values["subject"])
        self.assertEqual(row["body"], values["body"])
        self.assertEqual(row["to_email"], values["expected_to_email"])

    def test_failed_delivery_preserves_letter_and_schedule_for_retry(self):
        self.delivery.return_value = ("failed", "Email service temporarily unavailable")
        letter = self.saved(self.send())
        self.assertEqual(letter["status"], "failed")
        self.assertIsNotNone(self.db.get(ExamSchedule, letter["exam_schedule_id"]))
        self.delivery.return_value = ("sent", None)
        result = self.client.post(
            f"/admin/users/1/planning-letters/{letter['id']}/retry", headers=self.auth,
            data={"confirmed": "true", "expected_to_email": self.candidate.email},
        )
        retried = self.saved(result)
        self.assertEqual(retried["status"], "sent")
        self.assertEqual(retried["id"], letter["id"])
        self.assertEqual(len(self.history()), 1)
        self.assertEqual(len(self.db.scalars(select(ExamSchedule)).all()), 1)
        self.assertEqual(self.delivery.call_count, 2)

    def test_sent_or_uncertain_letter_cannot_be_retried_blindly(self):
        for day, status in (("2027-03-20", "sent"), ("2027-03-21", "uncertain")):
            self.delivery.return_value = (status, None)
            letter = self.saved(self.send(self.form(event_date=day)))
            result = self.client.post(
                f"/admin/users/1/planning-letters/{letter['id']}/retry", headers=self.auth,
                data={"confirmed": "true", "expected_to_email": self.candidate.email},
            )
            self.assertEqual(result.status_code, 200, result.text)
            self.assertEqual(result.json()["status"], status)
        self.assertEqual(self.delivery.call_count, 2)

    def test_executable_attachment_is_rejected_without_any_writes(self):
        result = self.send(files={"attachment": ("program.exe", b"MZnot-a-program", "application/octet-stream")})
        self.assertIn(result.status_code, (400, 422), result.text)
        self.delivery.assert_not_called()
        self.assertEqual(self.history(), [])
        self.assertEqual([item for item in self.media.rglob("*") if item.is_file()], [])

    def test_attachment_is_private_and_exact_bytes_are_preserved(self):
        document = b"%PDF-1.4\nTest attachment for a local-only regression test"
        letter = self.saved(self.send(files={"attachment": ("exam.pdf", document, "application/pdf")}))
        url = f"/admin/users/1/planning-letters/{letter['id']}/attachment"
        for headers in ({}, {"Authorization": "Bearer token-1"}, {"Authorization": "Bearer token-3"}):
            denied = self.client.get(url, headers=headers)
            self.assertIn(denied.status_code, (401, 403))
        response = self.client.get(url, headers=self.auth)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.content, document)
        self.assertIn("attachment", response.headers["content-disposition"])

    def test_save_only_creates_schedule_and_saved_letter_without_smtp(self):
        response = self.send(self.form(
            action_mode="save_only",
            event_date="2027-04-10",
            event_time="11:30",
            period="morning",
        ))
        letter = self.saved(response)
        self.assertEqual(letter["status"], "saved")
        self.assertIsNotNone(letter["exam_schedule_id"])
        self.assertEqual(letter["period"], "morning")
        self.delivery.assert_not_called()
        schedule = self.db.get(ExamSchedule, letter["exam_schedule_id"])
        self.assertIsNotNone(schedule)
        self.assertEqual(str(schedule.exam_date), "2027-04-10")
        self.assertEqual(schedule.period, "morning")

    def test_send_only_sends_email_without_creating_exam_schedule(self):
        self.delivery.return_value = ("sent", None)
        response = self.send(self.form(
            action_mode="send_only",
            event_date="2027-04-12",
            event_time="15:00",
            period="evening",
        ))
        letter = self.saved(response)
        self.assertEqual(letter["status"], "sent")
        self.assertIsNone(letter["exam_schedule_id"])
        self.delivery.assert_called_once()
        self.assertEqual(self.db.scalars(select(ExamSchedule)).all(), [])
        # Can also delete standalone letter
        del_res = self.client.delete(
            f"/admin/users/1/planning-letters/{letter['id']}", headers=self.auth
        )
        self.assertEqual(del_res.status_code, 204, del_res.text)
        self.assertEqual(self.history(), [])

    def test_edit_existing_schedule_with_save_only_and_save_and_send(self):
        self.delivery.return_value = ("sent", None)
        first = self.saved(self.send(self.form(
            action_mode="save_only",
            event_date="2027-05-01",
            event_time="10:00",
            period="morning",
        )))
        schedule_id = first["exam_schedule_id"]
        letter_id = first["id"]
        self.delivery.assert_not_called()

        # Edit date, period, time and choose save_and_send
        edited = self.saved(self.send(self.form(
            action_mode="save_and_send",
            schedule_id=str(schedule_id),
            edit_letter_id=str(letter_id),
            event_date="2027-05-02",
            event_time="16:30",
            period="evening",
            subject="განახლებული სათაური",
            body="განახლებული ტექსტი 02.05.2027 16:30",
        )))
        self.assertEqual(len(self.history()), 1)
        self.assertEqual(edited["exam_schedule_id"], schedule_id)
        self.assertEqual(edited["status"], "sent")
        self.assertEqual(edited["event_date"], "2027-05-02")
        self.assertEqual(edited["event_time"], "16:30")
        self.assertEqual(edited["period"], "evening")
        self.delivery.assert_called_once()
        self.db.expire_all()
        schedule = self.db.get(ExamSchedule, schedule_id)
        self.assertEqual(str(schedule.exam_date), "2027-05-02")
        self.assertEqual(schedule.period, "evening")


if __name__ == "__main__":
    unittest.main()

