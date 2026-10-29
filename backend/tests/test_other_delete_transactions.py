"""Synthetic, isolated regression tests for commit-before-file-delete behavior."""
from __future__ import annotations

from asyncio import CancelledError
from contextlib import ExitStack
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

try:
    from backend.app.models import AppFile, Base, ExpertUpload, SiteDocument, User
    from backend.app.routers import app_files, documents, expert_uploads
    from backend.app.services import media_storage
except ModuleNotFoundError:
    from app.models import AppFile, Base, ExpertUpload, SiteDocument, User
    from app.routers import app_files, documents, expert_uploads
    from app.services import media_storage


class OtherDeleteTransactionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory(prefix="gipc-delete-transaction-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.media = self.root / "media"
        self.docs = self.root / "documents"
        self.bundled = self.root / "bundled"
        for path in (self.media, self.docs, self.bundled):
            path.mkdir()

        self.engine = create_engine("sqlite:///:memory:")
        self.addCleanup(self.engine.dispose)
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.addCleanup(self.db.close)
        user = User(first_name="Synthetic", last_name="Candidate", personal_id="99900000123",
                    phone="555000111", email="synthetic@example.invalid", password_hash="unused",
                    code="9990000123", is_admin=False)
        self.db.add(user)
        self.db.commit()
        self.user_id = user.id

        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(media_storage, "_MEDIA_ROOT_CACHE", self.media))
        self.stack.enter_context(patch.object(documents, "DOCUMENTS_UPLOAD_DIR", self.docs))
        self.stack.enter_context(patch.object(documents, "BUNDLED_CONTRACTS_DIR", self.bundled))
        self.stack.enter_context(patch.object(expert_uploads, "_require_auth", return_value=SimpleNamespace(id=user.id)))
        self.stack.enter_context(patch.object(expert_uploads, "_require_admin"))
        self.stack.enter_context(patch.object(app_files, "_require_admin"))
        for name in ("smtplib.SMTP", "smtplib.SMTP_SSL"):
            self.stack.enter_context(patch(name, side_effect=AssertionError("Real SMTP forbidden")))

    def _file(self, relative: str, content=b"synthetic file") -> Path:
        path = self.media / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return path

    def _expert(self):
        code = "EX-synthetic-001"
        paths = [f"expert/{code}/expertise.pdf", f"expert/{code}/project.pdf"]
        for path in paths:
            self._file(path)
        upload = ExpertUpload(user_id=self.user_id, unique_code=code, status="draft",
                              expertise_path=paths[0], expertise_filename="expertise.pdf",
                              project_path=paths[1], project_filename="project.pdf")
        self.db.add(upload)
        self.db.commit()
        return upload.id, paths

    def test_expert_file_commit_failure_preserves_file_and_metadata(self):
        upload_id, paths = self._expert()
        with patch.object(self.db, "commit", side_effect=RuntimeError("commit failed")):
            with self.assertRaises(RuntimeError):
                expert_uploads.delete_file(upload_id, "expertise", None, self.db)
        self.assertEqual(self.db.get(ExpertUpload, upload_id).expertise_path, paths[0])
        self.assertEqual(self.db.get(ExpertUpload, upload_id).expertise_filename, "expertise.pdf")
        self.assertTrue(all((self.media / path).is_file() for path in paths))

    def test_expert_file_success_removes_only_selected_file(self):
        upload_id, paths = self._expert()
        other = self._file("expert/EX-other/untouched.pdf")
        expert_uploads.delete_file(upload_id, "expertise", None, self.db)
        self.assertIsNone(self.db.get(ExpertUpload, upload_id).expertise_path)
        self.assertFalse((self.media / paths[0]).exists())
        self.assertTrue((self.media / paths[1]).is_file())
        self.assertTrue(other.is_file())

    def test_expert_row_commit_failure_preserves_row_and_both_files(self):
        upload_id, paths = self._expert()
        with patch.object(self.db, "commit", side_effect=RuntimeError("commit failed")):
            with self.assertRaises(RuntimeError):
                expert_uploads.admin_delete_upload(upload_id, None, self.db)
        self.assertIsNotNone(self.db.get(ExpertUpload, upload_id))
        self.assertTrue(all((self.media / path).is_file() for path in paths))

    def test_expert_row_success_removes_files_and_empty_directory(self):
        upload_id, paths = self._expert()
        other = self._file("expert/EX-other/untouched.pdf")
        expert_uploads.admin_delete_upload(upload_id, None, self.db)
        self.assertIsNone(self.db.get(ExpertUpload, upload_id))
        self.assertFalse((self.media / paths[0]).parent.exists())
        self.assertTrue(other.is_file())

    def test_app_file_commit_failure_preserves_row_and_installer(self):
        path = self._file("app_files/test.exe")
        row = AppFile(storage_path="app_files/test.exe", filename="test.exe")
        self.db.add(row)
        self.db.commit()
        row_id = row.id
        with patch.object(self.db, "commit", side_effect=RuntimeError("commit failed")):
            with self.assertRaises(RuntimeError):
                app_files.admin_delete_app_file(row_id, None, self.db)
        self.assertIsNotNone(self.db.get(AppFile, row_id))
        self.assertTrue(path.is_file())

    def test_app_file_success_commits_before_unlink(self):
        target = self._file("app_files/test.exe")
        other = self._file("app_files/keep.exe")
        row = AppFile(storage_path="app_files/test.exe", filename="test.exe")
        self.db.add(row)
        self.db.commit()
        row_id = row.id
        original_unlink = Path.unlink

        def assert_committed(path, *args, **kwargs):
            if path == target:
                self.assertIsNone(self.db.get(AppFile, row_id))
                self.assertFalse(self.db.deleted)
            return original_unlink(path, *args, **kwargs)

        with patch.object(Path, "unlink", assert_committed):
            app_files.admin_delete_app_file(row_id, None, self.db)
        self.assertFalse(target.exists())
        self.assertTrue(other.exists())

    def test_delete_helpers_reject_paths_outside_storage_roots(self):
        outside = self.root / "outside.pdf"
        outside.write_bytes(b"must remain")
        row = AppFile(storage_path=str(outside), filename="outside.pdf")
        self.db.add(row)
        self.db.commit()
        app_files.admin_delete_app_file(row.id, None, self.db)
        self.assertTrue(outside.exists())
        self.assertFalse(documents._delete_document_file(outside))
        self.assertTrue(outside.exists())

    def _seed_contract_fixture(self, kind="public"):
        old_path = self.docs / "old.docx"
        old_path.write_bytes(b"OLD SYNTHETIC DOCUMENT")
        row = SiteDocument(title="Synthetic document", filename="synthetic.docx", content="",
                           contract_type="universal" if kind == "contract" else None,
                           file_path=str(old_path), file_size_bytes=22)
        self.db.add(row)
        self.db.commit()
        item = {"code": "SYNTHETIC-001", "default_title": "Synthetic document", "order_index": 1,
                "source_docx": "synthetic.docx", "source_md": "synthetic.md"}
        (self.bundled / "synthetic.md").write_text("Synthetic document", encoding="utf-8")
        (self.bundled / "synthetic.docx").write_bytes(b"NEW SYNTHETIC DOCUMENT")
        self.stack.enter_context(patch.object(documents, "PUBLIC_DOCUMENTS", [item] if kind == "public" else []))
        self.stack.enter_context(patch.object(documents, "CONTRACT_SLOTS", {"universal": item} if kind == "contract" else {}))
        return row.id, old_path

    def test_contract_seeder_commit_failure_keeps_old_and_removes_new_files(self):
        for kind in ("public", "contract"):
            with self.subTest(kind=kind), ExitStack() as stack:
                # Each scenario gets its own fully isolated fixture/session.
                case = OtherDeleteTransactionTests()
                case.setUp()
                stack.callback(case.doCleanups)
                row_id, old_path = case._seed_contract_fixture(kind)
                with patch.object(case.db, "commit", side_effect=RuntimeError("commit failed")):
                    documents._ensure_default_contracts(case.db)
                self.assertEqual(case.db.get(SiteDocument, row_id).file_path, str(old_path))
                self.assertEqual(list(case.docs.iterdir()), [old_path])
                self.assertEqual(old_path.read_bytes(), b"OLD SYNTHETIC DOCUMENT")

    def test_contract_seeder_partial_write_failure_removes_partial_new_file(self):
        row_id, old_path = self._seed_contract_fixture()
        original_write = Path.write_bytes

        def fail_partial(path, content):
            original_write(path, content[:3])
            raise OSError("disk full after partial write")

        with patch.object(Path, "write_bytes", fail_partial):
            documents._ensure_default_contracts(self.db)
        self.assertEqual(self.db.get(SiteDocument, row_id).file_path, str(old_path))
        self.assertEqual(list(self.docs.iterdir()), [old_path])

    def test_contract_seeder_cancellation_cleans_new_files_and_propagates(self):
        row_id, old_path = self._seed_contract_fixture()
        with patch.object(self.db, "commit", side_effect=CancelledError()):
            with self.assertRaises(CancelledError):
                documents._ensure_default_contracts(self.db)
        self.assertEqual(self.db.get(SiteDocument, row_id).file_path, str(old_path))
        self.assertEqual(list(self.docs.iterdir()), [old_path])

    def test_contract_seeder_success_deletes_replaced_and_obsolete_files_after_commit(self):
        row_id, old_path = self._seed_contract_fixture("contract")
        obsolete_path = self.docs / "obsolete.docx"
        obsolete_path.write_bytes(b"OLD LEGACY")
        obsolete = SiteDocument(title="Synthetic legacy", contract_type="exam", file_path=str(obsolete_path))
        self.db.add(obsolete)
        self.db.commit()
        obsolete_id = obsolete.id
        original_delete = documents._delete_document_file

        def assert_committed(path):
            self.assertNotEqual(self.db.get(SiteDocument, row_id).file_path, str(old_path))
            self.assertIsNone(self.db.get(SiteDocument, obsolete_id))
            return original_delete(path)

        with patch.object(documents, "_delete_document_file", side_effect=assert_committed):
            documents._ensure_default_contracts(self.db)
        self.assertFalse(old_path.exists())
        self.assertFalse(obsolete_path.exists())
        self.assertTrue(Path(self.db.get(SiteDocument, row_id).file_path).is_file())

    def test_contract_seeder_postcommit_interruption_preserves_new_file(self):
        row_id, old_path = self._seed_contract_fixture()
        with patch.object(documents, "_delete_document_file", side_effect=CancelledError()):
            with self.assertRaises(CancelledError):
                documents._ensure_default_contracts(self.db)
        new_path = Path(self.db.get(SiteDocument, row_id).file_path)
        self.assertNotEqual(new_path, old_path)
        self.assertTrue(new_path.is_file())
        self.assertTrue(old_path.is_file())


if __name__ == "__main__":
    unittest.main()
