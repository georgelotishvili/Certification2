"""Interrupted desktop attempts: isolated synthetic fixtures, never real data."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime, timedelta
import json
from pathlib import Path
import sqlite3
import tempfile
from threading import Barrier
import unittest
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from backend.app.database import get_db
from backend.app.models import (
    Answer, MultiApartmentEvaluation, MultiFunctionalEvaluation, OfflineExamAttempt,
    Session as ExamSession, UserExamStageGrant, UserSession,
)
from backend.app.routers import admin, exam
from backend.tests import test_offline_attempts as offline_contract


class OfflineCancellationTests(unittest.TestCase):
    enterContext = offline_contract.OfflineAttemptHTTPTests.enterContext
    setUp = offline_contract.OfflineAttemptHTTPTests.setUp
    headers = offline_contract.OfflineAttemptHTTPTests.headers
    grant = offline_contract.OfflineAttemptHTTPTests.grant
    prepare_theory = offline_contract.OfflineAttemptHTTPTests.prepare_theory
    project_prepare = offline_contract.OfflineAttemptHTTPTests.project_prepare
    theory = offline_contract.OfflineAttemptHTTPTests.theory
    theory_payload = offline_contract.OfflineAttemptHTTPTests.theory_payload
    theory_final = offline_contract.OfflineAttemptHTTPTests.theory_final
    project = offline_contract.OfflineAttemptHTTPTests.project
    project_payload = offline_contract.OfflineAttemptHTTPTests.project_payload

    def cancellation(self, started, stage="theory", **updates):
        token = started.get("offline_submission_token") or started.get("offlineSubmissionToken")
        attempt = self.db.scalar(select(OfflineExamAttempt).where(OfflineExamAttempt.token == token))
        return {
            "offline_submission_token": token,
            "stage": stage,
            "stage_grant_id": attempt.stage_grant_id,
            "session_id": attempt.session_id,
            "project_code": attempt.project_code,
            "cancellation_id": str(uuid4()),
            "start_request_id": attempt.start_request_id,
            **updates,
        }

    def cancel(self, payload, **kwargs):
        return self.client.post("/exam/offline/cancel", json=payload, **kwargs)

    def test_theory_interruption_is_idempotent_aborted_and_requires_new_grant(self):
        prepared, started = self.theory()
        payload = self.cancellation(started)
        first = self.cancel(payload)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertTrue(first.json()["cancelled"])
        self.assertEqual(first.json()["cancellation_id"], payload["cancellation_id"])
        self.db.expire_all()
        self.assertEqual(self.cancel(payload).json(), first.json())
        session = self.db.get(ExamSession, prepared["session_id"])
        self.assertFalse(session.active)
        self.assertIsNone(session.finished_at)
        self.assertIsNone(session.exam_snapshot)
        self.assertEqual(admin._session_status(session), "aborted")
        grant = self.db.get(UserExamStageGrant, prepared["stage_grant_id"])
        self.assertIsNotNone(grant.revoked_at)
        self.assertIsNone(grant.consumed_at)
        self.assertEqual(self.db.scalars(select(Answer)).all(), [])
        me = self.client.get("/users/me", headers=self.headers()).json()
        self.assertEqual(me["exam_stage_permissions"]["theory"]["status"], "none")
        fresh = self.grant("theory")
        self.assertNotEqual(fresh["grant_id"], prepared["stage_grant_id"])

    def test_cancel_blocks_delayed_final_and_begin_without_creating_a_result(self):
        prepared, started = self.theory()
        final_payload = self.theory_payload(prepared)
        self.assertEqual(self.cancel(self.cancellation(started)).status_code, 200)
        final = self.theory_final(prepared, started, final_payload)
        self.assertEqual(final.status_code, 409, final.text)
        for offline in ("true", "false"):
            begin = self.client.post(f'/exam/{prepared["session_id"]}/begin?offline={offline}',
                                     headers={"Authorization": f'Bearer {prepared["token"]}'})
            self.assertEqual(begin.status_code, 409, begin.text)
        self.assertEqual(self.db.scalars(select(Answer)).all(), [])

    def test_cancel_cannot_destroy_completed_result_or_change_terminal_receipt(self):
        prepared, started = self.theory()
        final_payload = self.theory_payload(prepared)
        completed = self.theory_final(prepared, started, final_payload)
        self.assertEqual(completed.status_code, 200, completed.text)
        cancelled = self.cancel(self.cancellation(started))
        self.assertEqual(cancelled.status_code, 409, cancelled.text)
        self.assertEqual(self.theory_final(prepared, started, final_payload).json(), completed.json())
        self.assertEqual(len(self.db.scalars(select(Answer)).all()), 1)

    def test_old_cancel_does_not_disable_replacement_or_other_stage_grants(self):
        prepared, started = self.theory()
        replacement = self.grant("theory", replace_started=True,
                                 expected_grant_id=prepared["stage_grant_id"])
        other = self.grant("project_stage_1")
        self.assertEqual(self.cancel(self.cancellation(started)).status_code, 200)
        self.db.expire_all()
        for grant_id in (replacement["grant_id"], other["grant_id"]):
            grant = self.db.get(UserExamStageGrant, grant_id)
            self.assertIsNone(grant.revoked_at)
            self.assertIsNone(grant.consumed_at)

    def test_capability_requires_exact_stage_session_grant_and_project(self):
        prepared, started = self.theory()
        payload = self.cancellation(started)
        for update, expected in (
            ({"offline_submission_token": "not-a-capability"}, 401),
            ({"stage": "project_stage_1"}, 403),
            ({"session_id": prepared["session_id"] + 1}, 403),
            ({"stage_grant_id": prepared["stage_grant_id"] + 1}, 403),
            ({"project_code": "another-project"}, 403),
            ({"start_request_id": str(uuid4())}, 403),
            ({"answers": []}, 422),
        ):
            with self.subTest(update=update):
                response = self.cancel({**payload, **update})
                self.assertEqual(response.status_code, expected, response.text)
        self.db.expire_all()
        self.assertTrue(self.db.get(ExamSession, prepared["session_id"]).active)
        self.assertIsNone(self.db.get(UserExamStageGrant, prepared["stage_grant_id"]).revoked_at)

    def test_different_cancellation_id_conflicts_but_original_receipt_survives(self):
        _, started = self.theory()
        payload = self.cancellation(started)
        first = self.cancel(payload)
        second = self.cancel({**payload, "cancellation_id": str(uuid4())})
        self.assertEqual(second.status_code, 409)
        self.assertEqual(self.cancel(payload).json(), first.json())

    def test_projects_cancel_without_evaluation_and_refuse_old_start_replay(self):
        for kind, stage, evaluation in (
            ("multi-apartment", "project_stage_1", MultiApartmentEvaluation),
            ("multi-functional", "project_stage_2", MultiFunctionalEvaluation),
        ):
            with self.subTest(kind=kind):
                project, start_payload, started = self.project(kind, stage)
                payload = self.cancellation(started, stage)
                cancelled = self.cancel(payload)
                self.assertEqual(cancelled.status_code, 200, cancelled.text)
                self.assertEqual(self.cancel(payload).json(), cancelled.json())
                old_start = self.client.post(f"/public/{kind}/start", headers=self.headers(), json=start_payload)
                self.assertEqual(old_start.status_code, 409, old_start.text)
                final = self.client.post(f"/public/{kind}/evaluations", json=self.project_payload(project, started))
                self.assertEqual(final.status_code, 409, final.text)
                self.assertEqual(self.db.scalars(select(evaluation)).all(), [])

    def test_admin_project_cancel_without_grant_stays_exact_request_scoped(self):
        _, _, started = self.project("multi-functional", "project_stage_2", actor=2)
        payload = self.cancellation(started, "project_stage_2")
        self.assertIsNone(payload["stage_grant_id"])
        cancelled = self.cancel(payload)
        self.assertEqual(cancelled.status_code, 200, cancelled.text)
        self.assertEqual(self.db.scalars(select(MultiFunctionalEvaluation)).all(), [])

    def test_capability_cancellation_does_not_require_unexpired_login(self):
        _, started = self.theory()
        login = self.db.scalar(select(UserSession).where(UserSession.user_id == 1))
        login.expires_at = datetime.utcnow() - timedelta(days=1)
        self.db.commit()
        self.assertEqual(self.cancel(self.cancellation(started)).status_code, 200)

    def test_lost_theory_start_response_cancel_requires_fresh_owner_login(self):
        _, started = self.theory()
        payload = self.cancellation(started, offline_submission_token=None)
        for headers, expected in (({}, 401), (self.headers(2), 403)):
            response = self.cancel(payload, headers=headers)
            self.assertEqual(response.status_code, expected, response.text)
        response = self.cancel(payload, headers=self.headers())
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.cancel(payload, headers=self.headers()).json(), response.json())

    def test_lost_project_start_response_requires_owner_and_original_request_id(self):
        _, _, started = self.project("multi-apartment", "project_stage_1")
        payload = self.cancellation(started, "project_stage_1", offline_submission_token=None)
        for updates, expected in (({"start_request_id": None}, 400),
                                  ({"start_request_id": str(uuid4())}, 404),
                                  ({"project_code": "OTHER"}, 403)):
            response = self.cancel({**payload, **updates}, headers=self.headers())
            self.assertEqual(response.status_code, expected, response.text)
        response = self.cancel(payload, headers=self.headers(2))
        self.assertEqual(response.status_code, 403, response.text)
        response = self.cancel(payload, headers=self.headers())
        self.assertEqual(response.status_code, 200, response.text)

    def test_unissued_start_intent_cannot_cancel_available_grant(self):
        grant = self.grant("theory")
        prepared = self.prepare_theory()
        response = self.cancel({
            "stage": "theory", "stage_grant_id": grant["grant_id"],
            "session_id": prepared["session_id"], "cancellation_id": str(uuid4()),
        }, headers=self.headers())
        self.assertEqual(response.status_code, 404, response.text)
        self.db.expire_all()
        self.assertIsNone(self.db.get(UserExamStageGrant, grant["grant_id"]).revoked_at)
        self.assertEqual(self.db.scalars(select(OfflineExamAttempt)).all(), [])

    def test_cancel_and_final_race_have_exactly_one_terminal_outcome(self):
        prepared, started = self.theory()
        cancel_payload, final_payload = self.cancellation(started), self.theory_payload(prepared)
        self.db.rollback()
        with tempfile.TemporaryDirectory(prefix="offline-cancel-race-") as directory:
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
                    def deliver(kind):
                        barrier.wait(timeout=10)
                        if kind == "cancel":
                            return client.post("/exam/offline/cancel", json=cancel_payload)
                        return client.post(f'/exam/{prepared["session_id"]}/offline-final',
                                           headers={"Authorization": f'Bearer {started["offline_submission_token"]}'},
                                           json=final_payload)
                    with ThreadPoolExecutor(max_workers=2) as executor:
                        cancelled, final = list(executor.map(deliver, ("cancel", "final")))
                    self.assertEqual(sorted([cancelled.status_code, final.status_code]), [200, 409],
                                     [cancelled.text, final.text])
                    with Session(engine) as db:
                        attempt = db.scalar(select(OfflineExamAttempt))
                        receipt = json.loads(attempt.receipt)
                        session = db.get(ExamSession, prepared["session_id"])
                        self.assertFalse(session.active)
                        if cancelled.status_code == 200:
                            self.assertTrue(receipt["cancelled"])
                            self.assertIsNone(session.finished_at)
                            self.assertEqual(db.scalars(select(Answer)).all(), [])
                        else:
                            self.assertNotIn("cancelled", receipt)
                            self.assertIsNotNone(session.finished_at)
                            self.assertEqual(len(db.scalars(select(Answer)).all()), 1)
            finally:
                engine.dispose()

    def test_cancel_and_late_begin_do_not_reactivate_cancelled_attempt(self):
        prepared, started = self.theory()
        cancel_payload = self.cancellation(started)
        self.db.rollback()
        with tempfile.TemporaryDirectory(prefix="offline-cancel-begin-") as directory:
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
                    def deliver(kind):
                        barrier.wait(timeout=10)
                        if kind == "cancel":
                            return client.post("/exam/offline/cancel", json=cancel_payload)
                        return client.post(f'/exam/{prepared["session_id"]}/begin?offline=true',
                                           headers={"Authorization": f'Bearer {prepared["token"]}'})
                    with ThreadPoolExecutor(max_workers=2) as executor:
                        cancelled, begin = list(executor.map(deliver, ("cancel", "begin")))
                    self.assertEqual(cancelled.status_code, 200, cancelled.text)
                    self.assertIn(begin.status_code, (200, 409), begin.text)
                    repeated = client.post(f'/exam/{prepared["session_id"]}/begin?offline=true',
                                           headers={"Authorization": f'Bearer {prepared["token"]}'})
                    self.assertEqual(repeated.status_code, 409, repeated.text)
                with Session(engine) as db:
                    self.assertFalse(db.get(ExamSession, prepared["session_id"]).active)
                    self.assertEqual(db.scalars(select(Answer)).all(), [])
                    self.assertTrue(json.loads(db.scalar(select(OfflineExamAttempt)).receipt)["cancelled"])
            finally:
                engine.dispose()


if __name__ == "__main__":
    unittest.main()
