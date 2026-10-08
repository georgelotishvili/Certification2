"""HTTP contracts for independent stages; all data lives in an in-memory DB."""
from datetime import datetime, timedelta
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from backend.app.database import get_db
from backend.app.models import (
    Base, User, UserSession, UserExamStageGrant, Exam, Block, Question, Option,
    Session as ExamSession, MultiApartmentProject, MultiApartmentAnswer,
    MultiApartmentEvaluation, MultiFunctionalProject, MultiFunctionalAnswer,
    MultiFunctionalEvaluation,
)
from backend.app.routers import admin, auth, exam, users, multi_apartment, multi_functional
from backend.app.services import exam_stage, exam_stage_grants


STAGES = ("theory", "project_stage_1", "project_stage_2")


class IndependentStageHTTPTests(unittest.TestCase):
    def enterContext(self, context):
        # The deployed/backend environment still supports Python 3.10.
        result = context.__enter__()
        self.addCleanup(context.__exit__, None, None, None)
        return result

    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:",
                                    connect_args={"check_same_thread": False}, poolclass=StaticPool)
        event.listen(self.engine, "connect", lambda conn, _: conn.execute("PRAGMA foreign_keys=ON"))
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine, autoflush=False)
        self.addCleanup(self.engine.dispose)
        self.addCleanup(self.db.close)
        settings = SimpleNamespace(founder_admin_email="founder@example.com")
        for module in (admin, users, auth, exam_stage):
            self.enterContext(patch.object(module, "get_settings", return_value=settings))
        for number, is_admin, email in ((1, False, "candidate@example.com"),
                                        (2, True, "staff@example.com"),
                                        (3, False, "founder@example.com")):
            self.db.add(User(id=number, personal_id=f"{number:011d}", code=f"{number:010d}",
                             first_name="Synthetic", last_name=str(number), phone="555000001",
                             email=email, password_hash="test-only", is_admin=is_admin))
        self.db.flush()
        for number in (1, 2, 3):
            self.db.add(UserSession(user_id=number, token=f"synthetic-{number}",
                                    expires_at=datetime.utcnow() + timedelta(days=1)))
        self.db.add(Exam(id=1, title="Synthetic theory", duration_minutes=90))
        self.db.flush()
        self.db.add(Block(id=1, exam_id=1, title="Synthetic block", qty=1))
        self.db.flush()
        self.db.add(Question(id=1, block_id=1, code="Q-TEST", text="Synthetic question"))
        self.db.flush()
        self.db.add(Option(id=1, question_id=1, text="Correct", is_correct=True))
        for project_type, answer_type, code in (
            (MultiApartmentProject, MultiApartmentAnswer, "P-APARTMENT"),
            (MultiFunctionalProject, MultiFunctionalAnswer, "P-FUNCTIONAL"),
        ):
            self.db.add(project_type(id=1, number=1, code=code))
            self.db.flush()
            self.db.add(answer_type(id=1, project_id=1, text="Correct", is_correct=True))
        self.db.commit()
        application = FastAPI()
        for router, prefix in ((admin.router, "/admin"), (auth.router, "/auth"),
                               (users.router, "/users"), (exam.router, "/exam"),
                               (multi_apartment.router, ""), (multi_functional.router, "")):
            application.include_router(router, prefix=prefix)

        def isolated_db():
            try:
                yield self.db
            finally:
                self.db.rollback()

        application.dependency_overrides[get_db] = isolated_db
        self.client = self.enterContext(TestClient(application))

    def headers(self, actor=1):
        return {"Authorization": f"Bearer synthetic-{actor}"}

    def grant(self, stage, granted=True, user=1, **extra):
        response = self.client.patch(f"/admin/users/{user}/exam-stage-permissions/{stage}",
                                     headers=self.headers(2),
                                     json={"granted": granted, **extra})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["exam_stage_permissions"][stage]

    def me(self, actor=1):
        response = self.client.get("/users/me", headers=self.headers(actor))
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def prepare_theory(self, actor=1, **extra):
        response = self.client.post("/exam/session/start", headers=self.headers(actor), json={
            "exam_id": 1, "candidate_code": f"{actor:010d}", "candidate_first_name": "Synthetic",
            "candidate_last_name": str(actor), "prepare_only": True, **extra,
        })
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def begin_theory(self, prepared):
        return self.client.post(f'/exam/{prepared["session_id"]}/begin',
                                headers={"Authorization": f'Bearer {prepared["token"]}'})

    def finish_theory(self, prepared):
        headers = {"Authorization": f'Bearer {prepared["token"]}'}
        path = f'/exam/{prepared["session_id"]}'
        self.assertEqual(self.client.get(path + "/all-questions", headers=headers).status_code, 200)
        self.assertEqual(self.begin_theory(prepared).status_code, 200)
        response = self.client.post(path + "/answers/batch", headers=headers,
                                    json={"answers": [{"question_id": 1, "option_id": 1}]})
        self.assertEqual(response.status_code, 200, response.text)
        response = self.client.post(path + "/finish", headers=headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["score_percent"], 100)
        return response.json()

    def project_prepare(self, kind, actor=1, prepare_only=True):
        response = self.client.get(f"/public/{kind}/projects/random",
                                   params={"prepare_only": str(prepare_only).lower()},
                                   headers=self.headers(actor))
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def project_start(self, kind, grant_id, actor=1):
        return self.client.post(f"/public/{kind}/start", headers=self.headers(actor),
                                json={"stageGrantId": grant_id})

    def project_finish(self, kind, project, actor=1):
        return self.client.post(f"/public/{kind}/evaluations", headers=self.headers(actor), json={
            "projectCode": project["code"], "projectName": "Synthetic project",
            "selectedAnswerIds": [1], "percentage": 0, "correctCount": 0,
            "wrongCount": 999, "totalCorrectAnswers": 0, "durationSeconds": 12,
            "stageGrantId": project.get("stageGrantId"),
        })

    def test_three_grants_are_independent_and_theory_never_auto_opens_next(self):
        first = self.grant("theory")
        self.assertAlmostEqual((datetime.fromisoformat(first["expires_at"]) -
                                datetime.fromisoformat(first["granted_at"])).total_seconds(), 3600)
        self.finish_theory(self.prepare_theory())
        self.db.expire_all()
        self.assertFalse(self.db.get(User, 1).exam_permission)
        self.assertFalse(any(item["granted"] for item in self.me()["exam_stage_permissions"].values()))
        for stage in STAGES:
            self.grant(stage)
        self.assertNotEqual(self.me()["exam_stage"], "all")
        self.grant("project_stage_1", False)
        permissions = self.me()["exam_stage_permissions"]
        self.assertEqual([permissions[s]["granted"] for s in STAGES], [True, False, True])

    def test_expired_prepared_theory_cannot_begin_or_use_a_replacement_grant(self):
        first = self.grant("theory")
        prepared = self.prepare_theory()
        self.assertIsNone(self.me()["exam_stage_permissions"]["theory"]["started_at"])
        grant = self.db.get(UserExamStageGrant, first["grant_id"])
        grant.expires_at = datetime.utcnow() - timedelta(seconds=1)
        self.db.commit()
        permission = self.me()["exam_stage_permissions"]["theory"]
        self.assertFalse(permission["granted"])
        self.assertEqual(permission["status"], "expired")
        second = self.grant("theory")
        self.assertNotEqual(first["grant_id"], second["grant_id"])
        self.assertEqual(self.begin_theory(prepared).status_code, 403)
        self.assertEqual(self.me()["exam_stage_permissions"]["theory"]["status"], "available")

    def test_repeated_theory_preparation_and_begin_reuse_the_same_attempt(self):
        self.grant("theory")
        prepared = self.prepare_theory()
        repeated = self.prepare_theory()
        # SQLite round-trips the existing UTC datetimes without a timezone suffix.
        self.assertEqual(repeated.pop("ends_at").removesuffix("Z"), prepared["ends_at"].removesuffix("Z"))
        self.assertEqual(repeated, {key: value for key, value in prepared.items() if key != "ends_at"})
        first = self.begin_theory(prepared)
        second = self.begin_theory(prepared)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.json(), first.json())
        running_retry = self.prepare_theory()
        self.assertEqual(running_retry["session_id"], prepared["session_id"])
        self.assertEqual(running_retry["token"], prepared["token"])
        self.assertEqual(running_retry["ends_at"].removesuffix("Z"), first.json()["ends_at"].removesuffix("Z"))
        self.assertEqual(len(self.db.scalars(select(ExamSession)).all()), 1)

    def test_project_start_is_idempotent_and_started_grant_cannot_prepare_again(self):
        for stage, kind in ((STAGES[1], "multi-apartment"), (STAGES[2], "multi-functional")):
            with self.subTest(kind=kind):
                permission = self.grant(stage)
                project = self.project_prepare(kind)
                first = self.project_start(kind, project["stageGrantId"])
                second = self.project_start(kind, project["stageGrantId"])
                self.assertEqual(first.status_code, 200, first.text)
                self.assertEqual(second.status_code, 200, second.text)
                self.assertEqual(second.json(), first.json())
                running = self.me()["exam_stage_permissions"][stage]
                self.assertEqual(running["status"], "started")
                self.assertFalse(running["granted"])
                self.assertEqual(running["grant_id"], permission["grant_id"])
                retry = self.client.get(
                    f"/public/{kind}/projects/random",
                    params={"prepare_only": "true"},
                    headers=self.headers(1),
                )
                self.assertEqual(retry.status_code, 409, retry.text)

    def test_running_stage_requires_exact_confirmed_replacement(self):
        stage = STAGES[1]
        original = self.grant(stage)
        project = self.project_prepare("multi-apartment")
        self.assertEqual(
            self.project_start("multi-apartment", project["stageGrantId"]).status_code,
            200,
        )
        path = f"/admin/users/1/exam-stage-permissions/{stage}"
        for payload in ({"granted": True}, {"granted": False}):
            response = self.client.patch(path, headers=self.headers(2), json=payload)
            self.assertEqual(response.status_code, 409, response.text)
        stale = self.client.patch(
            path,
            headers=self.headers(2),
            json={
                "granted": True,
                "replace_started": True,
                "expected_grant_id": original["grant_id"] + 999,
            },
        )
        self.assertEqual(stale.status_code, 409, stale.text)
        replacement = self.grant(
            stage,
            replace_started=True,
            expected_grant_id=original["grant_id"],
        )
        self.assertNotEqual(replacement["grant_id"], original["grant_id"])
        self.assertTrue(replacement["granted"])
        self.assertEqual(replacement["status"], "available")
        stale_retry = self.client.patch(
            path,
            headers=self.headers(2),
            json={
                "granted": True,
                "replace_started": True,
                "expected_grant_id": original["grant_id"],
            },
        )
        self.assertEqual(stale_retry.status_code, 409, stale_retry.text)
        current = self.me()["exam_stage_permissions"][stage]
        self.assertEqual(current["grant_id"], replacement["grant_id"])
        self.assertTrue(current["granted"])

    def test_started_theory_without_its_bound_session_cannot_prepare_fresh(self):
        permission = self.grant("theory")
        grant = self.db.get(UserExamStageGrant, permission["grant_id"])
        grant.started_at = datetime.utcnow()
        self.db.commit()
        response = self.client.post(
            "/exam/session/start",
            headers=self.headers(1),
            json={
                "exam_id": 1,
                "candidate_code": "0000000001",
                "candidate_first_name": "Synthetic",
                "candidate_last_name": "1",
                "prepare_only": True,
            },
        )
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(self.db.scalars(select(ExamSession)).all(), [])

    def test_old_project_payload_does_not_consume_ambiguous_replacement(self):
        for stage, kind in ((STAGES[1], "multi-apartment"), (STAGES[2], "multi-functional")):
            with self.subTest(kind=kind):
                self.grant(stage)
                old = self.project_prepare(kind, prepare_only=False)
                replacement = self.grant(
                    stage,
                    replace_started=True,
                    expected_grant_id=old["stageGrantId"],
                )
                self.assertEqual(self.project_start(kind, replacement["grant_id"]).status_code, 200)
                old.pop("stageGrantId")
                result = self.project_finish(kind, old)
                self.assertEqual(result.status_code, 409, result.text)
                self.assertEqual(self.me()["exam_stage_permissions"][stage]["grant_id"], replacement["grant_id"])

    def test_started_theory_outlives_unused_grant_deadline_and_retry_does_not_clear_new_grant(self):
        first = self.grant("theory")
        prepared = self.prepare_theory()
        self.assertEqual(self.begin_theory(prepared).status_code, 200)
        self.db.get(UserExamStageGrant, first["grant_id"]).expires_at = datetime.utcnow() - timedelta(hours=1)
        self.db.commit()
        running_state = self.me()
        running = running_state["exam_stage_permissions"]["theory"]
        self.assertEqual(running["status"], "started")
        self.assertFalse(running["granted"])
        self.assertEqual(running["grant_id"], first["grant_id"])
        self.assertFalse(running_state["exam_permission"])
        self.assertEqual(running_state["exam_stage"], "theory")
        self.assertEqual(running_state["exam_stage_status"], "started")
        finished = self.finish_theory(prepared)
        completed = self.me()["exam_stage_permissions"]["theory"]
        self.assertEqual(completed["status"], "completed")
        self.assertFalse(completed["granted"])
        self.assertEqual(completed["grant_id"], first["grant_id"])
        replacement = self.grant("theory")
        headers = {"Authorization": f'Bearer {prepared["token"]}'}
        path = f'/exam/{prepared["session_id"]}'
        retry = self.client.post(path + "/answers/batch", headers=headers, json={"answers": []})
        self.assertEqual(retry.status_code, 200, retry.text)
        self.assertEqual(self.client.post(path + "/finish", headers=headers).json(), finished)
        self.assertEqual(self.me()["exam_stage_permissions"]["theory"]["grant_id"], replacement["grant_id"])

    def test_both_projects_expire_before_visible_start_and_new_grant_cannot_rescue_old_preparation(self):
        for stage, kind in ((STAGES[1], "multi-apartment"), (STAGES[2], "multi-functional")):
            with self.subTest(kind=kind):
                permission = self.grant(stage)
                project = self.project_prepare(kind)
                self.assertEqual(project["stageGrantId"], permission["grant_id"])
                self.assertIsNone(self.db.get(UserExamStageGrant, permission["grant_id"]).started_at)
                self.db.get(UserExamStageGrant, permission["grant_id"]).expires_at = datetime.utcnow() - timedelta(seconds=1)
                self.db.commit()
                self.assertEqual(self.project_start(kind, project["stageGrantId"]).status_code, 403)
                replacement = self.grant(stage)
                self.assertEqual(self.project_start(kind, project["stageGrantId"]).status_code, 403)
                self.assertNotEqual(project["stageGrantId"], replacement["grant_id"])

    def test_projects_save_server_grade_once_without_consuming_replacement_or_other_stage(self):
        self.grant("theory")
        for stage, kind, model in ((STAGES[1], "multi-apartment", MultiApartmentEvaluation),
                                    (STAGES[2], "multi-functional", MultiFunctionalEvaluation)):
            with self.subTest(kind=kind):
                original = self.grant(stage)
                project = self.project_prepare(kind)
                self.assertEqual(self.project_start(kind, project["stageGrantId"]).status_code, 200)
                replacement = self.grant(
                    stage,
                    replace_started=True,
                    expected_grant_id=original["grant_id"],
                )
                saved = self.project_finish(kind, project)
                self.assertEqual(saved.status_code, 201, saved.text)
                self.assertEqual(saved.json()["percentage"], 100)
                retry = self.project_finish(kind, project)
                self.assertEqual(retry.json(), saved.json())
                self.assertEqual(len(self.db.scalars(select(model)).all()), 1)
                self.assertEqual(self.me()["exam_stage_permissions"][stage]["grant_id"], replacement["grant_id"])
                self.assertIsNotNone(self.db.get(UserExamStageGrant, original["grant_id"]).consumed_at)
        self.assertTrue(self.me()["exam_stage_permissions"]["theory"]["granted"])

    def test_full_and_live_admin_lists_and_login_expose_complete_maps(self):
        self.grant("project_stage_2")
        for live in (False, True):
            response = self.client.get("/admin/users", params={"page": 1, "size": 50, "live": str(live).lower()},
                                       headers=self.headers(2))
            self.assertEqual(response.status_code, 200, response.text)
            for item in response.json()["items"]:
                self.assertEqual(set(item["exam_stage_permissions"]), set(STAGES))
        with patch.object(auth, "verify_code", return_value=True), \
             patch.object(auth.login_limiter, "check"), patch.object(auth.login_account_limiter, "check_key"):
            response = self.client.post("/auth/login", json={"email": "candidate@example.com", "password": "synthetic"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(set(response.json()["user"]["exam_stage_permissions"]), set(STAGES))

    def test_only_admin_can_toggle_and_admin_founder_always_have_all_stages(self):
        path = "/admin/users/1/exam-stage-permissions/theory"
        for headers in ({}, self.headers(1)):
            response = self.client.patch(path, headers=headers, json={"granted": True})
            self.assertIn(response.status_code, (401, 403))
        for actor in (2, 3):
            permissions = self.me(actor)["exam_stage_permissions"]
            self.assertEqual(set(permissions), set(STAGES))
            self.assertTrue(all(p["granted"] and p["grant_id"] is None and p["expires_at"] is None for p in permissions.values()))
            for kind in ("multi-apartment", "multi-functional"):
                project = self.project_prepare(kind, actor)
                self.assertEqual(self.project_start(kind, project["stageGrantId"], actor).status_code, 200)

    def test_old_enable_is_theory_only_old_disable_and_admin_demotion_revoke_every_grant(self):
        old_path = "/admin/users/1/exam-permission"
        self.assertEqual(self.client.patch(old_path, headers=self.headers(2), json={"exam_permission": True}).status_code, 204)
        self.assertEqual([self.me()["exam_stage_permissions"][s]["granted"] for s in STAGES], [True, False, False])
        for stage in STAGES:
            self.grant(stage)
        self.assertEqual(self.client.patch(old_path, headers=self.headers(2), json={"exam_permission": False}).status_code, 204)
        self.assertFalse(any(p["granted"] for p in self.me()["exam_stage_permissions"].values()))
        self.grant("project_stage_2")
        for enabled in (True, False):
            response = self.client.patch("/admin/users/1/admin", headers=self.headers(3), json={"is_admin": enabled})
            self.assertEqual(response.status_code, 204, response.text)
        self.assertFalse(any(p["granted"] for p in self.me()["exam_stage_permissions"].values()))


if __name__ == "__main__":
    unittest.main()
