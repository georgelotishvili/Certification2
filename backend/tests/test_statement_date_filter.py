from __future__ import annotations

from datetime import date, datetime, timedelta
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

try:
    from backend.app.models import Base, PlanningLetter, Statement, User
    from backend.app.routers import admin
except ModuleNotFoundError:
    from app.models import Base, PlanningLetter, Statement, User
    from app.routers import admin


class StatementDateFilterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.addCleanup(self.engine.dispose)
        self.addCleanup(self.db.close)
        self._next_user_id = 1

        auth = patch.object(admin, "_require_admin")
        auth.start()
        self.addCleanup(auth.stop)
        settings = patch.object(
            admin, "get_settings",
            return_value=SimpleNamespace(founder_admin_email="founder@example.test"),
        )
        settings.start()
        self.addCleanup(settings.stop)

    def add_user(self, *, name="Person", is_admin=False) -> User:
        user_id = self._next_user_id
        self._next_user_id += 1
        user = User(
            id=user_id,
            personal_id=f"{user_id:011d}",
            first_name=name,
            last_name=f"Family{user_id}",
            phone=f"555{user_id:06d}",
            email=f"person{user_id}@example.test",
            password_hash="unused-test-hash",
            code=f"{user_id:010d}",
            is_admin=is_admin,
            created_at=datetime(2026, 1, 1) + timedelta(minutes=user_id),
        )
        self.db.add(user)
        self.db.flush()
        return user

    def add_statement(self, user, created_at, *, seen=False) -> Statement:
        statement = Statement(
            user_id=user.id,
            message="Test statement",
            created_at=created_at,
            seen_at=created_at + timedelta(hours=1) if seen else None,
            seen_by="admin@example.test" if seen else None,
        )
        self.db.add(statement)
        self.db.flush()
        return statement

    def add_letter(
        self,
        user: User,
        *,
        kind: str = "exam",
        period: str | None = "morning",
        sent_at: datetime,
    ) -> PlanningLetter:
        req_id = f"req-{user.id}-{kind}-{period}-{int(sent_at.timestamp())}"
        letter = PlanningLetter(
            user_id=user.id,
            kind=kind,
            period=period,
            event_date=date(2026, 10, 20),
            event_time="11:00",
            request_id=req_id[:36],
            request_fingerprint=req_id[:64],
            to_email=user.email,
            subject="Test subject",
            body="Test letter",
            status="sent",
            created_by="admin@example.test",
            sent_at=sent_at,
            created_at=sent_at,
        )
        self.db.add(letter)
        self.db.flush()
        return letter

    def list_users(self, **kwargs):
        return admin.admin_users(authorization=None, db=self.db, **kwargs)

    def test_tbilisi_midnight_bounds_include_start_and_exclude_end(self):
        timestamps = (
            datetime(2026, 10, 7, 19, 59, 59, 999999),
            datetime(2026, 10, 7, 20),
            datetime(2026, 10, 8, 19, 59, 59, 999999),
            datetime(2026, 10, 8, 20),
        )
        users = [self.add_user() for _ in timestamps]
        for user, created_at in zip(users, timestamps):
            self.add_statement(user, created_at)

        result = self.list_users(statement_date=date(2026, 10, 8))

        self.assertEqual({item.id for item in result.items}, {users[1].id, users[2].id})
        self.assertEqual(result.total, 2)

    def test_date_includes_both_read_and_unread_statements(self):
        read_user = self.add_user()
        unread_user = self.add_user()
        self.add_user()  # A person with no statement must not match.
        self.add_statement(read_user, datetime(2026, 10, 8, 8), seen=True)
        self.add_statement(unread_user, datetime(2026, 10, 8, 8))

        result = self.list_users(statement_date=date(2026, 10, 8))
        items = {item.id: item for item in result.items}

        self.assertEqual(set(items), {read_user.id, unread_user.id})
        self.assertFalse(items[read_user.id].has_unseen_statements)
        self.assertTrue(items[unread_user.id].has_unseen_statements)

    def test_multiple_matching_statements_do_not_duplicate_users(self):
        user = self.add_user()
        self.add_statement(user, datetime(2026, 10, 8, 8))
        self.add_statement(user, datetime(2026, 10, 8, 12), seen=True)
        # Red-border counts retain their existing all-dates meaning.
        self.add_statement(user, datetime(2026, 10, 7, 8))

        result = self.list_users(statement_date=date(2026, 10, 8))

        self.assertEqual([item.id for item in result.items], [user.id])
        self.assertEqual(result.total, 1)
        self.assertEqual(result.items[0].unseen_statement_count, 2)

    def test_date_combines_with_search_and_admin_filter(self):
        matching_admin = self.add_user(name="Target", is_admin=True)
        matching_nonadmin = self.add_user(name="Target")
        other_admin = self.add_user(name="Other", is_admin=True)
        wrong_day_admin = self.add_user(name="Target", is_admin=True)
        for user in (matching_admin, matching_nonadmin, other_admin):
            self.add_statement(user, datetime(2026, 10, 8, 8), seen=True)
        self.add_statement(wrong_day_admin, datetime(2026, 10, 9, 8))

        result = self.list_users(
            statement_date=date(2026, 10, 8), search="target", only_admins=True
        )

        self.assertEqual([item.id for item in result.items], [matching_admin.id])
        self.assertTrue(result.items[0].is_admin)
        self.assertTrue(result.items[0].exam_permission)

    def test_without_date_existing_list_and_unread_metadata_are_preserved(self):
        no_statement = self.add_user()
        read_user = self.add_user()
        unread_user = self.add_user()
        self.add_statement(read_user, datetime(2026, 10, 1, 8), seen=True)
        self.add_statement(unread_user, datetime(2026, 10, 8, 8))

        result = self.list_users()

        self.assertEqual(
            [item.id for item in result.items],
            [unread_user.id, read_user.id, no_statement.id],
        )
        self.assertEqual(result.total, 3)
        self.assertEqual(
            [item.id for item in result.items if item.has_unseen_statements],
            [unread_user.id],
        )

    def test_day_with_no_matching_statements_is_empty(self):
        user = self.add_user()
        self.add_statement(user, datetime(2026, 10, 8, 8))

        result = self.list_users(statement_date=date(2026, 10, 9))

        self.assertEqual(result.items, [])
        self.assertEqual(result.total, 0)

    def test_unrepresentable_utc_date_returns_validation_error(self):
        with self.assertRaises(HTTPException) as caught:
            self.list_users(statement_date=date.min)

        self.assertEqual(caught.exception.status_code, 422)

    def test_all_statements_filter_orders_by_statement_date_and_filters_by_day(self):
        no_stmt_user = self.add_user(name="NoStmt")
        early_reg_late_stmt = self.add_user(name="EarlyReg")
        late_reg_early_stmt = self.add_user(name="LateReg")
        st1 = self.add_statement(late_reg_early_stmt, datetime(2026, 10, 5, 10), seen=True)
        st1.answered_at = datetime(2026, 10, 5, 12)
        self.add_statement(early_reg_late_stmt, datetime(2026, 10, 8, 10))
        self.db.flush()

        all_res = self.list_users(all_statements=True, sort="date_desc")
        self.assertEqual(
            [item.id for item in all_res.items],
            [early_reg_late_stmt.id, late_reg_early_stmt.id],
        )
        self.assertNotIn(no_stmt_user.id, [item.id for item in all_res.items])

        dated_res = self.list_users(
            all_statements=True, statement_date=date(2026, 10, 5), sort="date_desc"
        )
        self.assertEqual([item.id for item in dated_res.items], [late_reg_early_stmt.id])

    def test_sent_letter_filters_and_sent_date(self):
        u_none = self.add_user(name="NoLetter")
        u_exam = self.add_user(name="ExamLetter")
        u_rej = self.add_user(name="RejLetter")
        u_cert = self.add_user(name="CertLetter")
        u_fail = self.add_user(name="FailLetter")
        u_cust = self.add_user(name="CustomLetter")

        self.add_letter(u_exam, kind="exam", period="morning", sent_at=datetime(2026, 10, 10, 8))
        self.add_letter(u_rej, kind="exam", period="rejection", sent_at=datetime(2026, 10, 11, 8))
        self.add_letter(u_cert, kind="certificate", period="morning", sent_at=datetime(2026, 10, 12, 8))
        self.add_letter(u_fail, kind="exam", period="exam_fail", sent_at=datetime(2026, 10, 13, 8))
        self.add_letter(u_cust, kind="exam", period="custom", sent_at=datetime(2026, 10, 14, 8))

        self.assertEqual([u.id for u in self.list_users(sent_exam_letter=True).items], [u_exam.id])
        self.assertEqual([u.id for u in self.list_users(sent_rejection_letter=True).items], [u_rej.id])
        self.assertEqual([u.id for u in self.list_users(sent_certificate_letter=True).items], [u_cert.id])
        self.assertEqual([u.id for u in self.list_users(sent_fail_letter=True).items], [u_fail.id])
        self.assertEqual([u.id for u in self.list_users(sent_custom_letter=True).items], [u_cust.id])

        # Combining multiple sent-letter checkboxes returns matching users ordered by latest sent_at
        combined = self.list_users(
            sent_exam_letter=True, sent_custom_letter=True, sort="date_desc"
        )
        self.assertEqual([u.id for u in combined.items], [u_cust.id, u_exam.id])
        self.assertNotIn(u_none.id, [u.id for u in combined.items])

        # Date alone filters all users who received any letter on that date
        by_date = self.list_users(sent_letter_date=date(2026, 10, 12))
        self.assertEqual([u.id for u in by_date.items], [u_cert.id])


if __name__ == "__main__":
    unittest.main()

