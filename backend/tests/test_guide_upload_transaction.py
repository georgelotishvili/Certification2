"""Transactional file cleanup tests for backend/app/routers/guide.py across all 3 failure points."""
from __future__ import annotations

from asyncio import CancelledError
from datetime import datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

try:
    from backend.app.database import get_db
    from backend.app.models import Base, GuideDocument, User, UserSession
    from backend.app.routers import admin, guide
except ModuleNotFoundError:
    from app.database import get_db
    from app.models import Base, GuideDocument, User, UserSession
    from app.routers import admin, guide


class GuideUploadTransactionTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine(
            "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool
        )
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.addCleanup(self.engine.dispose)
        self.addCleanup(self.db.close)

        self.tmp_dir = TemporaryDirectory(prefix="gipc-guide-tx-")
        self.addCleanup(self.tmp_dir.cleanup)
        self.guide_root = Path(self.tmp_dir.name)

        self.root_patch = patch.object(guide, "_guide_root", return_value=self.guide_root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)

        self.admin_settings = patch.object(
            admin, "get_settings", return_value=SimpleNamespace(founder_admin_email="founder@example.test")
        )
        self.admin_settings.start()
        self.addCleanup(self.admin_settings.stop)

        founder = User(
            first_name="Synthetic",
            last_name="GuideAdmin",
            personal_id="00000000001",
            phone="599000000",
            email="founder@example.test",
            password_hash="hash",
            code="0000000001",
            is_admin=True,
        )
        self.db.add(founder)
        self.db.flush()
        self.db.add(
            UserSession(
                user_id=founder.id,
                token="admin-token",
                expires_at=datetime.utcnow() + timedelta(days=1),
            )
        )
        self.db.commit()
        self.auth = {"Authorization": "Bearer admin-token"}

        app = FastAPI()
        app.include_router(guide.router)
        app.dependency_overrides[get_db] = lambda: self.db
        self.client = TestClient(app, raise_server_exceptions=False)
        self.addCleanup(self.client.close)

        for smtp_class in ("smtplib.SMTP", "smtplib.SMTP_SSL"):
            smtp_patch = patch(smtp_class, side_effect=AssertionError("Real SMTP is forbidden in tests"))
            smtp_patch.start()
            self.addCleanup(smtp_patch.stop)

    def _seed_existing_doc(self) -> tuple[GuideDocument, Path, bytes]:
        old_bytes = b"OLD_DOCX_CONTENT_12345"
        old_path = self.guide_root / "guide_existing0001.docx"
        old_path.write_bytes(old_bytes)
        doc = GuideDocument(
            title="ძველი სათაური",
            content="<p>ძველი ტექსტი</p>",
            order_index=1,
            file_path=str(old_path),
            filename="old_guide.docx",
            file_size_bytes=len(old_bytes),
        )
        self.db.add(doc)
        self.db.commit()
        self.db.refresh(doc)
        return doc, old_path, old_bytes

    def _assert_untouched(self, doc_id: int, old_path: Path, old_bytes: bytes):
        self.db.expire_all()
        row = self.db.get(GuideDocument, doc_id)
        self.assertIsNotNone(row)
        self.assertEqual(row.title, "ძველი სათაური")
        self.assertEqual(row.content, "<p>ძველი ტექსტი</p>")
        self.assertEqual(row.file_path, str(old_path))
        self.assertEqual(row.filename, "old_guide.docx")
        self.assertEqual(row.file_size_bytes, len(old_bytes))
        self.assertTrue(old_path.exists(), "Old file must remain on disk")
        self.assertEqual(old_path.read_bytes(), old_bytes)
        files_on_disk = list(self.guide_root.iterdir())
        self.assertEqual(files_on_disk, [old_path], f"Orphaned new files left on disk: {files_on_disk}")

    def _seed_factory_doc(self, label: str):
        title = f"Synthetic factory guide {label}"
        filename = f"{label}.docx"
        old_path = self.guide_root / f"old_{label}.docx"
        old_bytes = b"SYNTHETIC_OLD_GUIDE"
        old_path.write_bytes(old_bytes)
        doc = GuideDocument(
            title=title, content="", order_index=1,
            file_path=str(old_path), filename=filename,
            file_size_bytes=len(old_bytes),
        )
        self.db.add(doc)
        self.db.commit()
        section = (1, title, "Synthetic replacement", "<p>Synthetic replacement</p>", filename)
        return doc.id, old_path, old_bytes, section

    def test_seeder_precommit_cancellation_cleans_up_and_propagates(self):
        original_write = Path.write_bytes
        for failure_point in ("before_write", "partial_write", "commit"):
            with self.subTest(failure_point=failure_point):
                doc_id, old_path, old_bytes, section = self._seed_factory_doc(failure_point)
                files_before = set(self.guide_root.iterdir())

                def fail_write(path, content):
                    if failure_point == "partial_write":
                        original_write(path, b"PARTIAL_SYNTHETIC_GUIDE")
                    raise CancelledError("Synthetic precommit cancellation")

                failure_patch = (
                    patch.object(self.db, "commit", side_effect=CancelledError("Synthetic commit cancellation"))
                    if failure_point == "commit" else patch.object(Path, "write_bytes", fail_write)
                )
                with (
                    patch.object(guide, "_get_bundled_doc28_sections", return_value=[section]),
                    patch.object(guide, "markdown_to_docx_bytes", return_value=b"SYNTHETIC_NEW_GUIDE"),
                    patch.object(self.db, "rollback", wraps=self.db.rollback) as rollback,
                    failure_patch,
                ):
                    with self.assertRaises(CancelledError):
                        guide._ensure_default_guide_docs(self.db)
                    rollback.assert_called_once()

                self.db.expire_all()
                row = self.db.get(GuideDocument, doc_id)
                self.assertEqual(row.content, "")
                self.assertEqual(row.file_path, str(old_path))
                self.assertEqual(old_path.read_bytes(), old_bytes)
                self.assertEqual(set(self.guide_root.iterdir()), files_before)

    def test_seeder_postcommit_cancellation_keeps_committed_replacement(self):
        doc_id, old_path, old_bytes, section = self._seed_factory_doc("postcommit_cancel")

        def cancel_old_cleanup(stored_path):
            self.assertEqual(stored_path, str(old_path))
            raise CancelledError("Synthetic cancellation after commit")

        with (
            patch.object(guide, "_get_bundled_doc28_sections", return_value=[section]),
            patch.object(guide, "markdown_to_docx_bytes", return_value=b"SYNTHETIC_NEW_GUIDE"),
            patch.object(guide, "_delete_guide_file_from_disk", side_effect=cancel_old_cleanup) as cleanup,
            patch.object(self.db, "commit", wraps=self.db.commit) as commit,
            patch.object(self.db, "rollback", wraps=self.db.rollback) as rollback,
        ):
            with self.assertRaises(CancelledError):
                guide._ensure_default_guide_docs(self.db)
            commit.assert_called_once()
            rollback.assert_not_called()
            cleanup.assert_called_once_with(str(old_path))

        self.db.expire_all()
        row = self.db.get(GuideDocument, doc_id)
        new_path = Path(row.file_path)
        self.assertNotEqual(new_path, old_path)
        self.assertEqual(row.content, section[3])
        self.assertEqual(new_path.read_bytes(), b"SYNTHETIC_NEW_GUIDE")
        self.assertEqual(old_path.read_bytes(), old_bytes)
        self.assertEqual(set(self.guide_root.iterdir()), {old_path, new_path})

    def test_seeder_old_file_unlink_error_keeps_committed_replacement(self):
        doc_id, old_path, old_bytes, section = self._seed_factory_doc("postcommit_unlink")
        original_unlink = Path.unlink

        def fail_old_unlink(path, *args, **kwargs):
            if path == old_path:
                raise OSError("Synthetic locked old file")
            return original_unlink(path, *args, **kwargs)

        with (
            patch.object(guide, "_get_bundled_doc28_sections", return_value=[section]),
            patch.object(guide, "markdown_to_docx_bytes", return_value=b"SYNTHETIC_NEW_GUIDE"),
            patch.object(Path, "unlink", fail_old_unlink),
            patch.object(self.db, "rollback", wraps=self.db.rollback) as rollback,
        ):
            guide._ensure_default_guide_docs(self.db)
            rollback.assert_not_called()

        self.db.expire_all()
        row = self.db.get(GuideDocument, doc_id)
        new_path = Path(row.file_path)
        self.assertNotEqual(new_path, old_path)
        self.assertEqual(row.content, section[3])
        self.assertEqual(new_path.read_bytes(), b"SYNTHETIC_NEW_GUIDE")
        self.assertEqual(old_path.read_bytes(), old_bytes)

    def test_seeder_deletes_old_file_only_after_successful_commit(self):
        doc_id, old_path, _old_bytes, section = self._seed_factory_doc("successful_commit")
        original_commit = self.db.commit
        original_cleanup = guide._delete_guide_file_from_disk
        operations = []

        def commit():
            self.assertTrue(old_path.is_file())
            original_commit()
            operations.append("committed")

        def cleanup(stored_path):
            self.assertEqual(operations, ["committed"])
            original_cleanup(stored_path)
            operations.append("old_file_deleted")

        with (
            patch.object(guide, "_get_bundled_doc28_sections", return_value=[section]),
            patch.object(guide, "markdown_to_docx_bytes", return_value=b"SYNTHETIC_NEW_GUIDE"),
            patch.object(self.db, "commit", side_effect=commit),
            patch.object(guide, "_delete_guide_file_from_disk", side_effect=cleanup),
        ):
            guide._ensure_default_guide_docs(self.db)

        self.db.expire_all()
        row = self.db.get(GuideDocument, doc_id)
        new_path = Path(row.file_path)
        self.assertEqual(operations, ["committed", "old_file_deleted"])
        self.assertEqual(new_path.read_bytes(), b"SYNTHETIC_NEW_GUIDE")
        self.assertEqual(set(self.guide_root.iterdir()), {new_path})

    def test_admin_update_three_failure_points_and_success(self):
        doc, old_path, old_bytes = self._seed_existing_doc()

        # 1) Failure BEFORE write starts
        async def fail_before_write(upload_file, destination, *, max_bytes):
            raise RuntimeError("Error before any bytes written")

        with patch.object(guide, "save_async_upload", side_effect=fail_before_write):
            res1 = self.client.put(
                f"/admin/guide/documents/{doc.id}",
                headers=self.auth,
                data={"title": "ახალი სათაური 1", "content": "ახალი ტექსტი 1"},
                files={"file": ("new1.txt", b"new content 1", "text/plain")},
            )
            self.assertEqual(res1.status_code, 500)
        self._assert_untouched(doc.id, old_path, old_bytes)

        # 2) Failure DURING partial write (partial bytes written to destination before raising)
        async def fail_mid_write(upload_file, destination, *, max_bytes):
            Path(destination).write_bytes(b"PARTIAL_GARBAGE_BYTES")
            self.assertTrue(Path(destination).exists())
            raise OSError("Simulated disk full mid-write")

        with patch.object(guide, "save_async_upload", side_effect=fail_mid_write):
            res2 = self.client.put(
                f"/admin/guide/documents/{doc.id}",
                headers=self.auth,
                data={"title": "ახალი სათაური 2", "content": "ახალი ტექსტი 2"},
                files={"file": ("new2.txt", b"new content 2", "text/plain")},
            )
            self.assertEqual(res2.status_code, 500)
        self._assert_untouched(doc.id, old_path, old_bytes)

        # 3) Failure ON db.commit() (after new file is completely written)
        with patch.object(self.db, "commit", side_effect=RuntimeError("Simulated DB commit failure")):
            res3 = self.client.put(
                f"/admin/guide/documents/{doc.id}",
                headers=self.auth,
                data={"title": "ახალი სათაური 3", "content": "ახალი ტექსტი 3"},
                files={"file": ("new3.txt", b"new content 3", "text/plain")},
            )
            self.assertEqual(res3.status_code, 500)
        self._assert_untouched(doc.id, old_path, old_bytes)

        # 4) Successful update + commit -> old file deleted ONLY after commit, new file & DB row saved
        res4 = self.client.put(
            f"/admin/guide/documents/{doc.id}",
            headers=self.auth,
            data={"title": "განახლებული სათაური", "content": ""},
            files={"file": ("updated_guide.txt", "განახლებული ტექსტი".encode("utf-8"), "text/plain")},
        )
        self.assertEqual(res4.status_code, 200, res4.text)
        self.assertFalse(old_path.exists(), "Old file must be deleted after successful commit")
        self.db.expire_all()
        updated = self.db.get(GuideDocument, doc.id)
        self.assertEqual(updated.title, "განახლებული სათაური")
        self.assertEqual(updated.filename, "updated_guide.txt")
        new_path = Path(updated.file_path)
        self.assertTrue(new_path.exists())
        self.assertEqual(list(self.guide_root.iterdir()), [new_path])

    def test_ensure_default_guide_docs_partial_write_and_commit_cleanup(self):
        # Seed one legacy factory guide doc with an old file on disk so _ensure_default_guide_docs upgrades it
        idx, title, _body_promoted, _html_content, display_filename = guide._get_bundled_doc28_sections()[0]

        old_bytes = b"LEGACY_FACTORY_DOCX"
        old_path = self.guide_root / "guide_legacy0001.docx"
        old_path.write_bytes(old_bytes)

        # Find HTML content that produces known_hash or use empty content with factory filename
        doc = GuideDocument(
            title=title,
            content="",
            order_index=1,
            file_path=str(old_path),
            filename=display_filename,
            file_size_bytes=len(old_bytes),
        )
        self.db.add(doc)
        self.db.commit()
        doc_id = doc.id

        # 1) Failure BEFORE write starts in _ensure_default_guide_docs
        orig_write_bytes = Path.write_bytes

        def fail_before_write(path_self, data):
            raise OSError("Simulated failure before write")

        with patch.object(Path, "write_bytes", fail_before_write):
            guide._ensure_default_guide_docs(self.db)

        self.db.expire_all()
        row = self.db.get(GuideDocument, doc_id)
        self.assertEqual(row.file_path, str(old_path))
        self.assertTrue(old_path.exists())
        self.assertEqual(list(self.guide_root.iterdir()), [old_path])

        # 2) Failure DURING partial write in _ensure_default_guide_docs
        def fail_mid_write(path_self, data):
            orig_write_bytes(path_self, b"PARTIAL_DOCX_BYTES")
            raise OSError("Simulated failure mid-write after creating partial file")

        with patch.object(Path, "write_bytes", fail_mid_write):
            guide._ensure_default_guide_docs(self.db)

        self.db.expire_all()
        row = self.db.get(GuideDocument, doc_id)
        self.assertEqual(row.file_path, str(old_path))
        self.assertTrue(old_path.exists())
        self.assertEqual(list(self.guide_root.iterdir()), [old_path])

        # 3) Failure ON db.commit() in _ensure_default_guide_docs
        with patch.object(self.db, "commit", side_effect=RuntimeError("Commit failed")):
            guide._ensure_default_guide_docs(self.db)

        self.db.expire_all()
        row = self.db.get(GuideDocument, doc_id)
        self.assertEqual(row.file_path, str(old_path))
        self.assertTrue(old_path.exists())
        self.assertEqual(list(self.guide_root.iterdir()), [old_path])


if __name__ == "__main__":
    unittest.main()
