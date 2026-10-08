from __future__ import annotations

from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import HTTPException, UploadFile
from starlette.datastructures import Headers

try:
    from backend.app.routers import (
        admin,
        app_files,
        documents,
        expert_uploads,
        regulations,
        statements,
        users,
    )
    from backend.app.services import bounded_upload, media_storage
except ModuleNotFoundError:
    from app.routers import (
        admin,
        app_files,
        documents,
        expert_uploads,
        regulations,
        statements,
        users,
    )
    from app.services import bounded_upload, media_storage


def _upload(
    content: bytes,
    filename: str,
    content_type: str = "application/octet-stream",
) -> UploadFile:
    return UploadFile(
        BytesIO(content),
        filename=filename,
        headers=Headers({"content-type": content_type}),
    )


class _LookupDb:
    def __init__(self, item):
        self.item = item
        self.commit_calls = 0

    def get(self, model, item_id):
        return self.item

    def scalar(self, query):
        return self.item

    def add(self, item):
        pass

    def commit(self):
        self.commit_calls += 1

    def rollback(self):
        pass

    def refresh(self, item):
        pass


class _ExpertCreateDb:
    def __init__(self):
        self.added = []
        self.commit_calls = 0
        self.rollback_calls = 0

    def add(self, item):
        self.added.append(item)

    def commit(self):
        self.commit_calls += 1

    def rollback(self):
        self.rollback_calls += 1

    def refresh(self, item):
        pass


class _StatementDb:
    def __init__(self):
        self.statement = None
        self.commit_calls = 0
        self.rollback_calls = 0

    def add(self, statement):
        self.statement = statement

    def flush(self):
        self.statement.id = 77

    def commit(self):
        self.commit_calls += 1

    def rollback(self):
        self.rollback_calls += 1

    def refresh(self, statement):
        pass


class UploadSizeLimitTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._temporary_directory = TemporaryDirectory()
        self.root = Path(self._temporary_directory.name)
        self._previous_media_root = media_storage._MEDIA_ROOT_CACHE
        media_storage._MEDIA_ROOT_CACHE = self.root

    def tearDown(self) -> None:
        media_storage._MEDIA_ROOT_CACHE = self._previous_media_root
        self._temporary_directory.cleanup()

    def test_sync_writer_accepts_exact_limit_and_removes_oversize_partial(self) -> None:
        exact = self.root / "exact.bin"
        overflow = self.root / "overflow.bin"

        size = bounded_upload.save_upload_stream(
            BytesIO(b"1234"),
            exact,
            max_bytes=4,
            chunk_bytes=3,
        )
        self.assertEqual(size, 4)
        self.assertEqual(exact.read_bytes(), b"1234")

        with self.assertRaises(bounded_upload.UploadTooLarge):
            bounded_upload.save_upload_stream(
                BytesIO(b"12345"),
                overflow,
                max_bytes=4,
                chunk_bytes=3,
            )
        self.assertFalse(overflow.exists())

    def test_writer_never_deletes_a_preexisting_destination(self) -> None:
        destination = self.root / "existing.bin"
        destination.write_bytes(b"keep")

        with self.assertRaises(FileExistsError):
            bounded_upload.save_upload_stream(BytesIO(b"new"), destination)

        self.assertEqual(destination.read_bytes(), b"keep")

    async def test_async_writer_removes_oversize_partial(self) -> None:
        destination = self.root / "async.bin"

        with self.assertRaises(bounded_upload.UploadTooLarge):
            await bounded_upload.save_async_upload(
                _upload(b"12345", "async.bin"),
                destination,
                max_bytes=4,
                chunk_bytes=2,
            )

        self.assertFalse(destination.exists())

    def test_normal_limits_are_100_mib_and_installer_limit_is_1_gib(self) -> None:
        normal = 100 * 1024 * 1024
        installer = 1024 * 1024 * 1024

        self.assertEqual(bounded_upload.DEFAULT_UPLOAD_MAX_BYTES, normal)
        self.assertEqual(media_storage.PDF_UPLOAD_MAX_BYTES, normal)
        self.assertEqual(admin.PHOTO_UPLOAD_MAX_BYTES, normal)
        self.assertEqual(app_files.APPLICATION_FORM_MAX_BYTES, normal)
        self.assertEqual(documents.DOCUMENT_UPLOAD_MAX_BYTES, normal)
        self.assertEqual(expert_uploads.MAX_BYTES, normal)
        self.assertEqual(regulations.REGULATION_UPLOAD_MAX_BYTES, normal)
        self.assertEqual(statements.MAX_BYTES, normal)
        self.assertEqual(users.CERTIFICATE_UPLOAD_MAX_BYTES, normal)
        self.assertEqual(app_files.APP_FILE_MAX_BYTES, installer)

    async def test_application_form_oversize_keeps_previous_file(self) -> None:
        form_dir = app_files._ensure_application_form_dir()
        previous = form_dir / "old.pdf"
        previous.write_bytes(b"old")

        with (
            patch.object(app_files, "_require_admin"),
            patch.object(app_files, "APPLICATION_FORM_MAX_BYTES", 4),
        ):
            with self.assertRaises(HTTPException) as raised:
                await app_files.admin_upload_application_form(
                    file=_upload(b"12345", "new.pdf", "application/pdf"),
                    authorization=None,
                    db=object(),
                )

        self.assertEqual(raised.exception.status_code, 413)
        self.assertEqual(previous.read_bytes(), b"old")
        self.assertEqual(list(form_dir.iterdir()), [previous])

    async def test_small_application_form_still_replaces_previous_file(self) -> None:
        form_dir = app_files._ensure_application_form_dir()
        previous = form_dir / "old.pdf"
        previous.write_bytes(b"old")

        with (
            patch.object(app_files, "_require_admin"),
            patch.object(app_files, "APPLICATION_FORM_MAX_BYTES", 4),
        ):
            result = await app_files.admin_upload_application_form(
                file=_upload(b"new", "new.pdf", "application/pdf"),
                authorization=None,
                db=object(),
            )

        replacement = form_dir / "new.pdf"
        self.assertEqual(result, {"filename": "new.pdf", "size_bytes": 3})
        self.assertFalse(previous.exists())
        self.assertEqual(replacement.read_bytes(), b"new")

    async def test_installer_oversize_is_413_and_creates_no_db_row(self) -> None:
        db = _ExpertCreateDb()

        with (
            patch.object(app_files, "_require_admin"),
            patch.object(app_files, "APP_FILE_MAX_BYTES", 4),
        ):
            with self.assertRaises(HTTPException) as raised:
                await app_files.admin_create_app_file(
                    file=_upload(b"12345", "release.zip"),
                    authorization=None,
                    db=db,
                )

        self.assertEqual(raised.exception.status_code, 413)
        self.assertEqual(db.added, [])
        self.assertEqual(db.commit_calls, 0)
        self.assertEqual(list((self.root / "app_files").iterdir()), [])

    async def test_small_installer_upload_keeps_existing_result_contract(self) -> None:
        with patch.object(app_files, "APP_FILE_MAX_BYTES", 4):
            storage_path, filename, mime_type, size = await app_files._save_app_file(
                _upload(b"1234", "release.zip", "application/zip")
            )

        self.assertEqual(filename, "release.zip")
        self.assertEqual(mime_type, "application/zip")
        self.assertEqual(size, 4)
        self.assertEqual(
            media_storage.resolve_storage_path(storage_path).read_bytes(),
            b"1234",
        )

    async def test_expert_second_file_oversize_cleans_first_and_skips_db(self) -> None:
        db = _ExpertCreateDb()
        actor = SimpleNamespace(id=9)

        with (
            patch.object(expert_uploads, "_require_auth", return_value=actor),
            patch.object(expert_uploads, "_must_expert"),
            patch.object(expert_uploads, "_gen_unique_code", return_value="EX-test-001"),
            patch.object(expert_uploads, "MAX_BYTES", 4),
        ):
            with self.assertRaises(HTTPException) as raised:
                await expert_uploads.create_upload(
                    building_function="building",
                    cadastral_code="code",
                    project_address="address",
                    expertise=_upload(b"1234", "expertise.pdf", "application/pdf"),
                    project=_upload(b"12345", "project.zip"),
                    authorization=None,
                    db=db,
                )

        self.assertEqual(raised.exception.status_code, 413)
        self.assertEqual(db.added, [])
        self.assertEqual(db.commit_calls, 0)
        self.assertEqual(db.rollback_calls, 1)
        expert_root = self.root / "expert"
        self.assertEqual(list(expert_root.rglob("*")) if expert_root.exists() else [], [])

    async def test_small_expert_upload_preserves_api_filenames(self) -> None:
        db = _ExpertCreateDb()
        actor = SimpleNamespace(id=9)

        with (
            patch.object(expert_uploads, "_require_auth", return_value=actor),
            patch.object(expert_uploads, "_must_expert"),
            patch.object(expert_uploads, "_gen_unique_code", return_value="EX-test-002"),
            patch.object(expert_uploads, "_to_out", side_effect=lambda item: item),
            patch.object(expert_uploads, "MAX_BYTES", 4),
        ):
            created = await expert_uploads.create_upload(
                building_function="building",
                cadastral_code="code",
                project_address="address",
                expertise=_upload(b"1234", "expertise.pdf", "application/pdf"),
                project=_upload(b"1234", "project.zip"),
                authorization=None,
                db=db,
            )

        self.assertEqual(created.expertise_filename, "expertise.pdf")
        self.assertEqual(created.project_filename, "project.zip")
        self.assertEqual(
            media_storage.resolve_storage_path(created.expertise_path).read_bytes(),
            b"1234",
        )
        self.assertEqual(
            media_storage.resolve_storage_path(created.project_path).read_bytes(),
            b"1234",
        )
        self.assertEqual(db.added, [created])
        self.assertEqual(db.commit_calls, 1)

    def test_statement_oversize_rolls_back_pending_row(self) -> None:
        db = _StatementDb()

        with (
            patch.object(statements, "_get_actor_user", return_value=SimpleNamespace(id=5)),
            patch.object(statements, "MAX_BYTES", 4),
        ):
            with self.assertRaises(HTTPException) as raised:
                statements.create_statement(
                    message="message",
                    attachment=_upload(b"12345", "proof.pdf", "application/pdf"),
                    authorization=None,
                    db=db,
                )

        self.assertEqual(raised.exception.status_code, 413)
        self.assertEqual(db.commit_calls, 0)
        self.assertEqual(db.rollback_calls, 1)
        statement_root = self.root / "statements"
        files = [path for path in statement_root.rglob("*") if path.is_file()]
        self.assertEqual(files, [])

    def test_document_oversize_is_413_and_leaves_no_file(self) -> None:
        previous_dir = documents.DOCUMENTS_UPLOAD_DIR
        documents.DOCUMENTS_UPLOAD_DIR = self.root / "documents"
        try:
            stored_path, destination = documents._new_document_storage_path()
            with patch.object(documents, "DOCUMENT_UPLOAD_MAX_BYTES", 4):
                with self.assertRaises(HTTPException) as raised:
                    documents._write_document_upload(
                        _upload(b"12345", "document.docx"),
                        destination,
                    )
            self.assertEqual(raised.exception.status_code, 413)
            self.assertFalse(documents._resolve_document_path(stored_path).exists())
        finally:
            documents.DOCUMENTS_UPLOAD_DIR = previous_dir

    def test_regulation_oversize_keeps_previous_file(self) -> None:
        previous = self.root / "old-regulation.pdf"
        previous.write_bytes(b"old")
        regulation = SimpleNamespace(id=1, file_path=str(previous))
        db = _LookupDb(regulation)

        with (
            patch.object(regulations, "_require_admin"),
            patch.object(regulations, "REGULATION_UPLOAD_MAX_BYTES", 4),
        ):
            with self.assertRaises(HTTPException) as raised:
                regulations.admin_upload_regulation_file(
                    regulation_id=1,
                    file=_upload(b"12345", "regulation.pdf", "application/pdf"),
                    authorization=None,
                    db=db,
                )

        self.assertEqual(raised.exception.status_code, 413)
        self.assertEqual(previous.read_bytes(), b"old")
        self.assertEqual(db.commit_calls, 0)

    async def test_photo_oversize_keeps_previous_photo(self) -> None:
        photo_dir = self.root / "photos"
        photo_dir.mkdir()
        previous = photo_dir / "old.jpg"
        previous.write_bytes(b"old")
        user = SimpleNamespace(
            id=3,
            photo_path="photos/old.jpg",
            photo_filename="old.jpg",
        )
        db = _LookupDb(user)

        with (
            patch.object(admin, "_require_admin"),
            patch.object(admin, "PHOTO_UPLOAD_MAX_BYTES", 4),
        ):
            with self.assertRaises(HTTPException) as raised:
                await admin.admin_upload_user_photo(
                    user_id=3,
                    file=_upload(b"12345", "new.jpg", "image/jpeg"),
                    authorization=None,
                    db=db,
                )

        self.assertEqual(raised.exception.status_code, 413)
        self.assertEqual(previous.read_bytes(), b"old")
        self.assertEqual(db.commit_calls, 0)
        self.assertEqual(list(photo_dir.iterdir()), [previous])

    def test_certificate_oversize_keeps_previous_certificate(self) -> None:
        target = media_storage.certificate_file_path(4, "certificate.pdf")
        target.write_bytes(b"old certificate")
        user = SimpleNamespace(id=4)
        certificate = SimpleNamespace(file_path="certificates/4/certificate.pdf")

        class _CertificateDb(_LookupDb):
            def get(self, model, item_id):
                return user

            def scalar(self, query):
                return certificate

        db = _CertificateDb(user)
        with (
            patch.object(users, "_require_admin"),
            patch.object(users, "CERTIFICATE_UPLOAD_MAX_BYTES", 4),
        ):
            with self.assertRaises(HTTPException) as raised:
                users.upload_certificate_file(
                    user_id=4,
                    file=_upload(b"12345", "certificate.pdf", "application/pdf"),
                    authorization=None,
                    db=db,
                )

        self.assertEqual(raised.exception.status_code, 413)
        self.assertEqual(target.read_bytes(), b"old certificate")
        self.assertEqual(db.commit_calls, 0)
        self.assertEqual(list(target.parent.iterdir()), [target])


if __name__ == "__main__":
    unittest.main()
