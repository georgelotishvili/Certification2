"""Deletion tests use only in-memory SQLite, temporary files and synthetic people."""
from contextlib import ExitStack
from datetime import date, datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import Session

try:
    from backend.app.models import (
        Base, Certificate, Exam, ExamMedia, ExpertUpload, PlanningLetter,
        Session as ExamSession, Statement, User, UserCodeReservation,
    )
    from backend.app.routers import admin
    from backend.app.services import media_storage
except ModuleNotFoundError:
    from app.models import (
        Base, Certificate, Exam, ExamMedia, ExpertUpload, PlanningLetter,
        Session as ExamSession, Statement, User, UserCodeReservation,
    )
    from app.routers import admin
    from app.services import media_storage


class AdminDeleteTransactionTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.temp = self.stack.enter_context(TemporaryDirectory(prefix="gipc-admin-delete-test-"))
        self.root = Path(self.temp) / "media"
        self.root.mkdir()
        self.stack.enter_context(patch.object(media_storage, "_MEDIA_ROOT_CACHE", self.root))
        self.engine = create_engine("sqlite:///:memory:")
        event.listen(self.engine, "connect", lambda connection, _: connection.execute("PRAGMA foreign_keys=ON"))
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.addCleanup(self.engine.dispose)
        self.addCleanup(self.db.close)
        self.founder = self.user(1, email="founder@example.invalid", is_admin=True)
        self.target = self.user(2)
        self.other = self.user(3)
        self.stack.enter_context(patch.object(admin, "get_settings", return_value=SimpleNamespace(founder_admin_email=self.founder.email)))
        self.stack.enter_context(patch.object(admin, "_require_admin", return_value=self.founder))
        self.stack.enter_context(patch.object(admin, "_is_founder_actor", return_value=True))
        for name in ("smtplib.SMTP", "smtplib.SMTP_SSL"):
            self.stack.enter_context(patch(name, side_effect=AssertionError("Real email prohibited")))

    def user(self, number, **extra):
        values = dict(id=number, first_name="Synthetic", last_name=f"Person{number}",
                      personal_id=f"{number:011d}", code=f"{number:010d}", phone="555000000",
                      email=f"person{number}@example.invalid", password_hash="synthetic-only")
        values.update(extra)
        user = User(**values)
        self.db.add(user)
        self.db.commit()
        return user

    def write(self, rel):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"synthetic-file")
        return path

    def seed_files(self, user):
        uid = user.id
        paths = []
        user.photo_path = f"photos/person-{uid}.jpg"
        user.photo_filename = "photo.jpg"
        paths.append(self.write(user.photo_path))
        statement = Statement(user_id=uid, message="Synthetic application")
        self.db.add(statement)
        self.db.flush()
        for field, filename in (("attachment_path", "one.pdf"), ("attachment2_path", "two.pdf"), ("attachment3_path", "three.pdf")):
            rel = f"statements/{uid}/{statement.id}/{filename}"
            setattr(statement, field, rel)
            paths.append(self.write(rel))
        cert = Certificate(user_id=uid, file_path=f"certificates/{uid}/certificate.pdf", level="architect")
        paths.append(self.write(cert.file_path))
        expert = ExpertUpload(user_id=uid, unique_code=f"EX-synthetic-{uid}",
                              expertise_path=f"expert/EX-synthetic-{uid}/expertise.pdf",
                              project_path=f"expert/EX-synthetic-{uid}/project.pdf")
        paths.extend(self.write(rel) for rel in (expert.expertise_path, expert.project_path))
        letter = PlanningLetter(user_id=uid, kind="exam", event_date=date(2030, 1, 1), event_time="10:00",
                                request_id=f"synthetic-{uid}", request_fingerprint="synthetic", to_email=user.email,
                                subject="Synthetic letter", body="Synthetic body", created_by=self.founder.email,
                                status="simulated", statement_id=statement.id,
                                attachment_path=f"planning/letters/{uid}/letter.pdf")
        paths.append(self.write(letter.attachment_path))
        exam = Exam(title=f"Synthetic exam {uid}", gate_password="synthetic")
        self.db.add(exam)
        self.db.flush()
        session = ExamSession(exam_id=exam.id, user_id=uid, token=f"synthetic-exam-{uid}",
                              ends_at=datetime.utcnow() - timedelta(days=1), active=False)
        self.db.add(session)
        self.db.flush()
        media = ExamMedia(session_id=session.id, storage_path=f"session_{session.id}/camera.webm", filename="camera.webm")
        paths.append(self.write(media.storage_path))
        self.db.add_all([user, cert, expert, letter, media])
        self.db.commit()
        return dict(paths=paths, statement_id=statement.id, session_id=session.id,
                    letter_id=letter.id, expert_id=expert.id, user_id=uid,
                    personal_id=user.personal_id, code=user.code)

    def delete_user(self, user_id):
        return admin.admin_delete_user(user_id, authorization="synthetic", db=self.db)

    def fail_commit_after_flush(self):
        def failed():
            self.db.flush()
            raise RuntimeError("Synthetic commit failure")
        return patch.object(self.db, "commit", side_effect=failed)

    def test_user_delete_cleans_all_owned_files_after_commit_and_preserves_other_people(self):
        target = self.seed_files(self.target)
        other = self.seed_files(self.other)
        untracked = self.write(f"expert/EX-synthetic-{target['user_id']}/unrelated.txt")
        real_commit = self.db.commit
        def commit_before_cleanup():
            self.assertTrue(all(path.exists() for path in target["paths"]))
            real_commit()
        with patch.object(self.db, "commit", side_effect=commit_before_cleanup):
            self.delete_user(target["user_id"])
        self.assertIsNone(self.db.get(User, target["user_id"]))
        self.assertFalse(any(path.exists() for path in target["paths"]))
        self.assertTrue(all(path.exists() for path in other["paths"]))
        self.assertTrue(untracked.exists(), "Never recursively delete unknown files")
        self.assertEqual(self.db.get(UserCodeReservation, target["personal_id"]).code, target["code"])
        self.assertIsNone(self.db.get(ExpertUpload, target["expert_id"]))
        self.assertIsNone(self.db.get(PlanningLetter, target["letter_id"]))
        for rel in (f"session_{target['session_id']}", f"statements/{target['user_id']}",
                    f"planning/letters/{target['user_id']}", f"certificates/{target['user_id']}"):
            self.assertFalse((self.root / rel).exists())

    def test_user_commit_failure_retains_all_files_and_rows(self):
        target = self.seed_files(self.target)
        with self.fail_commit_after_flush(), self.assertRaises(RuntimeError):
            self.delete_user(target["user_id"])
        self.db.rollback()
        self.assertIsNotNone(self.db.get(User, target["user_id"]))
        self.assertIsNotNone(self.db.get(ExpertUpload, target["expert_id"]))
        self.assertIsNotNone(self.db.get(PlanningLetter, target["letter_id"]))
        self.assertTrue(all(path.exists() for path in target["paths"]))
        self.assertIsNone(self.db.get(UserCodeReservation, target["personal_id"]))

    def test_statement_commit_failure_keeps_attachments_and_letter_link(self):
        target = self.seed_files(self.target)
        with self.fail_commit_after_flush(), self.assertRaises(RuntimeError):
            admin.admin_delete_statement(target["statement_id"], authorization="synthetic", db=self.db)
        self.db.rollback()
        self.assertIsNotNone(self.db.get(Statement, target["statement_id"]))
        self.assertEqual(self.db.get(PlanningLetter, target["letter_id"]).statement_id, target["statement_id"])
        self.assertTrue(all(path.exists() for path in target["paths"]))

    def test_statement_success_cleans_three_slots_after_commit(self):
        target = self.seed_files(self.target)
        admin.admin_delete_statement(target["statement_id"], authorization="synthetic", db=self.db)
        self.assertIsNone(self.db.get(Statement, target["statement_id"]))
        self.assertEqual(self.db.get(PlanningLetter, target["letter_id"]).statement_id, -1)
        for path in target["paths"]:
            self.assertEqual(path.exists(), "statements" not in path.parts)

    def test_result_commit_failure_keeps_video_and_session(self):
        target = self.seed_files(self.target)
        with self.fail_commit_after_flush(), self.assertRaises(RuntimeError):
            admin.delete_result(target["session_id"], authorization="synthetic", db=self.db)
        self.db.rollback()
        self.assertIsNotNone(self.db.get(ExamSession, target["session_id"]))
        self.assertTrue(all(path.exists() for path in target["paths"]))

    def test_result_success_removes_only_its_video(self):
        target = self.seed_files(self.target)
        other = self.seed_files(self.other)
        admin.delete_result(target["session_id"], authorization="synthetic", db=self.db)
        self.assertFalse((self.root / f"session_{target['session_id']}").exists())
        self.assertTrue(all(path.exists() for path in other["paths"]))

    def test_photo_commit_failure_keeps_file_and_metadata(self):
        target = self.seed_files(self.target)
        old_path = self.target.photo_path
        with self.fail_commit_after_flush(), self.assertRaises(RuntimeError):
            admin.admin_delete_user_photo(target["user_id"], authorization="synthetic", db=self.db)
        self.db.rollback()
        self.assertEqual(self.db.get(User, target["user_id"]).photo_path, old_path)
        self.assertTrue((self.root / old_path).exists())

    def test_photo_success_does_not_remove_a_legacy_shared_photo(self):
        target = self.seed_files(self.target)
        shared = self.target.photo_path
        self.other.photo_path = shared
        self.db.commit()
        admin.admin_delete_user_photo(target["user_id"], authorization="synthetic", db=self.db)
        self.assertIsNone(self.db.get(User, target["user_id"]).photo_path)
        self.assertEqual(self.db.get(User, self.other.id).photo_path, shared)
        self.assertTrue((self.root / shared).exists())

    def test_photo_success_removes_only_target_photo(self):
        target = self.seed_files(self.target)
        other = self.seed_files(self.other)
        photo = self.root / self.target.photo_path
        admin.admin_delete_user_photo(target["user_id"], authorization="synthetic", db=self.db)
        self.assertFalse(photo.exists())
        self.assertIsNone(self.db.get(User, target["user_id"]).photo_path)
        self.assertTrue(all(path.exists() for path in other["paths"]))

    def test_post_commit_unlink_failure_does_not_restore_deleted_account(self):
        target = self.seed_files(self.target)
        with patch.object(Path, "unlink", side_effect=OSError("Synthetic locked file")):
            self.delete_user(target["user_id"])
        self.assertIsNone(self.db.get(User, target["user_id"]))
        self.assertTrue(all(path.exists() for path in target["paths"]))
        self.assertEqual(self.db.get(UserCodeReservation, target["personal_id"]).code, target["code"])

    def test_owner_containment_and_symlink_guard_prevent_other_file_cleanup(self):
        other = self.write("planning/letters/3/protected.pdf")
        outside = Path(self.temp) / "outside.pdf"
        outside.write_bytes(b"outside")
        for invalid in ("planning/letters/3/protected.pdf", "planning/letters/2/../3/protected.pdf", str(outside)):
            admin._cleanup_committed_media([(invalid, "planning/letters/2")], set())
        link = self.root / "planning/letters/2/link.pdf"
        link.parent.mkdir(parents=True, exist_ok=True)
        link.write_bytes(b"simulated-link")
        real_is_symlink = Path.is_symlink
        with patch.object(Path, "is_symlink", new=lambda path: path == link or real_is_symlink(path)):
            admin._cleanup_committed_media([("planning/letters/2/link.pdf", "planning/letters/2")], set())
        with patch.object(Path, "is_symlink", new=lambda path: path == link.parent or real_is_symlink(path)):
            admin._cleanup_committed_media([("planning/letters/2/link.pdf", "planning/letters/2")], {"planning/letters/2"})
        self.assertTrue(other.exists())
        self.assertTrue(outside.exists())
        self.assertTrue(link.exists())

    def test_retired_bulk_endpoint_never_writes_or_deletes(self):
        target = self.seed_files(self.target)
        with patch.object(self.db, "commit") as commit, patch.object(self.db, "delete") as delete:
            with self.assertRaises(HTTPException) as caught:
                admin.admin_delete_all_users(authorization="synthetic", db=self.db)
        self.assertEqual(caught.exception.status_code, 410)
        commit.assert_not_called()
        delete.assert_not_called()
        self.assertTrue(all(path.exists() for path in target["paths"]))
        self.assertEqual(len(self.db.scalars(select(User)).all()), 3)

    def test_retired_bulk_endpoint_still_requires_authentication(self):
        with patch.object(admin, "_require_admin", side_effect=HTTPException(401, "Unauthorized")):
            with self.assertRaises(HTTPException) as caught:
                admin.admin_delete_all_users(authorization=None, db=self.db)
        self.assertEqual(caught.exception.status_code, 401)


if __name__ == "__main__":
    unittest.main()
