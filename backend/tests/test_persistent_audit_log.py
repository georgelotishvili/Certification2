"""Synthetic opt-in journal contracts; no production data, SMTP or network.

Set the import-time database to a private temporary path before app imports.
Every test uses its own in-memory database, without application startup.
"""
import os
import sys
import tempfile

sys.dont_write_bytecode = True
_import_dir = tempfile.TemporaryDirectory(prefix="gipc-audit-import-")
os.environ["GIPC_DATABASE_PATH"] = os.path.join(_import_dir.name, "unused.db")

import json
import unittest
from contextlib import ExitStack
from datetime import date, datetime, timedelta
from unittest.mock import patch
from uuid import uuid4

from sqlalchemy import create_engine, delete, event, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from backend.app import database
from backend.app.models import (
    AuditEvent, Base, Certificate, Exam, PlanningLetter, Statement, User,
    UserSession, UserExamStageGrant, Session as ExamSession,
)
from backend.app.services.audit_log import enable_audit, record_reused_login, set_audit_actor
from backend.scripts.migrate_audit_events import run as migrate_audit


class PersistentAuditTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        self.addCleanup(self.engine.dispose)
        Base.metadata.create_all(self.engine)
        migrate_audit(self.engine)
        self.db = Session(self.engine, autoflush=False)
        self.addCleanup(self.db.close)
        def forbid_default(*_):
            raise AssertionError("Default application DB is forbidden in this synthetic test")
        event.listen(database.engine, "connect", forbid_default)
        self.addCleanup(event.remove, database.engine, "connect", forbid_default)
        self.patches = ExitStack()
        self.addCleanup(self.patches.close)
        for name in ("smtplib.SMTP", "smtplib.SMTP_SSL", "socket.create_connection"):
            self.patches.enter_context(patch(name, side_effect=AssertionError("Network forbidden")))
        self.admin = self.make_user(1, True)
        self.candidate = self.make_user(2)
        enable_audit(self.db)
        set_audit_actor(self.db, self.admin)

    def make_user(self, number, is_admin=False):
        user = User(personal_id=f"9990000{number:04d}", first_name="Synthetic", last_name="Only",
                    phone="555000000", email=f"synthetic-{number}@example.invalid",
                    code=f"999000{number:04d}", password_hash="SENSITIVE_PASSWORD_HASH",
                    is_admin=is_admin)
        self.db.add(user); self.db.commit()
        return user

    def events(self, category=None):
        statement = select(AuditEvent).order_by(AuditEvent.id)
        if category:
            statement = statement.where(AuditEvent.category == category)
        return list(self.db.scalars(statement))

    def make_statement(self):
        statement = Statement(user_id=self.candidate.id, message="SENSITIVE_STATEMENT_BODY")
        self.db.add(statement); self.db.commit()
        return statement

    def test_statement_history_records_actor_before_after_and_survives_source_delete(self):
        statement = self.make_statement()
        source_id = statement.id
        statement.seen_at = datetime(2026, 11, 4, 8, 0)
        self.db.commit()
        statement.answered_at = datetime(2026, 11, 4, 9, 0)
        self.db.commit()
        self.db.delete(statement); self.db.commit()
        events = self.events("statement")
        self.assertEqual([x.action for x in events], ["statements.created", "statements.updated", "statements.updated", "statements.deleted"])
        self.assertEqual({x.actor_id for x in events}, {self.admin.id})
        self.assertEqual({x.target_id for x in events}, {source_id})
        delta = json.loads(events[1].details)
        self.assertEqual(delta["seen_at"], {"before": None, "after": "2026-11-04T08:00:00Z"})
        self.assertNotIn("message", "".join(x.details for x in events))
        self.assertIsNone(self.db.get(Statement, source_id))

    def test_bulk_seen_and_deleted_source_keep_history(self):
        statement = self.make_statement()
        self.db.execute(update(Statement).where(Statement.id == statement.id).values(seen_at=datetime(2026, 11, 4)))
        self.db.commit()
        self.db.execute(delete(Statement).where(Statement.id == statement.id)); self.db.commit()
        events = self.events("statement")
        self.assertEqual([x.action for x in events], ["statements.created", "statements.updated", "statements.deleted"])
        self.assertEqual(json.loads(events[1].details)["seen_at"]["before"], None)

    def test_atomic_rollback_removes_event_and_source_mutation(self):
        statement = self.make_statement()
        before = len(self.events())
        statement.answered_at = datetime.utcnow(); self.db.flush()
        self.assertEqual(len(self.events()), before + 1)
        self.db.rollback()
        self.assertEqual(len(self.events()), before)
        self.assertIsNone(self.db.get(Statement, statement.id).answered_at)
        statement.seen_at = datetime.utcnow(); self.db.commit()
        self.assertEqual(len(self.events()), before + 1)

    def test_auth_login_reuse_logout_and_heartbeat_are_distinct(self):
        set_audit_actor(self.db, self.candidate)
        session = UserSession(user_id=self.candidate.id, token="SENSITIVE_TOKEN",
                              expires_at=datetime.utcnow() + timedelta(days=1), client_type="desktop",
                              device_id="SENSITIVE_DEVICE_ID")
        self.db.add(session); self.db.commit()
        self.assertEqual(self.events("auth")[-1].action, "user_sessions.created")
        session.last_used_at = datetime.utcnow(); self.db.commit()
        self.assertEqual(len(self.events("auth")), 1)
        record_reused_login(self.db, session); self.db.commit()
        self.db.info["audit_logout_session_id"] = session.id
        self.db.delete(session); self.db.commit()
        auth = self.events("auth")
        self.assertEqual([x.action for x in auth], ["user_sessions.created", "auth.login", "auth.logout"])
        self.assertEqual({x.actor_id for x in auth}, {self.candidate.id})
        serialized = json.dumps([x.details for x in auth])
        self.assertNotIn("SENSITIVE", serialized)
        self.assertNotIn("token", serialized)
        self.assertNotIn("device_id", serialized)

    def test_certificate_previous_status_and_deleted_account_are_not_erased(self):
        cert = Certificate(user_id=self.candidate.id, status="active", level="architect", file_path="SENSITIVE_FILE_PATH")
        self.db.add(cert); self.db.commit()
        cert.status = "suspended"; self.db.commit()
        stored = [(x.id, x.occurred_at, x.actor_label, x.details) for x in self.events("certificate")]
        self.candidate.first_name = "CHANGED_NAME"; self.db.commit()
        self.db.delete(self.candidate); self.db.commit()
        surviving = [(x.id, x.occurred_at, x.actor_label, x.details) for x in self.events("certificate")]
        self.assertEqual(surviving[:2], stored)
        self.assertEqual(json.loads(stored[1][3])["status"], {"before": "active", "after": "suspended"})
        self.assertNotIn("SENSITIVE", str(surviving))

    def test_real_letter_statuses_never_mislabel_failure_or_save_as_sent(self):
        for status in ("sending", "failed", "simulated", "uncertain", "sent"):
            letter = PlanningLetter(user_id=self.candidate.id, kind="certificate", event_date=date(2026, 11, 4),
                                    event_time="10:00", request_id=str(uuid4()), request_fingerprint="synthetic",
                                    to_email="SENSITIVE_EMAIL", subject="SENSITIVE_SUBJECT", body="SENSITIVE_BODY",
                                    created_by="SENSITIVE_CREATOR_EMAIL", status=status)
            self.db.add(letter); self.db.commit()
        self.assertEqual([x.action for x in self.events("letter")], ["letter.sending", "letter.failed", "letter.simulated", "letter.uncertain", "letter.sent"])
        self.assertNotIn("SENSITIVE", str([x.details for x in self.events("letter")]))

    def test_exam_lifecycle_records_minimal_state_not_questions_or_answers(self):
        grant = UserExamStageGrant(user_id=self.candidate.id, stage="theory", expires_at=datetime.utcnow() + timedelta(hours=1))
        exam = Exam(title="Synthetic only")
        self.db.add_all([grant, exam]); self.db.commit()
        grant.started_at = datetime.utcnow()
        session = ExamSession(exam_id=exam.id, user_id=self.candidate.id, stage_grant_id=grant.id,
                              token="SENSITIVE_EXAM_TOKEN", ends_at=datetime.utcnow() + timedelta(hours=1),
                              selected_map="SENSITIVE_SELECTIONS", exam_snapshot="SENSITIVE_CORRECT_ANSWERS")
        self.db.add(session); self.db.commit()
        count = len(self.events())
        session.selected_map = "MORE_SENSITIVE_SELECTIONS"; self.db.commit()
        self.assertEqual(len(self.events()), count)
        session.active = False; session.finished_at = datetime.utcnow(); session.score_percent = 82
        grant.consumed_at = datetime.utcnow(); self.db.commit()
        actions = [x.action for x in self.events()]
        self.assertIn("grant.started", actions); self.assertIn("grant.consumed", actions); self.assertIn("exam.finished", actions)
        self.assertNotIn("SENSITIVE", str([x.details for x in self.events()]))

    def test_opt_out_sessions_are_not_intercepted(self):
        with Session(self.engine) as other:
            other.add(Statement(user_id=self.candidate.id, message="synthetic import")); other.commit()
        self.assertEqual(self.events("statement"), [])

    def test_append_only_sqlite_triggers_reject_rewrites_and_deletions(self):
        event_id = self.events()[0].id
        for command in (update(AuditEvent).where(AuditEvent.id == event_id).values(action="rewritten"),
                        delete(AuditEvent).where(AuditEvent.id == event_id)):
            with self.assertRaises(IntegrityError):
                self.db.execute(command)
            self.db.rollback()
        self.assertEqual(self.events()[0].action, "journal.started")

    def test_migration_is_idempotent_and_does_not_reconstruct_fake_old_history(self):
        migrate_audit(self.engine); migrate_audit(self.engine)
        self.assertEqual(len(self.events()), 1)
        self.assertEqual(self.events()[0].action, "journal.started")
        self.assertEqual(self.events("registration"), [])


class PersistentAuditAPITests(unittest.TestCase):
    make_user = PersistentAuditTests.make_user

    def setUp(self):
        PersistentAuditTests.setUp(self)
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from backend.app.routers import admin
        from backend.tests.admin_mfa_fixtures import add_admin_mfa_elevation, install_mfa_settings
        install_mfa_settings(self)
        add_admin_mfa_elevation(self.db, self.admin.id, "synthetic-admin-token")
        self.db.add_all([
            UserSession(user_id=self.admin.id, token="synthetic-admin-token", expires_at=datetime.utcnow() + timedelta(days=1)),
            UserSession(user_id=self.candidate.id, token="synthetic-candidate-token", expires_at=datetime.utcnow() + timedelta(days=1)),
        ])
        self.db.commit()
        application = FastAPI()
        application.include_router(admin.router, prefix="/admin")
        def isolated_db():
            with Session(self.engine, autoflush=False) as db:
                enable_audit(db)
                yield db
        application.dependency_overrides[database.get_db] = isolated_db
        self.client = TestClient(application)
        self.addCleanup(self.client.close)

    def get(self, params=None, token="synthetic-admin-token"):
        return self.client.get("/admin/audit-logs", params=params or {},
                               headers={"Authorization": "Bearer " + token} if token else {})

    def seed(self, count, *, day=datetime(2026, 11, 4, 8), details="synthetic", category="exam"):
        rows = [dict(occurred_at=day, category=category, action="exam.finished", actor_id=self.admin.id,
                     actor_label=f"Synthetic administrator #{self.admin.id}", target_type="sessions",
                     target_id=index, target_label=f"Synthetic event {index}", details=details) for index in range(count)]
        self.db.execute(AuditEvent.__table__.insert(), rows); self.db.commit()

    def test_admin_required_and_query_bounds_validated(self):
        self.assertEqual(self.get(token="").status_code, 401)
        self.assertEqual(self.get(token="synthetic-candidate-token").status_code, 401)
        self.assertEqual(self.get(token="invalid").status_code, 401)
        self.assertEqual(self.get().status_code, 200)
        for params in ({"limit": 0}, {"limit": 1001}, {"before_id": 0}, {"snapshot_id": -1}, {"search": "x" * 301}):
            self.assertEqual(self.get(params).status_code, 422, params)
        self.assertEqual(self.get({"date": "2026-99-99"}).status_code, 400)

    def test_old_filtered_events_are_not_lost_behind_per_table_caps(self):
        self.seed(1, day=datetime(2020, 1, 1, 8), details="old unique 100% _ literal")
        self.seed(1105)
        response = self.get({"category": "exam", "search": "old unique", "date": "2020-01-01", "limit": 1})
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["total"], 1)
        self.assertIn("old unique", body["items"][0]["details"])
        self.assertEqual(self.get({"category": "exam", "search": "100% _"}).json()["total"], 1)
        self.assertEqual(self.get({"category": "exam", "search": "%"}).json()["total"], 1)
        self.assertTrue(body["coverage_note"])
        self.assertTrue(body["journal_started_at"])

    def test_full_export_pagination_freezes_snapshot_and_has_no_loss_or_duplicates(self):
        self.seed(1105)
        first = self.get({"category": "exam", "limit": 1000}).json()
        self.assertEqual(first["total"], 1105)
        self.assertEqual(len(first["items"]), 1000)
        self.assertIsNotNone(first["next_cursor"])
        self.seed(1, details="NEW_EVENT_AFTER_SNAPSHOT")
        second = self.get({"category": "exam", "limit": 1000, "snapshot_id": first["snapshot_id"], "before_id": first["next_cursor"]}).json()
        self.assertEqual(second["total"], 1105)
        self.assertEqual(second["snapshot_id"], first["snapshot_id"])
        self.assertEqual(len(second["items"]), 105)
        self.assertIsNone(second["next_cursor"])
        ids = [x["event_id"] for x in first["items"] + second["items"]]
        self.assertEqual(len(set(ids)), 1105)
        self.assertEqual(ids, sorted(ids, reverse=True))
        self.assertNotIn("NEW_EVENT_AFTER_SNAPSHOT", str(first) + str(second))
        self.assertEqual(self.get({"category": "exam"}).json()["total"], 1106)

    def test_tbilisi_date_boundaries_are_half_open(self):
        for timestamp in (datetime(2026, 11, 3, 19, 59, 59), datetime(2026, 11, 3, 20),
                          datetime(2026, 11, 4, 19, 59, 59), datetime(2026, 11, 4, 20)):
            self.seed(1, day=timestamp)
        body = self.get({"category": "exam", "date": "2026-11-04"}).json()
        self.assertEqual(body["total"], 2)
        self.assertEqual({x["timestamp"] for x in body["items"]}, {"2026-11-03T20:00:00Z", "2026-11-04T19:59:59Z"})

    def test_pagination_reads_only_journal_and_auth_not_all_domain_payloads(self):
        self.seed(1105)
        statements = []
        def collect(_conn, _cursor, sql, _params, _context, _many):
            statements.append(sql.lower())
        event.listen(self.engine, "before_cursor_execute", collect)
        self.addCleanup(event.remove, self.engine, "before_cursor_execute", collect)
        response = self.get({"category": "exam", "limit": 1})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["items"]), 1)
        combined = "\n".join(statements)
        self.assertNotIn("exam_snapshot", combined)
        self.assertNotIn("from statements", combined)
        self.assertNotIn("from certificates", combined)
        self.assertNotIn("from planning_letters", combined)
        journal_rows = [x for x in statements if "from audit_events" in x and "order by audit_events.id desc" in x]
        self.assertEqual(len(journal_rows), 1)
        self.assertIn("limit", journal_rows[0])


if __name__ == "__main__":
    unittest.main()
