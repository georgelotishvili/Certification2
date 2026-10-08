from __future__ import annotations

from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import UploadFile
from starlette.datastructures import Headers

try:
    from backend.app.routers import users
    from backend.app.services import media_storage
except ModuleNotFoundError:
    from app.routers import users
    from app.services import media_storage


def _upload(content: bytes) -> UploadFile:
    return UploadFile(
        BytesIO(content),
        filename="certificate.pdf",
        headers=Headers({"content-type": "application/pdf"}),
    )


class _CertificateDb:
    def __init__(self, user, certificate, *, on_commit=None, commit_error=None):
        self.user = user
        self.certificate = certificate
        self.on_commit = on_commit
        self.commit_error = commit_error
        self.commit_calls = 0
        self.rollback_calls = 0
        self.added = []

    def get(self, model, item_id):
        return self.user

    def scalar(self, query):
        return self.certificate

    def add(self, item):
        self.added.append(item)

    def commit(self):
        self.commit_calls += 1
        if self.on_commit is not None:
            self.on_commit()
        if self.commit_error is not None:
            raise self.commit_error

    def rollback(self):
        self.rollback_calls += 1


class _FailingStream:
    def __init__(self):
        self.calls = 0

    def read(self, size=-1):
        self.calls += 1
        if self.calls == 1:
            return b"%PDF-partial"
        raise OSError("simulated read failure")


class CertificateUploadTransactionTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary_directory = TemporaryDirectory()
        self.root = Path(self._temporary_directory.name)
        self._previous_media_root = media_storage._MEDIA_ROOT_CACHE
        media_storage._MEDIA_ROOT_CACHE = self.root

        self.user = SimpleNamespace(id=41)
        self.certificate_dir = media_storage.ensure_certificate_dir(self.user.id)
        self.previous = self.certificate_dir / "certificate.pdf"
        self.previous.write_bytes(b"%PDF-old")
        self.certificate = SimpleNamespace(
            file_path="certificates/41/certificate.pdf",
            filename="certificate.pdf",
            mime_type="application/pdf",
            size_bytes=8,
            updated_at=None,
            status="active",
            valid_until=None,
        )

    def tearDown(self) -> None:
        media_storage._MEDIA_ROOT_CACHE = self._previous_media_root
        self._temporary_directory.cleanup()

    def test_commit_failure_keeps_old_file_and_removes_new_orphan(self) -> None:
        observed = {}

        def observe_before_failure():
            observed["old"] = self.previous.read_bytes()
            new_path = media_storage.resolve_storage_path(
                self.certificate.file_path
            )
            observed["new"] = new_path.read_bytes()

        db = _CertificateDb(
            self.user,
            self.certificate,
            on_commit=observe_before_failure,
            commit_error=RuntimeError("simulated commit failure"),
        )

        with patch.object(users, "_require_admin"):
            with self.assertRaisesRegex(RuntimeError, "commit failure"):
                users.upload_certificate_file(
                    user_id=self.user.id,
                    file=_upload(b"%PDF-new"),
                    authorization=None,
                    db=db,
                )

        self.assertEqual(observed, {"old": b"%PDF-old", "new": b"%PDF-new"})
        self.assertEqual(self.previous.read_bytes(), b"%PDF-old")
        self.assertEqual(list(self.certificate_dir.iterdir()), [self.previous])
        self.assertEqual(db.commit_calls, 1)
        self.assertEqual(db.rollback_calls, 1)

    def test_success_commits_unique_file_before_deleting_legacy_file(self) -> None:
        # Absolute paths were stored by older versions and must remain supported.
        self.certificate.file_path = str(self.previous.resolve())
        observed = {}

        def observe_during_commit():
            new_path = media_storage.resolve_storage_path(
                self.certificate.file_path
            )
            observed["old_exists"] = self.previous.exists()
            observed["new_exists"] = new_path.exists()
            observed["new_bytes"] = new_path.read_bytes()

        db = _CertificateDb(
            self.user,
            self.certificate,
            on_commit=observe_during_commit,
        )

        with patch.object(users, "_require_admin"):
            result = users.upload_certificate_file(
                user_id=self.user.id,
                file=_upload(b"%PDF-new"),
                authorization=None,
                db=db,
            )

        new_path = media_storage.resolve_storage_path(self.certificate.file_path)
        self.assertIsNone(result)
        self.assertEqual(
            observed,
            {
                "old_exists": True,
                "new_exists": True,
                "new_bytes": b"%PDF-new",
            },
        )
        self.assertFalse(self.previous.exists())
        self.assertTrue(new_path.name.startswith("certificate-"))
        self.assertEqual(new_path.suffix, ".pdf")
        self.assertEqual(new_path.read_bytes(), b"%PDF-new")
        self.assertEqual(self.certificate.filename, "certificate.pdf")
        self.assertEqual(self.certificate.mime_type, "application/pdf")
        self.assertEqual(self.certificate.size_bytes, len(b"%PDF-new"))
        self.assertEqual(db.commit_calls, 1)
        self.assertEqual(db.rollback_calls, 0)

        response = users.download_certificate_file(
            user_id=self.user.id,
            authorization=None,
            actor=None,
            db=db,
        )
        self.assertEqual(Path(response.path), new_path)
        self.assertEqual(response.filename, "certificate.pdf")

    def test_write_failure_keeps_old_file_and_removes_partial_file(self) -> None:
        db = _CertificateDb(self.user, self.certificate)
        upload = SimpleNamespace(
            file=_FailingStream(),
            content_type="application/pdf",
        )

        with patch.object(users, "_require_admin"):
            with self.assertRaisesRegex(OSError, "read failure"):
                users.upload_certificate_file(
                    user_id=self.user.id,
                    file=upload,
                    authorization=None,
                    db=db,
                )

        self.assertEqual(self.previous.read_bytes(), b"%PDF-old")
        self.assertEqual(list(self.certificate_dir.iterdir()), [self.previous])
        self.assertEqual(db.commit_calls, 0)
        self.assertEqual(db.rollback_calls, 1)


if __name__ == "__main__":
    unittest.main()
