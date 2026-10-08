from __future__ import annotations

from contextlib import ExitStack
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier, Lock
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from sqlalchemy import create_engine, event
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

try:
    from backend.app.models import Base, Certificate, Statement, User, UserCodeReservation, UserSession
    from backend.app.routers import admin, users
    from backend.app.schemas import AdminUserUpdateRequest, UserCreateWithVerification, UserProfileUpdateRequest
    from backend.app.services import user_codes
except ModuleNotFoundError:
    from app.models import Base, Certificate, Statement, User, UserCodeReservation, UserSession
    from app.routers import admin, users
    from app.schemas import AdminUserUpdateRequest, UserCreateWithVerification, UserProfileUpdateRequest
    from app.services import user_codes


class UserCodePersistenceTests(unittest.TestCase):
    """Exercise real route transactions without email, passwords, or real media."""

    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")

        @event.listens_for(self.engine, "connect")
        def enable_foreign_keys(connection, _record):
            connection.execute("PRAGMA foreign_keys=ON")

        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.addCleanup(self.engine.dispose)
        self.addCleanup(self.db.close)
        self.patches = ExitStack()
        self.addCleanup(self.patches.close)
        directory = self.patches.enter_context(TemporaryDirectory(prefix="user-code-tests-"))
        self.media_root = Path(directory)
        settings = SimpleNamespace(founder_admin_email="founder@example.com")
        for module in (admin, users):
            self.patches.enter_context(patch.object(module, "get_settings", return_value=settings))
            self.patches.enter_context(patch.object(module, "ensure_media_root", return_value=self.media_root))
            self.patches.enter_context(patch.object(module, "delete_storage_file"))
            self.patches.enter_context(patch.object(module, "delete_expert_certificate_files"))
        self.photo_cleanup = self.patches.enter_context(patch.object(admin, "_delete_user_photo_file"))
        self.patches.enter_context(patch.object(admin, "_require_admin"))
        self.patches.enter_context(patch.object(admin, "_is_founder_actor", return_value=True))
        self.verification = self.patches.enter_context(
            patch.object(users.email_verification, "verify_code", return_value=True)
        )
        self.patches.enter_context(patch.object(users, "hash_code", return_value="test-password-hash"))
        self.password_check = self.patches.enter_context(patch.object(users, "verify_code", return_value=True))

    def payload(self, number=1, **overrides):
        values = dict(
            personal_id=f"{number:011d}",
            first_name="Example",
            last_name="Person",
            phone=f"555{number:06d}",
            email=f"person{number}@example.com",
            password="Test-password-123!",
            verification_code="1234",
        )
        values.update(overrides)
        return UserCreateWithVerification(**values)

    def register(self, number=1, **overrides):
        return users.register(self.payload(number, **overrides), db=self.db)

    def legacy_user(self, number=1, **overrides):
        values = dict(
            personal_id=f"{number:011d}", first_name="Legacy", last_name="Person",
            phone=f"555{number:06d}", email=f"person{number}@example.com",
            password_hash="legacy-password-hash", code=str(1000000000 + number),
        )
        values.update(overrides)
        user = User(**values)
        self.db.add(user)
        self.db.commit()
        return user

    def reservation(self, personal_id):
        return self.db.get(UserCodeReservation, personal_id)

    def delete(self, user):
        admin.admin_delete_user(user.id, authorization="Bearer test-founder", db=self.db)

    def update(self, mode, user, **changes):
        if mode == "admin":
            return admin.admin_update_user(
                user.id, AdminUserUpdateRequest(**changes),
                authorization="Bearer test-founder", db=self.db,
            )
        return users.update_profile(
            UserProfileUpdateRequest(current_password="Test-password-123!", **changes),
            current_user=user, db=self.db,
        )

    def test_first_registration_persists_only_personal_number_and_code(self):
        result = self.register()
        reservation = self.reservation(result.personal_id)
        self.assertEqual(reservation.code, result.code)
        self.assertRegex(result.code, r"^[0-9]{10}$")
        self.assertEqual(set(UserCodeReservation.__table__.columns.keys()), {"personal_id", "code"})
        self.assertEqual(len(UserCodeReservation.__table__.foreign_keys), 0)
        self.assertFalse(result.is_admin)
        self.assertFalse(result.is_founder)
        self.assertFalse(result.exam_permission)
        self.verification.assert_called_once_with("person1@example.com", "1234", "register")

    def test_single_delete_and_reregister_restores_code_with_new_contact_details(self):
        first = self.register()
        original_code = first.code
        self.delete(first)
        self.assertEqual(self.db.query(User).count(), 0)
        self.assertEqual(self.reservation(first.personal_id).code, original_code)

        second = self.register(email="changed@example.com", phone="599111111")
        self.assertEqual(second.code, original_code)
        self.assertEqual(second.email, "changed@example.com")
        self.assertEqual(second.phone, "599111111")

        self.delete(second)
        third = self.register(email="third@example.com", phone="599222222")
        self.assertEqual(third.code, original_code)
        self.assertEqual(self.db.query(UserCodeReservation).count(), 1)

    def test_single_delete_preserves_unreserved_legacy_code(self):
        legacy = self.legacy_user()
        original_pid, original_code = legacy.personal_id, legacy.code
        self.assertIsNone(self.reservation(original_pid))

        self.delete(legacy)

        self.assertEqual(self.reservation(original_pid).code, original_code)
        self.assertEqual(self.register().code, original_code)

    def test_bulk_delete_preserves_all_codes_and_does_not_delete_founder(self):
        founder = self.legacy_user(99, email="founder@example.com", is_admin=True)
        first = self.register(1)
        legacy = self.legacy_user(2)
        codes = {first.personal_id: first.code, legacy.personal_id: legacy.code}
        founder_id, founder_code = founder.id, founder.code

        admin.admin_delete_all_users(authorization="Bearer test-founder", db=self.db)

        self.assertEqual(self.db.query(User).count(), 1)
        self.assertEqual(self.db.get(User, founder_id).code, founder_code)
        for personal_id, code in codes.items():
            self.assertEqual(self.reservation(personal_id).code, code)
        self.assertEqual(self.register(1).code, codes[first.personal_id])
        self.assertEqual(self.register(2).code, codes[f"{2:011d}"])

    def test_delete_removes_old_records_and_never_restores_old_privileges(self):
        user = self.legacy_user(is_admin=True, exam_permission=True, exam_stage="all")
        original_code = user.code
        self.db.add_all([
            Statement(user_id=user.id, message="Old statement", attachment_path="statements/old.pdf"),
            Certificate(user_id=user.id, level="expert", status="active", unique_code="EX-OLD", file_path="certificates/old.pdf"),
            UserSession(user_id=user.id, token="old-login-token", expires_at=datetime.utcnow() + timedelta(days=1)),
        ])
        self.db.commit()

        self.delete(user)

        for model in (Statement, Certificate, UserSession):
            self.assertEqual(self.db.query(model).count(), 0)
        fresh = self.register()
        self.assertEqual(fresh.code, original_code)
        self.assertFalse(fresh.is_admin)
        self.assertFalse(fresh.is_founder)
        self.assertFalse(fresh.exam_permission)
        self.assertEqual(self.db.get(User, fresh.id).exam_stage, "none")

    def test_founder_registration_and_delete_protection_are_unchanged(self):
        founder = self.register(email="founder@example.com")
        self.assertTrue(founder.is_founder)
        self.assertTrue(founder.is_admin)
        self.assertTrue(founder.exam_permission)
        with self.assertRaises(HTTPException) as caught:
            self.delete(founder)
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIsNotNone(self.db.get(User, founder.id))

    def test_already_registered_personal_number_email_or_phone_still_conflicts(self):
        existing = self.register()
        for duplicate in (
            dict(personal_id=existing.personal_id),
            dict(email=existing.email),
            dict(phone=existing.phone),
        ):
            with self.subTest(duplicate=duplicate), self.assertRaises(HTTPException) as caught:
                self.register(2, **duplicate)
            self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(self.db.query(User).count(), 1)
        self.assertEqual(self.db.query(UserCodeReservation).count(), 1)

    def test_registration_verification_is_still_required_for_a_reserved_code(self):
        first = self.register()
        self.delete(first)
        self.verification.return_value = False
        with self.assertRaises(HTTPException) as caught:
            self.register()
        self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(self.db.query(User).count(), 0)
        self.assertEqual(self.reservation(first.personal_id).code, first.code)

    def test_generator_skips_both_legacy_active_and_reserved_codes(self):
        self.legacy_user(1)
        self.db.add(UserCodeReservation(personal_id=f"{2:011d}", code="1000000002"))
        self.db.commit()
        with patch.object(user_codes.secrets, "randbelow", side_effect=[1, 2, 3]) as random:
            result = self.register(3)
        self.assertEqual(result.code, "1000000003")
        self.assertEqual(random.call_count, 3)

    def test_generator_exhaustion_never_returns_an_unchecked_fallback(self):
        self.db.add(UserCodeReservation(personal_id=f"{1:011d}", code="1000000001"))
        self.db.commit()
        with patch.object(user_codes.secrets, "randbelow", return_value=1):
            with self.assertRaises(user_codes.UserCodeGenerationError):
                user_codes.generate_user_code(self.db)
        self.assertEqual(self.db.query(User).count(), 0)
        self.assertEqual(self.db.query(UserCodeReservation).count(), 1)

    def test_reservation_is_not_committed_without_successful_user_registration(self):
        code = user_codes.reserve_registration_code(self.db, f"{1:011d}")
        self.assertEqual(self.reservation(f"{1:011d}").code, code)
        self.db.rollback()
        self.assertIsNone(self.reservation(f"{1:011d}"))

    def test_failed_user_insert_rolls_back_new_reservation(self):
        insert_attempts = []

        def fail_insert(_mapper, _connection, target):
            insert_attempts.append(target.personal_id)
            raise IntegrityError("INSERT INTO users", {}, Exception("test insert failure"))

        event.listen(User, "before_insert", fail_insert)
        try:
            with self.assertRaises(HTTPException) as caught:
                self.register()
        finally:
            event.remove(User, "before_insert", fail_insert)
        self.assertEqual(caught.exception.status_code, 503)
        self.assertEqual(len(insert_attempts), 3)
        self.assertEqual(self.db.query(User).count(), 0)
        self.assertEqual(self.db.query(UserCodeReservation).count(), 0)

    def test_transient_insert_collision_retries_with_one_final_reservation(self):
        insert_attempts = []

        def fail_once(_mapper, _connection, target):
            insert_attempts.append(target.code)
            if len(insert_attempts) == 1:
                raise IntegrityError("INSERT INTO users", {}, Exception("simulated collision"))

        event.listen(User, "before_insert", fail_once)
        try:
            result = self.register()
        finally:
            event.remove(User, "before_insert", fail_once)
        self.assertEqual(len(insert_attempts), 2)
        self.assertEqual(self.db.query(User).count(), 1)
        self.assertEqual(self.db.query(UserCodeReservation).count(), 1)
        self.assertEqual(self.reservation(result.personal_id).code, result.code)
        self.verification.assert_called_once()

    def run_concurrent_registrations(self, *, same_personal_id):
        """Force both transactions past lookup before either inserts its reservation."""
        database = self.media_root / "concurrent-registration.sqlite"
        engine = create_engine(
            f"sqlite:///{database.as_posix()}",
            connect_args={"check_same_thread": False, "timeout": 5},
        )
        Base.metadata.create_all(engine)
        first_inserts = Barrier(2, timeout=5)
        insert_lock = Lock()
        insert_count = 0

        @event.listens_for(engine, "before_cursor_execute")
        def synchronize_first_inserts(_connection, _cursor, statement, _parameters, _context, _many):
            nonlocal insert_count
            if statement.lstrip().upper().startswith("INSERT INTO USER_CODE_RESERVATIONS"):
                with insert_lock:
                    insert_count += 1
                    initial = insert_count <= 2
                if initial:
                    first_inserts.wait()

        def register_one(number):
            with Session(engine) as db:
                personal_id = f"{1 if same_personal_id else number:011d}"
                try:
                    result = users.register(self.payload(number, personal_id=personal_id), db=db)
                    return "created", result.code
                except HTTPException as exc:
                    return "conflict", exc.status_code

        try:
            # Both transactions intentionally choose 1000000001 on their first
            # attempt; only a genuine retry may consume the third value.
            with patch.object(user_codes.secrets, "randbelow", side_effect=[1, 1, 2]):
                with ThreadPoolExecutor(max_workers=2) as executor:
                    futures = [executor.submit(register_one, number) for number in (1, 2)]
                    results = [future.result(timeout=12) for future in futures]
            with Session(engine) as db:
                active = {(user.personal_id, user.code) for user in db.query(User).all()}
                reserved = {(row.personal_id, row.code) for row in db.query(UserCodeReservation).all()}
            return results, active, reserved
        finally:
            engine.dispose()

    def test_concurrent_different_people_retry_real_unique_code_collision(self):
        results, active, reserved = self.run_concurrent_registrations(same_personal_id=False)
        self.assertEqual([result[0] for result in results], ["created", "created"])
        self.assertEqual({result[1] for result in results}, {"1000000001", "1000000002"})
        self.assertEqual(len(active), 2)
        self.assertEqual(reserved, active)

    def test_concurrent_same_person_creates_one_account_and_one_reservation(self):
        results, active, reserved = self.run_concurrent_registrations(same_personal_id=True)
        self.assertEqual(sorted(results), [("conflict", 409), ("created", "1000000001")])
        self.assertEqual(active, {(f"{1:011d}", "1000000001")})
        self.assertEqual(reserved, active)

    def test_reserved_code_owned_by_another_active_user_is_a_conflict(self):
        active = self.legacy_user(2)
        self.db.add(UserCodeReservation(personal_id=f"{1:011d}", code=active.code))
        self.db.commit()
        with self.assertRaises(HTTPException) as caught:
            self.register(1)
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(self.db.query(User).count(), 1)
        self.assertEqual(self.db.get(User, active.id).code, active.code)

    def test_mismatched_registry_blocks_deletion_before_any_file_cleanup(self):
        for bulk in (False, True):
            with self.subTest(bulk=bulk):
                user = self.legacy_user(1)
                self.db.add(UserCodeReservation(personal_id=user.personal_id, code="9999999999"))
                self.db.commit()
                with self.assertRaises(HTTPException) as caught:
                    if bulk:
                        admin.admin_delete_all_users(authorization="Bearer test-founder", db=self.db)
                    else:
                        self.delete(user)
                self.assertEqual(caught.exception.status_code, 409)
                self.photo_cleanup.assert_not_called()
                self.assertEqual(self.db.query(User).count(), 1)
                self.db.rollback()
                self.db.query(UserCodeReservation).delete()
                self.db.query(User).delete()
                self.db.commit()
                self.db.expunge_all()

    def test_bulk_delete_checks_all_reservations_before_deleting_any_files(self):
        first = self.legacy_user(1)
        second = self.legacy_user(2)
        self.db.add(UserCodeReservation(personal_id=second.personal_id, code="9999999999"))
        self.db.commit()
        with self.assertRaises(HTTPException) as caught:
            admin.admin_delete_all_users(authorization="Bearer test-founder", db=self.db)
        self.assertEqual(caught.exception.status_code, 409)
        self.photo_cleanup.assert_not_called()
        self.db.rollback()
        self.assertEqual(self.db.query(User).count(), 2)
        self.assertIsNone(self.reservation(first.personal_id))
        self.assertEqual(self.reservation(second.personal_id).code, "9999999999")

    def test_personal_number_correction_transfers_binding_without_changing_code(self):
        for mode, number in (("admin", 1), ("profile", 2)):
            with self.subTest(mode=mode):
                created = self.register(number)
                user = self.db.get(User, created.id)
                old_pid, code = user.personal_id, user.code
                corrected_pid = f"{number + 10:011d}"

                result = self.update(mode, user, personal_id=corrected_pid)

                self.assertEqual(result.code, code)
                self.assertEqual(result.personal_id, corrected_pid)
                self.assertIsNone(self.reservation(old_pid))
                self.assertEqual(self.reservation(corrected_pid).code, code)
                self.delete(result)
                restored = self.register(number, personal_id=corrected_pid)
                self.assertEqual(restored.code, code)
                new_person = self.register(number + 30, personal_id=old_pid)
                self.assertNotEqual(new_person.code, code)

    def test_legacy_personal_number_correction_preserves_existing_code(self):
        for mode, number in (("admin", 1), ("profile", 2)):
            with self.subTest(mode=mode):
                user = self.legacy_user(number)
                old_pid, code = user.personal_id, user.code
                new_pid = f"{number + 10:011d}"
                result = self.update(mode, user, personal_id=new_pid)
                self.assertEqual(result.code, code)
                self.assertIsNone(self.reservation(old_pid))
                self.assertEqual(self.reservation(new_pid).code, code)

    def test_correction_cannot_take_personal_number_reserved_for_someone_else(self):
        for mode, number in (("admin", 1), ("profile", 2)):
            with self.subTest(mode=mode):
                created = self.register(number)
                user = self.db.get(User, created.id)
                old_pid, code = user.personal_id, user.code
                reserved_pid = f"{number + 10:011d}"
                other_code = str(9000000000 + number)
                self.db.add(UserCodeReservation(personal_id=reserved_pid, code=other_code))
                self.db.commit()
                with self.assertRaises(HTTPException) as caught:
                    self.update(mode, user, personal_id=reserved_pid)
                self.assertEqual(caught.exception.status_code, 409)
                self.db.rollback()
                self.db.refresh(user)
                self.assertEqual(user.personal_id, old_pid)
                self.assertEqual(user.code, code)
                self.assertEqual(self.reservation(old_pid).code, code)
                self.assertEqual(self.reservation(reserved_pid).code, other_code)

    def test_personal_number_correction_still_requires_current_password(self):
        created = self.register()
        self.password_check.return_value = False
        with self.assertRaises(HTTPException) as caught:
            self.update("profile", self.db.get(User, created.id), personal_id=f"{2:011d}")
        self.assertEqual(caught.exception.status_code, 401)
        self.assertEqual(self.reservation(created.personal_id).code, created.code)
        self.assertIsNone(self.reservation(f"{2:011d}"))

    def test_even_founder_cannot_manually_change_unique_code(self):
        created = self.register()
        user = self.db.get(User, created.id)
        with self.assertRaises(HTTPException) as caught:
            self.update("admin", user, code="9999999999")
        self.assertEqual(caught.exception.status_code, 400)
        self.db.rollback()
        self.assertEqual(self.db.get(User, user.id).code, created.code)
        self.assertEqual(self.reservation(created.personal_id).code, created.code)


if __name__ == "__main__":
    unittest.main()
