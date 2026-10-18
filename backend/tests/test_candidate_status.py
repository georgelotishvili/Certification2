from __future__ import annotations

from datetime import date, datetime, timedelta
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

try:
    from backend.app.database import get_db
    from backend.app.models import (
        Base,
        Certificate,
        Exam,
        ExamSchedule,
        MultiApartmentEvaluation,
        MultiApartmentProject,
        MultiFunctionalEvaluation,
        MultiFunctionalProject,
        PlanningLetter,
        Session as ExamSession,
        Statement,
        User,
        UserSession,
    )
    from backend.app.routers import admin, exam_schedules, planning_letters, users
    from backend.app.schemas import CertificateCreate, ExamScheduleCreate
    from backend.app.services.candidate_status import (
        parse_statement_category,
        resolve_passed_category,
    )
except ModuleNotFoundError:
    from app.database import get_db
    from app.models import (
        Base,
        Certificate,
        Exam,
        ExamSchedule,
        MultiApartmentEvaluation,
        MultiApartmentProject,
        MultiFunctionalEvaluation,
        MultiFunctionalProject,
        PlanningLetter,
        Session as ExamSession,
        Statement,
        User,
        UserSession,
    )
    from app.routers import admin, exam_schedules, planning_letters, users
    from app.schemas import CertificateCreate, ExamScheduleCreate
    from app.services.candidate_status import (
        parse_statement_category,
        resolve_passed_category,
    )


def enable_foreign_keys(connection, _record):
    connection.execute("PRAGMA foreign_keys=ON")


class CandidateStatusLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine(
            "sqlite:///:memory:",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        event.listen(self.engine, "connect", enable_foreign_keys)
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.addCleanup(self.engine.dispose)
        self.addCleanup(self.db.close)

        settings = patch.object(
            admin,
            "get_settings",
            return_value=SimpleNamespace(founder_admin_email="founder@example.test"),
        )
        settings.start()
        self.addCleanup(settings.stop)

        self.candidate = self.add_user(1)
        self.staff = self.add_user(2, is_admin=True)
        self.auth = "Bearer token-2"

    def add_user(self, number: int, **overrides) -> User:
        fields = dict(
            id=number,
            personal_id=f"{number:011d}",
            first_name=f"Person{number}",
            last_name="Family",
            phone=f"555{number:06d}",
            email=f"person{number}@example.test",
            password_hash="unused-test-hash",
            code=f"{number:010d}",
        )
        fields.update(overrides)
        user = User(**fields)
        self.db.add(user)
        self.db.flush()
        self.db.add(
            UserSession(
                user_id=user.id,
                token=f"token-{number}",
                expires_at=datetime.utcnow() + timedelta(hours=1),
            )
        )
        self.db.commit()
        return user

    def client(self) -> TestClient:
        app = FastAPI()
        app.include_router(admin.router, prefix="/admin")
        app.include_router(exam_schedules.router, prefix="/admin")
        app.include_router(planning_letters.router, prefix="/admin")
        app.include_router(users.router, prefix="/users")

        def test_db():
            yield self.db

        app.dependency_overrides[get_db] = test_db
        return TestClient(app)

    def test_parse_statement_category_all_five_options(self):
        self.assertEqual(
            parse_statement_category("☑ 1) კატეგორია A — შენობა-ნაგებობის არქიტექტორი"),
            "A",
        )
        self.assertEqual(
            parse_statement_category(
                "☑ 2) კატეგორია C ან A (ქულების ან გამოცდილების/განათლების შესაბამისად) — ... (კატეგორია A)"
            ),
            "C_A",
        )
        self.assertEqual(
            parse_statement_category(
                "☑ 3) კატეგორია B ან A (ქულების შესაბამისად) — ... (კატეგორია A)"
            ),
            "B_A",
        )
        self.assertEqual(
            parse_statement_category("☑ 4) კატეგორია B — არქიტექტურული პროექტის შემსწავლელი სპეციალისტი"),
            "B",
        )
        self.assertEqual(
            parse_statement_category("☑ 5) კატეგორია C — არქიტექტურული პროექტის ექსპერტი"),
            "C",
        )

    def test_resolve_passed_category_rules(self):
        self.assertEqual(resolve_passed_category("A", "pass_a"), "A")
        self.assertEqual(resolve_passed_category("A", "pass_bc"), "A")
        self.assertIsNone(resolve_passed_category("B", "pass_a"))
        self.assertEqual(resolve_passed_category("B", "pass_bc"), "B")
        self.assertIsNone(resolve_passed_category("C", "pass_a"))
        self.assertEqual(resolve_passed_category("C", "pass_bc"), "C")
        self.assertEqual(resolve_passed_category("B_A", "pass_a"), "A")
        self.assertEqual(resolve_passed_category("B_A", "pass_bc"), "B")
        self.assertEqual(resolve_passed_category("C_A", "pass_a"), "A")
        self.assertEqual(resolve_passed_category("C_A", "pass_bc"), "C")
        self.assertIsNone(resolve_passed_category("C_A", "fail"))

    def test_full_candidate_lifecycle_and_filters(self):
        client = self.client()
        headers = {"Authorization": self.auth}

        # 1. Submit an exam admission statement requesting C_A
        stmt = Statement(
            user_id=self.candidate.id,
            message="სერტიფიცირების განაცხადი\n☑ 2) კატეგორია C ან A (ქულების ან გამოცდილების/განათლების შესაბამისად) — (კატეგორია A)",
            created_at=datetime.utcnow() - timedelta(days=2),
        )
        self.db.add(stmt)
        self.db.commit()

        # 2. Schedule an exam via planning-letters (save_only) -> becomes exam_candidate with C_A
        res = client.post(
            f"/admin/users/{self.candidate.id}/planning-letters",
            headers=headers,
            data={
                "kind": "exam",
                "action_mode": "save_only",
                "event_date": "2026-10-20",
                "event_time": "10:00",
                "period": "morning",
                "subject": "გამოცდაზე დაშვება",
                "body": "ტექსტი",
                "request_id": "11111111-1111-4111-8111-111111111111",
                "expected_to_email": self.candidate.email,
                "confirmed": "true",
            },
        )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertEqual(payload["user_candidate_status"], "exam_candidate")
        self.assertEqual(payload["user_candidate_category"], "C_A")

        # Verify filter qualification=exam_candidate returns the user
        list_res = client.get("/admin/users?paginated=true&page=1&qualification=exam_candidate", headers=headers)
        self.assertEqual(list_res.status_code, 200)
        data = list_res.json()
        self.assertEqual(data["global_exam_candidates"], 1)
        self.assertEqual(data["global_cert_candidates"], 0)
        self.assertEqual([u["id"] for u in data["items"]], [self.candidate.id])

        # 3. Complete 3 exam stages with pass_a scores (e.g. 72% on stage1, 75% on stage2, 75% on stage3)
        exam_obj = Exam(id=1, title="Test Exam", duration_minutes=60, gate_password="pass")
        ma_proj = MultiApartmentProject(id=1, number=1, code="MA-1")
        mf_proj = MultiFunctionalProject(id=1, number=1, code="MF-1")
        self.db.add_all([exam_obj, ma_proj, mf_proj])
        self.db.flush()
        now = datetime.utcnow()
        self.db.add(
            ExamSession(
                user_id=self.candidate.id,
                exam_id=exam_obj.id,
                token="session-token-1",
                candidate_first_name="Person1",
                candidate_last_name="Family",
                candidate_code=self.candidate.code,
                started_at=now - timedelta(minutes=30),
                ends_at=now + timedelta(minutes=30),
                finished_at=now - timedelta(minutes=10),
                active=False,
                score_percent=72.0,
            )
        )
        self.db.add(
            MultiApartmentEvaluation(
                user_id=self.candidate.id,
                project_id=ma_proj.id,
                project_code="MA-1",
                project_name="MA Project 1",
                percentage=75.0,
                wrong_count=1,
                created_at=now - timedelta(minutes=5),
            )
        )
        self.db.add(
            MultiFunctionalEvaluation(
                user_id=self.candidate.id,
                project_id=mf_proj.id,
                project_code="MF-1",
                project_name="MF Project 1",
                percentage=75.0,
                wrong_count=1,
                created_at=now - timedelta(minutes=1),
            )
        )
        self.db.commit()

        # Fetching /admin/users automatically transitions C_A + pass_a -> cert_candidate with category A!
        list_res2 = client.get("/admin/users?paginated=true&page=1&qualification=cert_candidate", headers=headers)
        self.assertEqual(list_res2.status_code, 200)
        data2 = list_res2.json()
        self.assertEqual(data2["global_exam_candidates"], 0)
        self.assertEqual(data2["global_cert_candidates"], 1)
        self.assertEqual(len(data2["items"]), 1)
        self.assertEqual(data2["items"][0]["candidate_status"], "cert_candidate")
        self.assertEqual(data2["items"][0]["candidate_category"], "A")

        # 4. Simulate 30-day payment expiry after certificate handover letter
        handover_letter = PlanningLetter(
            user_id=self.candidate.id,
            kind="certificate",
            event_date=date(2026, 9, 1),
            event_time="10:00",
            period="morning",
            request_id="22222222-2222-4222-8222-222222222222",
            request_fingerprint="fp-2",
            to_email=self.candidate.email,
            subject="სერტიფიკატის გადაცემა",
            body="ტექსტი",
            status="sent",
            created_by="staff@example.test",
            sent_at=now - timedelta(days=31),
            created_at=now - timedelta(days=31),
        )
        self.db.add(handover_letter)
        # Ensure candidate_updated_at is before the 30-day expiry mark
        self.db.refresh(self.candidate)
        self.candidate.candidate_updated_at = now - timedelta(days=31)
        self.db.commit()

        list_res3 = client.get("/admin/users?paginated=true&page=1", headers=headers)
        self.assertEqual(list_res3.status_code, 200)
        data3 = list_res3.json()
        self.assertEqual(data3["global_cert_candidates"], 0)
        cand_item = next(u for u in data3["items"] if u["id"] == self.candidate.id)
        self.assertIsNone(cand_item["candidate_status"])

        # 5. Manual admin re-activation via PATCH /admin/users/{id}/candidate-status
        patch_res = client.patch(
            f"/admin/users/{self.candidate.id}/candidate-status",
            headers=headers,
            json={"candidate_status": "cert_candidate", "candidate_category": "C"},
        )
        self.assertEqual(patch_res.status_code, 200, patch_res.text)
        self.assertEqual(patch_res.json()["candidate_status"], "cert_candidate")
        self.assertEqual(patch_res.json()["candidate_category"], "C")

        # 6. Activating a certificate clears candidate_status and candidate_category
        cert_res = client.post(
            f"/users/{self.candidate.id}/certificate",
            headers=headers,
            json={
                "unique_code": self.candidate.code,
                "level": "expert",
                "status": "active",
                "issue_date": "2026-10-18",
                "validity_term": 5,
                "valid_until": "2031-10-18",
                "send_notification": False,
            },
        )
        self.assertEqual(cert_res.status_code, 201, cert_res.text)
        self.db.refresh(self.candidate)
        self.assertIsNone(self.candidate.candidate_status)
        self.assertIsNone(self.candidate.candidate_category)


if __name__ == "__main__":
    unittest.main()
