"""Opt-in admin pagination and live polling: isolated in-memory data only."""
from datetime import date, datetime, timedelta
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

try:
    from backend.app.models import Base, User, Statement, Certificate, ExamSchedule, UserSession
    from backend.app.database import get_db
    from backend.app.routers import admin
except ModuleNotFoundError:
    from app.models import Base, User, Statement, Certificate, ExamSchedule, UserSession
    from app.database import get_db
    from app.routers import admin


class AdminUserPaginationTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:",
                                    connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.addCleanup(self.engine.dispose)
        self.addCleanup(self.db.close)
        settings = patch.object(admin, "get_settings", return_value=SimpleNamespace(
            founder_admin_email="founder@example.test"))
        settings.start()
        self.addCleanup(settings.stop)
        self.staff = self.user(1000, is_admin=True)
        self.db.add(UserSession(user_id=self.staff.id, token="staff-test-token",
                                expires_at=datetime.utcnow() + timedelta(hours=1)))
        self.db.commit()

    def user(self, number, **overrides):
        fields = dict(id=number, personal_id=f"{number:011d}", first_name=f"Person{number}",
                      last_name="Family", phone=f"555{number:06d}",
                      email=f"person{number}@example.test", code=f"{number:010d}",
                      password_hash="not-a-real-hash", created_at=datetime(2026, 1, 1))
        fields.update(overrides)
        user = User(**fields)
        self.db.add(user)
        self.db.flush()
        return user

    def statement(self, user, *, seen=False, answered=False, when=None):
        when = when or datetime(2026, 10, 8, 8)
        row = Statement(user_id=user.id, message="Test only", created_at=when,
                        seen_at=when if seen else None, answered_at=when if answered else None)
        self.db.add(row)
        self.db.flush()
        return row

    def certificate(self, user, level, status="active"):
        self.db.add(Certificate(user_id=user.id, level=level, status=status))
        self.db.flush()

    def schedule(self, user, day, period):
        self.db.add(ExamSchedule(user_id=user.id, exam_date=day, period=period))
        self.db.flush()

    def list(self, **kwargs):
        return admin.admin_users(db=self.db, authorization="Bearer staff-test-token",
                                 **{"paginated": True, "sort": "date_asc", **kwargs})

    @staticmethod
    def ids(response):
        return [item["id"] for item in response["items"]]

    def test_default_page_bounded_and_all_pages_include_every_user_once(self):
        for number in range(1, 121):
            self.user(number)
        first = self.list()
        self.assertEqual(first["total"], 121)
        self.assertEqual(first["size"], 50)
        self.assertEqual(self.ids(first), list(range(1, 51)))
        self.assertEqual(self.ids(self.list(page=2)), list(range(51, 101)))
        self.assertEqual(self.ids(self.list(page=3)), list(range(101, 121)) + [1000])
        self.assertEqual(self.list(page=999)["page"], 3)
        self.assertEqual(len(self.list(size=9999)["items"]), 100)
        self.assertEqual(self.list(page=-1, size=0)["page"], 1)

    def test_legacy_call_ignores_page_limit_and_keeps_original_shape(self):
        for number in range(1, 61):
            self.user(number)
        result = self.list(paginated=False, page=2, size=5)
        self.assertEqual(len(result.items), 61)
        self.assertEqual(set(result.model_dump()), {"items", "total"})
        self.assertNotIn("display_revision", result.items[0].model_dump())

    def test_search_and_qualification_apply_before_page_limit(self):
        for number in range(1, 65):
            user = self.user(number)
            self.certificate(user, "municipal" if number > 60 else "architect")
        self.assertEqual(self.ids(self.list(qualification="municipal", size=2)), [61, 62])
        self.assertEqual(self.ids(self.list(qualification="municipal", size=2, page=2)), [63, 64])
        self.assertEqual(self.list(qualification="municipal")["total"], 4)
        self.assertEqual(self.ids(self.list(search="Person64", qualification="municipal")), [64])
        self.assertEqual(self.ids(self.list(search="0000000064")), [64])

    def test_qualification_types_and_legacy_architect_alias_keep_existing_semantics(self):
        for number, level in enumerate(("architect", "architect_expert", "expert", "municipal"), 1):
            self.certificate(self.user(number), level, status="suspended")
        self.assertEqual(self.ids(self.list(qualification="architect")), [1, 2])
        self.assertEqual(self.ids(self.list(qualification="expert")), [3])
        self.assertEqual(self.ids(self.list(qualification="municipal")), [4])
        self.assertEqual(self.ids(self.list(qualification="certified")), [1, 3, 4])
        with self.assertRaises(HTTPException) as caught:
            self.list(qualification="invalid")
        self.assertEqual(caught.exception.status_code, 422)

    def test_red_blue_union_and_date_override_count_before_pagination(self):
        red, blue, mixed, answered = [self.user(number) for number in range(1, 5)]
        self.statement(red)
        self.statement(blue, seen=True)
        self.statement(mixed)
        self.statement(mixed, seen=True)
        self.statement(answered, seen=True, answered=True)
        self.assertEqual(self.ids(self.list(new_statements=True)), [1, 3])
        self.assertEqual(self.ids(self.list(pending_statements=True)), [2])
        combined = self.list(new_statements=True, pending_statements=True, size=2)
        self.assertEqual(combined["total"], 3)
        self.assertEqual(self.ids(combined), [1, 2])
        self.assertEqual(self.ids(self.list(new_statements=True, pending_statements=True, size=2, page=2)), [3])
        for new in (True, False):
            for pending in (True, False):
                dated = self.list(new_statements=new, pending_statements=pending,
                                  statement_date=date(2026, 10, 8))
                self.assertEqual(self.ids(dated), [1, 2, 3, 4])

    def test_all_filters_combine_without_silently_excluding_later_candidates(self):
        for number in range(1, 61):
            self.user(number)
        match = self.user(61, is_admin=True)
        wrong_group = self.user(62, is_admin=True)
        for user in (match, wrong_group):
            self.statement(user, seen=True)
            self.certificate(user, "municipal")
        self.schedule(match, date(2025, 9, 1), "morning")
        self.schedule(wrong_group, date(2025, 9, 1), "evening")
        result = self.list(search="Person", only_admins=True, qualification="municipal",
                           pending_statements=True, exam_morning=True, exam_date=date(2025, 9, 1), size=1)
        self.assertEqual(self.ids(result), [61])
        self.assertEqual(result["total"], 1)

    def test_exam_date_default_is_tbilisi_and_history_future_supported(self):
        morning, evening = self.user(1), self.user(2)
        self.schedule(morning, date(2026, 10, 8), "morning")
        self.schedule(evening, date(2026, 10, 8), "evening")
        self.schedule(morning, date(2027, 1, 1), "evening")
        with patch.object(admin, "_today_in_tbilisi", return_value=date(2026, 10, 8)):
            self.assertEqual(self.ids(self.list(exam_morning=True)), [1])
            self.assertEqual(self.ids(self.list(exam_evening=True)), [2])
            self.assertEqual(self.ids(self.list(exam_evening=True, exam_morning=True)), [1, 2])
        self.assertEqual(self.ids(self.list(exam_date=date(2027, 1, 1))), [1])

    def test_live_is_compact_and_global_badge_includes_off_page_filtered_users(self):
        for number in range(1, 61):
            self.user(number)
        self.statement(self.db.get(User, 60))
        result = self.list(live=True, size=2, search="Person1")
        self.assertEqual(result["global_unseen_users"], 1)
        self.assertEqual(len(result["items"]), 2)
        self.assertEqual(set(result["items"][0]), {
            "id", "exam_permission", "has_unseen_statements", "unseen_statement_count",
            "has_pending_statements", "pending_statement_count", "display_revision",
        })
        self.assertEqual(result["items"][0]["display_revision"],
                         self.list(size=2, search="Person1")["items"][0]["display_revision"])

    def test_live_revision_changes_for_profile_and_certificate_not_statement_color(self):
        user = self.user(1)
        initial = self.list(live=True)["items"][0]["display_revision"]
        self.statement(user)
        self.assertEqual(initial, self.list(live=True)["items"][0]["display_revision"])
        user.first_name = "Changed"
        changed = self.list(live=True)["items"][0]["display_revision"]
        self.assertNotEqual(initial, changed)
        self.certificate(user, "expert")
        self.db.expire(user, ["certificate"])
        self.assertNotEqual(changed, self.list(live=True)["items"][0]["display_revision"])

    def test_live_membership_follows_read_reply_new_statement_and_user_deletion(self):
        person = self.user(1)
        statement = self.statement(person)
        self.assertEqual(self.ids(self.list(live=True, new_statements=True)), [1])
        statement.seen_at = datetime.utcnow()
        self.assertEqual(self.ids(self.list(live=True, new_statements=True)), [])
        self.assertEqual(self.ids(self.list(live=True, pending_statements=True)), [1])
        statement.answered_at = datetime.utcnow()
        self.assertEqual(self.ids(self.list(live=True, pending_statements=True)), [])
        self.statement(person)
        self.assertEqual(self.ids(self.list(live=True, new_statements=True)), [1])
        self.db.delete(person)
        self.db.flush()
        self.assertEqual(self.ids(self.list(live=True, new_statements=True)), [])

    def test_compact_poll_only_expiry_checks_current_page_not_whole_population(self):
        for number in range(1, 81):
            self.user(number)
        with patch.object(admin, "expire_if_unused", return_value=False) as expire:
            self.list(live=True, size=10, page=2)
        self.assertEqual(expire.call_count, 10)

    def test_admin_founder_and_manual_exam_permissions_unchanged(self):
        self.user(1, exam_permission=False)
        self.user(2, is_admin=True, exam_permission=False)
        self.user(3, email="founder@example.test", exam_permission=False)
        items = {item["id"]: item for item in self.list(live=True)["items"]}
        self.assertFalse(items[1]["exam_permission"])
        self.assertTrue(items[2]["exam_permission"])
        self.assertTrue(items[3]["exam_permission"])

    def test_new_modes_remain_admin_only(self):
        for params in ({"paginated": True}, {"paginated": True, "live": True}):
            with self.assertRaises(HTTPException) as caught:
                admin.admin_users(db=self.db, authorization=None, **params)
            self.assertEqual(caught.exception.status_code, 401)

    def test_http_endpoint_serializes_legacy_full_and_compact_responses(self):
        self.user(1)
        app = FastAPI()
        app.include_router(admin.router, prefix="/admin")
        app.dependency_overrides[get_db] = lambda: self.db
        with TestClient(app) as client:
            headers = {"Authorization": "Bearer staff-test-token"}
            legacy = client.get("/admin/users", headers=headers)
            self.assertEqual(legacy.status_code, 200)
            self.assertEqual(set(legacy.json()), {"items", "total"})
            full = client.get("/admin/users?paginated=true&size=1", headers=headers)
            self.assertEqual(full.status_code, 200)
            self.assertEqual(full.json()["total"], 2)
            self.assertEqual(len(full.json()["items"]), 1)
            live = client.get("/admin/users?paginated=true&size=1&live=true", headers=headers)
            self.assertEqual(live.status_code, 200)
            self.assertNotIn("email", live.json()["items"][0])
            self.assertNotIn("password_hash", full.text)
            denied = client.get("/admin/users?paginated=true&live=true")
            self.assertEqual(denied.status_code, 401)


if __name__ == "__main__":
    unittest.main()
