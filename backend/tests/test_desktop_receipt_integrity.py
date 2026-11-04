"""Real HTTP desktop retries must never manufacture a successful exam result.

All records and routes use the existing isolated in-memory HTTP fixture.
No application startup, production database, email or external requests.
"""
from uuid import uuid4
import unittest

from sqlalchemy import func, select

from backend.app.models import Answer, OfflineExamAttempt, Session as ExamSession, UserExamStageGrant
from backend.tests import test_offline_attempts as offline


class DesktopReceiptIntegrityTests(unittest.TestCase):
    enterContext = offline.OfflineAttemptHTTPTests.enterContext
    setUp = offline.OfflineAttemptHTTPTests.setUp
    headers = offline.OfflineAttemptHTTPTests.headers
    grant = offline.OfflineAttemptHTTPTests.grant
    prepare_theory = offline.OfflineAttemptHTTPTests.prepare_theory
    theory = offline.OfflineAttemptHTTPTests.theory
    theory_payload = offline.OfflineAttemptHTTPTests.theory_payload

    def final(self, prepared, started, payload, token=None):
        return self.client.post(
            f'/exam/{prepared["session_id"]}/offline-final', json=payload,
            headers={"Authorization": "Bearer " + (token or started["offline_submission_token"]),
                     "User-Agent": "certification-exam-app/1.1.26 Electron/28.3.3"},
        )

    def test_exact_desktop_retry_returns_only_original_persisted_grade(self):
        prepared, started = self.theory()
        payload = self.theory_payload(prepared)
        first = self.final(prepared, started, payload)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()["score_percent"], 100)
        self.db.expire_all()
        again = self.final(prepared, started, payload)
        self.assertEqual(again.status_code, 200, again.text)
        self.assertEqual(again.json(), first.json())
        self.assertEqual(self.db.scalar(select(func.count()).select_from(Answer)), 1)

    def test_changed_desktop_answers_are_conflict_not_zero_receipt(self):
        prepared, started = self.theory()
        payload = self.theory_payload(prepared)
        first = self.final(prepared, started, payload)
        self.assertEqual(first.status_code, 200, first.text)
        conflict = self.final(prepared, started, {**payload, "answers": []})
        self.assertEqual(conflict.status_code, 409, conflict.text)
        self.assertEqual(conflict.json()["detail"]["code"], "EXAM_PAYLOAD_CONFLICT")
        self.assertNotIn("score_percent", conflict.json())
        self.db.expire_all()
        self.assertEqual(self.db.get(ExamSession, prepared["session_id"]).score_percent, 100)
        self.assertEqual(self.final(prepared, started, payload).json(), first.json())

    def test_different_submission_uuid_cannot_be_acknowledged_as_another_result(self):
        prepared, started = self.theory()
        payload = self.theory_payload(prepared)
        self.assertEqual(self.final(prepared, started, payload).status_code, 200)
        conflict = self.final(prepared, started, {**payload, "submission_id": str(uuid4())})
        self.assertEqual(conflict.status_code, 409, conflict.text)
        self.assertNotIn("score_percent", conflict.json())

    def test_deleted_result_never_authenticates_by_consumed_grant_alone(self):
        prepared, started = self.theory()
        payload = self.theory_payload(prepared)
        self.assertEqual(self.final(prepared, started, payload).status_code, 200)
        deleted = self.client.delete(f'/admin/results/{prepared["session_id"]}', headers=self.headers(3))
        self.assertEqual(deleted.status_code, 204, deleted.text)
        self.db.expire_all()
        self.assertIsNotNone(self.db.get(UserExamStageGrant, prepared["stage_grant_id"]))
        before = [self.db.scalar(select(func.count()).select_from(model))
                  for model in (ExamSession, OfflineExamAttempt, Answer)]
        for target, capability in ((prepared, started["offline_submission_token"]),
                                   (prepared, "unrelated-capability"),
                                   ({"session_id": 987654321}, "unrelated-capability")):
            with self.subTest(target=target, capability_valid=capability == started["offline_submission_token"]):
                response = self.final(target, started, payload, token=capability)
                self.assertEqual(response.status_code, 401, response.text)
                self.assertNotIn("score_percent", response.json())
        after = [self.db.scalar(select(func.count()).select_from(model))
                 for model in (ExamSession, OfflineExamAttempt, Answer)]
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
