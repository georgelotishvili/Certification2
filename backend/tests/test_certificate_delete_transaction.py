from __future__ import annotations

from asyncio import CancelledError
from contextlib import ExitStack
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import Session

try:
    from backend.app import database
    from backend.app.models import Base, Certificate, Comment, ExpertUpload, Rating, User
    from backend.app.routers import users
    from backend.app.services import media_storage
except ModuleNotFoundError:
    from app import database
    from app.models import Base, Certificate, Comment, ExpertUpload, Rating, User
    from app.routers import users
    from app.services import media_storage


class CertificateDeleteTransactionTests(unittest.TestCase):
    def setUp(self):
        def forbid_default(*_args):
            raise AssertionError("Default database access forbidden")

        event.listen(database.engine, "connect", forbid_default)
        self.addCleanup(event.remove, database.engine, "connect", forbid_default)
        self.engine = create_engine("sqlite:///:memory:")
        self.addCleanup(self.engine.dispose)

        @event.listens_for(self.engine, "connect")
        def enable_foreign_keys(connection, _record):
            connection.execute("PRAGMA foreign_keys=ON")

        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.addCleanup(self.db.close)
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.media = Path(self.stack.enter_context(TemporaryDirectory(prefix="gipc-cert-delete-")))
        self.stack.enter_context(patch.object(media_storage, "_MEDIA_ROOT_CACHE", self.media))
        self.admin = self.stack.enter_context(patch.object(users, "_require_admin", return_value=SimpleNamespace(email="founder@example.invalid")))
        self.stack.enter_context(patch.object(users, "get_settings", return_value=SimpleNamespace(founder_admin_email="founder@example.invalid")))
        for name in ("smtplib.SMTP", "smtplib.SMTP_SSL"):
            self.stack.enter_context(patch(name, side_effect=AssertionError("SMTP forbidden")))

        target = User(personal_id="99900000001", first_name="Synthetic", last_name="Target", phone="555000001",
                      email="target@example.invalid", password_hash="unused", code="9990000001", photo_path="photos/target.jpg")
        other = User(personal_id="99900000002", first_name="Synthetic", last_name="Other", phone="555000002",
                     email="other@example.invalid", password_hash="unused", code="9990000002")
        self.db.add_all([target, other])
        self.db.flush()
        self.target_id, self.other_id = target.id, other.id
        cert = Certificate(user_id=target.id, level="expert", unique_code="EX-cert-target", file_path=f"certificates/{target.id}/target.pdf")
        self.db.add_all([
            cert,
            Certificate(user_id=other.id, level="expert", unique_code="EX-cert-other", file_path=f"certificates/{other.id}/other.pdf"),
            ExpertUpload(user_id=target.id, unique_code="EX-upload-target", expertise_path="expert/EX-upload-target/expertise.pdf", project_path="expert/EX-upload-target/project.pdf"),
            ExpertUpload(user_id=other.id, unique_code="EX-upload-other", expertise_path="expert/EX-upload-other/expertise.pdf", project_path="expert/EX-upload-other/project.pdf"),
            Rating(target_user_id=target.id, author_user_id=other.id, score=5),
            Rating(target_user_id=other.id, author_user_id=target.id, score=7),
            Comment(target_user_id=target.id, author_user_id=other.id, message="Synthetic target comment"),
            Comment(target_user_id=other.id, author_user_id=target.id, message="Synthetic other comment"),
        ])
        self.db.commit()
        self.cert_id = cert.id
        self.targets = [f"certificates/{target.id}/target.pdf", "expert/EX-cert-target/certificate-test.pdf",
                        "expert/EX-upload-target/expertise.pdf", "expert/EX-upload-target/project.pdf"]
        self.kept = ["photos/target.jpg", f"certificates/{other.id}/other.pdf", "expert/EX-cert-other/certificate-test.pdf",
                     "expert/EX-upload-other/expertise.pdf", "expert/EX-upload-other/project.pdf"]
        for relative in self.targets + self.kept:
            file_path = self.media / relative
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.write_bytes(b"synthetic original")
        self.before = self.snapshot()

    def snapshot(self):
        return {model.__tablename__: [tuple(row) for row in self.db.execute(select(model.__table__).order_by(model.id))]
                for model in (User, Certificate, ExpertUpload, Rating, Comment)}

    def delete(self):
        return users.delete_certificate(self.target_id, authorization=None, db=self.db)

    def assert_all_files_exist(self):
        for relative in self.targets + self.kept:
            self.assertEqual((self.media / relative).read_bytes(), b"synthetic original")

    def test_commit_failure_retains_all_files_and_rolls_back_related_rows(self):
        with patch.object(self.db, "commit", side_effect=RuntimeError("synthetic failed commit")):
            with self.assertRaisesRegex(RuntimeError, "failed commit"):
                self.delete()
        self.assertEqual(self.snapshot(), self.before)
        self.assert_all_files_exist()

    def test_precommit_cancellation_retains_files_and_rows(self):
        with patch.object(self.db, "commit", side_effect=CancelledError()):
            with self.assertRaises(CancelledError):
                self.delete()
        self.assertEqual(self.snapshot(), self.before)
        self.assert_all_files_exist()

    def test_success_cleans_targeted_files_only_after_commit_and_keeps_profile_photo(self):
        original_unlink = Path.unlink

        def check_committed(path, *args, **kwargs):
            self.assertIsNone(self.db.get(Certificate, self.cert_id))
            self.assertIsNone(self.db.scalar(select(ExpertUpload).where(ExpertUpload.user_id == self.target_id)))
            self.assertIsNone(self.db.scalar(select(Rating).where(Rating.target_user_id == self.target_id)))
            return original_unlink(path, *args, **kwargs)

        with patch.object(Path, "unlink", check_committed):
            self.assertIsNone(self.delete())
        for relative in self.targets:
            self.assertFalse((self.media / relative).exists())
        for relative in self.kept:
            self.assertEqual((self.media / relative).read_bytes(), b"synthetic original")
        self.assertEqual(self.db.get(User, self.target_id).photo_path, "photos/target.jpg")
        self.assertIsNotNone(self.db.scalar(select(Certificate).where(Certificate.user_id == self.other_id)))
        self.assertEqual(self.db.query(Rating).count(), 1)
        self.assertEqual(self.db.query(Comment).count(), 1)

    def test_non_founder_admin_cannot_delete_or_touch_files(self):
        self.admin.return_value = SimpleNamespace(email="other-admin@example.invalid")
        with self.assertRaises(HTTPException) as error:
            self.delete()
        self.assertEqual(error.exception.status_code, 403)
        self.assertEqual(self.snapshot(), self.before)
        self.assert_all_files_exist()

    def test_postcommit_interruption_does_not_rollback_deleted_rows_or_touch_others(self):
        with patch.object(users, "_delete_certificate_files", side_effect=CancelledError()), patch.object(self.db, "rollback") as rollback:
            with self.assertRaises(CancelledError):
                self.delete()
        rollback.assert_not_called()
        self.assertIsNone(self.db.get(Certificate, self.cert_id))
        self.assert_all_files_exist()


if __name__ == "__main__":
    unittest.main()
