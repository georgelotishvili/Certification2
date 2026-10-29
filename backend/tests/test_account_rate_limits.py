from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from threading import Barrier
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from fastapi import HTTPException
from starlette.requests import Request

try:
    from backend.app import rate_limiter as rate_limiter_module
    from backend.app.rate_limiter import RateLimiter
    from backend.app.routers import auth, users
    from backend.app.schemas import (
        ForgotPasswordRequest,
        LoginRequest,
        SendVerificationCodeRequest,
    )
except ModuleNotFoundError:
    from app import rate_limiter as rate_limiter_module
    from app.rate_limiter import RateLimiter
    from app.routers import auth, users
    from app.schemas import (
        ForgotPasswordRequest,
        LoginRequest,
        SendVerificationCodeRequest,
    )


def make_request(client_host: str = "203.0.113.10") -> Request:
    return Request(
        {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "https",
            "path": "/",
            "raw_path": b"/",
            "query_string": b"",
            "headers": [],
            "client": (client_host, 54321),
            "server": ("testserver", 443),
        }
    )


class _MissingUserDb:
    def __init__(self):
        self.scalar_calls = 0

    def scalar(self, query):
        self.scalar_calls += 1
        return None


class _LoginDb:
    def __init__(self, user):
        self.user = user
        self.added = []
        self.executed = []
        self.commit_calls = 0
        self.rollback_calls = 0

    def scalar(self, query):
        return self.user

    def add(self, item):
        self.added.append(item)

    def execute(self, statement):
        self.executed.append(statement)

    def commit(self):
        self.commit_calls += 1

    def rollback(self):
        self.rollback_calls += 1

    def refresh(self, item):
        pass


class AccountRateLimitTests(unittest.TestCase):
    def test_login_account_limit_cannot_be_bypassed_by_ip_or_email_case(self) -> None:
        ip_limiter = RateLimiter(max_requests=10, window_seconds=60)
        account_limiter = RateLimiter(max_requests=2, window_seconds=60)
        db = _MissingUserDb()

        with (
            patch.object(auth, "login_limiter", ip_limiter),
            patch.object(auth, "login_account_limiter", account_limiter),
        ):
            for index, email in enumerate(
                ("Person@Example.com", "PERSON@example.com"),
                start=1,
            ):
                with self.assertRaises(HTTPException) as raised:
                    auth.login(
                        make_request(f"203.0.113.{index}"),
                        LoginRequest(email=email, password="wrong"),
                        db,
                    )
                self.assertEqual(raised.exception.status_code, 401)

            with self.assertRaises(HTTPException) as raised:
                auth.login(
                    make_request("203.0.113.99"),
                    LoginRequest(email="person@EXAMPLE.COM", password="wrong"),
                    db,
                )

        self.assertEqual(raised.exception.status_code, 429)
        self.assertEqual(db.scalar_calls, 2)

    def test_password_reset_bucket_is_shared_across_routes_and_ips(self) -> None:
        ip_limiter = RateLimiter(max_requests=20, window_seconds=60)
        account_limiter = RateLimiter(max_requests=3, window_seconds=60)
        db = _MissingUserDb()

        with (
            patch.object(auth, "verification_limiter", ip_limiter),
            patch.object(users, "verification_limiter", ip_limiter),
            patch.object(auth, "verification_account_limiter", account_limiter),
            patch.object(users, "verification_account_limiter", account_limiter),
            patch.object(
                users.email_verification,
                "send_verification_code",
            ) as sender,
        ):
            users.send_verification_code_endpoint(
                make_request("203.0.113.1"),
                SendVerificationCodeRequest(
                    email="Person@Example.com",
                    purpose=" Password_Reset ",
                ),
                db,
            )
            auth.forgot_password(
                make_request("203.0.113.2"),
                ForgotPasswordRequest(email="person@example.com"),
                db,
            )
            users.send_verification_code_endpoint(
                make_request("203.0.113.3"),
                SendVerificationCodeRequest(
                    email="PERSON@example.com",
                    purpose="password_reset",
                ),
                db,
            )

            with self.assertRaises(HTTPException) as raised:
                auth.forgot_password(
                    make_request("203.0.113.4"),
                    ForgotPasswordRequest(email="Person@Example.com"),
                    db,
                )

        self.assertEqual(raised.exception.status_code, 429)
        self.assertEqual(db.scalar_calls, 1)
        self.assertEqual(sender.call_count, 2)
        sender.assert_any_call("person@example.com", "password_reset")

    def test_successful_login_resets_only_account_bucket(self) -> None:
        ip_limiter = RateLimiter(max_requests=5, window_seconds=60)
        account_limiter = RateLimiter(max_requests=5, window_seconds=60)
        user = SimpleNamespace(
            id=1,
            personal_id="01000000001",
            first_name="Test",
            last_name="User",
            phone="555000001",
            email="person@example.com",
            password_hash="stored-hash",
            code="1000000001",
            is_admin=False,
            exam_permission=False,
            created_at=datetime(2026, 1, 1),
        )
        db = _LoginDb(user)

        with (
            patch.object(auth, "login_limiter", ip_limiter),
            patch.object(auth, "login_account_limiter", account_limiter),
            patch.object(auth, "verify_code", return_value=True),
            patch.object(auth, "generate_session_token", return_value="token"),
            patch.object(
                auth,
                "get_settings",
                return_value=SimpleNamespace(founder_admin_email=""),
            ),
            patch.object(auth, "expire_unused_stage_permissions", return_value=False),
            patch.object(
                auth,
                "exam_state_with_permissions",
                return_value={
                    "exam_permission": False,
                    "exam_stage": "none",
                    "exam_stage_expires_at": None,
                    "exam_stage_started_at": None,
                    "exam_stage_status": "none",
                    "exam_stage_remaining_seconds": None,
                    "exam_stage_permissions": {
                        stage: {
                            "granted": False,
                            "status": "none",
                            "grant_id": None,
                            "granted_at": None,
                            "expires_at": None,
                            "started_at": None,
                            "remaining_seconds": None,
                        }
                        for stage in ("theory", "project_stage_1", "project_stage_2")
                    },
                },
            ),
        ):
            response = auth.login(
                make_request("203.0.113.25"),
                LoginRequest(email="Person@Example.com", password="password"),
                db,
            )

        self.assertEqual(response.token, "token")
        self.assertNotIn("person@example.com", account_limiter._requests)
        self.assertEqual(ip_limiter._requests["203.0.113.25"], [
            ip_limiter._requests["203.0.113.25"][0]
        ])
        self.assertEqual(db.commit_calls, 1)

    def test_invalid_verification_purpose_stops_before_account_db_or_smtp(self) -> None:
        db = Mock()
        account_limiter = Mock()

        with (
            patch.object(users.verification_limiter, "check"),
            patch.object(users, "verification_account_limiter", account_limiter),
            patch.object(
                users.email_verification,
                "send_verification_code",
            ) as sender,
        ):
            with self.assertRaises(HTTPException) as raised:
                users.send_verification_code_endpoint(
                    make_request(),
                    SendVerificationCodeRequest(
                        email="person@example.com",
                        purpose=" ADMIN ",
                    ),
                    db,
                )

        self.assertEqual(raised.exception.status_code, 400)
        account_limiter.check_key.assert_not_called()
        db.scalar.assert_not_called()
        sender.assert_not_called()

    def test_forgot_password_keeps_same_generic_response(self) -> None:
        unknown_db = _MissingUserDb()
        known_db = Mock()
        known_db.scalar.return_value = SimpleNamespace(id=1)
        account_limiter = RateLimiter(max_requests=3, window_seconds=60)

        with (
            patch.object(auth.verification_limiter, "check"),
            patch.object(auth, "verification_account_limiter", account_limiter),
            patch.object(
                auth.email_verification,
                "send_verification_code",
            ) as sender,
        ):
            unknown_response = auth.forgot_password(
                make_request(),
                ForgotPasswordRequest(email="unknown@example.com"),
                unknown_db,
            )
            known_response = auth.forgot_password(
                make_request(),
                ForgotPasswordRequest(email="Known@Example.com"),
                known_db,
            )

        self.assertEqual(
            unknown_response.model_dump(),
            known_response.model_dump(),
        )
        sender.assert_called_once_with(
            "known@example.com",
            "password_reset",
        )

    def test_forgot_password_smtp_failure_keeps_generic_response(self) -> None:
        unknown_db = _MissingUserDb()
        known_db = Mock()
        known_db.scalar.return_value = SimpleNamespace(id=1)
        account_limiter = RateLimiter(max_requests=3, window_seconds=60)

        with (
            patch.object(auth.verification_limiter, "check"),
            patch.object(auth, "verification_account_limiter", account_limiter),
            patch.object(
                auth.email_verification,
                "send_verification_code",
                side_effect=RuntimeError("SMTP unavailable"),
            ) as sender,
            patch.object(auth.logger, "warning") as warning,
        ):
            unknown_response = auth.forgot_password(
                make_request(),
                ForgotPasswordRequest(email="unknown@example.com"),
                unknown_db,
            )
            known_response = auth.forgot_password(
                make_request(),
                ForgotPasswordRequest(email="Known@Example.com"),
                known_db,
            )

        self.assertEqual(
            unknown_response.model_dump(),
            known_response.model_dump(),
        )
        sender.assert_called_once_with(
            "known@example.com",
            "password_reset",
        )
        warning.assert_called_once_with(
            "Password reset email delivery failed",
            exc_info=True,
        )

    def test_check_key_is_atomic_under_concurrency(self) -> None:
        limiter = RateLimiter(max_requests=7, window_seconds=60)
        worker_count = 24
        start = Barrier(worker_count)

        def attempt() -> bool:
            start.wait(timeout=5)
            try:
                limiter.check_key(("person@example.com", "register"))
            except HTTPException as exc:
                self.assertEqual(exc.status_code, 429)
                return False
            return True

        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            results = list(executor.map(lambda _: attempt(), range(worker_count)))

        self.assertEqual(results.count(True), 7)
        self.assertEqual(results.count(False), worker_count - 7)

    def test_periodic_cleanup_removes_expired_keys(self) -> None:
        limiter = RateLimiter(max_requests=3, window_seconds=10)
        limiter._requests["stale"] = [1.0, 2.0]
        limiter._requests["fresh"] = [95.0]
        limiter._last_full_cleanup = 0.0

        with patch.object(rate_limiter_module.time, "time", return_value=100.0):
            limiter.check_key("new")

        self.assertNotIn("stale", limiter._requests)
        self.assertEqual(limiter._requests["fresh"], [95.0])
        self.assertEqual(limiter._requests["new"], [100.0])


if __name__ == "__main__":
    unittest.main()
