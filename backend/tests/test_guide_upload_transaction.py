"""Transactional file cleanup tests for backend/app/routers/guide.py across all 3 failure points."""
from __future__ import annotations

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
            first_name="ლაშა",
            last_name="ფოფხაძე",
            personal_id="01031003115",
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
