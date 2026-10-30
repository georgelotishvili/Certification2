"""Authorized offline content stays gradeable after question-bank edits."""
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from sqlalchemy import select

from backend.app.models import (
    Answer, Block, Option, Question, Session as ExamSession, OfflineExamAttempt,
    OfflineExamContent, MultiApartmentProject, MultiApartmentAnswer,
    MultiFunctionalProject, MultiFunctionalAnswer,
)
from backend.app.routers import admin
from backend.tests import test_offline_attempts as contracts


class OfflineGradingSnapshotTests(unittest.TestCase):
    enterContext = contracts.OfflineAttemptHTTPTests.enterContext
    setUp = contracts.OfflineAttemptHTTPTests.setUp
    headers = contracts.OfflineAttemptHTTPTests.headers
    grant = contracts.OfflineAttemptHTTPTests.grant
    prepare_theory = contracts.OfflineAttemptHTTPTests.prepare_theory
    project_prepare = contracts.OfflineAttemptHTTPTests.project_prepare
    theory = contracts.OfflineAttemptHTTPTests.theory
    theory_payload = contracts.OfflineAttemptHTTPTests.theory_payload
    theory_final = contracts.OfflineAttemptHTTPTests.theory_final
    project = contracts.OfflineAttemptHTTPTests.project
    project_payload = contracts.OfflineAttemptHTTPTests.project_payload

    def content(self, grant_id):
        attempt = self.db.scalar(select(OfflineExamAttempt).where(OfflineExamAttempt.stage_grant_id == grant_id))
        return self.db.get(OfflineExamContent, attempt.id)

    def test_theory_freezes_key_text_taxonomy_and_retry_does_not_recapture(self):
        prepared, started = self.theory()
        before = self.content(prepared["stage_grant_id"]).snapshot
        self.db.get(Option, 1).is_correct = False
        self.db.get(Option, 1).text = "Changed option"
        self.db.get(Question, 1).text = "Changed question"
        self.db.get(Block, 1).title = "Changed block"
        self.db.add(Option(id=2, question_id=1, text="New correct", is_correct=True))
        self.db.commit()
        retry = self.client.post(f'/exam/{prepared["session_id"]}/begin?offline=true',
                                 headers={"Authorization": f'Bearer {prepared["token"]}'})
        self.assertEqual(retry.status_code, 200, retry.text)
        self.assertEqual(self.content(prepared["stage_grant_id"]).snapshot, before)
        response = self.theory_final(prepared, started, self.theory_payload(prepared))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["score_percent"], 100)
        report = self.client.get(f'/admin/results/{prepared["session_id"]}', headers=self.headers(2))
        self.assertEqual(report.status_code, 200, report.text)
        self.assertEqual(report.json()["answers"][0]["question_text"], "Synthetic question")
        self.assertEqual(report.json()["answers"][0]["selected_option_text"], "Correct")
        self.assertEqual(report.json()["block_stats"][0]["block_title"], "Synthetic block")
        self.assertTrue(self.db.scalar(select(Answer)).is_correct)

    def test_deleted_theory_questions_still_grade_and_report_from_original_template(self):
        prepared, started = self.theory()
        removed = self.client.put('/admin/exam/blocks', headers=self.headers(2),
                                  json={"exam_id": 1, "blocks": []})
        self.assertEqual(removed.status_code, 200, removed.text)
        self.assertIsNone(self.db.get(Question, 1))
        response = self.theory_final(prepared, started, self.theory_payload(prepared))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["score_percent"], 100)
        self.assertEqual(self.db.scalars(select(Answer)).all(), [])
        report = self.client.get(f'/admin/results/{prepared["session_id"]}', headers=self.headers(2))
        self.assertEqual(report.status_code, 200, report.text)
        self.assertEqual(report.json()["answers"][0]["question_text"], "Synthetic question")
        self.assertEqual(report.json()["correct_answers"], 1)
        self.assertFalse(report.json()["legacy"])

    def test_new_live_option_was_not_authorized_and_missing_template_fails_closed(self):
        prepared, started = self.theory()
        self.db.add(Option(id=2, question_id=1, text="Added later", is_correct=True))
        self.db.commit()
        payload = self.theory_payload(prepared, answers=[{"question_id": 1, "option_id": 2}])
        rejected = self.theory_final(prepared, started, payload)
        self.assertEqual(rejected.status_code, 400, rejected.text)
        self.db.delete(self.content(prepared["stage_grant_id"]))
        self.db.commit()
        rejected = self.theory_final(prepared, started, self.theory_payload(prepared))
        self.assertEqual(rejected.status_code, 409, rejected.text)
        self.assertIsNone(self.db.get(ExamSession, prepared["session_id"]).finished_at)

    def test_both_project_keys_and_details_survive_answer_removal_and_code_changes(self):
        for kind, stage, project_model, answer_model in (
            ("multi-apartment", "project_stage_1", MultiApartmentProject, MultiApartmentAnswer),
            ("multi-functional", "project_stage_2", MultiFunctionalProject, MultiFunctionalAnswer),
        ):
            with self.subTest(kind=kind):
                project, start_payload, started = self.project(kind, stage)
                before = self.content(project["stageGrantId"]).snapshot
                self.db.delete(self.db.get(answer_model, 1))
                self.db.add(answer_model(id=2, project_id=1, text="Replacement", is_correct=True))
                self.db.get(project_model, 1).code = "RENAMED"
                self.db.commit()
                retry = self.client.post(f'/public/{kind}/start', headers=self.headers(), json=start_payload)
                self.assertEqual(retry.status_code, 200, retry.text)
                self.assertEqual(self.content(project["stageGrantId"]).snapshot, before)
                forbidden = self.client.post(f'/public/{kind}/evaluations',
                                             json=self.project_payload(project, started, selectedAnswerIds=[2]))
                self.assertEqual(forbidden.status_code, 400, forbidden.text)
                result = self.client.post(f'/public/{kind}/evaluations', json=self.project_payload(project, started))
                self.assertEqual(result.status_code, 201, result.text)
                self.assertEqual(result.json()["percentage"], 100)
                self.assertEqual(result.json()["projectCode"], project["code"])
                report = self.client.get(f'/admin/{kind}/evaluations/detail/{result.json()["id"]}', headers=self.headers(2))
                self.assertEqual(report.status_code, 200, report.text)
                self.assertEqual(report.json()["answers"], [{"id": 1, "text": "Correct", "isCorrect": True, "isSelected": True}])

    def test_project_direct_and_bulk_deletes_block_only_while_offline_final_is_pending(self):
        for kind, stage, model in (("multi-apartment", "project_stage_1", MultiApartmentProject),
                                   ("multi-functional", "project_stage_2", MultiFunctionalProject)):
            with self.subTest(kind=kind):
                project, _, started = self.project(kind, stage)
                direct = self.client.delete(f'/admin/{kind}/projects/1', headers=self.headers(2))
                self.assertEqual(direct.status_code, 409, direct.text)
                bulk = self.client.post(f'/admin/{kind}/projects', headers=self.headers(2), json={"projects": [
                    {"id": "new", "number": 2, "code": "NEW", "answers": []}]})
                self.assertEqual(bulk.status_code, 409, bulk.text)
                self.assertIsNotNone(self.db.get(model, 1))
                self.assertEqual(len(self.db.scalars(select(model)).all()), 1)
                final = self.client.post(f'/public/{kind}/evaluations', json=self.project_payload(project, started))
                self.assertEqual(final.status_code, 201, final.text)
                content = self.content(project["stageGrantId"])
                self.assertIsNotNone(content.evaluation_id)
                removed = self.client.delete(f'/admin/{kind}/projects/1', headers=self.headers(2))
                self.assertEqual(removed.status_code, 204, removed.text)
                self.db.expire_all()
                self.assertIsNone(self.db.get(model, 1))
                self.assertIsNone(self.content(project["stageGrantId"]).evaluation_id)

    def test_theory_attempt_delete_is_blocked_pending_and_allowed_after_final(self):
        prepared, started = self.theory()
        path = f'/admin/results/{prepared["session_id"]}'
        rejected = self.client.delete(path, headers=self.headers(3))
        self.assertEqual(rejected.status_code, 409, rejected.text)
        final = self.theory_final(prepared, started, self.theory_payload(prepared))
        self.assertEqual(final.status_code, 200, final.text)
        with patch.object(admin, 'ensure_media_root', return_value=Path('synthetic-no-media-directory')):
            removed = self.client.delete(path, headers=self.headers(3))
        self.assertEqual(removed.status_code, 204, removed.text)
        self.assertIsNone(self.db.get(ExamSession, prepared["session_id"]))

    def test_server_only_snapshot_does_not_leak_keys_in_authorization_or_questions(self):
        prepared, started = self.theory()
        self.assertNotIn('is_correct', json.dumps(started))
        questions = self.client.get(f'/exam/{prepared["session_id"]}/all-questions',
                                    headers={"Authorization": f'Bearer {prepared["token"]}'})
        self.assertNotIn('is_correct', questions.text)
        project, _, start = self.project('multi-apartment', 'project_stage_1')
        self.assertNotIn('is_correct', json.dumps(project))
        self.assertNotIn('is_correct', json.dumps(start))
        self.assertIn('is_correct', self.content(project["stageGrantId"]).snapshot)

    def test_deleted_project_result_detaches_template_before_result_id_can_be_reused(self):
        project, _, started = self.project('multi-apartment', 'project_stage_1', actor=2)
        result = self.client.post('/public/multi-apartment/evaluations', json=self.project_payload(project, started))
        self.assertEqual(result.status_code, 201, result.text)
        removed = self.client.delete(f'/admin/multi-apartment/evaluations/{result.json()["id"]}', headers=self.headers(2))
        self.assertEqual(removed.status_code, 204, removed.text)
        self.db.get(MultiApartmentAnswer, 1).text = 'New authorized version'
        self.db.commit()
        project, _, started = self.project('multi-apartment', 'project_stage_1', actor=2)
        next_result = self.client.post('/public/multi-apartment/evaluations', json=self.project_payload(project, started))
        self.assertEqual(next_result.status_code, 201, next_result.text)
        report = self.client.get(f'/admin/multi-apartment/evaluations/detail/{next_result.json()["id"]}', headers=self.headers(2))
        self.assertEqual(report.json()["answers"][0]["text"], 'New authorized version')

    def test_theory_edits_between_prepare_and_start_keep_prepared_snapshot(self):
        self.grant("theory")
        prepared = self.prepare_theory()
        path = f'/exam/{prepared["session_id"]}'
        headers = {"Authorization": f'Bearer {prepared["token"]}'}
        first_q = self.client.get(path + "/all-questions", headers=headers)
        self.assertEqual(first_q.status_code, 200, first_q.text)
        # Admin edits and deletes live questions between Prepare and Begin
        self.db.get(Option, 1).is_correct = False
        self.db.get(Option, 1).text = "Mutated before begin"
        self.db.get(Question, 1).text = "Mutated question before begin"
        self.db.commit()
        second_q = self.client.get(path + "/all-questions", headers=headers)
        self.assertEqual(second_q.json(), first_q.json())
        begin = self.client.post(path + "/begin?offline=true", headers=headers)
        self.assertEqual(begin.status_code, 200, begin.text)
        started = begin.json()
        final = self.theory_final(prepared, started, self.theory_payload(prepared))
        self.assertEqual(final.status_code, 200, final.text)
        self.assertEqual(final.json()["score_percent"], 100)

    def test_project_edits_and_code_substitution_between_prepare_and_start_are_bound(self):
        for kind, stage, project_model, answer_model in (
            ("multi-apartment", "project_stage_1", MultiApartmentProject, MultiApartmentAnswer),
            ("multi-functional", "project_stage_2", MultiFunctionalProject, MultiFunctionalAnswer),
        ):
            with self.subTest(kind=kind):
                self.grant(stage)
                project = self.project_prepare(kind)
                self.db.add(project_model(id=2, number=2, code="OTHER-PROJ"))
                self.db.get(answer_model, 1).is_correct = False
                self.db.get(answer_model, 1).text = "Mutated before start"
                self.db.get(project_model, 1).code = "RENAMED-BEFORE-START"
                self.db.commit()
                # Substituting another project code at Start is rejected
                wrong_start = self.client.post(
                    f"/public/{kind}/start",
                    headers=self.headers(),
                    json={
                        "stageGrantId": project["stageGrantId"],
                        "projectCode": "OTHER-PROJ",
                        "offline": True,
                        "startRequestId": "00000000-0000-0000-0000-000000000099",
                    },
                )
                self.assertEqual(wrong_start.status_code, 409, wrong_start.text)
                # Starting with the prepared project code succeeds and uses the prepared snapshot
                ok_start = self.client.post(
                    f"/public/{kind}/start",
                    headers=self.headers(),
                    json={
                        "stageGrantId": project["stageGrantId"],
                        "projectCode": project["code"],
                        "offline": True,
                        "startRequestId": f"00000000-0000-0000-0000-00000000000{1 if kind == 'multi-apartment' else 2}",
                    },
                )
                self.assertEqual(ok_start.status_code, 200, ok_start.text)
                started = ok_start.json()
                res = self.client.post(f"/public/{kind}/evaluations", json=self.project_payload(project, started))
                self.assertEqual(res.status_code, 201, res.text)
                self.assertEqual(res.json()["percentage"], 100)

    def test_candidate_cannot_choose_project_without_server_assignment(self):
        from backend.app.models import UserExamStageGrant
        for kind, stage, project_model in (
            ("multi-apartment", "project_stage_1", MultiApartmentProject),
            ("multi-functional", "project_stage_2", MultiFunctionalProject),
        ):
            with self.subTest(kind=kind):
                grant_info = self.grant(stage)
                grant_id = grant_info["grant_id"]
                code = self.db.get(project_model, 1).code
                # 1. Offline start without /projects/random preparation is rejected
                unprep_offline = self.client.post(
                    f"/public/{kind}/start",
                    headers=self.headers(),
                    json={
                        "stageGrantId": grant_id,
                        "projectCode": code,
                        "offline": True,
                        "startRequestId": f"00000000-0000-0000-0000-00000000005{1 if kind == 'multi-apartment' else 2}",
                    },
                )
                self.assertEqual(unprep_offline.status_code, 409, unprep_offline.text)

                # 2. Online start with self-chosen projectCode without /projects/random is rejected
                unprep_online = self.client.post(
                    f"/public/{kind}/start",
                    headers=self.headers(),
                    json={
                        "stageGrantId": grant_id,
                        "projectCode": code,
                        "offline": False,
                    },
                )
                self.assertEqual(unprep_online.status_code, 409, unprep_online.text)

                # 3. Direct /evaluations submission without server-assigned PreparedExamMaterial is rejected
                grant_row = self.db.get(UserExamStageGrant, grant_id)
                grant_row.started_at = grant_row.granted_at
                self.db.add(grant_row)
                self.db.commit()
                unassigned_eval = self.client.post(
                    f"/public/{kind}/evaluations",
                    headers=self.headers(),
                    json={
                        "projectCode": code,
                        "projectName": "Test Project",
                        "percentage": 100.0,
                        "correctCount": 1,
                        "wrongCount": 0,
                        "totalCorrectAnswers": 1,
                        "selectedAnswerIds": [1],
                        "startedAt": "2026-10-20T10:00:00Z",
                        "finishedAt": "2026-10-20T10:05:00Z",
                        "durationSeconds": 300,
                        "stageGrantId": grant_id,
                    },
                )
                self.assertEqual(unassigned_eval.status_code, 403, unassigned_eval.text)

    def test_prepared_project_pdf_snapshot_survives_admin_replace_or_delete(self):
        import tempfile
        from backend.app.services import media_storage

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_root = Path(tmpdir)
            with patch.object(media_storage, "ensure_media_root", return_value=tmp_root):
                for kind, stage, project_model in (
                    ("multi-apartment", "project_stage_1", MultiApartmentProject),
                    ("multi-functional", "project_stage_2", MultiFunctionalProject),
                ):
                    with self.subTest(kind=kind):
                        orig_bytes = f"%PDF-1.4 original {kind} blueprint".encode("utf-8")
                        new_bytes = f"%PDF-1.4 replaced {kind} blueprint".encode("utf-8")
                        up1 = self.client.post(
                            f"/admin/{kind}/projects/1/pdf",
                            headers=self.headers(2),
                            files={"file": ("orig.pdf", orig_bytes, "application/pdf")},
                        )
                        self.assertEqual(up1.status_code, 200, up1.text)

                        self.grant(stage)
                        prepared = self.project_prepare(kind)
                        self.assertTrue(prepared["pdfUrl"])

                        # Admin replaces the project PDF with a different file after candidate prepared
                        up2 = self.client.post(
                            f"/admin/{kind}/projects/1/pdf",
                            headers=self.headers(2),
                            files={"file": ("new.pdf", new_bytes, "application/pdf")},
                        )
                        self.assertEqual(up2.status_code, 200, up2.text)

                        # Candidate fetching prepared pdfUrl (and bare /pdf) still receives original PDF
                        res_versioned = self.client.get(prepared["pdfUrl"])
                        self.assertEqual(res_versioned.status_code, 200)
                        self.assertEqual(res_versioned.content, orig_bytes)

                        res_bare = self.client.get(f"/public/{kind}/projects/{prepared['code']}/pdf")
                        self.assertEqual(res_bare.status_code, 200)
                        self.assertEqual(res_bare.content, orig_bytes)

                        # Admin deletes the live project PDF completely -> prepared PDF still works
                        del_res = self.client.delete(
                            f"/admin/{kind}/projects/1/pdf",
                            headers=self.headers(2),
                        )
                        self.assertEqual(del_res.status_code, 204, del_res.text)

                        res_after_del = self.client.get(prepared["pdfUrl"])
                        self.assertEqual(res_after_del.status_code, 200)
                        self.assertEqual(res_after_del.content, orig_bytes)


if __name__ == '__main__':
    unittest.main()
