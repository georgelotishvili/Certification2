"""Statement HTTP defaults and upload atomicity; synthetic DB/media/mail only."""
from asyncio import CancelledError
from contextlib import ExitStack
from datetime import datetime, timedelta
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
import zipfile

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from backend.app.models import Base, Statement, User, UserSession
from backend.app.routers import statements
from backend.app.services import media_storage


def upload(name, content=b"synthetic attachment"):
    return UploadFile(BytesIO(content), filename=name)


class StatementUploadTransactionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory(prefix="gipc-statement-upload-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.engine = create_engine("sqlite:///:memory:",
            connect_args={"check_same_thread": False}, poolclass=StaticPool)
        self.addCleanup(self.engine.dispose)
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.addCleanup(self.db.close)
        self.user = User(first_name="Synthetic", last_name="Candidate",
            personal_id="99900000077", code="9990000077", phone="555000077",
            email="synthetic@example.invalid", password_hash="unused")
        self.db.add(self.user)
        self.db.flush()
        self.db.add(UserSession(user_id=self.user.id, token="test-only",
            expires_at=datetime.utcnow() + timedelta(hours=1)))
        self.db.commit()
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(media_storage, "_MEDIA_ROOT_CACHE", self.root))
        self.mail = self.stack.enter_context(patch.object(statements, "send_statement_confirmation_email"))
        for target in ("smtplib.SMTP", "smtplib.SMTP_SSL"):
            self.stack.enter_context(patch(target, side_effect=AssertionError("Real SMTP forbidden")))
        app = FastAPI()
        app.include_router(statements.router, prefix="/statements")
        def override_database():
            yield self.db
        app.dependency_overrides[statements.get_db] = override_database
        self.client = self.stack.enter_context(TestClient(app))
        self.headers = {"Authorization": "Bearer test-only"}

    def submit(self, **kwargs):
        return statements.create_statement(message="Synthetic request", is_exam_application=False,
            authorization="Bearer test-only", db=self.db, **kwargs)

    def assert_empty(self):
        self.assertEqual(list(self.db.scalars(select(Statement))), [])
        self.assertEqual([p for p in self.root.rglob("*") if p.is_file()], [])
        self.mail.assert_not_called()

    def test_http_ordinary_message_without_exam_flag_needs_no_identity_files(self):
        response = self.client.post("/statements", data={"message": "Other request"}, headers=self.headers)
        self.assertEqual(response.status_code, 201, response.text)
        stored = self.db.get(Statement, response.json()["id"])
        self.assertIsNone(stored.seen_at)
        self.assertIsNone(stored.answered_at)
        self.assertIsNone(stored.attachment_path)
        self.mail.assert_called_once_with(self.user.email, "Synthetic Candidate")

    def test_http_exam_flag_requires_all_three_document_slots(self):
        for provided in (0, 1, 2):
            with self.subTest(provided=provided):
                files = [(slot, ("proof.pdf", b"test", "application/pdf"))
                    for slot in ("id_attachments", "diploma_attachments", "experience_attachments")[:provided]]
                response = self.client.post("/statements", headers=self.headers,
                    data={"message": "Exam request", "is_exam_application": "true"}, files=files)
                self.assertEqual(response.status_code, 400, response.text)
                self.assert_empty()

    def test_http_exam_submission_preserves_all_three_slots(self):
        files = [(slot, (name, name.encode(), "application/pdf")) for slot, name in
            (("id_attachments", "identity.pdf"), ("diploma_attachments", "diploma.pdf"),
             ("experience_attachments", "experience.pdf"))]
        response = self.client.post("/statements", headers=self.headers,
            data={"message": "Exam request", "is_exam_application": "true"}, files=files)
        self.assertEqual(response.status_code, 201, response.text)
        stored = self.db.get(Statement, response.json()["id"])
        for path, expected in ((stored.attachment_path, b"identity.pdf"),
                (stored.attachment2_path, b"diploma.pdf"), (stored.attachment3_path, b"experience.pdf")):
            self.assertEqual(media_storage.resolve_storage_path(path).read_bytes(), expected)
        self.mail.assert_called_once()

    def test_partial_archive_is_removed_when_zip_write_fails(self):
        original = zipfile.ZipFile.write
        def fail_after_write(archive, *args, **kwargs):
            original(archive, *args, **kwargs)
            raise OSError("synthetic disk failure")
        with patch.object(zipfile.ZipFile, "write", fail_after_write):
            with self.assertRaises(HTTPException) as caught:
                self.submit(attachments=[upload("one.pdf"), upload("two.pdf")])
        self.assertEqual(caught.exception.status_code, 500)
        self.assert_empty()

    def test_combined_archive_limit_is_enforced_without_leaving_partial_files(self):
        with patch.object(statements, "MAX_BYTES", 4):
            with self.assertRaises(HTTPException) as caught:
                self.submit(attachments=[upload("one.pdf", b"123"), upload("two.pdf", b"45")])
            self.assertEqual(caught.exception.status_code, 413)
            self.assert_empty()
            created = self.submit(attachments=[upload("one.pdf", b"12"), upload("two.pdf", b"34")])
        stored = self.db.get(Statement, created.id)
        with zipfile.ZipFile(media_storage.resolve_storage_path(stored.attachment_path)) as archive:
            self.assertEqual([archive.read(n) for n in archive.namelist()], [b"12", b"34"])
        self.mail.assert_called_once()

    def test_cancelled_zip_write_cleans_prior_slot_and_rolls_back(self):
        with patch.object(zipfile.ZipFile, "write", side_effect=CancelledError("synthetic interruption")):
            with self.assertRaises(CancelledError):
                statements.create_statement(message="Synthetic exam", is_exam_application=True,
                    id_attachments=[upload("identity.pdf")],
                    diploma_attachments=[upload("one.pdf"), upload("two.pdf")],
                    experience_attachments=[upload("experience.pdf")],
                    authorization="Bearer test-only", db=self.db)
        self.assert_empty()

    def test_commit_failure_removes_new_files_but_preserves_existing_attachment(self):
        old = self.submit(attachment=upload("original.pdf", b"keep"))
        old_row = self.db.get(Statement, old.id)
        old_path = media_storage.resolve_storage_path(old_row.attachment_path)
        self.mail.reset_mock()
        with patch.object(self.db, "commit", side_effect=RuntimeError("synthetic commit failure")):
            with self.assertRaises(HTTPException) as caught:
                self.submit(attachments=[upload("one.pdf"), upload("two.pdf")])
        self.assertEqual(caught.exception.status_code, 500)
        self.assertEqual([r.id for r in self.db.scalars(select(Statement))], [old.id])
        self.assertEqual(old_path.read_bytes(), b"keep")
        self.assertEqual([p for p in self.root.rglob("*") if p.is_file()], [old_path])
        self.mail.assert_not_called()

    def test_duplicate_archive_names_never_shadow_a_different_file(self):
        created = self.submit(attachments=[upload("proof.pdf", b"first"),
            upload("proof.pdf", b"second"), upload("proof_2.pdf", b"third"),
            upload(r"C:\fakepath\proof.pdf", b"fourth")])
        row = self.db.get(Statement, created.id)
        with zipfile.ZipFile(media_storage.resolve_storage_path(row.attachment_path)) as archive:
            names = archive.namelist()
            self.assertEqual(len(set(n.casefold() for n in names)), 4)
            self.assertTrue(all("/" not in n and "\\" not in n for n in names))
            self.assertEqual([archive.read(n) for n in names], [b"first", b"second", b"third", b"fourth"])

    def test_existing_zip_destination_is_not_overwritten_or_deleted(self):
        existing = self.root / "statements" / str(self.user.id) / "1" / "collision.zip"
        existing.parent.mkdir(parents=True)
        existing.write_bytes(b"keep original")
        from types import SimpleNamespace
        with patch.object(statements, "uuid4", return_value=SimpleNamespace(hex="collision")):
            with self.assertRaises(HTTPException) as caught:
                self.submit(attachments=[upload("one.pdf"), upload("two.docx")])
        self.assertEqual(caught.exception.status_code, 500)
        self.assertEqual(existing.read_bytes(), b"keep original")
        self.assertEqual(list(self.db.scalars(select(Statement))), [])
        self.mail.assert_not_called()

    def test_existing_temporary_destination_is_not_deleted_on_collision(self):
        existing = self.root / "statements" / str(self.user.id) / "1" / "tmp_collision.pdf"
        existing.parent.mkdir(parents=True)
        existing.write_bytes(b"keep old temporary data")
        from types import SimpleNamespace
        with patch.object(statements, "uuid4", return_value=SimpleNamespace(hex="collision")):
            with self.assertRaises(HTTPException) as caught:
                self.submit(attachments=[upload("one.pdf"), upload("two.docx")])
        self.assertEqual(caught.exception.status_code, 500)
        self.assertEqual(existing.read_bytes(), b"keep old temporary data")
        self.assertEqual(list(self.db.scalars(select(Statement))), [])
        self.mail.assert_not_called()


if __name__ == "__main__":
    unittest.main()
