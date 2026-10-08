from __future__ import annotations

from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path
import sqlite3
import tempfile
from threading import Barrier
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

try:
    from backend.app.models import Base, User, UserExamStageGrant
    from backend.app.services.exam_stage import (
        STAGE_PROJECT_1,
        STAGE_PROJECT_2,
        STAGE_THEORY,
    )
    from backend.app.services.exam_stage_grants import (
        completion_grant,
        consume_stage_permission,
        exam_state_with_permissions,
        expire_unused_stage_permissions,
        grant_stage_permission,
        require_stage_permission,
        revoke_stage_permission,
    )
    from backend.scripts import migrate_exam_stage_grants as migration
except ModuleNotFoundError:
    from app.models import Base, User, UserExamStageGrant
    from app.services.exam_stage import STAGE_PROJECT_1, STAGE_PROJECT_2, STAGE_THEORY
    from app.services.exam_stage_grants import (
        completion_grant,
        consume_stage_permission,
        exam_state_with_permissions,
        expire_unused_stage_permissions,
        grant_stage_permission,
        require_stage_permission,
        revoke_stage_permission,
    )
    from scripts import migrate_exam_stage_grants as migration


def _user(number: int, *, is_admin: bool = False) -> User:
    return User(
        id=number,
        personal_id=f"{number:011d}",
        first_name="Test",
        last_name="Person",
        phone=f"555{number:06d}",
        email=f"person{number}@example.test",
        password_hash="unused",
        code=f"{number:010d}",
        is_admin=is_admin,
    )


class ExamStageGrantServiceTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine(
            "sqlite:///:memory:",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine, autoflush=False)
        self.addCleanup(self.engine.dispose)
        self.addCleanup(self.db.close)
        self.user = _user(1)
        self.db.add(self.user)
        self.db.commit()

    def test_three_grants_are_independent_and_legacy_never_projects_all(self):
        grants = [
            grant_stage_permission(self.db, self.user, stage)
            for stage in (STAGE_THEORY, STAGE_PROJECT_1, STAGE_PROJECT_2)
        ]
        self.db.commit()
        state = exam_state_with_permissions(self.db, self.user)
        self.assertEqual(set(state["exam_stage_permissions"]), {
            STAGE_THEORY, STAGE_PROJECT_1, STAGE_PROJECT_2,
        })
        self.assertTrue(all(item["granted"] for item in state["exam_stage_permissions"].values()))
        self.assertNotEqual(state["exam_stage"], "all")
        self.assertEqual(len({grant.id for grant in grants}), 3)

    def test_started_grant_survives_window_and_only_exact_stage_is_consumed(self):
        old = datetime.utcnow() - timedelta(hours=2)
        theory = grant_stage_permission(self.db, self.user, STAGE_THEORY)
        require_stage_permission(
            self.db, self.user, STAGE_THEORY, mark_started=True, grant_id=theory.id
        )
        theory.expires_at = old
        project = grant_stage_permission(self.db, self.user, STAGE_PROJECT_1)
        self.db.commit()
        state = exam_state_with_permissions(self.db, self.user)
        theory_item = state["exam_stage_permissions"][STAGE_THEORY]
        self.assertEqual(theory_item["status"], "started")
        self.assertFalse(theory_item["granted"])
        self.assertEqual(theory_item["grant_id"], theory.id)
        self.assertIsNone(theory_item["remaining_seconds"])
        self.assertEqual(
            require_stage_permission(self.db, self.user, STAGE_THEORY, grant_id=theory.id).id,
            theory.id,
        )
        consume_stage_permission(
            self.db, self.user, STAGE_THEORY, grant_id=theory.id
        )
        self.db.commit()
        completed_item = exam_state_with_permissions(self.db, self.user)[
            "exam_stage_permissions"
        ][STAGE_THEORY]
        self.assertEqual(completed_item["status"], "completed")
        self.assertFalse(completed_item["granted"])
        self.assertEqual(completed_item["grant_id"], theory.id)
        self.db.refresh(project)
        self.assertIsNone(project.consumed_at)
        self.assertIsNone(
            self.db.scalar(select(UserExamStageGrant).where(
                UserExamStageGrant.user_id == self.user.id,
                UserExamStageGrant.stage == STAGE_PROJECT_2,
            ))
        )

    def test_late_revoked_result_cannot_consume_new_generation(self):
        old = grant_stage_permission(self.db, self.user, STAGE_PROJECT_1)
        require_stage_permission(
            self.db, self.user, STAGE_PROJECT_1, mark_started=True, grant_id=old.id
        )
        revoke_stage_permission(self.db, self.user, STAGE_PROJECT_1)
        new = grant_stage_permission(self.db, self.user, STAGE_PROJECT_1)
        consume_stage_permission(
            self.db, self.user, STAGE_PROJECT_1, grant_id=old.id
        )
        self.db.commit()
        self.db.refresh(new)
        self.assertIsNone(new.consumed_at)
        self.assertEqual(completion_grant(
            self.db, self.user, STAGE_PROJECT_1, old.id
        ).id, old.id)
        with self.assertRaises(HTTPException):
            require_stage_permission(
                self.db, self.user, STAGE_PROJECT_1, grant_id=old.id
            )

    def test_admin_has_full_virtual_map_without_persisted_grants(self):
        admin = _user(2, is_admin=True)
        self.db.add(admin)
        self.db.commit()
        state = exam_state_with_permissions(self.db, admin)
        self.assertEqual(state["exam_stage"], "all")
        self.assertTrue(all(item["granted"] for item in state["exam_stage_permissions"].values()))
        self.assertEqual(self.db.scalars(select(UserExamStageGrant).where(
            UserExamStageGrant.user_id == admin.id
        )).all(), [])


class ExamStageGrantConcurrencyTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="stage-grant-race-")
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "isolated.db"
        self.engine = create_engine(
            f"sqlite:///{self.path}",
            connect_args={"check_same_thread": False, "timeout": 10},
        )
        self.addCleanup(self.engine.dispose)
        Base.metadata.create_all(self.engine)
        with Session(self.engine, autoflush=False) as db:
            db.add(_user(1))
            db.commit()

    def test_simultaneous_identical_grants_both_resolve_to_one_row(self):
        barrier = Barrier(2)

        def issue() -> int:
            with Session(self.engine, autoflush=False) as db:
                user = db.get(User, 1)
                barrier.wait(timeout=10)
                grant = grant_stage_permission(db, user, STAGE_THEORY)
                db.commit()
                return int(grant.id)

        with ThreadPoolExecutor(max_workers=2) as pool:
            ids = list(pool.map(lambda _item: issue(), range(2)))
        self.assertEqual(ids[0], ids[1])
        with Session(self.engine, autoflush=False) as db:
            grants = db.scalars(select(UserExamStageGrant)).all()
            self.assertEqual(len(grants), 1)

    def test_stale_session_refreshes_started_generation_under_transition_lock(self):
        with Session(
            self.engine, autoflush=False, expire_on_commit=False
        ) as stale_db:
            stale_user = stale_db.get(User, 1)
            stale_grant = grant_stage_permission(
                stale_db, stale_user, STAGE_THEORY
            )
            stale_db.commit()
            self.assertIsNone(stale_grant.started_at)

            with Session(self.engine, autoflush=False) as writer_db:
                writer_user = writer_db.get(User, 1)
                require_stage_permission(
                    writer_db,
                    writer_user,
                    STAGE_THEORY,
                    mark_started=True,
                    grant_id=stale_grant.id,
                )
                writer_db.commit()

            # Prove the first Session still holds the pre-start snapshot.  The
            # grant service must refresh it only after obtaining the row lock.
            self.assertIsNone(stale_grant.started_at)
            with self.assertRaises(HTTPException) as raised:
                grant_stage_permission(stale_db, stale_user, STAGE_THEORY)
            self.assertEqual(raised.exception.status_code, 409)

    def test_start_and_expire_race_cannot_leave_both_flags_set(self):
        base = datetime.utcnow()
        with Session(self.engine, autoflush=False) as db:
            user = db.get(User, 1)
            grant = grant_stage_permission(db, user, STAGE_THEORY, now=base)
            grant.expires_at = base + timedelta(seconds=30)
            db.commit()
            grant_id = grant.id

        barrier = Barrier(2)

        def start() -> str:
            with Session(self.engine, autoflush=False) as db:
                user = db.get(User, 1)
                barrier.wait(timeout=10)
                try:
                    require_stage_permission(
                        db, user, STAGE_THEORY, mark_started=True,
                        grant_id=grant_id,
                    )
                    db.commit()
                    return "started"
                except HTTPException:
                    db.rollback()
                    return "denied"

        def expire() -> str:
            with Session(self.engine, autoflush=False) as db:
                user = db.get(User, 1)
                barrier.wait(timeout=10)
                expire_unused_stage_permissions(
                    db,
                    user,
                    now=base + timedelta(seconds=60),
                    commit=True,
                )
                return "expired"

        with ThreadPoolExecutor(max_workers=2) as pool:
            start_future = pool.submit(start)
            expire_future = pool.submit(expire)
            outcomes = {start_future.result(), expire_future.result()}
        self.assertIn("expired", outcomes)
        with Session(self.engine, autoflush=False) as db:
            grant = db.get(UserExamStageGrant, grant_id)
            self.assertFalse(
                grant.started_at is not None and grant.expired_at is not None
            )
            self.assertEqual(
                grant.started_at is not None,
                grant.expired_at is None,
            )


class ExamStageGrantMigrationTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="stage-grant-migration-")
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "isolated.db"
        db_patch = patch.object(migration, "SQLITE_PATH", str(self.path))
        db_patch.start()
        self.addCleanup(db_patch.stop)

    def _legacy_database(self):
        now = datetime.utcnow().replace(microsecond=0)
        future = now + timedelta(minutes=40)
        preload_end = now + timedelta(hours=2)
        past = now - timedelta(minutes=40)
        with closing(sqlite3.connect(self.path)) as conn, conn:
            conn.execute(
                """CREATE TABLE users (
                    id INTEGER PRIMARY KEY, is_admin INTEGER, exam_permission INTEGER,
                    exam_stage TEXT, exam_stage_expires_at DATETIME,
                    exam_stage_started_at DATETIME
                )"""
            )
            conn.executemany(
                "INSERT INTO users VALUES (?, 0, ?, ?, ?, ?)",
                [
                    (1, 1, STAGE_PROJECT_1, str(future), None),
                    (2, 0, "none", None, None),
                    (3, 1, STAGE_THEORY, str(future), str(now)),
                    (4, 1, STAGE_PROJECT_2, str(past), None),
                    (5, 0, "none", None, None),
                ],
            )
            conn.execute(
                """CREATE TABLE sessions (
                    id INTEGER PRIMARY KEY, user_id INTEGER, started_at DATETIME,
                    ends_at DATETIME, finished_at DATETIME, active INTEGER
                )"""
            )
            conn.executemany(
                "INSERT INTO sessions VALUES (?, ?, ?, ?, NULL, ?)",
                [
                    (1, 2, str(now - timedelta(minutes=10)), str(future), 1),
                    (2, 3, str(now), str(preload_end), 0),
                    (3, 5, str(now), str(future), 0),
                ],
            )
        return now, future

    def test_backfill_is_idempotent_and_preserves_started_vs_prepared_state(self):
        _now, future = self._legacy_database()
        migration.run()
        with closing(sqlite3.connect(self.path)) as conn:
            conn.row_factory = sqlite3.Row
            grants = conn.execute(
                "SELECT * FROM user_exam_stage_grants ORDER BY user_id, id"
            ).fetchall()
            by_user = {int(row["user_id"]): row for row in grants}
            self.assertEqual(_as_dt(by_user[1]["expires_at"]), future)
            self.assertIsNotNone(by_user[2]["started_at"])
            self.assertIsNone(by_user[3]["started_at"])
            self.assertEqual(_as_dt(by_user[3]["expires_at"]), future)
            self.assertIsNotNone(by_user[4]["expired_at"])
            self.assertIsNotNone(by_user[5]["revoked_at"])
            bindings = conn.execute(
                "SELECT id, stage_grant_id FROM sessions ORDER BY id"
            ).fetchall()
            self.assertTrue(all(row["stage_grant_id"] is not None for row in bindings))
            first_dump = list(conn.iterdump())
        migration.run()
        with closing(sqlite3.connect(self.path)) as conn:
            self.assertEqual(list(conn.iterdump()), first_dump)


def _as_dt(value: object) -> datetime:
    return datetime.fromisoformat(str(value))


if __name__ == "__main__":
    unittest.main()
