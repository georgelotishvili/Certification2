"""Synthetic DB-only regressions; no user accounts, SMTP, or production database."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from datetime import datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier
from uuid import uuid4
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from sqlalchemy import create_engine, event, select, text
from sqlalchemy.orm import Session
from starlette.requests import Request

from backend.app import database
from backend.app.models import Base, User, UserSession, Exam, Session as ExamSession, OfflineExamAttempt
from backend.app.routers import auth, exam, users
from backend.app.schemas import LoginRequest, StartSessionRequest, OfflineAttemptCancelRequest
from backend.app.services.desktop_sessions import request_device_id, require_matching_device
from backend.app.services.exam_stage_grants import grant_stage_permission
from backend.scripts.migrate_desktop_sessions import run as migrate
from backend.tests import test_offline_attempts as offline_contract

A = 'd279eb07-798d-41c4-b67f-5911d12f7e09'
B = '6b28d1dd-a7bb-4415-b521-5c5d93adc2d4'


def request(device=A, desktop=True):
    headers = [(b'user-agent', b'Electron/39.0' if desktop else b'Chrome/130')]
    if device is not None:
        headers.append((b'x-gipc-device-id', device.encode()))
    return Request({'type': 'http', 'method': 'POST', 'path': '/login',
                    'headers': headers, 'client': ('203.0.113.90', 1234)})


class DesktopSessionOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory(prefix='gipc-device-test-')
        self.addCleanup(self.tmp.cleanup)
        self.engine = create_engine('sqlite:///' + str(Path(self.tmp.name) / 'synthetic.db'),
                                    connect_args={'check_same_thread': False})
        self.addCleanup(self.engine.dispose)
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine, autoflush=False)
        self.addCleanup(self.db.close)
        def forbid_default(*_): raise AssertionError('Default database forbidden')
        event.listen(database.engine, 'connect', forbid_default)
        self.addCleanup(event.remove, database.engine, 'connect', forbid_default)
        self.patches = ExitStack()
        self.addCleanup(self.patches.close)
        for name in ('smtplib.SMTP', 'smtplib.SMTP_SSL', 'socket.create_connection'):
            self.patches.enter_context(patch(name, side_effect=AssertionError('Network forbidden')))
        self.patches.enter_context(patch.object(auth, 'verify_code', return_value=True))
        for obj, method in ((auth.login_limiter, 'check'), (auth.login_account_limiter, 'check_key'),
                            (auth.login_account_limiter, 'reset_key')):
            self.patches.enter_context(patch.object(obj, method))
        self.user = User(personal_id='99900000001', first_name='Synthetic', last_name='Candidate',
                         phone='555000000', email='audit@example.org', code='9990000001', password_hash='unused')
        self.db.add(self.user); self.db.commit()

    def login(self, device=A, desktop=True, db=None):
        return auth.login(request(device, desktop), LoginRequest(email='audit@example.org', password='Synthetic123!'), db or self.db)

    def status(self, fn):
        try: fn()
        except HTTPException as error:
            self.db.rollback()
            return error.status_code
        return 200

    def prepare(self, device=A, token=None):
        if token is None: token = self.login(device).token
        e = Exam(title='Synthetic', duration_minutes=120, gate_password='1')
        self.db.add(e); self.db.commit()
        grant = grant_stage_permission(self.db, self.user, 'theory'); self.db.commit()
        payload = StartSessionRequest(exam_id=e.id, candidate_first_name='Synthetic',
            candidate_last_name='Candidate', candidate_code=self.user.code, prepare_only=True)
        result = exam.start_session(payload, request(device), authorization='Bearer '+token, db=self.db)
        return payload, result, grant, token

    def test_browser_neither_blocks_desktop_nor_gets_revoked(self):
        browser = self.login(None, False)
        desktop = self.login()
        self.assertNotEqual(browser.token, desktop.token)
        self.assertIsNotNone(self.db.scalar(select(UserSession).where(UserSession.token == browser.token)))

    def test_same_device_login_reuses_token_and_different_device_blocks(self):
        first = self.login(); second = self.login()
        self.assertEqual(first.token, second.token)
        self.assertEqual(self.status(lambda: self.login(B)), 409)

    def test_seven_second_network_gap_does_not_permit_takeover(self):
        token = self.login().token
        session = self.db.scalar(select(UserSession).where(UserSession.token == token))
        session.last_used_at = datetime.utcnow()-timedelta(seconds=7); self.db.commit()
        self.assertEqual(self.status(lambda: self.login(B)), 409)
        self.assertIsNotNone(self.db.scalar(select(UserSession.id).where(UserSession.token == token)))

    def test_idle_expired_lease_can_move_without_touching_browser(self):
        browser = self.login(None, False).token
        old = self.login().token
        session = self.db.scalar(select(UserSession).where(UserSession.token == old))
        session.last_used_at = datetime.utcnow()-timedelta(seconds=121); self.db.commit()
        self.login(B)
        self.assertIsNone(self.db.scalar(select(UserSession.id).where(UserSession.token == old)))
        self.assertIsNotNone(self.db.scalar(select(UserSession.id).where(UserSession.token == browser)))

    def test_admin_login_exemption_retained(self):
        self.user.is_admin = True; self.db.commit()
        self.login(A); self.login(B)
        self.assertEqual(len(self.db.scalars(select(UserSession)).all()), 2)

    def test_downloaded_preparation_retry_is_idempotent_and_bound(self):
        payload, result, grant, token = self.prepare()
        session = self.db.get(ExamSession, result.session_id)
        session.selected_map = '{"1":[1]}'; self.db.commit()
        retry = exam.start_session(payload, request(A), authorization='Bearer '+token, db=self.db)
        self.assertEqual(retry.session_id, result.session_id)
        self.assertFalse(session.active)
        self.assertIsNone(grant.started_at)
        self.assertEqual(self.status(lambda: exam.start_session(payload, request(B), authorization='Bearer '+token, db=self.db)),409)
        self.assertEqual(self.status(lambda: exam.start_session(payload, request(None, False), authorization='Bearer '+token, db=self.db)),409)

    def test_legacy_prepared_session_not_claimed_or_rejected(self):
        payload, result, grant, token = self.prepare(None)
        session = self.db.get(ExamSession, result.session_id)
        session.selected_map = '{"1":[1]}'; self.db.commit()
        retry = exam.start_session(payload, request(None), authorization='Bearer '+token, db=self.db)
        self.assertEqual(retry.session_id, result.session_id)
        self.assertIsNone(session.device_id)

    def test_missing_start_response_owner_can_login_cancel_not_resume(self):
        _, result, grant, token = self.prepare()
        session = self.db.get(ExamSession,result.session_id)
        session.active=True; session.started_at=datetime.utcnow(); session.ends_at=datetime.utcnow()+timedelta(hours=2)
        grant.started_at=session.started_at
        self.db.add_all([session,grant]); self.db.flush()
        # Simulate issued Begin whose response was lost. No question content is
        # needed to check ownership/cancellation and no real material is loaded.
        attempt=OfflineExamAttempt(user_id=self.user.id,token='synthetic-capability',device_id=A,
            stage='theory',stage_grant_id=grant.id,session_id=session.id,
            started_at=session.started_at,ends_at=session.ends_at)
        self.db.add(attempt);self.db.commit()
        auth.logout(authorization='Bearer '+token,db=self.db)
        self.assertEqual(self.status(lambda:self.login(B)),409)
        newtoken=self.login(A).token
        cancel=OfflineAttemptCancelRequest(stage='theory',session_id=session.id,stage_grant_id=grant.id,cancellation_id=uuid4())
        receipt=exam.cancel_offline_attempt(cancel,authorization='Bearer '+newtoken,db=self.db)
        self.assertTrue(receipt['cancelled'])
        self.assertFalse(self.db.get(ExamSession,session.id).active)

    def test_legacy_active_attempt_login_restriction_unchanged_and_no_mutation(self):
        e=Exam(title='Synthetic');self.db.add(e);self.db.commit()
        running=ExamSession(user_id=self.user.id,exam_id=e.id,token='legacy-session',active=True,
            ends_at=datetime.utcnow()+timedelta(hours=1))
        self.db.add(running);self.db.commit()
        self.assertEqual(self.status(lambda:self.login(A)),409)
        self.db.refresh(running)
        self.assertTrue(running.active)
        self.assertIsNone(running.device_id)
        require_matching_device(None,None)  # No extra requirement on legacy calls.

    def test_heartbeat_refreshes_only_desktop_session(self):
        browser=self.login(None,False).token
        desktop=self.login(A).token
        row=self.db.scalar(select(UserSession).where(UserSession.token==desktop))
        old=datetime.utcnow()-timedelta(seconds=50);row.last_used_at=old;self.db.commit()
        users.get_current_user_info(request(A),authorization='Bearer '+desktop,db=self.db)
        self.db.refresh(row);self.assertGreater(row.last_used_at,old)
        self.assertEqual(self.status(lambda:users.get_current_user_info(request(B),authorization='Bearer '+desktop,db=self.db)),409)
        users.get_current_user_info(request(None,False),authorization='Bearer '+browser,db=self.db)

    def test_two_simultaneous_devices_issue_only_one_session(self):
        barrier=Barrier(2)
        self.db.close()
        def run(device):
            with Session(self.engine,autoflush=False) as db:
                barrier.wait()
                try:self.login(device,db=db);return 200
                except HTTPException as err:db.rollback();return err.status_code
        with ThreadPoolExecutor(max_workers=2) as pool:
            result=list(pool.map(run,[A,B]))
        self.assertEqual(sorted(result),[200,409])
        self.assertEqual(len(self.db.scalars(select(UserSession)).all()),1)

    def test_two_simultaneous_same_device_logins_share_one_token(self):
        barrier = Barrier(2)
        self.db.close()
        def run(_):
            with Session(self.engine, autoflush=False) as db:
                barrier.wait()
                return self.login(A, db=db).token
        with ThreadPoolExecutor(max_workers=2) as pool:
            tokens = list(pool.map(run, range(2)))
        self.assertEqual(tokens[0], tokens[1])
        self.assertEqual(len(self.db.scalars(select(UserSession)).all()), 1)

    def test_invalid_device_identifier_rejected_without_session(self):
        self.assertEqual(self.status(lambda:self.login('bad')),400)
        self.assertEqual(len(self.db.scalars(select(UserSession)).all()),0)

    def test_migration_idempotent_and_legacy_rows_preserved(self):
        eng=create_engine('sqlite:///:memory:')
        try:
            with eng.begin() as conn:
                for table in ('user_sessions','sessions','offline_exam_attempts'):
                    conn.execute(text(f'CREATE TABLE {table} (id INTEGER PRIMARY KEY, original TEXT)'))
                    conn.execute(text(f"INSERT INTO {table} VALUES (1,'unchanged')"))
            migrate(eng);migrate(eng)
            with eng.connect() as conn:
                for table in ('user_sessions','sessions','offline_exam_attempts'):
                    self.assertEqual(tuple(conn.execute(text(f'SELECT original,device_id FROM {table}')).one()),('unchanged',None))
        finally:eng.dispose()


class DesktopAttemptOwnershipHTTPTests(unittest.TestCase):
    enterContext = offline_contract.OfflineAttemptHTTPTests.enterContext
    setUp = offline_contract.OfflineAttemptHTTPTests.setUp
    headers = offline_contract.OfflineAttemptHTTPTests.headers
    grant = offline_contract.OfflineAttemptHTTPTests.grant
    prepare_theory = offline_contract.OfflineAttemptHTTPTests.prepare_theory
    project_prepare = offline_contract.OfflineAttemptHTTPTests.project_prepare

    def test_each_practical_lost_start_response_can_relogin_and_cancel_idempotently(self):
        # Password hashing is covered elsewhere; this checks the complete HTTP
        # recovery contract with synthetic credentials and no network/SMTP.
        for name in ('smtplib.SMTP', 'smtplib.SMTP_SSL', 'socket.create_connection'):
            self.enterContext(patch(name, side_effect=AssertionError('Network forbidden')))
        self.enterContext(patch.object(auth, 'verify_code', return_value=True))
        for obj, method in ((auth.login_limiter, 'check'), (auth.login_account_limiter, 'check_key'),
                            (auth.login_account_limiter, 'reset_key')):
            self.enterContext(patch.object(obj, method))

        def login(device):
            return self.client.post('/auth/login', headers={'X-GIPC-Device-ID': device},
                json={'email': 'candidate@example.com', 'password': 'Synthetic123!'})

        for kind, stage in [('multi-apartment', 'project_stage_1'), ('multi-functional', 'project_stage_2')]:
            with self.subTest(stage=stage):
                self.grant(stage)
                initial_login = login(A)
                self.assertEqual(initial_login.status_code, 200, initial_login.text)
                headers = {'Authorization': 'Bearer ' + initial_login.json()['token'],
                           'X-GIPC-Device-ID': A}
                prepared = self.client.get(f'/public/{kind}/projects/random',
                    params={'prepare_only': 'true'}, headers=headers)
                self.assertEqual(prepared.status_code, 200, prepared.text)
                project = prepared.json()
                payload = {'stageGrantId': project['stageGrantId'], 'projectCode': project['code'],
                           'offline': True, 'startRequestId': str(uuid4())}
                lost = self.client.post(f'/public/{kind}/start', headers=headers, json=payload)
                self.assertEqual(lost.status_code, 200, lost.text)
                # Treat the successful Start response as lost: do not use its
                # capability in any recovery request, only the saved intent.
                self.assertEqual(self.client.post('/auth/logout', headers=headers).status_code, 204)
                denied = login(B)
                self.assertEqual(denied.status_code, 409, denied.text)
                recovered = login(A)
                self.assertEqual(recovered.status_code, 200, recovered.text)
                owner_headers = {'Authorization': 'Bearer ' + recovered.json()['token'],
                                 'X-GIPC-Device-ID': A}
                cancel = {'stage': stage, 'stage_grant_id': payload['stageGrantId'],
                          'project_code': payload['projectCode'], 'start_request_id': payload['startRequestId'],
                          'cancellation_id': str(uuid4())}
                first = self.client.post('/exam/offline/cancel', headers=owner_headers, json=cancel)
                self.assertEqual(first.status_code, 200, first.text)
                self.assertTrue(first.json()['cancelled'])
                again = self.client.post('/exam/offline/cancel', headers=owner_headers, json=cancel)
                self.assertEqual(again.status_code, 200, again.text)
                self.assertEqual(again.json(), first.json())
                replay = self.client.post(f'/public/{kind}/start', headers=owner_headers, json=payload)
                self.assertEqual(replay.status_code, 409, replay.text)

    def test_legacy_theory_begin_and_finish_accept_new_device_header_unchanged(self):
        self.grant('theory')
        prepared = self.prepare_theory()
        headers = {'Authorization': 'Bearer ' + prepared['token'], 'X-GIPC-Device-ID': A}
        path = f"/exam/{prepared['session_id']}"
        self.assertEqual(self.client.get(path + '/all-questions', headers=headers).status_code, 200)
        started = self.client.post(path + '/begin', headers=headers)
        self.assertEqual(started.status_code, 200, started.text)
        answers = self.client.post(path + '/answers/batch', headers=headers,
            json={'answers': [{'question_id': 1, 'option_id': 1}]})
        self.assertEqual(answers.status_code, 200, answers.text)
        finished = self.client.post(path + '/finish', headers=headers)
        self.assertEqual(finished.status_code, 200, finished.text)
        self.assertEqual(finished.json()['score_percent'], 100)
        self.db.expire_all()
        self.assertIsNone(self.db.get(ExamSession, prepared['session_id']).device_id)

    def test_new_practical_attempts_bound_and_retried_only_on_owner(self):
        for kind, stage in [('multi-apartment','project_stage_1'),('multi-functional','project_stage_2')]:
            with self.subTest(stage=stage):
                self.grant(stage)
                project=self.project_prepare(kind)
                payload={'stageGrantId':project['stageGrantId'],'projectCode':project['code'],
                         'offline':True,'startRequestId':str(uuid4())}
                headers={**self.headers(),'X-GIPC-Device-ID':A}
                first=self.client.post(f'/public/{kind}/start',headers=headers,json=payload)
                self.assertEqual(first.status_code,200,first.text)
                again=self.client.post(f'/public/{kind}/start',headers=headers,json=payload)
                self.assertEqual(again.json()['offlineSubmissionToken'],first.json()['offlineSubmissionToken'])
                for changed in ({**self.headers(),'X-GIPC-Device-ID':B},self.headers()):
                    refused=self.client.post(f'/public/{kind}/start',headers=changed,json=payload)
                    self.assertEqual(refused.status_code,409,refused.text)
                attempt=self.db.scalar(select(OfflineExamAttempt).where(OfflineExamAttempt.token==first.json()['offlineSubmissionToken']))
                self.assertEqual(attempt.device_id,A)

    def test_legacy_practical_retry_not_blocked_or_claimed(self):
        self.grant('project_stage_1')
        project=self.project_prepare('multi-apartment')
        payload={'stageGrantId':project['stageGrantId'],'projectCode':project['code'],
                 'offline':True,'startRequestId':str(uuid4())}
        first=self.client.post('/public/multi-apartment/start',headers=self.headers(),json=payload)
        self.assertEqual(first.status_code,200,first.text)
        again=self.client.post('/public/multi-apartment/start',headers={**self.headers(),'X-GIPC-Device-ID':A},json=payload)
        self.assertEqual(again.json()['offlineSubmissionToken'],first.json()['offlineSubmissionToken'])
        attempt=self.db.scalar(select(OfflineExamAttempt).where(OfflineExamAttempt.token==first.json()['offlineSubmissionToken']))
        self.assertIsNone(attempt.device_id)

    def test_theory_offline_attempt_inherits_owner_without_changing_legacy_begin(self):
        self.grant('theory')
        prepared=self.client.post('/exam/session/start',headers={**self.headers(),'X-GIPC-Device-ID':A},json={
            'exam_id':1,'candidate_first_name':'Synthetic','candidate_last_name':'Person',
            'candidate_code':'0000000001','prepare_only':True})
        self.assertEqual(prepared.status_code,200,prepared.text)
        data=prepared.json();headers={'Authorization':'Bearer '+data['token']}
        self.assertEqual(self.client.get(f"/exam/{data['session_id']}/all-questions",headers=headers).status_code,200)
        started=self.client.post(f"/exam/{data['session_id']}/begin?offline=true",headers=headers)
        self.assertEqual(started.status_code,200,started.text)
        attempt=self.db.scalar(select(OfflineExamAttempt).where(OfflineExamAttempt.token==started.json()['offline_submission_token']))
        self.assertEqual(attempt.device_id,A)


if __name__=='__main__':unittest.main()
