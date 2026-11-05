"""Synthetic, isolated MFA tests: no real accounts, mail, network or secrets."""
from __future__ import annotations

from contextlib import ExitStack
import base64
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor

from cryptography.fernet import Fernet
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pyotp
from sqlalchemy import create_engine, event, select, func, delete
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from backend.app.database import get_db
from backend.app.models import (
    Base, User, UserSession, AuditEvent, AdminMfaCredential, AdminMfaElevation,
    AdminMfaPending, AdminMfaRecoveryCode,
)
from backend.app.routers import admin_mfa as api
from backend.app.services import admin_mfa as mfa


class AdminMfaTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        self.addCleanup(self.engine.dispose)
        @event.listens_for(self.engine, "connect")
        def fk(connection, _record):
            connection.execute("PRAGMA foreign_keys=ON")
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.addCleanup(self.db.close)
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.now = datetime(2026, 11, 5, 15, 0, 0)
        self.settings = SimpleNamespace(founder_admin_email="founder@example.test", admin_mfa_encryption_key=Fernet.generate_key().decode(), admin_mfa_key_file=None)
        self.stack.enter_context(patch.object(mfa, "get_settings", return_value=self.settings))
        self.stack.enter_context(patch.object(mfa, "_now", side_effect=lambda: self.now))
        self.stack.enter_context(patch("backend.app.security.verify_code", side_effect=lambda plain, stored: plain == "synthetic-password" and stored == "synthetic-hash"))
        self.admin = self._user(1, "admin@example.test", True)
        self.founder = self._user(2, "founder@example.test", False)
        self.candidate = self._user(3, "candidate@example.test", False)
        self.auth = self._login(self.admin, "synthetic-first-token")
        self.auth2 = self._login(self.admin, "synthetic-second-token")
        self.candidate_auth = self._login(self.candidate, "synthetic-candidate-token")
        self.founder_auth = self._login(self.founder, "synthetic-founder-token")

    def _user(self, number, email, admin):
        user = User(personal_id=f"999990000{number:02}", first_name="Synthetic", last_name="MFA", phone="555000000", email=email,
                    password_hash="synthetic-hash", code=f"9900000{number:03}", is_admin=admin)
        self.db.add(user)
        self.db.commit()
        return user

    def _login(self, user, token):
        self.db.add(UserSession(user_id=user.id, token=token, created_at=self.now, expires_at=self.now + timedelta(days=30), client_type="web"))
        self.db.commit()
        return "Bearer " + token

    def otp(self, secret, shift=0):
        return pyotp.TOTP(secret).at(self.now.replace(tzinfo=timezone.utc) + timedelta(seconds=shift))

    def enroll(self, auth=None):
        auth = auth or self.auth
        setup = mfa.begin_setup(self.db, auth, "synthetic-password")
        result = mfa.confirm_setup(self.db, auth, self.otp(setup["secret"]))
        return setup, result

    def assert_error(self, status, call, code=None):
        with self.assertRaises(HTTPException) as caught:
            call()
        self.assertEqual(caught.exception.status_code, status)
        if code:
            self.assertEqual(caught.exception.detail["code"], code)
        self.assertEqual(caught.exception.headers["Cache-Control"], "no-store")
        self.db.rollback()
        return caught.exception

    def test_no_mfa_does_not_grant_admin_access(self):
        self.assertFalse(mfa.mfa_status(self.db, self.auth)["enrolled"])
        self.assert_error(403, lambda: mfa.require_admin_mfa(self.db, self.auth), "ADMIN_MFA_REQUIRED")

    def test_totp_uses_rfc6238_sha1_six_digit_vectors_independent_of_timezone(self):
        # RFC6238 SHA-1 vectors truncated to Google's six-digit default.
        secret = base64.b32encode(b"12345678901234567890").decode()
        for timestamp, expected in ((59, "287082"), (1111111109, "081804"),
                                    (1111111111, "050471"), (1234567890, "005924"),
                                    (2000000000, "279037"), (20000000000, "353130")):
            moment = datetime.fromtimestamp(timestamp, timezone.utc).replace(tzinfo=None)
            self.assertEqual(mfa._totp_counter(secret, expected, moment), timestamp // 30)

    def test_unauthenticated_and_nonadmin_are_rejected(self):
        self.assert_error(401, lambda: mfa.mfa_status(self.db, None))
        self.assert_error(401, lambda: mfa.begin_setup(self.db, "Bearer unknown", "synthetic-password"))
        self.assert_error(403, lambda: mfa.begin_setup(self.db, self.candidate_auth, "synthetic-password"))
        self.assertEqual(self.db.scalar(select(func.count()).select_from(AdminMfaCredential)), 0)

    def test_founder_must_enroll_too(self):
        self.assert_error(403, lambda: mfa.require_admin_mfa(self.db, self.founder_auth))
        self.enroll(self.founder_auth)
        self.assertEqual(mfa.require_admin_mfa(self.db, self.founder_auth).id, self.founder.id)

    def test_enrollment_confirms_code_and_encrypts_seed(self):
        setup, result = self.enroll()
        self.assertEqual(setup["issuer"], "GIPC")
        self.assertTrue(setup["otpauth_uri"].startswith("otpauth://totp/"))
        cred = self.db.get(AdminMfaCredential, self.admin.id)
        self.assertNotIn(setup["secret"], cred.secret_ciphertext)
        self.assertEqual(mfa._decrypt(cred.secret_ciphertext), setup["secret"])
        self.assertEqual(len(result["recovery_codes"]), 10)
        self.assertTrue(mfa.mfa_status(self.db, self.auth)["verified"])
        self.assertIsNone(self.db.get(AdminMfaPending, self.admin.id))
        self.assertEqual(mfa.require_admin_mfa(self.db, self.auth).id, self.admin.id)

    def test_setup_requires_password_and_is_session_bound(self):
        self.assert_error(400, lambda: mfa.begin_setup(self.db, self.auth, "wrong"))
        setup = mfa.begin_setup(self.db, self.auth, "synthetic-password")
        self.assert_error(400, lambda: mfa.confirm_setup(self.db, self.auth2, self.otp(setup["secret"])), "ADMIN_MFA_SETUP_EXPIRED")
        self.assertFalse(mfa.mfa_status(self.db, self.auth)["enrolled"])

    def test_repeat_setup_keeps_qr_valid_and_wrong_code_does_not_enable(self):
        setup = mfa.begin_setup(self.db, self.auth, "synthetic-password")
        again = mfa.begin_setup(self.db, self.auth, "synthetic-password")
        self.assertEqual(setup["secret"], again["secret"])
        self.assert_error(400, lambda: mfa.confirm_setup(self.db, self.auth, "invalid"))
        self.assertFalse(mfa.mfa_status(self.db, self.auth)["enrolled"])

    def test_setup_expires_after_ten_minutes(self):
        setup = mfa.begin_setup(self.db, self.auth, "synthetic-password")
        self.now += timedelta(minutes=10)
        self.assert_error(400, lambda: mfa.confirm_setup(self.db, self.auth, self.otp(setup["secret"])), "ADMIN_MFA_SETUP_EXPIRED")

    def test_initial_confirmation_code_cannot_be_replayed(self):
        setup, _ = self.enroll()
        self.assert_error(400, lambda: mfa.verify_mfa(self.db, self.auth2, self.otp(setup["secret"])))
        self.assertFalse(mfa.mfa_status(self.db, self.auth2)["verified"])

    def test_new_totp_grants_only_current_session_and_cannot_be_reused(self):
        setup, _ = self.enroll()
        self.now += timedelta(seconds=30)
        result = mfa.verify_mfa(self.db, self.auth2, self.otp(setup["secret"]))
        self.assertFalse(result["recovery_code_used"])
        third = self._login(self.admin, "third-token")
        self.assertFalse(mfa.mfa_status(self.db, third)["verified"])
        self.assert_error(400, lambda: mfa.verify_mfa(self.db, third, self.otp(setup["secret"])))

    def test_totp_clock_skew_window_is_bounded(self):
        setup, _ = self.enroll()
        self.now += timedelta(minutes=2)
        self.assert_error(400, lambda: mfa.verify_mfa(self.db, self.auth2, self.otp(setup["secret"], 60)))
        result = mfa.verify_mfa(self.db, self.auth2, self.otp(setup["secret"], -30))
        self.assertTrue(result["verified"])

    def test_recovery_is_hashed_single_use_and_account_bound(self):
        _, result = self.enroll()
        code = result["recovery_codes"][0]
        saved = self.db.scalars(select(AdminMfaRecoveryCode)).all()
        self.assertTrue(all(code not in item.code_hash for item in saved))
        response = mfa.verify_mfa(self.db, self.auth2, code.lower().replace("-", " "))
        self.assertTrue(response["recovery_code_used"])
        self.assertEqual(mfa.mfa_status(self.db, self.auth)["recovery_codes_remaining"], 9)
        self.assert_error(400, lambda: mfa.verify_mfa(self.db, self.auth, code))
        self.enroll(self.founder_auth)
        self.assert_error(400, lambda: mfa.verify_mfa(self.db, self.founder_auth, result["recovery_codes"][1]))

    def test_account_lockout_survives_sessions_and_expires(self):
        setup, _ = self.enroll()
        for _ in range(4):
            self.assert_error(400, lambda: mfa.verify_mfa(self.db, self.auth2, "bad"))
        self.assert_error(429, lambda: mfa.verify_mfa(self.db, self.auth2, "bad"), "ADMIN_MFA_LOCKED")
        self.now += timedelta(seconds=30)
        self.assert_error(429, lambda: mfa.verify_mfa(self.db, self.auth, self.otp(setup["secret"])))
        self.now += timedelta(minutes=15)
        self.assertTrue(mfa.verify_mfa(self.db, self.auth2, self.otp(setup["secret"]))["verified"])

    def test_password_failures_also_lock_account(self):
        for _ in range(4):
            self.assert_error(400, lambda: mfa.begin_setup(self.db, self.auth, "wrong"))
        self.assert_error(429, lambda: mfa.begin_setup(self.db, self.auth2, "wrong"))

    def test_status_does_not_extend_idle_timeout(self):
        self.enroll()
        self.now += timedelta(minutes=29)
        self.assertTrue(mfa.mfa_status(self.db, self.auth)["verified"])
        self.now += timedelta(minutes=1)
        self.assertFalse(mfa.mfa_status(self.db, self.auth)["verified"])
        self.assert_error(403, lambda: mfa.require_admin_mfa(self.db, self.auth))

    def test_activity_touches_only_same_live_grant(self):
        self.enroll()
        self.now += timedelta(minutes=20)
        mfa.require_admin_mfa(self.db, self.auth)
        activity = self.db.info.pop("admin_mfa_activity")
        self.db.rollback()
        mfa.touch_admin_mfa_activity(self.engine, activity)
        self.now += timedelta(minutes=20)
        self.assertTrue(mfa.mfa_status(self.db, self.auth)["verified"])
        self.now += timedelta(minutes=11)
        mfa.touch_admin_mfa_activity(self.engine, activity)
        self.assertFalse(mfa.mfa_status(self.db, self.auth)["verified"])

    def test_late_activity_cannot_revive_locked_grant(self):
        self.enroll()
        self.now += timedelta(minutes=1)
        mfa.require_admin_mfa(self.db, self.auth)
        activity = self.db.info.pop("admin_mfa_activity")
        mfa.lock_mfa(self.db, self.auth)
        mfa.touch_admin_mfa_activity(self.engine, activity)
        self.assertFalse(mfa.mfa_status(self.db, self.auth)["verified"])

    def test_helper_does_not_commit_or_discard_unrelated_dirty_data(self):
        self.enroll()
        original = self.admin.first_name
        self.admin.first_name = "Uncommitted-change"
        with patch.object(self.db, "commit", side_effect=AssertionError("Helper must not commit")):
            mfa.require_admin_mfa(self.db, self.auth, user=self.admin)
        self.assertEqual(self.admin.first_name, "Uncommitted-change")
        self.db.rollback()
        self.assertEqual(self.admin.first_name, original)

    def test_absolute_eight_hour_timeout_despite_recent_activity(self):
        self.enroll()
        grant = self.db.get(AdminMfaElevation, mfa.token_digest(self.auth.split()[1]))
        grant.last_used_at = self.now + timedelta(hours=7, minutes=50)
        self.db.commit()
        self.now += timedelta(hours=8)
        self.assertFalse(mfa.mfa_status(self.db, self.auth)["verified"])

    def test_expired_or_deleted_login_and_role_revocation_fail_closed(self):
        self.enroll()
        self.admin.is_admin = False
        self.db.commit()
        self.assert_error(403, lambda: mfa.require_admin_mfa(self.db, self.auth))
        self.admin.is_admin = True
        self.db.commit()
        self.db.execute(delete(UserSession).where(UserSession.token == self.auth.split()[1]))
        self.db.commit()
        self.assert_error(401, lambda: mfa.require_admin_mfa(self.db, self.auth))

    def test_login_id_reuse_does_not_inherit_elevation(self):
        self.enroll()
        old = self.db.scalar(select(UserSession).where(UserSession.token == self.auth.split()[1]))
        old_id = old.id
        self.db.delete(old)
        self.db.commit()
        self.db.add(UserSession(id=old_id, user_id=self.admin.id, token="reused-id-new-token", created_at=self.now, expires_at=self.now + timedelta(days=1)))
        self.db.commit()
        self.assert_error(403, lambda: mfa.require_admin_mfa(self.db, "Bearer reused-id-new-token"))

    def test_rotation_requires_mfa_and_password_old_seed_stays_until_confirm(self):
        original, _ = self.enroll()
        self.assert_error(403, lambda: mfa.begin_setup(self.db, self.auth2, "synthetic-password"))
        self.assert_error(400, lambda: mfa.begin_setup(self.db, self.auth, "wrong"))
        new = mfa.begin_setup(self.db, self.auth, "synthetic-password")
        self.assertNotEqual(new["secret"], original["secret"])
        self.assertEqual(mfa._decrypt(self.db.get(AdminMfaCredential, self.admin.id).secret_ciphertext), original["secret"])

    def test_confirm_rotation_revokes_other_elevations_and_old_recovery_codes(self):
        setup, result = self.enroll()
        self.now += timedelta(seconds=30)
        mfa.verify_mfa(self.db, self.auth2, self.otp(setup["secret"]))
        new = mfa.begin_setup(self.db, self.auth, "synthetic-password")
        mfa.confirm_setup(self.db, self.auth, self.otp(new["secret"]))
        self.assertFalse(mfa.mfa_status(self.db, self.auth2)["verified"])
        self.assert_error(400, lambda: mfa.verify_mfa(self.db, self.auth2, result["recovery_codes"][0]))

    def test_recovery_regeneration_requires_elevation_and_password(self):
        _, old = self.enroll()
        self.assert_error(403, lambda: mfa.regenerate_recovery_codes(self.db, self.auth2, "synthetic-password"))
        self.assert_error(400, lambda: mfa.regenerate_recovery_codes(self.db, self.auth, "wrong"))
        new = mfa.regenerate_recovery_codes(self.db, self.auth, "synthetic-password")
        self.assertEqual(len(new["recovery_codes"]), 10)
        self.assert_error(400, lambda: mfa.verify_mfa(self.db, self.auth2, old["recovery_codes"][0]))

    def test_lock_only_current_admin_elevation_not_login_or_other_sessions(self):
        _, result = self.enroll()
        mfa.verify_mfa(self.db, self.auth2, result["recovery_codes"][0])
        count = self.db.scalar(select(func.count()).select_from(UserSession))
        mfa.lock_mfa(self.db, self.auth)
        self.assertFalse(mfa.mfa_status(self.db, self.auth)["verified"])
        self.assertTrue(mfa.mfa_status(self.db, self.auth2)["verified"])
        self.assertEqual(self.db.scalar(select(func.count()).select_from(UserSession)), count)

    def test_missing_wrong_or_corrupt_key_fails_closed(self):
        setup, _ = self.enroll()
        self.settings.admin_mfa_encryption_key = None
        self.assert_error(503, lambda: mfa.begin_setup(self.db, self.auth, "synthetic-password"))
        self.assert_error(503, lambda: mfa.verify_mfa(self.db, self.auth2, self.otp(setup["secret"])))
        self.assert_error(503, lambda: mfa.require_admin_mfa(self.db, self.auth))
        self.assert_error(503, lambda: mfa.mfa_status(self.db, self.auth))
        self.settings.admin_mfa_encryption_key = Fernet.generate_key().decode()
        self.assert_error(503, lambda: mfa.verify_mfa(self.db, self.auth2, self.otp(setup["secret"])))

    def test_secret_key_file_supported_without_secret_in_config(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "key"
            path.write_text(self.settings.admin_mfa_encryption_key)
            self.settings.admin_mfa_encryption_key = None
            self.settings.admin_mfa_key_file = str(path)
            self.enroll()
            self.assertTrue(mfa.mfa_status(self.db, self.auth)["verified"])

    def test_relative_key_path_is_rejected(self):
        self.settings.admin_mfa_encryption_key = None
        self.settings.admin_mfa_key_file = "relative-secret.key"
        self.assert_error(503, lambda: mfa.begin_setup(self.db, self.auth, "synthetic-password"))

    def test_commit_failure_never_enables_or_leaks_partial_recovery(self):
        setup = mfa.begin_setup(self.db, self.auth, "synthetic-password")
        with patch.object(self.db, "commit", side_effect=RuntimeError("synthetic-commit")):
            with self.assertRaises(RuntimeError):
                mfa.confirm_setup(self.db, self.auth, self.otp(setup["secret"]))
        self.db.rollback()
        self.assertFalse(mfa.mfa_status(self.db, self.auth)["enrolled"])
        self.assertEqual(self.db.scalar(select(func.count()).select_from(AdminMfaRecoveryCode)), 0)

    def test_audit_events_have_no_codes_seeds_passwords_or_tokens(self):
        setup, result = self.enroll()
        mfa.verify_mfa(self.db, self.auth2, result["recovery_codes"][0])
        self.assert_error(400, lambda: mfa.verify_mfa(self.db, self.auth2, "bad-code-secret"))
        events = self.db.scalars(select(AuditEvent)).all()
        text = json.dumps([dict(action=e.action, details=e.details, actor=e.actor_label, target=e.target_label) for e in events])
        for secret in [setup["secret"], *result["recovery_codes"], "synthetic-password", "synthetic-first-token", "bad-code-secret"]:
            self.assertNotIn(secret, text)
        self.assertIn("auth.admin_mfa.enabled", text)
        self.assertIn("auth.admin_mfa.failed", text)

    def test_api_success_is_no_store_and_secret_not_in_status(self):
        app = FastAPI()
        app.include_router(api.router, prefix="/auth/admin-mfa")
        def synthetic_db():
            yield self.db
        app.dependency_overrides[get_db] = synthetic_db
        self.enroll()
        with TestClient(app) as client:
            response = client.get("/auth/admin-mfa/status", headers={"Authorization": self.auth})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(set(response.json()), {"enrolled", "verified", "expires_at", "recovery_codes_remaining"})

    def test_user_delete_cascades_mfa_not_durable_audit(self):
        self.enroll()
        self.db.delete(self.admin)
        self.db.commit()
        for model in (AdminMfaCredential, AdminMfaPending, AdminMfaElevation, AdminMfaRecoveryCode):
            self.assertEqual(self.db.scalar(select(func.count()).select_from(model)), 0)
        self.assertGreater(self.db.scalar(select(func.count()).select_from(AuditEvent)), 0)

    def _concurrent_consumption(self, recovery):
        with TemporaryDirectory() as directory:
            engine = create_engine("sqlite:///" + str(Path(directory) / "concurrency.db"), connect_args={"check_same_thread": False, "timeout": 10})
            try:
                Base.metadata.create_all(engine)
                with Session(engine) as db:
                    user = User(personal_id="99999000999", first_name="Synthetic", last_name="Concurrent", phone="555000000", email="parallel@example.test", password_hash="synthetic-hash", code="9900000999", is_admin=True)
                    db.add(user)
                    db.flush()
                    for token in ("parallel-first", "parallel-second"):
                        db.add(UserSession(user_id=user.id, token=token, created_at=self.now, expires_at=self.now + timedelta(days=1)))
                    db.commit()
                    setup = mfa.begin_setup(db, "Bearer parallel-first", "synthetic-password")
                    codes = mfa.confirm_setup(db, "Bearer parallel-first", self.otp(setup["secret"]))["recovery_codes"]
                    self.now += timedelta(seconds=30)
                    code = codes[0] if recovery else self.otp(setup["secret"])
                def verify(token):
                    with Session(engine) as db:
                        try:
                            mfa.verify_mfa(db, "Bearer " + token, code)
                            return 200
                        except HTTPException as exc:
                            return exc.status_code
                with ThreadPoolExecutor(max_workers=2) as pool:
                    statuses = list(pool.map(verify, ("parallel-first", "parallel-second")))
                self.assertEqual(sorted(statuses), [200, 400])
            finally:
                engine.dispose()

    def test_concurrent_recovery_code_can_be_consumed_only_once(self):
        self._concurrent_consumption(recovery=True)

    def test_concurrent_totp_can_be_consumed_only_once(self):
        self._concurrent_consumption(recovery=False)


if __name__ == "__main__":
    unittest.main()
