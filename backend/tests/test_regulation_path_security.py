from __future__ import annotations

from datetime import datetime
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import HTTPException, UploadFile
from starlette.datastructures import Headers

try:
    from backend.app.routers import regulations
    from backend.app.services import media_storage
except ModuleNotFoundError:
    from app.routers import regulations
    from app.services import media_storage


def _upload(content: bytes = b"%PDF-1.7\nnew") -> UploadFile:
    return UploadFile(
        BytesIO(content),
        filename="replacement.pdf",
        headers=Headers({"content-type": "application/pdf"}),
    )


def _regulation(storage_path: str | None) -> SimpleNamespace:
    return SimpleNamespace(
        id=1,
        title="Rule",
        filename="legacy.pdf",
        file_path=storage_path,
        order_index=1,
        created_at=datetime(2026, 1, 1),
        updated_at=None,
    )


class _Db:
    def __init__(self, regulation, *, fail_commit=False, on_commit=None):
        self.regulation = regulation
        self.fail_commit = fail_commit
        self.on_commit = on_commit
        self.added = []
        self.deleted = []
        self.commit_calls = 0
        self.rollback_calls = 0

    def get(self, model, regulation_id):
        return self.regulation if regulation_id == self.regulation.id else None

    def add(self, regulation):
        self.added.append(regulation)

    def delete(self, regulation):
        self.deleted.append(regulation)

    def commit(self):
        self.commit_calls += 1
        if self.on_commit is not None:
            self.on_commit()
        if self.fail_commit:
            raise RuntimeError("commit failed")

    def rollback(self):
        self.rollback_calls += 1

    def refresh(self, regulation):
        pass


class RegulationPathSecurityTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary_directory = TemporaryDirectory()
        self.workspace = Path(self._temporary_directory.name)
        self.media_root = self.workspace / "media"
        self._previous_media_root = media_storage._MEDIA_ROOT_CACHE
        media_storage._MEDIA_ROOT_CACHE = self.media_root
        media_storage.ensure_media_root()

    def tearDown(self) -> None:
        media_storage._MEDIA_ROOT_CACHE = self._previous_media_root
        self._temporary_directory.cleanup()

    def test_poisoned_outside_path_is_not_downloaded_or_deleted(self) -> None:
        outside = self.workspace / "outside.pdf"
        outside.write_bytes(b"outside")
        regulation = _regulation(str(outside))
        db = _Db(regulation)

        with patch.object(regulations, "_require_admin"):
            with self.assertRaises(HTTPException) as admin_error:
                regulations.admin_download_regulation(
                    regulation_id=1,
                    authorization=None,
                    db=db,
                )
            with self.assertRaises(HTTPException) as public_error:
                regulations.public_view_regulation(regulation_id=1, db=db)
            regulations.admin_delete_regulation(
                regulation_id=1,
                authorization=None,
                db=db,
            )

        self.assertEqual(admin_error.exception.status_code, 404)
        self.assertEqual(public_error.exception.status_code, 404)
        self.assertTrue(outside.exists())
        self.assertEqual(db.deleted, [regulation])
        self.assertEqual(db.commit_calls, 1)

    def test_replacement_preserves_poisoned_outside_path(self) -> None:
        outside = self.workspace / "outside.pdf"
        outside.write_bytes(b"outside")
        regulation = _regulation(str(outside))
        db = _Db(regulation, on_commit=lambda: self.assertTrue(outside.exists()))

        with patch.object(regulations, "_require_admin"):
            result = regulations.admin_upload_regulation_file(
                regulation_id=1,
                file=_upload(),
                authorization=None,
                db=db,
            )

        self.assertEqual(result.filename, "replacement.pdf")
        self.assertTrue(outside.exists())
        self.assertFalse(Path(regulation.file_path).is_absolute())
        stored = media_storage.resolve_storage_path(regulation.file_path)
        self.assertEqual(stored.read_bytes(), b"%PDF-1.7\nnew")

    def test_legacy_relative_and_absolute_inside_paths_still_download(self) -> None:
        stored = self.media_root / "regulations" / "legacy.pdf"
        stored.parent.mkdir(parents=True)
        stored.write_bytes(b"legacy")
        relative = media_storage.relative_storage_path(stored)

        for legacy_path in (relative, str(stored.resolve())):
            with self.subTest(legacy_path=legacy_path):
                db = _Db(_regulation(legacy_path))
                with patch.object(regulations, "_require_admin"):
                    admin_response = regulations.admin_download_regulation(
                        regulation_id=1,
                        authorization=None,
                        db=db,
                    )
                public_response = regulations.public_view_regulation(
                    regulation_id=1,
                    db=db,
                )

                self.assertEqual(Path(admin_response.path).resolve(), stored.resolve())
                self.assertEqual(Path(public_response.path).resolve(), stored.resolve())
                self.assertEqual(public_response.media_type, "application/pdf")

    def test_successful_replacement_stores_relative_and_deletes_old_after_commit(self) -> None:
        old = self.media_root / "regulations" / "legacy.pdf"
        old.parent.mkdir(parents=True)
        old.write_bytes(b"legacy")
        observations = []
        regulation = _regulation(str(old.resolve()))
        db = _Db(regulation, on_commit=lambda: observations.append(old.exists()))

        with patch.object(regulations, "_require_admin"):
            regulations.admin_upload_regulation_file(
                regulation_id=1,
                file=_upload(),
                authorization=None,
                db=db,
            )

        self.assertEqual(observations, [True])
        self.assertFalse(old.exists())
        self.assertFalse(Path(regulation.file_path).is_absolute())
        self.assertTrue(media_storage.resolve_storage_path(regulation.file_path).is_file())

    def test_replacement_commit_failure_removes_new_and_preserves_old(self) -> None:
        old = self.media_root / "regulations" / "legacy.pdf"
        old.parent.mkdir(parents=True)
        old.write_bytes(b"legacy")
        regulation = _regulation(media_storage.relative_storage_path(old))
        db = _Db(regulation, fail_commit=True)

        with patch.object(regulations, "_require_admin"):
            with self.assertRaisesRegex(RuntimeError, "commit failed"):
                regulations.admin_upload_regulation_file(
                    regulation_id=1,
                    file=_upload(),
                    authorization=None,
                    db=db,
                )

        self.assertTrue(old.exists())
        self.assertEqual(list(old.parent.glob("*.pdf")), [old])
        self.assertEqual(db.rollback_calls, 1)

    def test_delete_commit_failure_preserves_inside_file(self) -> None:
        old = self.media_root / "regulations" / "legacy.pdf"
        old.parent.mkdir(parents=True)
        old.write_bytes(b"legacy")
        regulation = _regulation(media_storage.relative_storage_path(old))
        db = _Db(regulation, fail_commit=True)

        with patch.object(regulations, "_require_admin"):
            with self.assertRaisesRegex(RuntimeError, "commit failed"):
                regulations.admin_delete_regulation(
                    regulation_id=1,
                    authorization=None,
                    db=db,
                )

        self.assertTrue(old.exists())
        self.assertEqual(db.rollback_calls, 1)

    def test_sibling_prefix_and_symlink_escape_are_rejected(self) -> None:
        sibling = self.workspace / "media-sibling" / "outside.pdf"
        sibling.parent.mkdir()
        sibling.write_bytes(b"sibling")
        with self.assertRaises(HTTPException) as sibling_error:
            regulations.public_view_regulation(
                regulation_id=1,
                db=_Db(_regulation(str(sibling))),
            )
        self.assertEqual(sibling_error.exception.status_code, 404)
        self.assertTrue(sibling.exists())

        target = self.workspace / "symlink-target.pdf"
        target.write_bytes(b"target")
        link = self.media_root / "regulations" / "escape.pdf"
        link.parent.mkdir(parents=True, exist_ok=True)
        try:
            link.symlink_to(target)
        except (NotImplementedError, OSError):
            return

        regulation = _regulation("regulations/escape.pdf")
        db = _Db(regulation)
        with self.assertRaises(HTTPException) as symlink_error:
            regulations.public_view_regulation(regulation_id=1, db=db)
        with patch.object(regulations, "_require_admin"):
            regulations.admin_delete_regulation(
                regulation_id=1,
                authorization=None,
                db=db,
            )

        self.assertEqual(symlink_error.exception.status_code, 404)
        self.assertTrue(target.exists())
        self.assertTrue(link.is_symlink())


if __name__ == "__main__":
    unittest.main()
