"""Offline capability contracts; isolated synthetic database, never production."""
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
from threading import Barrier
from uuid import uuid4
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, delete, event, select
from sqlalchemy.orm import Session

from backend.app.database import get_db
from backend.app.routers import exam
from backend.app.models import (
    Answer, Exam, OfflineExamAttempt, Session as ExamSession, UserExamStageGrant,
    User, UserSession, MultiApartmentEvaluation, MultiFunctionalEvaluation,
)
from backend.app.services.exam_lifecycle import auto_close_expired_sessions
from backend.tests import test_independent_stage_contract as stage_contract


class OfflineAttemptHTTPTests(unittest.TestCase):
    enterContext = stage_contract.IndependentStageHTTPTests.enterContext
    setUp = stage_contract.IndependentStageHTTPTests.setUp
    headers = stage_contract.IndependentStageHTTPTests.headers
    grant = stage_contract.IndependentStageHTTPTests.grant
    prepare_theory = stage_contract.IndependentStageHTTPTests.prepare_theory
    project_prepare = stage_contract.IndependentStageHTTPTests.project_prepare

    def test_offline_capabilities_is_public_and_never_touches_database(self):
        statements = []

        def track_sql(connection, cursor, statement, parameters, context, many):
            statements.append(statement)

        event.listen(self.engine, "before_cursor_execute", track_sql)
        self.addCleanup(event.remove, self.engine, "before_cursor_execute", track_sql)
        response = self.client.get('/exam/offline/capabilities')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {
            "protocol": 1, "grading_snapshots": True, "interruption_cancellation": True,
        })
        self.assertEqual(statements, [])

    def theory(self):
        self.grant("theory")
        prepared = self.prepare_theory()
        path = f'/exam/{prepared["session_id"]}'
        headers = {"Authorization": f'Bearer {prepared["token"]}'}
        self.assertEqual(self.client.get(path + "/all-questions", headers=headers).status_code, 200)
        response = self.client.post(path + "/begin?offline=true", headers=headers)
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertTrue(data["offline_submission_token"])
        return prepared, data

    def theory_payload(self, prepared, **updates):
        attempt = self.db.scalar(select(OfflineExamAttempt).where(
            OfflineExamAttempt.session_id == prepared["session_id"]))
        return {"stage_grant_id": attempt.stage_grant_id,
                "submission_id": str(uuid4()),
                "finished_at": attempt.started_at.replace(tzinfo=timezone.utc).isoformat(),
                "answers": [{"question_id": 1, "option_id": 1}], **updates}

    def theory_final(self, prepared, started, payload):
        return self.client.post(f'/exam/{prepared["session_id"]}/offline-final',
                                headers={"Authorization": f'Bearer {started["offline_submission_token"]}'},
                                json=payload)

    def age_theory(self, prepared):
        session = self.db.get(ExamSession, prepared["session_id"])
        attempt = self.db.scalar(select(OfflineExamAttempt).where(
            OfflineExamAttempt.session_id == session.id))
        for item in (session, attempt):
            item.started_at -= timedelta(days=2)
            item.ends_at -= timedelta(days=2)
        self.db.commit()
        return session, attempt

    def test_theory_late_atomic_final_retry_and_no_deadline_reset(self):
        prepared, started = self.theory()
        session, attempt = self.age_theory(prepared)
        original_end = session.ends_at
        self.assertEqual(auto_close_expired_sessions(self.db), 0)
        again = self.client.post(f'/exam/{session.id}/begin?offline=true',
                                 headers={"Authorization": f'Bearer {prepared["token"]}'})
        self.assertEqual(again.status_code, 200, again.text)
        self.assertEqual(again.json()["offline_submission_token"], started["offline_submission_token"])
        self.assertEqual(datetime.fromisoformat(again.json()["started_at"].replace("Z", "+00:00")).replace(tzinfo=None), attempt.started_at)
        self.assertEqual(datetime.fromisoformat(again.json()["ends_at"].replace("Z", "+00:00")).replace(tzinfo=None), original_end)
        payload = self.theory_payload(prepared)
        first = self.theory_final(prepared, started, payload)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()["score_percent"], 100)
        self.assertEqual(first.json()["submission_id"], payload["submission_id"])
        self.assertEqual(first.json()["session_id"], prepared["session_id"])
        self.assertEqual(first.json()["stage_grant_id"], prepared["stage_grant_id"])
        self.db.expire_all()  # receipt survives a fresh ORM read / lost response
        second = self.theory_final(prepared, started, payload)
        self.assertEqual(second.json(), first.json())
        self.assertEqual(len(self.db.scalars(select(Answer)).all()), 1)
        self.assertEqual(self.db.get(ExamSession, session.id).ends_at, original_end)
        conflict = self.theory_final(prepared, started, {**payload, "answers": []})
        self.assertEqual(conflict.status_code, 409, conflict.text)

    def test_theory_begin_reports_original_start_even_if_duration_settings_change(self):
        self.grant("theory")
        prepared = self.prepare_theory()
        path = f'/exam/{prepared["session_id"]}'
        headers = {"Authorization": f'Bearer {prepared["token"]}'}
        self.assertEqual(self.client.get(path + "/all-questions", headers=headers).status_code, 200)
        exam = self.db.get(Exam, 1)
        exam.duration_minutes = 60
        self.db.commit()
        first = self.client.post(path + "/begin?offline=true", headers=headers)
        self.assertEqual(first.status_code, 200, first.text)
        data = first.json()
        started = datetime.fromisoformat(data["started_at"].replace("Z", "+00:00"))
        ended = datetime.fromisoformat(data["ends_at"].replace("Z", "+00:00"))
        self.assertEqual(ended - started, timedelta(minutes=60))
        self.assertEqual(data["duration_minutes"], 60)
        exam.duration_minutes = 120
        self.db.commit()
        again = self.client.post(path + "/begin?offline=true", headers=headers)
        self.assertEqual(again.status_code, 200, again.text)
        for field in ("started_at", "ends_at", "duration_minutes", "offline_submission_token"):
            self.assertEqual(again.json()[field], data[field])

    def test_theory_old_completion_does_not_consume_replacement_grant(self):
        prepared, started = self.theory()
        old = prepared["stage_grant_id"]
        replacement = self.grant("theory", replace_started=True, expected_grant_id=old)
        response = self.theory_final(prepared, started, self.theory_payload(prepared))
        self.assertEqual(response.status_code, 200, response.text)
        self.db.expire_all()
        self.assertIsNotNone(self.db.get(UserExamStageGrant, old).consumed_at)
        self.assertIsNone(self.db.get(UserExamStageGrant, replacement["grant_id"]).consumed_at)

    def test_capability_cannot_authorize_a_different_stage_or_session(self):
        prepared, started = self.theory()
        project, _, project_started = self.project("multi-functional", "project_stage_2")
        payload = self.theory_payload(prepared)
        cross_stage = self.client.post(f'/exam/{prepared["session_id"]}/offline-final',
                                      headers={"Authorization": f'Bearer {project_started["offlineSubmissionToken"]}'},
                                      json=payload)
        self.assertEqual(cross_stage.status_code, 403, cross_stage.text)
        cross_session = self.client.post(f'/exam/{prepared["session_id"] + 999}/offline-final',
                                        headers={"Authorization": f'Bearer {started["offline_submission_token"]}'},
                                        json=payload)
        self.assertEqual(cross_session.status_code, 403, cross_session.text)
        project_payload = self.project_payload(project, project_started,
                                               offlineSubmissionToken=started["offline_submission_token"])
        cross_project = self.client.post('/public/multi-functional/evaluations', json=project_payload)
        self.assertEqual(cross_project.status_code, 403, cross_project.text)
        self.assertEqual(self.db.scalars(select(Answer)).all(), [])
        self.assertEqual(self.db.scalars(select(MultiFunctionalEvaluation)).all(), [])

    def test_deleted_candidate_capability_does_not_keep_account_authority(self):
        prepared, started = self.theory()
        payload = self.theory_payload(prepared)
        self.db.execute(delete(User).where(User.id == 1))
        self.db.commit()
        self.db.expire_all()
        response = self.theory_final(prepared, started, payload)
        self.assertEqual(response.status_code, 401, response.text)
        self.assertEqual(self.db.scalars(select(OfflineExamAttempt)).all(), [])

    def test_theory_rejects_foreign_duplicate_and_out_of_interval_payloads_atomically(self):
        prepared, started = self.theory()
        base = self.theory_payload(prepared)
        for updates in (
            {"answers": [{"question_id": 999, "option_id": 1}]},
            {"answers": [{"question_id": 1, "option_id": 999}]},
            {"answers": base["answers"] * 2},
            {"finished_at": "2000-01-01T00:00:00Z"},
            {"stage_grant_id": prepared["stage_grant_id"] + 999},
        ):
            with self.subTest(updates=updates):
                response = self.theory_final(prepared, started, {**base, **updates})
                self.assertIn(response.status_code, (400, 403), response.text)
        self.assertEqual(self.db.scalars(select(Answer)).all(), [])
        self.assertIsNone(self.db.get(ExamSession, prepared["session_id"]).finished_at)
        self.assertEqual(self.theory_final(prepared, started, base).status_code, 200)

    def test_legacy_deadline_and_offline_capability_cannot_be_bypassed(self):
        prepared, started = self.theory()
        path = f'/exam/{prepared["session_id"]}'
        headers = {"Authorization": f'Bearer {prepared["token"]}'}
        self.assertEqual(self.client.post(path + "/answers/batch", headers=headers,
                                         json={"answers": []}).status_code, 409)
        self.assertEqual(self.client.post(path + "/finish", headers=headers).status_code, 409)
        rejected = self.client.post(path + "/offline-final", headers=headers,
                                    json=self.theory_payload(prepared))
        self.assertEqual(rejected.status_code, 401)
        # A separate ordinary attempt still auto-closes after its grace window.
        legacy = ExamSession(exam_id=1, user_id=1, token="legacy-test-token", active=True,
                             started_at=datetime.utcnow() - timedelta(hours=3),
                             ends_at=datetime.utcnow() - timedelta(hours=2))
        self.db.add(legacy)
        self.db.commit()
        self.assertEqual(auto_close_expired_sessions(self.db), 1)
        self.assertIsNotNone(self.db.get(ExamSession, legacy.id).finished_at)

    def project(self, kind, stage, actor=1):
        if actor == 1:
            self.grant(stage)
        project = self.project_prepare(kind, actor=actor)
        payload = {"stageGrantId": project["stageGrantId"], "projectCode": project["code"],
                   "offline": True, "startRequestId": str(uuid4())}
        response = self.client.post(f"/public/{kind}/start", headers=self.headers(actor), json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        return project, payload, response.json()

    def project_payload(self, project, started, **updates):
        return {"projectCode": project["code"], "projectName": "Synthetic project",
                "selectedAnswerIds": [1], "percentage": 999, "correctCount": 999,
                "wrongCount": 999, "totalCorrectAnswers": 999, "durationSeconds": 999,
                "stageGrantId": project["stageGrantId"],
                "offlineSubmissionToken": started["offlineSubmissionToken"],
                "submissionId": str(uuid4()), "finishedAt": started["startedAt"], **updates}

    def test_projects_late_after_login_expiry_receipt_and_new_grant_isolation(self):
        for kind, stage, model in (("multi-apartment", "project_stage_1", MultiApartmentEvaluation),
                                   ("multi-functional", "project_stage_2", MultiFunctionalEvaluation)):
            with self.subTest(kind=kind):
                login = self.db.scalar(select(UserSession).where(UserSession.token == "synthetic-1"))
                login.expires_at = datetime.utcnow() + timedelta(days=1)
                self.db.commit()
                project, start_payload, started = self.project(kind, stage)
                again = self.client.post(f"/public/{kind}/start", headers=self.headers(), json=start_payload)
                for field in ("offlineSubmissionToken", "startedAt", "endsAt"):
                    self.assertEqual(again.json()[field], started[field])
                replacement = self.grant(stage, replace_started=True, expected_grant_id=project["stageGrantId"])
                attempt = self.db.scalar(select(OfflineExamAttempt).where(
                    OfflineExamAttempt.stage_grant_id == project["stageGrantId"]))
                attempt.started_at -= timedelta(days=2)
                attempt.ends_at -= timedelta(days=2)
                login.expires_at = datetime.utcnow() - timedelta(days=1)
                self.db.commit()
                payload = self.project_payload(project, started, finishedAt=attempt.ends_at.isoformat() + "Z")
                response = self.client.post(f"/public/{kind}/evaluations", json=payload)
                self.assertEqual(response.status_code, 201, response.text)
                self.assertEqual(response.json()["percentage"], 100)
                self.assertEqual(response.json()["offlineSubmissionId"], payload["submissionId"])
                self.assertEqual(response.json()["stageGrantId"], project["stageGrantId"])
                self.db.expire_all()
                replay = self.client.post(f"/public/{kind}/evaluations", json=payload)
                self.assertEqual(replay.json(), response.json())
                self.assertEqual(len(self.db.scalars(select(model)).all()), 1)
                self.assertIsNone(self.db.get(UserExamStageGrant, replacement["grant_id"]).consumed_at)
                conflict = self.client.post(f"/public/{kind}/evaluations", json={**payload, "selectedAnswerIds": []})
                self.assertEqual(conflict.status_code, 409, conflict.text)

    def test_project_binding_foreign_answers_and_legacy_bypass_rejected(self):
        project, start_payload, started = self.project("multi-apartment", "project_stage_1")
        payload = self.project_payload(project, started)
        for updates, expected in (({"projectCode": "OTHER"}, 403),
                                  ({"selectedAnswerIds": [999]}, 400),
                                  ({"selectedAnswerIds": [1, 1]}, 400),
                                  ({"stageGrantId": None}, 403),
                                  ({"offlineSubmissionToken": None}, 409)):
            response = self.client.post("/public/multi-apartment/evaluations",
                                        headers=self.headers(), json={**payload, **updates})
            self.assertEqual(response.status_code, expected, response.text)
        altered_start = self.client.post("/public/multi-apartment/start", headers=self.headers(),
                                         json={**start_payload, "projectCode": "OTHER"})
        self.assertEqual(altered_start.status_code, 409)
        self.assertEqual(self.db.scalars(select(MultiApartmentEvaluation)).all(), [])
        functional, _, _ = self.project("multi-functional", "project_stage_2")
        alternate = self.client.post("/public/multi-functional/submissions", headers=self.headers(),
                                     json={"projectCode": functional["code"], "selectedAnswerId": 1})
        self.assertEqual(alternate.status_code, 409, alternate.text)

    def test_admin_offline_start_request_id_keeps_same_attempt_and_receipt(self):
        project, start_payload, started = self.project("multi-functional", "project_stage_2", actor=2)
        repeated = self.client.post("/public/multi-functional/start", headers=self.headers(2), json=start_payload)
        self.assertEqual(repeated.json()["offlineSubmissionToken"], started["offlineSubmissionToken"])
        self.assertEqual(repeated.json()["endsAt"], started["endsAt"])
        missing = self.client.post("/public/multi-functional/start", headers=self.headers(2),
                                   json={**start_payload, "startRequestId": None})
        self.assertEqual(missing.status_code, 400)
        payload = self.project_payload(project, started)
        first = self.client.post("/public/multi-functional/evaluations", json=payload)
        self.assertEqual(first.status_code, 201, first.text)
        self.assertEqual(first.json()["offlineSubmissionId"], payload["submissionId"])
        replay = self.client.post("/public/multi-functional/evaluations", json=payload)
        self.assertEqual(replay.json(), first.json())
        self.assertEqual(len(self.db.scalars(select(MultiFunctionalEvaluation)).all()), 1)

    def test_concurrent_final_delivery_and_fresh_server_receipt_are_idempotent(self):
        prepared, started = self.theory()
        payload = self.theory_payload(prepared)
        self.db.rollback()
        # Move only the synthetic fixture to a disposable database so separate
        # requests use independent connections and real SQLite transaction locks.
        with tempfile.TemporaryDirectory(prefix="offline-attempt-test-") as directory:
            database_path = Path(directory) / "synthetic.db"
            with self.engine.connect() as source, closing(sqlite3.connect(database_path)) as destination:
                source.connection.driver_connection.backup(destination)
            engine = create_engine(f"sqlite:///{database_path}",
                                   connect_args={"check_same_thread": False, "timeout": 15})
            try:
                application = FastAPI()
                application.include_router(exam.router, prefix="/exam")

                def isolated_connection():
                    with Session(engine, autoflush=False) as db:
                        yield db

                application.dependency_overrides[get_db] = isolated_connection
                barrier = Barrier(2)
                with TestClient(application) as client:
                    def deliver():
                        barrier.wait(timeout=10)
                        return client.post(f'/exam/{prepared["session_id"]}/offline-final',
                                           headers={"Authorization": f'Bearer {started["offline_submission_token"]}'},
                                           json=payload)
                    with ThreadPoolExecutor(max_workers=2) as executor:
                        results = list(executor.map(lambda _: deliver(), range(2)))
                    self.assertEqual([item.status_code for item in results], [200, 200],
                                     [item.text for item in results])
                    self.assertEqual(results[0].json(), results[1].json())
                # A newly constructed client/server and DB session still returns
                # the same durable receipt, without another result/answer write.
                with TestClient(application) as client:
                    replay = client.post(f'/exam/{prepared["session_id"]}/offline-final',
                                         headers={"Authorization": f'Bearer {started["offline_submission_token"]}'},
                                         json=payload)
                    self.assertEqual(replay.json(), results[0].json())
                with Session(engine) as db:
                    self.assertEqual(len(db.scalars(select(Answer)).all()), 1)
                    self.assertEqual(len(db.scalars(select(OfflineExamAttempt)).all()), 1)
            finally:
                engine.dispose()


if __name__ == "__main__":
    unittest.main()
