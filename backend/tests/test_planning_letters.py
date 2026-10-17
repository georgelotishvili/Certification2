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
    from backend.app.models import (
        Base, Exam, ExamSchedule, Session as ExamSession,
        MultiApartmentEvaluation, MultiApartmentProject,
        MultiFunctionalEvaluation, MultiFunctionalProject,
        PlanningLetter, User, UserSession,
    )
    from backend.app.routers import admin, exam_schedules, planning_letters, users
    from backend.app.services import media_storage, planning_email
except ModuleNotFoundError:
    from app.database import get_db
    from app.models import (
        Base, Exam, ExamSchedule, Session as ExamSession,
        MultiApartmentEvaluation, MultiApartmentProject,
        MultiFunctionalEvaluation, MultiFunctionalProject,
        PlanningLetter, User, UserSession,
    )
    from app.routers import admin, exam_schedules, planning_letters, users
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
        user_settings = patch.object(users, "get_settings", return_value=SimpleNamespace(
            founder_admin_email="founder@example.test",
        ))
        user_settings.start()
        self.addCleanup(user_settings.stop)
        self.smtp = patch("smtplib.SMTP", side_effect=AssertionError("Real SMTP is forbidden in tests"))
        self.smtp_ssl = patch("smtplib.SMTP_SSL", side_effect=AssertionError("Real SMTP is forbidden in tests"))
        self.smtp.start()
        self.smtp_ssl.start()
        self.addCleanup(self.smtp.stop)
        self.addCleanup(self.smtp_ssl.stop)
        self.delivery_patch = patch.object(planning_letters, "deliver_letter", return_value=("simulated", None))
        self.delivery = self.delivery_patch.start()
        self.addCleanup(self.delivery_patch.stop)
        self.users_delivery_patch = patch.object(users, "deliver_letter", side_effect=lambda letter: self.delivery(letter))
        self.users_delivery_patch.start()
        self.addCleanup(self.users_delivery_patch.stop)
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
        app.include_router(admin.router, prefix="/admin")
        app.include_router(users.router, prefix="/users")
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

    def test_rejection_template_and_letters(self):
        # 1. GET /admin/planning-templates includes rejection_template
        tmpl_res = self.client.get("/admin/planning-templates", headers=self.auth)
        self.assertEqual(tmpl_res.status_code, 200, tmpl_res.text)
        rej = tmpl_res.json().get("rejection_template")
        self.assertIsNotNone(rej)
        self.assertEqual(rej["kind"], "rejection")
        self.assertTrue(rej["body"].startswith("ადრესატი: "))

        # 2. PUT /admin/planning-templates/rejection updates standard negative response template
        put_res = self.client.put(
            "/admin/planning-templates/rejection",
            headers=self.auth,
            data={"subject": "უარყოფითი პასუხი — {date}", "body": "მოგესალმებით,\n\nსატესტო უარი: {name}"},
        )
        self.assertEqual(put_res.status_code, 200, put_res.text)
        self.assertEqual(put_res.json()["subject"], "უარყოფითი პასუხი — {date}")

        # 3. POST /admin/users/1/planning-letters with period="rejection" saves/sends without creating ExamSchedule
        self.delivery.return_value = ("sent", None)
        sent_rej = self.saved(self.send(self.form(
            action_mode="save_and_send",
            period="rejection",
            event_date="2027-06-01",
            event_time="00:00",
            subject="უარყოფითი პასუხი — 01-06-2027",
            body="მოგესალმებით,\n\nსატესტო უარყოფითი პასუხი",
        )))
        self.assertEqual(sent_rej["period"], "rejection")
        self.assertEqual(sent_rej["status"], "sent")
        self.assertIsNone(sent_rej["exam_schedule_id"])
        self.assertEqual(self.db.scalars(select(ExamSchedule)).all(), [])
        self.delivery.assert_called_once()

        # 4. exam_fail template and letter
        fail_tmpl = tmpl_res.json().get("exam_fail_template")
        self.assertIsNotNone(fail_tmpl)
        self.assertEqual(fail_tmpl["kind"], "exam_fail")
        self.assertTrue(fail_tmpl["body"].startswith("ადრესატი: "))

        put_fail = self.client.put(
            "/admin/planning-templates/exam_fail",
            headers=self.auth,
            data={"subject": "გამოცდის შედეგი — {date}", "body": "მოგესალმებით,\n\nგანმეორებითი გამოცდა: {name}"},
        )
        self.assertEqual(put_fail.status_code, 200, put_fail.text)

        saved_fail = self.saved(self.send(self.form(
            kind="certificate",
            action_mode="save_only",
            period="exam_fail",
            event_date="2027-06-05",
            event_time="00:00",
            subject="გამოცდის შედეგი — 05-06-2027",
            body="მოგესალმებით,\n\nსატესტო ჩაჭრის წერილი",
        )))
        self.assertEqual(saved_fail["period"], "exam_fail")
        self.assertEqual(saved_fail["status"], "saved")
        self.assertIsNone(saved_fail["exam_schedule_id"])

        # 5. custom message without template (period="custom")
        sent_custom = self.saved(self.send(self.form(
            kind="exam",
            action_mode="save_and_send",
            period="custom",
            event_date="2027-06-10",
            event_time="00:00",
            subject="შეტყობინება — GIPC",
            body="ეს არის თავისუფალი ტექსტის შეტყობინება შაბლონის გარეშე.",
            use_template_attachment="false",
        )))
        self.assertEqual(sent_custom["period"], "custom")
        self.assertEqual(sent_custom["status"], "sent")
        self.assertIsNone(sent_custom["exam_schedule_id"])

    def test_certificate_activation_notification(self):
        self.delivery.return_value = ("sent", None)

        # 1. Create certificate with send_notification=False -> only saves certificate
        create_res = self.client.post(
            "/users/1/certificate",
            headers=self.auth,
            json={
                "unique_code": "1000000001",
                "level": "architect",
                "status": "active",
                "issue_date": "2026-10-16",
                "validity_term": 5,
                "valid_until": "2031-10-16",
                "send_notification": False,
            },
        )
        self.assertEqual(create_res.status_code, 201, create_res.text)
        create_data = create_res.json()
        self.assertIsNone(create_data.get("notification_status"))
        self.assertEqual(self.db.scalars(select(PlanningLetter)).all(), [])
        self.delivery.assert_not_called()

        # 2. Update certificate with send_notification=True -> saves AND sends §3.11 notification
        update_res = self.client.put(
            "/users/1/certificate",
            headers=self.auth,
            json={
                "unique_code": "1000000001",
                "level": "expert",
                "status": "active",
                "issue_date": "2026-10-16",
                "validity_term": 5,
                "valid_until": "2031-10-16",
                "send_notification": True,
            },
        )
        self.assertEqual(update_res.status_code, 200, update_res.text)
        update_data = update_res.json()
        self.assertEqual(update_data.get("notification_status"), "sent")
        letters = self.db.scalars(select(PlanningLetter)).all()
        self.assertEqual(len(letters), 1)
        self.assertEqual(letters[0].period, "cert_issued")
        self.assertTrue(letters[0].body.startswith("ადრესატი: "))
        self.assertIn("გილოცავთ! თქვენზე გაიცა სერტიფიკატი.", letters[0].body)
        self.assertIn("gipc.org.ge", letters[0].body)
        self.assertEqual(letters[0].subject, "სერტიფიკატის გაცემა და საჯარო რეესტრში ასახვა")

        # 3. Upload PDF and call POST /users/1/certificate/notify -> attaches PDF to §3.11 email
        upload_res = self.client.post(
            "/users/1/certificate/file",
            headers=self.auth,
            files={"file": ("certificate.pdf", b"%PDF-1.4 sample certificate", "application/pdf")},
        )
        self.assertEqual(upload_res.status_code, 204, upload_res.text)

        notify_res = self.client.post(
            "/users/1/certificate/notify",
            headers=self.auth,
            json={
                "subject": "ჩასწორებული სათაური — {code}",
                "body": "მოგესალმებით,\n\nჩასწორებული ტექსტი: {name}, კოდი: {code}",
            },
        )
        self.assertEqual(notify_res.status_code, 200, notify_res.text)
        self.assertEqual(notify_res.json().get("notification_status"), "sent")
        letters = self.db.scalars(select(PlanningLetter).order_by(PlanningLetter.id)).all()
        self.assertEqual(len(letters), 2)
        self.assertEqual(letters[1].attachment_filename, "certificate-1000000001.pdf")
        self.assertEqual(letters[1].subject, "ჩასწორებული სათაური — 1000000001")
        self.assertIn("ჩასწორებული ტექსტი: Person1 Family, კოდი: 1000000001", letters[1].body)

        # 4. PUT /admin/planning-templates/cert_issued updates default template
        put_cert_tmpl = self.client.put(
            "/admin/planning-templates/cert_issued",
            headers=self.auth,
            data={"subject": "ახალი შაბლონი — {code}", "body": "მოგესალმებით,\n\nშაბლონი: {name}"},
        )
        self.assertEqual(put_cert_tmpl.status_code, 200, put_cert_tmpl.text)
        self.assertEqual(put_cert_tmpl.json()["subject"], "ახალი შაბლონი — {code}")

    def test_schedule_times_persist_via_endpoint_and_one_time_letter_preserves_defaults(self):
        # 1. Default times returned in GET /admin/planning-templates
        res = self.client.get("/admin/planning-templates", headers=self.auth)
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json().get("schedule_times"), {"morning": "10:00", "evening": "14:00"})

        # 2. PUT /admin/planning-schedule-times updates morning/evening defaults
        put_res = self.client.put(
            "/admin/planning-schedule-times",
            headers=self.auth,
            data={"morning": "11:15", "evening": "16:45"},
        )
        self.assertEqual(put_res.status_code, 200, put_res.text)
        self.assertEqual(put_res.json().get("schedule_times"), {"morning": "11:15", "evening": "16:45"})

        # 3. Sending an exam or certificate letter with a one-time time does NOT overwrite standard defaults
        self.saved(self.send(self.form(kind="exam", period="morning", event_time="09:30")))
        self.saved(self.send(self.form(kind="certificate", period="evening", event_time="17:00")))

        res2 = self.client.get("/admin/planning-templates", headers=self.auth)
        self.assertEqual(res2.status_code, 200, res2.text)
        self.assertEqual(res2.json().get("schedule_times"), {"morning": "11:15", "evening": "16:45"})

    def test_exam_outcome_all_three_pass_vs_skipped_or_failed(self):
        import json as _json
        now = datetime.utcnow()
        exam = Exam(title="Test Exam", duration_minutes=60)
        p2 = MultiApartmentProject(number=1, code="MA-1")
        p3 = MultiFunctionalProject(number=1, code="MF-1")
        self.db.add_all([exam, p2, p3])
        self.db.commit()

        # 1. Candidate takes Stage 1 (80% in both chapters) and Stage 2 (100%, 0 wrong), skips Stage 3 -> outcome is 'fail'
        s1 = ExamSession(
            exam_id=exam.id,
            token="test-session-token-1",
            user_id=1,
            candidate_code="1000000001",
            started_at=now - timedelta(minutes=50),
            ends_at=now + timedelta(minutes=10),
            finished_at=now - timedelta(minutes=30),
            score_percent=80.0,
            exam_snapshot=_json.dumps({
                "chapters": [
                    {"name": "თავი I", "stats": {"total": 10, "correct": 8, "percent": 80.0}},
                    {"name": "თავი II", "stats": {"total": 10, "correct": 8, "percent": 80.0}},
                ]
            }),
        )
        e2 = MultiApartmentEvaluation(
            user_id=1,
            project_id=p2.id,
            project_code="MA-1",
            project_name="MA Project 1",
            percentage=100.0,
            correct_count=5,
            wrong_count=0,
            total_correct_answers=5,
            started_at=now - timedelta(minutes=25),
            finished_at=now - timedelta(minutes=15),
        )
        self.db.add_all([s1, e2])
        self.db.commit()

        res_skip = self.client.get("/admin/users/1/exam-outcome", headers=self.auth)
        self.assertEqual(res_skip.status_code, 200, res_skip.text)
        data_skip = res_skip.json()
        self.assertTrue(data_skip["has_results"])
        self.assertTrue(data_skip["unacknowledged"])
        self.assertEqual(data_skip["outcome"], "fail")
        self.assertIn("• ეტაპი 3 — მრავალფუნქციური შენობის პროექტის შეფასება: გამოტოვებულია", data_skip["results_text"])

        # 2. Candidate completes Stage 3 (90%, 1 wrong) -> all 3 passed with B/C -> outcome is 'pass_bc'
        e3 = MultiFunctionalEvaluation(
            user_id=1,
            project_id=p3.id,
            project_code="MF-1",
            project_name="MF Project 1",
            percentage=90.0,
            correct_count=4,
            wrong_count=1,
            total_correct_answers=5,
            started_at=now - timedelta(minutes=12),
            finished_at=now - timedelta(minutes=5),
        )
        self.db.add(e3)
        self.db.commit()

        res_pass = self.client.get("/admin/users/1/exam-outcome", headers=self.auth)
        self.assertEqual(res_pass.status_code, 200, res_pass.text)
        data_pass = res_pass.json()
        self.assertEqual(data_pass["outcome"], "pass_bc")
        self.assertEqual(data_pass["category_label"], "B/C კატეგორიის")
        self.assertTrue(data_pass["unacknowledged"])
        self.assertIn("10 კითხვიდან 8 სწორი — 80%", data_pass["results_text"])
        self.assertIn("• ეტაპი 2 — მრავალბინიანი შენობის პროექტის შეფასება: 100%, არასწორი პასუხები: 0", data_pass["results_text"])
        self.assertIn("• ეტაპი 3 — მრავალფუნქციური შენობის პროექტის შეფასება: 90%, არასწორი პასუხები: 1", data_pass["results_text"])

        # 3. Saving a certificate handover letter acknowledges the exam outcome automatically
        self.saved(self.send(self.form(kind="certificate", action_mode="save_only", period="morning")))
        res_ack = self.client.get("/admin/users/1/exam-outcome", headers=self.auth)
        self.assertEqual(res_ack.status_code, 200, res_ack.text)
        self.assertFalse(res_ack.json()["unacknowledged"])

    def test_admin_users_exam_outcome_filters_and_pending_letter_badges(self):
        import json as _json
        exam = Exam(title="Filter Exam", duration_minutes=60)
        p2 = MultiApartmentProject(number=2, code="MA-2")
        p3 = MultiFunctionalProject(number=2, code="MF-2")
        self.db.add_all([exam, p2, p3])
        self.db.commit()

        # Sitting 1 on 2026-10-10: candidate 1 fails (skips stages 2 & 3)
        dt_fail = datetime(2026, 10, 10, 9, 0, 0)
        s_fail = ExamSession(
            exam_id=exam.id,
            token="fail-sitting-token",
            user_id=1,
            candidate_code="1000000001",
            started_at=dt_fail,
            ends_at=dt_fail + timedelta(minutes=60),
            finished_at=dt_fail + timedelta(minutes=30),
            score_percent=60.0,
            exam_snapshot=_json.dumps({
                "chapters": [
                    {"name": "თავი I", "stats": {"total": 10, "correct": 6, "percent": 60.0}},
                ]
            }),
        )
        self.db.add(s_fail)
        self.db.commit()

        # Check pending_fail_letter and exam_failed
        r1 = self.client.get("/admin/users?paginated=true&pending_fail_letter=true", headers=self.auth).json()
        self.assertEqual(r1["total"], 1)
        self.assertEqual(r1["global_pending_fail_users"], 1)
        self.assertEqual(r1["global_pending_pass_users"], 0)

        # Acknowledge fail sitting via fail_send_only letter at 2026-10-10 12:00
        fail_letter = PlanningLetter(
            user_id=1,
            kind="exam",
            event_date=dt_fail.date(),
            event_time="12:00",
            period="fail_send_only",
            request_id="req-fail-ack-1",
            request_fingerprint="fp-fail-ack-1",
            to_email="person1@example.com",
            subject="გამოცდის შედეგები",
            body="სამწუხაროდ ვერ გადალახეთ",
            status="sent",
            created_by="g.berb@yahoo.com",
            created_at=datetime(2026, 10, 10, 12, 0, 0),
            sent_at=datetime(2026, 10, 10, 12, 0, 0),
        )
        self.db.add(fail_letter)
        self.db.commit()

        r2 = self.client.get("/admin/users?paginated=true&pending_fail_letter=true", headers=self.auth).json()
        self.assertEqual(r2["total"], 0)
        self.assertEqual(r2["global_pending_fail_users"], 0)

        # Historical fail is still found via exam_failed and exam_result_date=2026-10-10
        r_hist_fail = self.client.get("/admin/users?paginated=true&exam_failed=true&exam_result_date=2026-10-10", headers=self.auth).json()
        self.assertEqual(r_hist_fail["total"], 1)
        r_hist_wrong_date = self.client.get("/admin/users?paginated=true&exam_failed=true&exam_result_date=2026-10-11", headers=self.auth).json()
        self.assertEqual(r_hist_wrong_date["total"], 0)

        # Sitting 2 on 2026-10-15: candidate 1 passes all 3 stages
        dt_pass = datetime(2026, 10, 15, 10, 0, 0)
        s_pass = ExamSession(
            exam_id=exam.id,
            token="pass-sitting-token",
            user_id=1,
            candidate_code="1000000001",
            started_at=dt_pass,
            ends_at=dt_pass + timedelta(minutes=60),
            finished_at=dt_pass + timedelta(minutes=25),
            score_percent=85.0,
            exam_snapshot=_json.dumps({
                "chapters": [
                    {"name": "თავი I", "stats": {"total": 10, "correct": 8, "percent": 80.0}},
                    {"name": "თავი II", "stats": {"total": 10, "correct": 9, "percent": 90.0}},
                ]
            }),
        )
        e2_pass = MultiApartmentEvaluation(
            user_id=1,
            project_id=p2.id,
            project_code="MA-2",
            project_name="MA Project 2",
            percentage=100.0,
            correct_count=5,
            wrong_count=0,
            total_correct_answers=5,
            started_at=dt_pass + timedelta(minutes=30),
            finished_at=dt_pass + timedelta(minutes=40),
        )
        e3_pass = MultiFunctionalEvaluation(
            user_id=1,
            project_id=p3.id,
            project_code="MF-2",
            project_name="MF Project 2",
            percentage=90.0,
            correct_count=4,
            wrong_count=1,
            total_correct_answers=5,
            started_at=dt_pass + timedelta(minutes=45),
            finished_at=dt_pass + timedelta(minutes=55),
        )
        self.db.add_all([s_pass, e2_pass, e3_pass])
        self.db.commit()

        # Now candidate 1 has pending pass letter AND matches both exam_passed (on 2026-10-15) and exam_failed (on 2026-10-10)
        r_pass_pending = self.client.get("/admin/users?paginated=true&pending_pass_letter=true", headers=self.auth).json()
        self.assertEqual(r_pass_pending["total"], 1)
        self.assertEqual(r_pass_pending["global_pending_pass_users"], 1)

        r_pass_date = self.client.get("/admin/users?paginated=true&exam_passed=true&exam_result_date=2026-10-15", headers=self.auth).json()
        self.assertEqual(r_pass_date["total"], 1)

        r_pass_wrong_date = self.client.get("/admin/users?paginated=true&exam_passed=true&exam_result_date=2026-10-10", headers=self.auth).json()
        self.assertEqual(r_pass_wrong_date["total"], 0)

        r_fail_still = self.client.get("/admin/users?paginated=true&exam_failed=true&exam_result_date=2026-10-10", headers=self.auth).json()
        self.assertEqual(r_fail_still["total"], 1)


if __name__ == "__main__":
    unittest.main()

