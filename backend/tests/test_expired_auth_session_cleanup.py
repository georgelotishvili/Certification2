from __future__ import annotations

from contextlib import ExitStack
from datetime import datetime, timedelta
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import Session
from starlette.requests import Request

try:
    from backend.app import database
    from backend.app.models import Base, Exam, Session as ExamSession, User, UserSession
    from backend.app.routers import auth, users
    from backend.app.schemas import LoginRequest, UserCreateWithVerification
except ModuleNotFoundError:
    from app import database
    from app.models import Base, Exam, Session as ExamSession, User, UserSession
    from app.routers import auth, users
    from app.schemas import LoginRequest, UserCreateWithVerification


NOW = datetime(2026, 10, 30, 10, 0, 0)


class FrozenDateTime(datetime):
    @classmethod
    def utcnow(cls):
        return NOW


class ExpiredAuthSessionCleanupTests(unittest.TestCase):
    """Only temporary in-memory fixtures: no default DB, users, or SMTP."""

    def setUp(self):
        def forbid_default_database(*_args):
            raise AssertionError("Default database access forbidden")

        event.listen(database.engine, "connect", forbid_default_database)
        self.addCleanup(event.remove, database.engine, "connect", forbid_default_database)
        self.engine = create_engine("sqlite:///:memory:")
        self.addCleanup(self.engine.dispose)

        @event.listens_for(self.engine, "connect")
        def enable_foreign_keys(connection, _record):
            connection.execute("PRAGMA foreign_keys=ON")

        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.addCleanup(self.db.close)
        self.patches = ExitStack()
        self.addCleanup(self.patches.close)
        for name in ("smtplib.SMTP", "smtplib.SMTP_SSL"):
            self.patches.enter_context(patch(name, side_effect=AssertionError("SMTP forbidden")))
        self.patches.enter_context(patch.object(auth.login_limiter, "check"))
        self.patches.enter_context(patch.object(auth.login_account_limiter, "check_key"))
        self.patches.enter_context(patch.object(auth.login_account_limiter, "reset_key"))
        self.password_check = self.patches.enter_context(patch.object(auth, "verify_code", return_value=True))
        self.patches.enter_context(patch.object(users, "hash_code", return_value="synthetic-hash"))
        self.otp_check = self.patches.enter_context(patch.object(users.email_verification, "verify_code", return_value=True))
        state = dict(exam_permission=False, exam_stage="none", exam_stage_expires_at=None,
                     exam_stage_started_at=None, exam_stage_status="none",
                     exam_stage_remaining_seconds=None, exam_stage_permissions={})
        for module in (auth, users):
            self.patches.enter_context(patch.object(module, "datetime", FrozenDateTime))
            self.patches.enter_context(patch.object(module, "get_settings", return_value=SimpleNamespace(founder_admin_email="")))
            self.patches.enter_context(patch.object(module, "exam_state_with_permissions", return_value=state))
            self.patches.enter_context(patch.object(module, "generate_session_token", return_value="new-synthetic-token"))
        self.patches.enter_context(patch.object(auth, "expire_unused_stage_permissions", return_value=False))

        self.candidate = User(personal_id="99900000001", first_name="საცდელი", last_name="კანდიდატი",
                              phone="555000001", email="candidate@example.org", code="9990000001",
                              password_hash="synthetic-hash")
        self.other = User(personal_id="99900000002", first_name="საცდელი", last_name="მეორე",
                          phone="555000002", email="other@example.org", code="9990000002",
                          password_hash="synthetic-hash")
        exam = Exam(title="Synthetic fixture", gate_password="synthetic-gate")
        self.db.add_all([self.candidate, self.other, exam])
        self.db.flush()
        self.db.add_all([
            UserSession(user_id=self.candidate.id, token="expired", expires_at=NOW - timedelta(days=1)),
            UserSession(user_id=self.other.id, token="exact-boundary", expires_at=NOW),
            UserSession(user_id=self.candidate.id, token="active-own", expires_at=NOW + timedelta(microseconds=1)),
            UserSession(user_id=self.other.id, token="active-other", expires_at=NOW + timedelta(days=1)),
            ExamSession(exam_id=exam.id, user_id=self.candidate.id, token="past-exam",
                        ends_at=NOW - timedelta(days=1), finished_at=NOW - timedelta(days=1), active=False),
            ExamSession(exam_id=exam.id, user_id=self.other.id, token="active-exam",
                        ends_at=NOW + timedelta(hours=1), active=True),
        ])
        self.db.commit()
        self.original_auth = self.auth_snapshot()
        self.original_exams = self.exam_snapshot()

    def auth_snapshot(self):
        return [tuple(row) for row in self.db.execute(select(UserSession.__table__).order_by(UserSession.id))]

    def exam_snapshot(self):
        return [tuple(row) for row in self.db.execute(select(ExamSession.__table__).order_by(ExamSession.id))]

    def login(self, **overrides):
        payload = dict(email="candidate@example.org", password="Synthetic123!")
        payload.update(overrides)
        request = Request({"type": "http", "method": "POST", "path": "/login", "headers": [],
                           "client": ("203.0.113.1", 12345)})
        return auth.login(request, LoginRequest(**payload), db=self.db)

    def register(self, **overrides):
        payload = dict(personal_id="99900000003", first_name="საცდელი", last_name="ახალი",
                       phone="555000003", email="new@example.org", password="Synthetic123!", verification_code="1234")
        payload.update(overrides)
        return users.register(UserCreateWithVerification(**payload), db=self.db)

    def assert_successful_pruning(self, token):
        self.assertEqual(token, "new-synthetic-token")
        self.assertEqual(set(self.db.scalars(select(UserSession.token))), {"active-own", "active-other", token})
        active_before = [row for row in self.original_auth if row[2].startswith("active-")]
        active_after = [row for row in self.auth_snapshot() if row[2].startswith("active-")]
        self.assertEqual(active_after, active_before)
        self.assertEqual(self.exam_snapshot(), self.original_exams)

    def test_login_prunes_expired_and_boundary_only_in_session_transaction(self):
        response = self.login()
        self.assert_successful_pruning(response.token)
        new_session = self.db.scalar(select(UserSession).where(UserSession.token == response.token))
        self.assertEqual(new_session.user_id, self.candidate.id)
        self.assertEqual(new_session.expires_at, NOW + timedelta(days=30))

    def test_invalid_password_does_not_prune_any_session(self):
        self.password_check.return_value = False
        with self.assertRaises(HTTPException) as error:
            self.login()
        self.assertEqual(error.exception.status_code, 401)
        self.assertEqual(self.auth_snapshot(), self.original_auth)
        self.assertEqual(self.exam_snapshot(), self.original_exams)

    def test_unknown_login_does_not_prune_any_session(self):
        with self.assertRaises(HTTPException) as error:
            self.login(email="absent@example.org")
        self.assertEqual(error.exception.status_code, 401)
        self.assertEqual(self.auth_snapshot(), self.original_auth)

    def test_failed_login_commit_restores_expired_sessions_and_new_token(self):
        with patch.object(self.db, "commit", side_effect=RuntimeError("synthetic commit failure")):
            with self.assertRaises(HTTPException) as error:
                self.login()
        self.assertEqual(error.exception.status_code, 500)
        self.assertEqual(self.auth_snapshot(), self.original_auth)
        self.assertEqual(self.exam_snapshot(), self.original_exams)

    def test_registration_auto_login_prunes_only_expired_sessions(self):
        response = self.register()
        self.assert_successful_pruning(response.token)
        self.assertIsNotNone(self.db.get(User, response.id))
        self.otp_check.assert_called_once_with("new@example.org", "1234", "register")

    def test_registration_login_commit_failure_keeps_account_and_restores_sessions(self):
        original_commit = self.db.commit
        calls = 0

        def commit_account_then_fail_token():
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError("synthetic automatic-login commit failure")
            return original_commit()

        with patch.object(self.db, "commit", side_effect=commit_account_then_fail_token):
            response = self.register()
        self.assertEqual(calls, 2)
        self.assertIsNone(response.token)
        self.assertIsNotNone(self.db.get(User, response.id))
        self.assertEqual(self.auth_snapshot(), self.original_auth)
        self.assertEqual(self.exam_snapshot(), self.original_exams)

    def test_invalid_registration_verification_does_not_prune(self):
        self.otp_check.return_value = False
        with self.assertRaises(HTTPException) as error:
            self.register()
        self.assertEqual(error.exception.status_code, 400)
        self.assertEqual(self.auth_snapshot(), self.original_auth)

    def test_duplicate_registration_does_not_prune(self):
        with self.assertRaises(HTTPException) as error:
            self.register(email="candidate@example.org")
        self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(self.auth_snapshot(), self.original_auth)


if __name__ == "__main__":
    unittest.main()
