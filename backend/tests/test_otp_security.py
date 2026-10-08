from __future__ import annotations

import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from threading import Barrier
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from starlette.requests import Request

try:
    from backend.app.models import Base, User, UserSession
    from backend.app.rate_limiter import RateLimiter
    from backend.app.routers import auth, users
    from backend.app.schemas import ResetPasswordRequest, VerifyCodeRequest
    from backend.app.services import email_verification
except ModuleNotFoundError:
    from app.models import Base, User, UserSession
    from app.rate_limiter import RateLimiter
    from app.routers import auth, users
    from app.schemas import ResetPasswordRequest, VerifyCodeRequest
    from app.services import email_verification


def make_request(
    client_host: str = "203.0.113.10",
    headers: dict[str, str] | None = None,
) -> Request:
    encoded_headers = [
        (name.lower().encode("latin-1"), value.encode("latin-1"))
        for name, value in (headers or {}).items()
    ]
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
            "headers": encoded_headers,
            "client": (client_host, 54321),
            "server": ("testserver", 443),
        }
    )


class EmailVerificationTests(unittest.TestCase):
    def setUp(self) -> None:
        with email_verification._verification_lock:
            email_verification._verification_codes.clear()
            email_verification._verification_attempts.clear()

    def tearDown(self) -> None:
        with email_verification._verification_lock:
            email_verification._verification_codes.clear()
            email_verification._verification_attempts.clear()

    def _store_code(
        self,
        email: str,
        code: str = "1234",
        purpose: str = "register",
    ) -> None:
        with email_verification._verification_lock:
            email_verification._verification_codes[email] = {
                "code": code,
                "expires_at": 1300.0,
                "purpose": purpose,
            }

    def test_secure_generator_preserves_four_digit_contract(self) -> None:
        with patch.object(email_verification.secrets, "randbelow", return_value=0):
            self.assertEqual(email_verification._generate_code(), "1000")
        with patch.object(email_verification.secrets, "randbelow", return_value=8999):
            self.assertEqual(email_verification._generate_code(), "9999")

    def test_non_consuming_check_then_single_use_consumption(self) -> None:
        email = "person@example.com"
        email_verification._verification_codes[email] = {
            "code": "1234",
            "expires_at": 1300.0,
            "purpose": "password_reset",
        }

        with patch.object(email_verification.time, "time", return_value=1000.0):
            self.assertTrue(
                email_verification.verify_code(
                    email,
                    "1234",
                    "password_reset",
                    consume=False,
                )
            )
            self.assertIn(email, email_verification._verification_codes)
            self.assertTrue(
                email_verification.verify_code(email, "1234", "password_reset")
            )
            self.assertNotIn(email, email_verification._verification_codes)

    def test_failed_prechecks_lock_only_the_requested_purpose(self) -> None:
        email = "person@example.com"
        email_verification._verification_codes[email] = {
            "code": "1234",
            "expires_at": 1300.0,
            "purpose": "register",
        }

        with patch.object(email_verification.time, "time", return_value=1000.0):
            for _ in range(email_verification.MAX_VERIFICATION_ATTEMPTS - 1):
                self.assertFalse(
                    email_verification.verify_code(
                        email,
                        "9999",
                        "update",
                        consume=False,
                    )
                )

            with self.assertRaises(HTTPException) as raised:
                email_verification.verify_code(
                    email,
                    "9999",
                    "update",
                    consume=False,
                )
            self.assertEqual(raised.exception.status_code, 429)
            self.assertTrue(
                email_verification.verify_code(
                    email,
                    "1234",
                    "register",
                    consume=False,
                )
            )

    def test_non_ascii_input_is_rejected_without_server_error(self) -> None:
        email = "person@example.com"
        email_verification._verification_codes[email] = {
            "code": "1234",
            "expires_at": 1300.0,
            "purpose": "register",
        }
        with patch.object(email_verification.time, "time", return_value=1000.0):
            self.assertFalse(
                email_verification.verify_code(
                    email,
                    "არასწორი",
                    "რეგისტრაცია",
                    consume=False,
                )
            )

    def test_smtp_failure_never_emits_or_stores_new_code(self) -> None:
        email = "person@example.com"
        original = {
            "code": "1111",
            "expires_at": 1300.0,
            "purpose": "password_reset",
        }
        email_verification._verification_codes[email] = original.copy()
        settings = SimpleNamespace(email_mode="smtp", mail_mailer=None)

        with (
            patch.object(email_verification, "get_settings", return_value=settings),
            patch.object(email_verification, "_generate_code", return_value="2222"),
            patch.object(email_verification, "_send_smtp_message", return_value=False),
            patch.object(email_verification, "_emit_console_code") as console_output,
            patch.object(email_verification.time, "time", return_value=1000.0),
        ):
            with self.assertRaises(RuntimeError):
                email_verification.send_verification_code(email, "password_reset")

        console_output.assert_not_called()
        self.assertEqual(email_verification._verification_codes[email], original)

    def test_explicit_console_mode_stores_code_after_emission(self) -> None:
        settings = SimpleNamespace(email_mode="console", mail_mailer=None)
        with (
            patch.object(email_verification, "get_settings", return_value=settings),
            patch.object(email_verification, "_generate_code", return_value="4321"),
            patch.object(email_verification, "_emit_console_code") as console_output,
            patch.object(email_verification.time, "time", return_value=1000.0),
        ):
            result = email_verification.send_verification_code(
                "Person@Example.com",
                "register",
            )

        self.assertEqual(result, "4321")
        console_output.assert_called_once_with(
            "person@example.com",
            "register",
            "4321",
        )
        self.assertEqual(
            email_verification._verification_codes["person@example.com"]["code"],
            "4321",
        )

    def test_console_emission_never_opens_or_writes_a_file(self) -> None:
        with (
            patch("builtins.open") as file_open,
            patch("builtins.print"),
        ):
            email_verification._emit_console_code(
                "person@example.com",
                "register",
                "1234",
            )
        file_open.assert_not_called()

    def test_smtp_network_call_runs_without_otp_lock(self) -> None:
        settings = SimpleNamespace(email_mode="smtp", mail_mailer=None)
        lock_was_available: list[bool] = []

        def send_without_holding_lock(*_args) -> bool:
            def probe_from_another_thread() -> bool:
                acquired = email_verification._verification_lock.acquire(
                    blocking=False
                )
                if acquired:
                    email_verification._verification_lock.release()
                return acquired

            with ThreadPoolExecutor(max_workers=1) as executor:
                lock_was_available.append(
                    executor.submit(probe_from_another_thread).result(timeout=2)
                )
            return True

        with (
            patch.object(email_verification, "get_settings", return_value=settings),
            patch.object(email_verification, "_generate_code", return_value="4321"),
            patch.object(
                email_verification,
                "_send_smtp_message",
                side_effect=send_without_holding_lock,
            ),
            patch.object(email_verification.time, "time", return_value=1000.0),
        ):
            email_verification.send_verification_code(
                "person@example.com",
                "register",
            )

        self.assertEqual(lock_was_available, [True])

    def test_unknown_purposes_share_one_bounded_attempt_bucket(self) -> None:
        email = "person@example.com"
        self._store_code(email)

        with patch.object(email_verification.time, "time", return_value=1000.0):
            for index in range(email_verification.MAX_VERIFICATION_ATTEMPTS - 1):
                self.assertFalse(
                    email_verification.verify_code(
                        email,
                        "9999",
                        f"attacker-purpose-{index}",
                        consume=False,
                    )
                )

            with email_verification._verification_lock:
                self.assertEqual(
                    set(email_verification._verification_attempts),
                    {(email, email_verification._INVALID_PURPOSE)},
                )
                self.assertEqual(
                    email_verification._verification_attempts[
                        (email, email_verification._INVALID_PURPOSE)
                    ]["count"],
                    email_verification.MAX_VERIFICATION_ATTEMPTS - 1,
                )

            with self.assertRaises(HTTPException) as raised:
                email_verification.verify_code(
                    email,
                    "9999",
                    "one-more-unknown-purpose",
                    consume=False,
                )
        self.assertEqual(raised.exception.status_code, 429)

    def test_parallel_failures_do_not_lose_attempt_counts(self) -> None:
        email = "person@example.com"
        self._store_code(email)
        worker_count = email_verification.MAX_VERIFICATION_ATTEMPTS - 1
        start = Barrier(worker_count + 1)

        def fail_once() -> bool:
            start.wait(timeout=2)
            return email_verification.verify_code(
                email,
                "9999",
                "register",
                consume=False,
            )

        with (
            patch.object(email_verification.time, "time", return_value=1000.0),
            ThreadPoolExecutor(max_workers=worker_count) as executor,
        ):
            futures = [executor.submit(fail_once) for _ in range(worker_count)]
            start.wait(timeout=2)
            results = [future.result(timeout=2) for future in futures]

        self.assertEqual(results, [False] * worker_count)
        with email_verification._verification_lock:
            attempts = email_verification._verification_attempts[
                (email, "register")
            ]
            self.assertEqual(attempts["count"], worker_count)

    def test_concurrent_consumers_return_one_success_without_exception(self) -> None:
        email = "person@example.com"
        self._store_code(email)
        start = Barrier(3)

        def consume_once() -> bool:
            start.wait(timeout=2)
            return email_verification.verify_code(
                email,
                "1234",
                "register",
            )

        with (
            patch.object(email_verification.time, "time", return_value=1000.0),
            ThreadPoolExecutor(max_workers=2) as executor,
        ):
            futures = [executor.submit(consume_once) for _ in range(2)]
            start.wait(timeout=2)
            results = [future.result(timeout=2) for future in futures]

        self.assertEqual(sorted(results), [False, True])
        with email_verification._verification_lock:
            self.assertNotIn(email, email_verification._verification_codes)


class VerifyCodeEndpointTests(unittest.TestCase):
    def test_response_shape_and_non_consuming_service_call_are_preserved(self) -> None:
        request = make_request()
        payload = VerifyCodeRequest(
            email="Person@Example.com",
            code="1234",
            purpose="register",
        )
        with (
            patch.object(users.code_verify_limiter, "check"),
            patch.object(
                users.email_verification,
                "verify_code",
                return_value=True,
            ) as verifier,
        ):
            response = users.verify_code_endpoint(request, payload)

        self.assertEqual(response.model_dump(), {"valid": True})
        verifier.assert_called_once_with(
            "person@example.com",
            "1234",
            "register",
            consume=False,
        )


class RateLimiterTests(unittest.TestCase):
    def test_untrusted_direct_client_cannot_select_forwarded_headers(self) -> None:
        limiter = RateLimiter()
        request = make_request(
            "203.0.113.10",
            {
                "x-forwarded-for": "198.51.100.1",
                "x-real-ip": "198.51.100.2",
            },
        )
        self.assertEqual(limiter._get_client_ip(request), "203.0.113.10")

    def test_loopback_proxy_may_supply_only_valid_real_ip(self) -> None:
        limiter = RateLimiter()
        request = make_request(
            "127.0.0.1",
            {
                "x-forwarded-for": "198.51.100.1",
                "x-real-ip": "203.0.113.25",
            },
        )
        self.assertEqual(limiter._get_client_ip(request), "203.0.113.25")

        invalid = make_request(
            "127.0.0.1",
            {"x-real-ip": "not-an-ip"},
        )
        self.assertEqual(limiter._get_client_ip(invalid), "127.0.0.1")

    def test_varying_xff_does_not_bypass_direct_client_limit(self) -> None:
        limiter = RateLimiter(max_requests=2, window_seconds=60)
        limiter.check(make_request(headers={"x-forwarded-for": "198.51.100.1"}))
        limiter.check(make_request(headers={"x-forwarded-for": "198.51.100.2"}))
        with self.assertRaises(HTTPException) as raised:
            limiter.check(
                make_request(headers={"x-forwarded-for": "198.51.100.3"})
            )
        self.assertEqual(raised.exception.status_code, 429)


class PasswordResetTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        session_factory = sessionmaker(bind=self.engine)
        self.db = session_factory()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def _add_user(self, suffix: str) -> User:
        user = User(
            personal_id=f"0100000000{suffix}",
            first_name="Test",
            last_name="User",
            phone=f"55500000{suffix}",
            email=f"person{suffix}@example.com",
            password_hash="old-hash",
            code=f"100000000{suffix}",
        )
        self.db.add(user)
        self.db.flush()
        return user

    def test_successful_reset_invalidates_only_target_web_sessions(self) -> None:
        target = self._add_user("1")
        other = self._add_user("2")
        now = datetime.utcnow()
        self.db.add_all(
            [
                UserSession(
                    user_id=target.id,
                    token="target-token-1",
                    created_at=now,
                    expires_at=now + timedelta(days=1),
                    last_used_at=now,
                ),
                UserSession(
                    user_id=target.id,
                    token="target-token-2",
                    created_at=now,
                    expires_at=now + timedelta(days=1),
                    last_used_at=now,
                ),
                UserSession(
                    user_id=other.id,
                    token="other-token",
                    created_at=now,
                    expires_at=now + timedelta(days=1),
                    last_used_at=now,
                ),
            ]
        )
        self.db.commit()

        payload = ResetPasswordRequest(
            email=target.email,
            verification_code="1234",
            new_password="NewPassword1",
            confirm_new_password="NewPassword1",
        )
        with (
            patch.object(auth.code_verify_limiter, "check"),
            patch.object(auth, "validate_password_strength"),
            patch.object(auth.email_verification, "verify_code", return_value=True),
            patch.object(auth, "hash_code", return_value="new-hash"),
        ):
            response = auth.reset_password(make_request(), payload, self.db)

        self.assertTrue(response.success)
        self.assertEqual(set(response.model_dump()), {"success", "message"})
        target_sessions = self.db.scalars(
            select(UserSession).where(UserSession.user_id == target.id)
        ).all()
        other_sessions = self.db.scalars(
            select(UserSession).where(UserSession.user_id == other.id)
        ).all()
        self.assertEqual(target_sessions, [])
        self.assertEqual(len(other_sessions), 1)
        self.assertEqual(self.db.get(User, target.id).password_hash, "new-hash")

    def test_failed_reset_keeps_existing_web_sessions(self) -> None:
        target = self._add_user("3")
        now = datetime.utcnow()
        self.db.add(
            UserSession(
                user_id=target.id,
                token="still-valid-token",
                created_at=now,
                expires_at=now + timedelta(days=1),
                last_used_at=now,
            )
        )
        self.db.commit()
        payload = ResetPasswordRequest(
            email=target.email,
            verification_code="9999",
            new_password="NewPassword1",
            confirm_new_password="NewPassword1",
        )

        with (
            patch.object(auth.code_verify_limiter, "check"),
            patch.object(auth, "validate_password_strength"),
            patch.object(auth.email_verification, "verify_code", return_value=False),
        ):
            with self.assertRaises(HTTPException) as raised:
                auth.reset_password(make_request(), payload, self.db)

        self.assertEqual(raised.exception.status_code, 400)
        remaining = self.db.scalars(
            select(UserSession).where(UserSession.user_id == target.id)
        ).all()
        self.assertEqual(len(remaining), 1)
        self.assertEqual(self.db.get(User, target.id).password_hash, "old-hash")


if __name__ == "__main__":
    unittest.main()
