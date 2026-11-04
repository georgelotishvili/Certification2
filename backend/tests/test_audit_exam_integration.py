"""Audit-enabled exam contracts and SQLite races; synthetic data, no network."""
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from sqlalchemy import create_engine, event, select, update
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from backend.app import database
from backend.app.models import AuditEvent, Base, User, UserSession, Answer
from backend.app.services.audit_log import enable_audit, set_audit_actor
from backend.app.services import audit_log as journal
from backend.tests import test_offline_attempts as offline_contract
from backend.tests import test_desktop_session_ownership as ownership_contract


def forbid_external(test):
    for name in ('smtplib.SMTP', 'smtplib.SMTP_SSL', 'socket.create_connection'):
        test.enterContext(patch(name, side_effect=AssertionError('Network forbidden')))
    def forbid_default(*_):
        raise AssertionError('Default database forbidden')
    event.listen(database.engine, 'connect', forbid_default)
    test.addCleanup(event.remove, database.engine, 'connect', forbid_default)


class AuditEnabledOfflineHTTPTests(offline_contract.OfflineAttemptHTTPTests):
    """Run every existing offline HTTP contract with the journal enabled."""
    def setUp(self):
        super().setUp()
        forbid_external(self)
        enable_audit(self.db)

    def test_final_events_use_candidate_actor_and_receipt_retries_add_no_event(self):
        prepared, started = self.theory()
        payload = self.theory_payload(prepared)
        result = self.theory_final(prepared, started, payload)
        self.assertEqual(result.status_code, 200, result.text)
        finished = self.db.scalars(select(AuditEvent).where(AuditEvent.action == 'exam.finished')).all()
        self.assertEqual(len(finished), 1)
        self.assertEqual(finished[0].actor_id, 1)
        count = len(self.db.scalars(select(AuditEvent)).all())
        self.assertEqual(self.theory_final(prepared, started, payload).json(), result.json())
        self.assertEqual(len(self.db.scalars(select(AuditEvent)).all()), count)
        for kind, stage, table in (
            ('multi-apartment', 'project_stage_1', 'multi_apartment_evaluations'),
            ('multi-functional', 'project_stage_2', 'multi_functional_evaluations'),
        ):
            project, _, begin = self.project(kind, stage)
            final = self.project_payload(project, begin)
            response = self.client.post(f'/public/{kind}/evaluations', json=final)
            self.assertEqual(response.status_code, 201, response.text)
            entries = self.db.scalars(select(AuditEvent).where(AuditEvent.target_type == table)).all()
            self.assertEqual(len(entries), 1)
            self.assertEqual(entries[0].actor_id, 1)
            count = len(self.db.scalars(select(AuditEvent)).all())
            self.assertEqual(self.client.post(f'/public/{kind}/evaluations', json=final).json(), response.json())
            self.assertEqual(len(self.db.scalars(select(AuditEvent)).all()), count)

    def test_answer_batch_and_presence_do_not_write_audit_events(self):
        self.grant('theory')
        prepared = self.prepare_theory()
        headers = {'Authorization': 'Bearer ' + prepared['token']}
        path = f"/exam/{prepared['session_id']}"
        self.assertEqual(self.client.get(path + '/all-questions', headers=headers).status_code, 200)
        self.assertEqual(self.client.post(path + '/begin', headers=headers).status_code, 200)
        statements = []
        def capture(_conn, _cursor, statement, _params, _context, _many):
            statements.append(statement)
        event.listen(self.engine, 'before_cursor_execute', capture)
        try:
            response = self.client.post(path + '/answers/batch', headers=headers,
                json={'answers': [{'question_id': 1, 'option_id': 1}]})
            self.assertEqual(response.status_code, 200, response.text)
            response = self.client.get('/users/me', headers=self.headers())
            self.assertEqual(response.status_code, 200, response.text)
        finally:
            event.remove(self.engine, 'before_cursor_execute', capture)
        self.assertFalse(any('audit_events' in sql.lower() for sql in statements), statements)

    def test_failed_journal_insert_rolls_back_final_and_original_payload_can_retry(self):
        prepared, started = self.theory()
        payload = self.theory_payload(prepared)
        def fail_audit(_conn, _cursor, statement, _params, _context, _many):
            if statement.lower().startswith('insert into audit_events'):
                raise RuntimeError('synthetic journal write failure')
        event.listen(self.engine, 'before_cursor_execute', fail_audit)
        try:
            with self.assertRaisesRegex(RuntimeError, 'synthetic journal write failure'):
                self.theory_final(prepared, started, payload)
        finally:
            event.remove(self.engine, 'before_cursor_execute', fail_audit)
        self.db.expire_all()
        self.assertEqual(self.db.scalars(select(Answer)).all(), [])
        result = self.theory_final(prepared, started, payload)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()['score_percent'], 100)


class AuditEnabledDeviceHTTPTests(ownership_contract.DesktopAttemptOwnershipHTTPTests):
    def setUp(self):
        super().setUp()
        forbid_external(self)
        enable_audit(self.db)


class AuditWriteIsolationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory(prefix='gipc-audit-isolation-')
        self.addCleanup(self.tmp.cleanup)
        self.engine = create_engine('sqlite:///' + str(Path(self.tmp.name) / 'synthetic.db'),
                                    connect_args={'timeout': 0.05})
        self.addCleanup(self.engine.dispose)
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine, autoflush=False)
        self.addCleanup(self.db.close)
        self.user = User(personal_id='99900000001', code='9990000001',
            first_name='Synthetic', last_name='Audit', phone='555000000',
            email='audit@example.org', password_hash='unused')
        self.db.add(self.user); self.db.commit()
        self.user_id = self.user.id
        enable_audit(self.db)
        set_audit_actor(self.db, self.user)

    def test_untracked_transition_update_does_not_flush_or_read_audit_snapshots(self):
        self.user.candidate_category = 'A'
        statements = []
        def capture(_conn, _cursor, statement, _params, _context, _many):
            statements.append(statement)
        event.listen(self.engine, 'before_cursor_execute', capture)
        try:
            self.db.execute(update(User).where(User.id == self.user_id)
                .values(exam_permission=User.exam_permission).execution_options(synchronize_session=False))
        finally:
            event.remove(self.engine, 'before_cursor_execute', capture)
        self.assertEqual(len(statements), 1, statements)
        self.assertTrue(statements[0].lower().startswith('update users'), statements)
        self.assertIn(self.user, self.db.dirty)
        self.db.rollback()
        self.assertEqual(self.db.scalars(select(AuditEvent)).all(), [])

    def test_bulk_snapshot_is_locked_before_concurrent_writer_can_change_it(self):
        observed = []
        # This listener runs inside audit's invoke_statement(), after its
        # snapshot but before the actual mutation. A second DB connection must
        # not be able to change that snapshot's row in this interval.
        def try_competing_writer(state):
            if state.session is not self.db or not state.is_update:
                return None
            with self.engine.connect() as competitor:
                try:
                    competitor.execute(update(User).where(User.id == self.user_id)
                        .values(candidate_category='C'))
                    competitor.commit()
                    observed.append('incorrectly committed')
                except OperationalError as error:
                    self.assertIn('locked', str(error).lower())
                    competitor.rollback()
                    observed.append('locked')
            return None
        event.listen(Session, 'do_orm_execute', try_competing_writer)
        try:
            self.db.execute(update(User).where(User.id == self.user_id).values(candidate_category='A'))
            self.db.commit()
        finally:
            event.remove(Session, 'do_orm_execute', try_competing_writer)
        self.assertEqual(observed, ['locked'])
        entries = self.db.scalars(select(AuditEvent)).all()
        self.assertEqual(len(entries), 1)
        self.assertEqual(json.loads(entries[0].details)['candidate_category'], {'before': None, 'after': 'A'})

    def test_orm_audit_uses_actual_post_flush_row_not_stale_unmodified_attributes(self):
        # Both operators originally read an empty category. The other writer
        # changes it; this request only changes the administrator flag.
        self.assertIsNone(self.user.candidate_category)
        with self.engine.begin() as concurrent:
            concurrent.execute(update(User).where(User.id == self.user_id).values(candidate_category='C'))
        self.user.is_admin = True
        self.db.commit()
        entry = self.db.scalars(select(AuditEvent)).one()
        changes = json.loads(entry.details)
        self.assertEqual(changes, {'is_admin': {'before': False, 'after': True}})
        self.db.refresh(self.user)
        self.assertEqual(self.user.candidate_category, 'C')

    def test_multiple_orm_updates_take_only_one_snapshot_lock_per_flush(self):
        other = User(personal_id='99900000002', code='9990000002', first_name='Other',
            last_name='Synthetic', phone='555000001', email='other@example.org', password_hash='unused')
        self.db.add(other); self.db.commit()
        self.user.candidate_category = 'A'
        other.candidate_category = 'B'
        statements = []
        def capture(_conn, _cursor, statement, _params, _context, _many):
            statements.append(statement)
        event.listen(self.engine, 'before_cursor_execute', capture)
        try:
            self.db.commit()
        finally:
            event.remove(self.engine, 'before_cursor_execute', capture)
        locks = [sql for sql in statements if 'SET id=id WHERE 0' in sql]
        self.assertEqual(len(locks), 1, statements)

    def test_commit_clears_logout_marker_but_keeps_authenticated_actor(self):
        actor = dict(self.db.info['audit_actor'])
        self.db.info['audit_logout_session_id'] = 123
        self.db.commit()
        self.assertNotIn('audit_logout_session_id', self.db.info)
        self.assertEqual(self.db.info['audit_actor'], actor)

    def test_concurrent_first_enable_registers_each_hook_only_once(self):
        barrier = Barrier(8)
        def run(_):
            db = SimpleNamespace(info={})
            barrier.wait()
            enable_audit(db)
            return db.info['audit_enabled']
        with patch.object(journal, '_HOOKS_INSTALLED', False), \
             patch.object(journal.event, 'contains', return_value=False) as contains, \
             patch.object(journal.event, 'listen') as listen:
            with ThreadPoolExecutor(max_workers=8) as pool:
                self.assertTrue(all(pool.map(run, range(8))))
            self.assertEqual(contains.call_count, 5)
            self.assertEqual(listen.call_count, 5)


if __name__ == '__main__':
    unittest.main()
