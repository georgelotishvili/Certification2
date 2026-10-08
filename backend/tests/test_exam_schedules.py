from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
import sqlite3
import tempfile
from threading import Barrier
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import create_engine, event, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

try:
    from backend.app.database import get_db
    from backend.app.models import (
        Base, Certificate, Exam, ExamSchedule, Session as ExamSession,
        Statement, User, UserCodeReservation, UserSession,
    )
    from backend.app.routers import admin, exam_schedules
    from backend.app.schemas import ExamScheduleCreate, PublicUserOut, UserOut
    from backend.scripts import migrate_exam_schedules as migration
except ModuleNotFoundError:
    from app.database import get_db
    from app.models import (
        Base, Certificate, Exam, ExamSchedule, Session as ExamSession,
        Statement, User, UserCodeReservation, UserSession,
    )
    from app.routers import admin, exam_schedules
    from app.schemas import ExamScheduleCreate, PublicUserOut, UserOut
    from scripts import migrate_exam_schedules as migration


def enable_foreign_keys(connection, _record):
    connection.execute("PRAGMA foreign_keys=ON")


class ExamScheduleTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine(
            "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool,
        )
        event.listen(self.engine, "connect", enable_foreign_keys)
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.addCleanup(self.engine.dispose)
        self.addCleanup(self.db.close)
        settings = patch.object(admin, "get_settings", return_value=SimpleNamespace(
            founder_admin_email="founder@example.test",
        ))
        settings.start()
        self.addCleanup(settings.stop)
        self.candidate = self.add_user(1)
        self.staff = self.add_user(2, is_admin=True)
        self.other_staff = self.add_user(3, is_admin=True)
        self.other_candidate = self.add_user(4)
        self.founder = self.add_user(5, email="founder@example.test")
        self.auth = "Bearer token-2"

    def add_user(self, number, **overrides):
        fields = dict(
            id=number, personal_id=f"{number:011d}", first_name=f"Person{number}",
            last_name="Family", phone=f"555{number:06d}", email=f"person{number}@example.test",
            password_hash="unused-test-hash", code=f"{number:010d}",
        )
        fields.update(overrides)
        user = User(**fields)
        self.db.add(user)
        self.db.flush()
        self.db.add(UserSession(
            user_id=user.id, token=f"token-{number}", expires_at=datetime.utcnow() + timedelta(hours=1),
        ))
        self.db.commit()
        return user

    def create(self, day="2026-10-08", period="morning", user=None, auth=None):
        return exam_schedules.create_exam_schedule(
            (user or self.candidate).id, ExamScheduleCreate(exam_date=day, period=period),
            authorization=auth or self.auth, db=self.db,
        )

    def history(self, user=None, auth=None):
        return exam_schedules.list_exam_schedules(
            (user or self.candidate).id, authorization=auth or self.auth, db=self.db,
        ).items

    def delete(self, entry, user=None, auth=None):
        return exam_schedules.delete_exam_schedule(
            (user or self.candidate).id, entry.id, authorization=auth or self.auth, db=self.db,
        )

    def filtered_ids(self, **kwargs):
        result = admin.admin_users(authorization=self.auth, db=self.db, **kwargs)
        self.assertEqual(result.total, len(result.items))
        return [item.id for item in result.items]

    def client(self):
        app = FastAPI()
        app.include_router(admin.router, prefix="/admin")
        app.include_router(exam_schedules.router, prefix="/admin")

        def test_db():
            yield self.db

        app.dependency_overrides[get_db] = test_db
        return TestClient(app)

    def test_each_admin_and_founder_can_create_read_and_delete(self):
        for actor in (self.staff, self.other_staff, self.founder):
            with self.subTest(actor=actor.id):
                auth = f"Bearer token-{actor.id}"
                entry = self.create(auth=auth)
                self.assertEqual([item.id for item in self.history(auth=auth)], [entry.id])
                self.assertEqual(self.delete(entry, auth=auth).status_code, 204)
                self.assertEqual(self.history(auth=auth), [])

    def test_another_admin_may_remove_the_original_admins_entry(self):
        entry = self.create()
        self.delete(entry, auth="Bearer token-3")
        self.assertEqual(self.history(), [])

    def test_anonymous_nonadmin_and_expired_sessions_cannot_access_routes(self):
        entry = self.create()
        expired = UserSession(
            user_id=self.staff.id, token="expired", expires_at=datetime.utcnow() - timedelta(seconds=1),
        )
        self.db.add(expired)
        self.db.commit()
        for auth in (None, "Bearer missing", "Bearer token-1", "Bearer expired", "Basic token-2"):
            for operation in ("list", "create", "delete"):
                with self.subTest(auth=auth, operation=operation), self.assertRaises(HTTPException) as error:
                    common = dict(authorization=auth, db=self.db)
                    if operation == "list":
                        exam_schedules.list_exam_schedules(self.candidate.id, **common)
                    elif operation == "create":
                        exam_schedules.create_exam_schedule(
                            self.candidate.id, ExamScheduleCreate(exam_date="2026-10-09", period="evening"),
                            **common,
                        )
                    else:
                        exam_schedules.delete_exam_schedule(self.candidate.id, entry.id, **common)
                self.assertEqual(error.exception.status_code, 401)
        self.assertEqual(len(self.history()), 1)

    def test_missing_user_is_404_after_authentication(self):
        calls = (
            lambda: exam_schedules.list_exam_schedules(999, authorization=self.auth, db=self.db),
            lambda: exam_schedules.create_exam_schedule(
                999, ExamScheduleCreate(exam_date="2026-10-08", period="morning"),
                authorization=self.auth, db=self.db,
            ),
            lambda: exam_schedules.delete_exam_schedule(999, 1, authorization=self.auth, db=self.db),
        )
        for call in calls:
            with self.assertRaises(HTTPException) as error:
                call()
            self.assertEqual(error.exception.status_code, 404)

    def test_old_dates_and_future_dates_are_both_retained(self):
        past = self.create("2020-01-02")
        future = self.create("2035-12-31", "evening")
        present = self.create()
        self.assertEqual([row.id for row in self.history()], [future.id, present.id, past.id])
        self.assertEqual(self.history()[-1].exam_date, date(2020, 1, 2))

    def test_same_person_can_be_planned_again_without_overwriting_history(self):
        first = self.create("2026-01-01")
        second = self.create("2026-11-01")
        self.assertNotEqual(first.id, second.id)
        self.assertEqual({row.id for row in self.history()}, {first.id, second.id})

    def test_delete_one_record_preserves_other_history_and_other_person(self):
        old = self.create("2026-01-01")
        recent = self.create()
        other = self.create(user=self.other_candidate)
        self.delete(old)
        self.assertEqual([row.id for row in self.history()], [recent.id])
        self.assertEqual([row.id for row in self.history(self.other_candidate)], [other.id])

    def test_delete_cannot_target_another_persons_record(self):
        other = self.create(user=self.other_candidate)
        with self.assertRaises(HTTPException) as error:
            self.delete(other)
        self.assertEqual(error.exception.status_code, 404)
        self.assertEqual(len(self.history(self.other_candidate)), 1)

    def test_deleting_missing_entry_is_404(self):
        with self.assertRaises(HTTPException) as error:
            self.delete(SimpleNamespace(id=999))
        self.assertEqual(error.exception.status_code, 404)

    def test_stale_delete_does_not_remove_a_new_entry_after_last_row_deleted(self):
        old = self.create("2026-01-01")
        self.delete(old, auth="Bearer token-3")
        new = self.create("2026-12-31", "evening", auth="Bearer token-3")
        self.assertGreater(new.id, old.id)

        # Another admin still has the original row on screen and deletes it.
        with self.assertRaises(HTTPException) as error:
            self.delete(old)
        self.assertEqual(error.exception.status_code, 404)
        self.assertEqual([row.id for row in self.history()], [new.id])
        self.assertEqual(self.history()[0].exam_date, date(2026, 12, 31))
        self.assertEqual(self.history()[0].period, "evening")

    def test_duplicate_is_409_and_transaction_remains_usable(self):
        first = self.create()
        with self.assertRaises(HTTPException) as error:
            self.create()
        self.assertEqual(error.exception.status_code, 409)
        self.assertEqual([row.id for row in self.history()], [first.id])
        self.create("2026-10-09")
        self.assertEqual(len(self.history()), 2)

    def test_same_day_other_group_and_other_person_are_not_duplicates(self):
        self.create()
        self.create(period="evening")
        self.create(user=self.other_candidate)
        self.assertEqual(len(self.history()), 2)
        self.assertEqual(len(self.history(self.other_candidate)), 1)

    def test_database_constraint_rejects_duplicate_even_when_bypassing_route(self):
        self.create()
        self.db.add(ExamSchedule(user_id=self.candidate.id, exam_date=date(2026, 10, 8), period="morning"))
        with self.assertRaises(IntegrityError):
            self.db.commit()
        self.db.rollback()
        self.assertEqual(len(self.history()), 1)

    def test_database_constraint_rejects_invalid_group(self):
        self.db.add(ExamSchedule(user_id=self.candidate.id, exam_date=date(2026, 10, 8), period="night"))
        with self.assertRaises(IntegrityError):
            self.db.commit()
        self.db.rollback()

    def test_invalid_dates_groups_and_privilege_fields_are_rejected(self):
        for extra in (
            {"exam_date": "2026-02-30"}, {"exam_date": "not-a-date"},
            {"exam_date": None}, {"period": "night"}, {"period": "Morning"},
            {"period": None}, {"is_admin": True}, {"exam_permission": True},
            {"user_id": self.other_candidate.id},
        ):
            with self.subTest(extra=extra), self.assertRaises(ValidationError):
                ExamScheduleCreate.model_validate(dict(exam_date="2026-10-08", period="morning") | extra)

    def test_operations_do_not_change_permissions_stage_codes_statements_certificates_or_results(self):
        self.candidate.exam_permission = True
        self.candidate.exam_stage = "theory"
        self.candidate.exam_stage_expires_at = datetime.utcnow() - timedelta(days=1)
        self.candidate.exam_stage_started_at = None
        self.db.add(Exam(id=1, title="Existing exam"))
        self.db.flush()
        self.db.add_all([
            Certificate(user_id=self.candidate.id, unique_code="unchanged-cert", level="architect"),
            Statement(user_id=self.candidate.id, message="Unchanged statement"),
            ExamSession(exam_id=1, user_id=self.candidate.id, token="existing-result",
                        ends_at=datetime(2020, 1, 1), active=False, score_percent=94),
            UserCodeReservation(personal_id=self.candidate.personal_id, code=self.candidate.code),
        ])
        self.db.commit()
        tables = ("users", "certificates", "statements", "sessions", "user_code_reservations", "user_sessions")
        before = {table: self.db.execute(text(f'SELECT * FROM "{table}"')).fetchall() for table in tables}
        entry = self.create()
        self.history()
        self.delete(entry)
        after = {table: self.db.execute(text(f'SELECT * FROM "{table}"')).fetchall() for table in tables}
        self.assertEqual(after, before)

    def test_unauthorized_candidate_remains_unauthorized_when_scheduled(self):
        self.assertFalse(self.candidate.exam_permission)
        self.create()
        self.db.refresh(self.candidate)
        self.assertFalse(self.candidate.exam_permission)
        self.assertEqual(self.candidate.exam_stage, "none")

    def test_founder_account_deletion_cascades_schedules_but_preserves_code(self):
        self.create()
        candidate_id = self.candidate.id
        personal_id, code = self.candidate.personal_id, self.candidate.code
        other = self.create(user=self.other_candidate)
        with patch.object(admin, "_delete_user_photo_file"):
            admin.admin_delete_user(candidate_id, authorization="Bearer token-5", db=self.db)
        self.assertIsNone(self.db.get(User, candidate_id))
        self.assertEqual(self.db.scalars(select(ExamSchedule).where(ExamSchedule.user_id == candidate_id)).all(), [])
        self.assertEqual(self.db.get(UserCodeReservation, personal_id).code, code)
        self.assertIsNotNone(self.db.get(ExamSchedule, other.id))

    def test_no_schedule_information_is_added_to_user_or_public_response(self):
        self.assertNotIn("exam_schedules", UserOut.model_fields)
        self.assertNotIn("exam_schedules", PublicUserOut.model_fields)

    def test_http_create_list_delete_shapes_and_validation(self):
        path = f"/admin/users/{self.candidate.id}/exam-schedules"
        with self.client() as client:
            headers = {"Authorization": self.auth}
            response = client.post(path, headers=headers, json={"exam_date": "2030-12-31", "period": "evening"})
            self.assertEqual(response.status_code, 201, response.text)
            record = response.json()
            self.assertEqual(set(record), {"id", "user_id", "exam_date", "period", "created_at"})
            self.assertEqual(record["exam_date"], "2030-12-31")
            self.assertEqual(client.get(path, headers=headers).json(), {"items": [record]})
            self.assertEqual(client.post(path, headers=headers, json={"exam_date": "2030-12-31", "period": "evening"}).status_code, 409)
            self.assertEqual(client.post(path, headers=headers, json={"exam_date": "2030-02-30", "period": "morning"}).status_code, 422)
            self.assertEqual(client.get(path).status_code, 401)
            deleted = client.delete(f'{path}/{record["id"]}', headers=headers)
            self.assertEqual(deleted.status_code, 204)
            self.assertEqual(deleted.content, b"")
            self.assertEqual(client.get(path, headers=headers).json(), {"items": []})

    def test_filter_morning_only_evening_only_and_both(self):
        self.create()
        self.create(period="evening", user=self.other_candidate)
        kwargs = dict(exam_date=date(2026, 10, 8))
        self.assertEqual(self.filtered_ids(exam_morning=True, **kwargs), [self.candidate.id])
        self.assertEqual(self.filtered_ids(exam_evening=True, **kwargs), [self.other_candidate.id])
        self.assertEqual(set(self.filtered_ids(exam_morning=True, exam_evening=True, **kwargs)), {1, 4})

    def test_date_alone_matches_both_groups(self):
        self.create()
        self.create(period="evening", user=self.other_candidate)
        self.assertEqual(set(self.filtered_ids(exam_date=date(2026, 10, 8))), {1, 4})

    def test_flag_without_date_defaults_to_today_in_tbilisi(self):
        self.create()
        self.create("2026-10-09", user=self.other_candidate)
        with patch.object(admin, "_today_in_tbilisi", return_value=date(2026, 10, 8)) as today:
            self.assertEqual(self.filtered_ids(exam_morning=True), [self.candidate.id])
            today.assert_called_once()

    def test_explicit_date_ignores_today(self):
        self.create("2020-01-01")
        with patch.object(admin, "_today_in_tbilisi", side_effect=AssertionError("should not use today")):
            self.assertEqual(self.filtered_ids(exam_date=date(2020, 1, 1), exam_morning=True), [1])

    def test_past_and_future_filters_work_from_preserved_history(self):
        self.create("2020-01-01")
        self.create("2030-12-31", "evening")
        self.assertEqual(self.filtered_ids(exam_date=date(2020, 1, 1), exam_morning=True), [1])
        self.assertEqual(self.filtered_ids(exam_date=date(2030, 12, 31), exam_evening=True), [1])

    def test_multiple_matching_records_do_not_duplicate_person(self):
        self.create()
        self.create(period="evening")
        self.assertEqual(self.filtered_ids(exam_date=date(2026, 10, 8)), [1])
        self.assertEqual(self.filtered_ids(exam_date=date(2026, 10, 8), exam_morning=True, exam_evening=True), [1])

    def test_deleted_record_disappears_from_its_date_filter(self):
        old = self.create("2020-01-01")
        self.create("2030-12-31")
        self.delete(old)
        self.assertEqual(self.filtered_ids(exam_date=date(2020, 1, 1)), [])
        self.assertEqual(self.filtered_ids(exam_date=date(2030, 12, 31)), [1])

    def test_no_filters_preserves_existing_list(self):
        expected = self.filtered_ids()
        self.create()
        self.assertEqual(self.filtered_ids(), expected)
        self.assertEqual(set(expected), {1, 2, 3, 4, 5})

    def test_exam_filters_compose_with_search_admin_and_statement_date(self):
        for user in (self.candidate, self.staff, self.other_staff):
            self.create(user=user)
        self.db.add(Statement(user_id=self.staff.id, message="Test", created_at=datetime(2026, 10, 8, 8)))
        self.db.add(Statement(user_id=self.other_staff.id, message="Other day", created_at=datetime(2026, 10, 9, 8)))
        self.db.commit()
        self.assertEqual(self.filtered_ids(
            exam_date=date(2026, 10, 8), exam_morning=True,
            search="person", only_admins=True, statement_date=date(2026, 10, 8),
        ), [self.staff.id])

    def test_tbilisi_today_uses_georgian_midnight_not_utc_or_machine_date(self):
        for moment, expected in (
            (datetime(2026, 10, 7, 19, 59, 59, tzinfo=timezone.utc), date(2026, 10, 7)),
            (datetime(2026, 10, 7, 20, 0, 0, tzinfo=timezone.utc), date(2026, 10, 8)),
        ):
            class FrozenDateTime(datetime):
                @classmethod
                def now(cls, tz=None):
                    return moment.astimezone(tz)
            with self.subTest(moment=moment), patch.object(admin, "datetime", FrozenDateTime):
                self.assertEqual(admin._today_in_tbilisi(), expected)

    def test_http_filter_query_and_invalid_dates(self):
        self.create()
        self.create(period="evening", user=self.other_candidate)
        with self.client() as client:
            headers = {"Authorization": self.auth}
            response = client.get("/admin/users?exam_date=2026-10-08&exam_evening=true", headers=headers)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual([item["id"] for item in response.json()["items"]], [4])
            self.assertEqual(client.get("/admin/users?exam_date=2026-02-30", headers=headers).status_code, 422)
            self.assertEqual(client.get("/admin/users?exam_morning=invalid", headers=headers).status_code, 422)


class ExamScheduleMigrationTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="exam-schedule-migration-")
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "isolated.db"
        database = patch.object(migration, "SQLITE_PATH", str(self.path))
        database.start()
        self.addCleanup(database.stop)

    def create_legacy(self):
        with closing(sqlite3.connect(self.path)) as conn, conn:
            conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, exam_permission BOOLEAN)")
            conn.execute("INSERT INTO users VALUES (1, 'Unchanged', 0)")
            conn.execute("CREATE TABLE results (score INTEGER)")
            conn.execute("INSERT INTO results VALUES (97)")

    def test_idempotent_additive_migration_preserves_old_schema_and_records(self):
        self.create_legacy()
        with closing(sqlite3.connect(self.path)) as conn:
            before_schema = conn.execute("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()
            before_rows = {name: conn.execute(f'SELECT * FROM "{name}"').fetchall() for name, _ in before_schema}
        migration.run()
        with closing(sqlite3.connect(self.path)) as conn, conn:
            conn.execute("INSERT INTO exam_schedules VALUES (1, 1, '2026-10-08', 'morning', '2026-10-01 09:00:00')")
        migration.run()
        with closing(sqlite3.connect(self.path)) as conn:
            first_dump = list(conn.iterdump())
        migration.run()
        with closing(sqlite3.connect(self.path)) as conn:
            self.assertEqual(list(conn.iterdump()), first_dump)
            for name, sql in before_schema:
                self.assertEqual(conn.execute("SELECT sql FROM sqlite_master WHERE name=?", (name,)).fetchone(), (sql,))
                self.assertEqual(conn.execute(f'SELECT * FROM "{name}"').fetchall(), before_rows[name])
            indexes = {row[1] for row in conn.execute("PRAGMA index_list(exam_schedules)")}
            self.assertIn("ix_exam_schedules_user_id", indexes)
            self.assertIn("ix_exam_schedules_date_period_user", indexes)

    def test_migrated_table_enforces_duplicate_and_period_constraints(self):
        self.create_legacy()
        migration.run()
        with closing(sqlite3.connect(self.path)) as conn, conn:
            conn.execute("INSERT INTO exam_schedules VALUES (1, 1, '2026-10-08', 'morning', '2026-10-01 09:00:00')")
        for row in (
            (2, 1, "2026-10-08", "morning", "2026-10-01"),
            (3, 1, "2026-10-08", "night", "2026-10-01"),
        ):
            with closing(sqlite3.connect(self.path)) as conn, conn:
                with self.assertRaises(sqlite3.IntegrityError):
                    conn.execute("INSERT INTO exam_schedules VALUES (?, ?, ?, ?, ?)", row)

    def test_migrated_foreign_key_cascades_and_rejects_nonexistent_user(self):
        self.create_legacy()
        migration.run()
        with closing(sqlite3.connect(self.path)) as conn, conn:
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("INSERT INTO exam_schedules VALUES (1, 1, '2026-10-08', 'morning', '2026-10-01')")
            conn.execute("DELETE FROM users WHERE id=1")
            self.assertEqual(conn.execute("SELECT * FROM exam_schedules").fetchall(), [])
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute("INSERT INTO exam_schedules VALUES (2, 999, '2026-10-08', 'morning', '2026-10-01')")

    def test_migrated_table_never_reuses_deleted_schedule_identifiers(self):
        self.create_legacy()
        migration.run()
        with closing(sqlite3.connect(self.path)) as conn, conn:
            old_id = conn.execute(
                "INSERT INTO exam_schedules (user_id, exam_date, period, created_at) VALUES (1, '2026-01-01', 'morning', '2026-01-01')"
            ).lastrowid
            conn.execute("DELETE FROM exam_schedules WHERE id=?", (old_id,))
            new_id = conn.execute(
                "INSERT INTO exam_schedules (user_id, exam_date, period, created_at) VALUES (1, '2026-12-31', 'evening', '2026-01-01')"
            ).lastrowid
            self.assertGreater(new_id, old_id)
            conn.execute("DELETE FROM exam_schedules WHERE id=?", (old_id,))
            self.assertEqual(conn.execute("SELECT id FROM exam_schedules").fetchall(), [(new_id,)])

    def test_missing_database_and_missing_users_do_not_create_partial_tables(self):
        migration.run()
        self.assertFalse(self.path.exists())
        with closing(sqlite3.connect(self.path)) as conn, conn:
            conn.execute("CREATE TABLE sentinel (value TEXT)")
        migration.run()
        with closing(sqlite3.connect(self.path)) as conn:
            self.assertEqual(conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall(), [("sentinel",)])

    def test_migration_and_orm_definition_are_compatible(self):
        engine = create_engine(f"sqlite:///{self.path}")
        self.addCleanup(engine.dispose)
        Base.metadata.create_all(engine)
        migration.run()
        with Session(engine) as db:
            user = User(personal_id="00000000001", code="0000000001", first_name="Test", last_name="Person",
                        phone="555000001", email="test@example.test", password_hash="test")
            db.add(user)
            db.flush()
            db.add(ExamSchedule(user_id=user.id, exam_date=date(2026, 10, 8), period="morning"))
            db.commit()
        migration.run()
        with Session(engine) as db:
            self.assertEqual(db.scalar(select(ExamSchedule)).exam_date, date(2026, 10, 8))

    def test_concurrent_duplicate_requests_create_only_one_entry(self):
        engine = create_engine(f"sqlite:///{self.path}", connect_args={"check_same_thread": False, "timeout": 10})
        self.addCleanup(engine.dispose)
        Base.metadata.create_all(engine)
        with Session(engine) as db:
            db.add(User(id=1, personal_id="00000000001", code="0000000001", first_name="Test", last_name="Person",
                        phone="555000001", email="test@example.test", password_hash="test"))
            db.commit()
        barrier = Barrier(2)

        def attempt():
            with Session(engine) as db:
                barrier.wait(timeout=10)
                try:
                    exam_schedules.create_exam_schedule(
                        1, ExamScheduleCreate(exam_date="2026-10-08", period="morning"),
                        authorization="Bearer test", db=db,
                    )
                    return 201
                except HTTPException as error:
                    return error.status_code

        with patch.object(exam_schedules, "_require_admin"), ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _number: attempt(), range(2)))
        self.assertEqual(sorted(results), [201, 409])
        with Session(engine) as db:
            self.assertEqual(len(db.scalars(select(ExamSchedule)).all()), 1)


if __name__ == "__main__":
    unittest.main()
