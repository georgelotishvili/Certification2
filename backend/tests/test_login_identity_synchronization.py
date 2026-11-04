"""Real login cleanup with strict ORM warnings; synthetic in-memory DB only."""
from contextlib import ExitStack
from datetime import datetime, timedelta
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import warnings

from fastapi import HTTPException
from sqlalchemy import create_engine, event, inspect, select
from sqlalchemy.exc import SAWarning
from sqlalchemy.orm import Session
from starlette.requests import Request

from backend.app import database
from backend.app.models import AuditEvent, Base, User, UserSession
from backend.app.routers import auth
from backend.app.schemas import LoginRequest
from backend.app.services import exam_stage
from backend.app.services.audit_log import enable_audit


A = 'd279eb07-798d-41c4-b67f-5911d12f7e09'
B = '6b28d1dd-a7bb-4415-b521-5c5d93adc2d4'


class LoginIdentitySynchronizationTests(unittest.TestCase):
    def setUp(self):
        self.patches = ExitStack()
        self.addCleanup(self.patches.close)
        for name in ('smtplib.SMTP', 'smtplib.SMTP_SSL', 'socket.create_connection'):
            self.patches.enter_context(patch(name, side_effect=AssertionError('Network forbidden')))
        def forbid_default(*_args):
            raise AssertionError('Default database access forbidden')
        event.listen(database.engine, 'connect', forbid_default)
        self.addCleanup(event.remove, database.engine, 'connect', forbid_default)
        self.patches.enter_context(patch.object(auth, 'verify_code', return_value=True))
        for obj, name in ((auth.login_limiter, 'check'), (auth.login_account_limiter, 'check_key'),
                          (auth.login_account_limiter, 'reset_key')):
            self.patches.enter_context(patch.object(obj, name))
        for module in (auth, exam_stage):
            self.patches.enter_context(patch.object(module, 'get_settings',
                return_value=SimpleNamespace(founder_admin_email='founder@example.org')))

    def fixture(self, *, audit, expired_object, desktop, reuse=False):
        engine = create_engine('sqlite:///:memory:')
        self.addCleanup(engine.dispose)
        Base.metadata.create_all(engine)
        db = Session(engine, autoflush=False)
        self.addCleanup(db.close)
        now = datetime.utcnow()
        user = User(first_name='Synthetic', last_name='Candidate', personal_id='99900000001',
            code='9990000001', phone='555000001', email='candidate@example.org', password_hash='test-only')
        db.add(user); db.flush()
        browser = UserSession(user_id=user.id, token='synthetic-browser', client_type='web',
            expires_at=now + timedelta(days=1), last_used_at=now)
        db.add(browser); db.flush()
        old = UserSession(user_id=user.id, token='synthetic-old',
            client_type='desktop' if desktop else 'web', device_id=A if desktop else None,
            expires_at=now + timedelta(days=1) if desktop else now - timedelta(days=1),
            last_used_at=now if reuse else now - timedelta(seconds=121))
        db.add(old); db.flush()
        old_id = old.id
        db.commit()
        if not expired_object:
            db.refresh(old)
        if audit:
            enable_audit(db)
        return db, old, old_id

    def login(self, db, device=None):
        headers = [(b'user-agent', b'Chrome/130')]
        if device:
            headers = [(b'user-agent', b'Electron/39.0'), (b'x-gipc-device-id', device.encode())]
        request = Request({'type': 'http', 'method': 'POST', 'path': '/auth/login',
            'headers': headers, 'client': ('203.0.113.99', 1234)})
        with warnings.catch_warnings():
            # A warning must fail the test, never be hidden or counted as success.
            warnings.simplefilter('error', SAWarning)
            return auth.login(request, LoginRequest(email='candidate@example.org', password='Synthetic123!'), db)

    def assert_replacement(self, *, desktop):
        for audit in (False, True):
            for expired_object in (False, True):
                with self.subTest(audit=audit, expired_object=expired_object, desktop=desktop):
                    db, old, old_id = self.fixture(audit=audit, expired_object=expired_object, desktop=desktop)
                    response = self.login(db, B if desktop else None)
                    self.assertTrue(inspect(old).detached)
                    self.assertFalse(inspect(old).persistent)
                    fresh = db.scalar(select(UserSession).where(UserSession.token == response.token))
                    self.assertIsNot(fresh, old)
                    self.assertEqual(fresh.id, old_id, 'Fixture must exercise SQLite primary-key reuse')
                    self.assertIs(db.get(UserSession, old_id), fresh)
                    self.assertEqual(set(db.scalars(select(UserSession.token))), {'synthetic-browser', response.token})
                    records = db.scalars(select(AuditEvent).order_by(AuditEvent.id)).all()
                    self.assertEqual([row.action for row in records],
                        ['user_sessions.deleted', 'user_sessions.created'] if audit else [])

    def test_expired_login_pruning_detaches_old_identity_before_id_reuse(self):
        self.assert_replacement(desktop=False)

    def test_desktop_cleanup_detaches_old_identity_before_id_reuse(self):
        self.assert_replacement(desktop=True)

    def test_same_device_login_preserves_existing_identity_and_token(self):
        for audit in (False, True):
            for expired_object in (False, True):
                with self.subTest(audit=audit, expired_object=expired_object):
                    db, old, old_id = self.fixture(audit=audit, expired_object=expired_object, desktop=True, reuse=True)
                    response = self.login(db, A)
                    self.assertEqual(response.token, 'synthetic-old')
                    self.assertTrue(inspect(old).persistent)
                    self.assertIs(db.get(UserSession, old_id), old)
                    self.assertEqual(set(db.scalars(select(UserSession.token))), {'synthetic-browser', 'synthetic-old'})
                    self.assertEqual(list(db.scalars(select(AuditEvent.action))), ['auth.login'] if audit else [])

    def test_failed_commit_restores_deleted_identity_and_tokens(self):
        for audit in (False, True):
            for desktop in (False, True):
                with self.subTest(audit=audit, desktop=desktop):
                    db, old, old_id = self.fixture(audit=audit, expired_object=True, desktop=desktop)
                    with patch.object(db, 'commit', side_effect=RuntimeError('synthetic login commit failure')):
                        with self.assertRaises(HTTPException) as failed:
                            self.login(db, B if desktop else None)
                    self.assertEqual(failed.exception.status_code, 500)
                    self.assertTrue(inspect(old).persistent)
                    self.assertIs(db.get(UserSession, old_id), old)
                    self.assertEqual(set(db.scalars(select(UserSession.token))), {'synthetic-browser', 'synthetic-old'})
                    self.assertEqual(db.scalars(select(AuditEvent)).all(), [])


if __name__ == '__main__':
    unittest.main()
