from __future__ import annotations

from datetime import date, datetime, timedelta
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

try:
    from backend.app.models import Base, Statement, User, UserSession
    from backend.app.routers import admin, statements
    from backend.app.schemas import (
        AdminUserUpdateRequest,
        StatementAnsweredRequest,
        StatementSeenRequest,
    )
    from backend.scripts import migrate_statements_answered as migration
except ModuleNotFoundError:
    from app.models import Base, Statement, User, UserSession
    from app.routers import admin, statements
    from app.schemas import AdminUserUpdateRequest, StatementAnsweredRequest, StatementSeenRequest
    from scripts import migrate_statements_answered as migration


class StatementAnsweredTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.addCleanup(self.engine.dispose)
        self.addCleanup(self.db.close)
        settings = patch.object(
            admin, "get_settings",
            return_value=SimpleNamespace(founder_admin_email="founder@example.test"),
        )
        settings.start()
        self.addCleanup(settings.stop)
        self.candidate = self.add_user(1)
        self.staff = self.add_user(2, is_admin=True)
        self.other_staff = self.add_user(3, is_admin=True)
        self.other_candidate = self.add_user(4)
        self.founder = self.add_user(5, email="founder@example.test")
        self.auth = "Bearer token-2"

    def add_user(self, user_id, *, is_admin=False, email=None):
        user = User(
            id=user_id,
            personal_id=f"{user_id:011d}",
            first_name=f"Person{user_id}",
            last_name="Family",
            phone=f"555{user_id:06d}",
            email=email or f"person{user_id}@example.test",
            password_hash="unused-test-hash",
            code=f"{user_id:010d}",
            is_admin=is_admin,
        )
        self.db.add(user)
        self.db.flush()
        self.db.add(UserSession(
            user_id=user_id,
            token=f"token-{user_id}",
            expires_at=datetime.utcnow() + timedelta(hours=1),
        ))
        self.db.commit()
        return user

    def add_statement(self, *, user=None, seen=False, created_at=None):
        statement = Statement(
            user_id=(user or self.candidate).id,
            message="Persistent original statement",
            created_at=created_at or datetime.utcnow(),
            seen_at=datetime(2026, 1, 1) if seen else None,
            seen_by="first-reader@example.test" if seen else None,
            attachment_path="statements/unchanged.pdf",
            attachment_filename="unchanged.pdf",
            attachment_size_bytes=42,
        )
        self.db.add(statement)
        self.db.commit()
        return statement

    def set_answered(self, statement, answered=True, authorization=None):
        return admin.admin_set_statement_answered(
            statement_id=statement.id,
            payload=StatementAnsweredRequest(answered=answered),
            authorization=authorization or self.auth,
            db=self.db,
        )

    def state(self, user=None, **kwargs):
        selected_user = user or self.candidate
        result = admin.admin_users(authorization=self.auth, db=self.db, **kwargs)
        return next(item for item in result.items if item.id == selected_user.id)

    def mark_seen(self, *statement_ids, authorization=None):
        admin.admin_mark_statements_seen(
            StatementSeenRequest(statement_ids=list(statement_ids)),
            authorization=authorization or self.auth,
            db=self.db,
        )

    def assert_counts(self, state, unseen, pending):
        self.assertEqual(state.unseen_statement_count, unseen)
        self.assertEqual(state.has_unseen_statements, unseen > 0)
        self.assertEqual(state.pending_statement_count, pending)
        self.assertEqual(state.has_pending_statements, pending > 0)

    def test_unread_read_answered_and_new_statement_restart_independently(self):
        statement = self.add_statement()
        self.assert_counts(self.state(), 1, 0)
        self.mark_seen(statement.id)
        self.assert_counts(self.state(), 0, 1)
        response = self.set_answered(statement)
        self.assert_counts(response, 0, 0)
        self.assert_counts(self.state(), 0, 0)

        # Exercise the real submission path: no default read/answer state.
        created = statements.create_statement(
            message="Another application", attachment=None,
            authorization="Bearer token-1", db=self.db,
        )
        self.assertNotEqual(created.id, statement.id)
        self.assert_counts(self.state(), 1, 0)
        self.mark_seen(created.id)
        self.assert_counts(self.state(), 0, 1)
        self.assert_counts(self.set_answered(self.db.get(Statement, created.id)), 0, 0)
        self.assertIsNotNone(self.db.get(Statement, statement.id).answered_at)

    def test_multiple_statements_and_other_person_are_not_bulk_answered(self):
        first = self.add_statement(seen=True)
        second = self.add_statement(seen=True)
        unread = self.add_statement()
        other = self.add_statement(user=self.other_candidate, seen=True)

        response = self.set_answered(first)

        self.assert_counts(response, 1, 1)
        self.db.refresh(second)
        self.db.refresh(unread)
        self.db.refresh(other)
        self.assertIsNone(second.answered_at)
        self.assertIsNone(unread.seen_at)
        self.assertIsNone(other.answered_at)
        self.assert_counts(self.state(self.other_candidate), 0, 1)

    def test_unchecking_returns_read_statement_to_pending(self):
        statement = self.add_statement(seen=True)
        original_seen = statement.seen_at
        self.set_answered(statement)

        response = self.set_answered(statement, False)

        self.assert_counts(response, 0, 1)
        self.assertIsNone(response.statement.answered_at)
        self.assertIsNone(response.statement.answered_by)
        self.assertEqual(response.statement.seen_at, original_seen)
        self.assertEqual(response.statement.seen_by, "first-reader@example.test")

    def test_unchecking_an_unread_statement_does_not_silently_read_it(self):
        response = self.set_answered(self.add_statement(), False)
        self.assert_counts(response, 1, 0)
        self.assertIsNone(response.statement.seen_at)

    def test_answering_unread_marks_only_that_statement_read(self):
        statement = self.add_statement()
        self.add_statement()

        response = self.set_answered(statement)

        self.assert_counts(response, 1, 0)
        self.assertEqual(response.statement.seen_at, response.statement.answered_at)
        self.assertEqual(response.statement.seen_by, self.staff.email)
        self.assertEqual(response.statement.answered_by, self.staff.email)

    def test_repeated_answer_preserves_first_answer_and_reader(self):
        statement = self.add_statement(seen=True)
        first = self.set_answered(statement)
        second = self.set_answered(statement, authorization="Bearer token-3")

        self.assertEqual(second.statement.answered_at, first.statement.answered_at)
        self.assertEqual(second.statement.answered_by, self.staff.email)
        self.assertEqual(second.statement.seen_at, datetime(2026, 1, 1))
        self.assertEqual(second.statement.seen_by, "first-reader@example.test")

    def test_stale_admin_session_does_not_overwrite_first_answer(self):
        statement = self.add_statement()
        with Session(self.engine) as other_db:
            stale = other_db.get(Statement, statement.id)
            self.assertIsNone(stale.answered_at)
            first = self.set_answered(statement)
            second = admin.admin_set_statement_answered(
                stale.id, StatementAnsweredRequest(answered=True),
                authorization="Bearer token-3", db=other_db,
            )
            self.assertEqual(second.statement.answered_at, first.statement.answered_at)
            self.assertEqual(second.statement.answered_by, self.staff.email)
            self.assertEqual(second.statement.seen_at, first.statement.seen_at)
            self.assertEqual(second.statement.seen_by, self.staff.email)

    def test_mark_seen_preserves_read_and_answered_metadata_and_new_arrivals(self):
        read = self.add_statement(seen=True)
        answered = self.add_statement()
        response = self.set_answered(answered)
        unseen = self.add_statement()
        later = self.add_statement()

        self.mark_seen(read.id, answered.id, unseen.id, authorization="Bearer token-3")

        self.db.refresh(read)
        self.db.refresh(answered)
        self.db.refresh(unseen)
        self.db.refresh(later)
        self.assertEqual(read.seen_by, "first-reader@example.test")
        self.assertEqual(read.seen_at, datetime(2026, 1, 1))
        self.assertEqual(answered.seen_at, response.statement.seen_at)
        self.assertEqual(answered.answered_at, response.statement.answered_at)
        self.assertEqual(unseen.seen_by, self.other_staff.email)
        self.assertIsNone(later.seen_at)
        self.assert_counts(self.state(), 1, 2)

    def test_admin_authorization_required_and_founder_not_required(self):
        statement = self.add_statement()
        for authorization in (None, "", "Basic invalid", "Bearer unknown", "Bearer token-1"):
            with self.subTest(authorization=authorization):
                with self.assertRaises(HTTPException) as caught:
                    admin.admin_set_statement_answered(
                        statement.id, StatementAnsweredRequest(answered=True),
                        authorization=authorization, db=self.db,
                    )
                self.assertEqual(caught.exception.status_code, 401)
        self.db.refresh(statement)
        self.assertIsNone(statement.answered_at)
        self.assertIsNotNone(self.set_answered(statement).statement.answered_at)
        self.set_answered(statement, False)
        self.assertIsNotNone(self.set_answered(statement, authorization="Bearer token-5").statement.answered_at)

    def test_expired_token_cannot_answer(self):
        statement = self.add_statement()
        session = self.db.query(UserSession).filter_by(token="token-2").one()
        session.expires_at = datetime.utcnow() - timedelta(seconds=1)
        self.db.commit()

        with self.assertRaises(HTTPException) as caught:
            self.set_answered(statement)

        self.assertEqual(caught.exception.status_code, 401)
        self.db.refresh(statement)
        self.assertIsNone(statement.answered_at)

    def test_missing_statement_is_404(self):
        with self.assertRaises(HTTPException) as caught:
            admin.admin_set_statement_answered(
                99999, StatementAnsweredRequest(answered=True),
                authorization=self.auth, db=self.db,
            )
        self.assertEqual(caught.exception.status_code, 404)

    def test_date_filter_includes_answered_and_uses_global_state_counts(self):
        answered = self.add_statement(seen=True, created_at=datetime(2026, 10, 8, 8))
        self.set_answered(answered)
        self.add_statement(seen=True, created_at=datetime(2026, 10, 7, 8))
        self.add_statement(created_at=datetime(2026, 10, 9, 8))

        self.assert_counts(self.state(statement_date=date(2026, 10, 8)), 1, 1)
        staff_state = self.state(self.staff)
        self.assertTrue(staff_state.is_admin)
        self.assertTrue(staff_state.exam_permission)

    def test_statement_list_and_user_update_keep_persistent_answer_state(self):
        statement = self.add_statement(seen=True)
        response = self.set_answered(statement)
        other = self.add_statement(seen=True)
        result = admin.admin_user_statements(
            self.candidate.id, authorization=self.auth, db=self.db,
        )
        item = next(item for item in result.items if item.id == statement.id)
        self.assertEqual(item.answered_at, response.statement.answered_at)
        self.assertEqual(item.answered_by, self.staff.email)
        self.assertEqual(item.message, "Persistent original statement")
        self.assertEqual(item.attachment_filename, "unchanged.pdf")
        self.assertIsNone(next(item for item in result.items if item.id == other.id).answered_at)
        updated = admin.admin_update_user(
            self.candidate.id, AdminUserUpdateRequest(first_name="Updated"),
            authorization="Bearer token-5", db=self.db,
        )
        self.assert_counts(updated, 0, 1)

    def test_patch_contract_and_required_boolean(self):
        app = FastAPI()
        app.include_router(admin.router, prefix="/admin")
        operation = app.openapi()["paths"]["/admin/statements/{statement_id}/answered"]["patch"]
        self.assertIn("200", operation["responses"])
        self.assertTrue(operation["requestBody"]["required"])
        with self.assertRaises(ValidationError):
            StatementAnsweredRequest()
        with self.assertRaises(ValidationError):
            StatementAnsweredRequest(answered="not-a-boolean")


class StatementAnsweredMigrationTests(unittest.TestCase):
    def test_migration_twice_preserves_statements_files_and_other_tables(self):
        with tempfile.TemporaryDirectory(prefix="statement-answer-test-") as directory:
            db_path = Path(directory) / "isolated.db"
            attachment_path = Path(directory) / "statement.pdf"
            attachment_path.write_bytes(b"unchanged attachment bytes")
            with closing(sqlite3.connect(db_path)) as conn, conn:
                conn.execute("CREATE TABLE statements (id INTEGER PRIMARY KEY, message TEXT, seen_at DATETIME, seen_by TEXT, attachment_path TEXT)")
                conn.execute("CREATE TABLE sentinel (value TEXT)")
                conn.execute("INSERT INTO sentinel VALUES ('do not touch')")
                conn.execute("INSERT INTO statements VALUES (1, 'original read', '2026-10-08 08:00:00', 'reader', ?)", (str(attachment_path),))
                conn.execute("INSERT INTO statements VALUES (2, 'original unread', NULL, NULL, NULL)")

            with patch.object(migration, "SQLITE_PATH", str(db_path)):
                migration.run()
                migration.run()

            with closing(sqlite3.connect(db_path)) as conn, conn:
                rows = conn.execute("SELECT * FROM statements ORDER BY id").fetchall()
                self.assertEqual(rows, [
                    (1, "original read", "2026-10-08 08:00:00", "reader", str(attachment_path), None, None),
                    (2, "original unread", None, None, None, None, None),
                ])
                self.assertEqual(conn.execute("SELECT value FROM sentinel").fetchall(), [("do not touch",)])
                conn.execute("UPDATE statements SET answered_at='2026-10-08 09:00:00', answered_by='admin' WHERE id=1")
            with patch.object(migration, "SQLITE_PATH", str(db_path)):
                migration.run()
            with closing(sqlite3.connect(db_path)) as conn, conn:
                self.assertEqual(conn.execute("SELECT answered_at, answered_by FROM statements WHERE id=1").fetchone(), ("2026-10-08 09:00:00", "admin"))
            self.assertEqual(attachment_path.read_bytes(), b"unchanged attachment bytes")

    def test_missing_database_and_missing_table_are_safe_no_ops(self):
        with tempfile.TemporaryDirectory(prefix="statement-answer-test-") as directory:
            db_path = Path(directory) / "isolated.db"
            with patch.object(migration, "SQLITE_PATH", str(db_path)):
                migration.run()
                self.assertFalse(db_path.exists())
                with closing(sqlite3.connect(db_path)) as conn, conn:
                    conn.execute("CREATE TABLE sentinel (value TEXT)")
                migration.run()
            with closing(sqlite3.connect(db_path)) as conn, conn:
                self.assertEqual(conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall(), [("sentinel",)])


if __name__ == "__main__":
    unittest.main()
