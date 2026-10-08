from __future__ import annotations

from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import re
import unittest
from unittest.mock import patch

from fastapi import HTTPException, UploadFile
from starlette.datastructures import Headers

try:
    from backend.app.routers import documents
except ModuleNotFoundError:
    from app.routers import documents


class _FakeDb:
    def __init__(
        self,
        document=None,
        *,
        fail_commit: bool = False,
        on_commit=None,
    ):
        self.document = document
        self.fail_commit = fail_commit
        self.on_commit = on_commit
        self.added = []
        self.deleted = []
        self.commit_calls = 0
        self.rollback_calls = 0
        self.refresh_calls = 0

    def scalar(self, query):
        return 0

    def get(self, model, document_id: int):
        if self.document is not None and self.document.id == document_id:
            return self.document
        return None

    def add(self, document) -> None:
        self.added.append(document)

    def delete(self, document) -> None:
        self.deleted.append(document)

    def commit(self) -> None:
        self.commit_calls += 1
        if self.on_commit is not None:
            self.on_commit()
        if self.fail_commit:
            raise RuntimeError("commit failed")

    def rollback(self) -> None:
        self.rollback_calls += 1

    def refresh(self, document) -> None:
        self.refresh_calls += 1


def _docx_upload(
    filename: str,
    content: bytes = b"PK\x03\x04test docx content",
) -> UploadFile:
    return UploadFile(
        BytesIO(content),
        filename=filename,
        headers=Headers(
            {
                "content-type": (
                    "application/vnd.openxmlformats-officedocument."
                    "wordprocessingml.document"
                )
            }
        ),
    )


class _FailingStream:
    def __init__(self):
        self.read_count = 0

    def read(self, size: int = -1) -> bytes:
        self.read_count += 1
        if self.read_count == 1:
            return b"partial"
        raise RuntimeError("read failed")


class DocumentUploadSecurityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._temporary_directory = TemporaryDirectory()
        self.temporary_root = Path(self._temporary_directory.name)
        self.documents_root = self.temporary_root / "documents"
        self._previous_upload_dir = documents.DOCUMENTS_UPLOAD_DIR
        documents.DOCUMENTS_UPLOAD_DIR = self.documents_root

    def tearDown(self) -> None:
        documents.DOCUMENTS_UPLOAD_DIR = self._previous_upload_dir
        self._temporary_directory.cleanup()

    async def test_create_uses_uuid_storage_and_safe_display_basename(self) -> None:
        db = _FakeDb()

        with (
            patch.object(documents, "_require_admin"),
            patch.object(documents, "_document_out", side_effect=lambda doc: doc),
        ):
            created = await documents.admin_create_document(
                title="Title",
                content="Content",
                file=_docx_upload("../../../../outside.docx"),
                authorization=None,
                db=db,
            )

        stored_path = documents._resolve_document_path(created.file_path)
        self.assertRegex(stored_path.name, re.compile(r"^[0-9a-f]{32}\.docx$"))
        self.assertEqual(created.filename, "outside.docx")
        self.assertEqual(stored_path.read_bytes(), b"PK\x03\x04test docx content")
        self.assertFalse((self.temporary_root / "outside.docx").exists())
        self.assertEqual(db.commit_calls, 1)

    async def test_update_writes_and_commits_before_deleting_legacy_file(self) -> None:
        legacy_file = self.documents_root / "legacy original.docx"
        legacy_file.parent.mkdir(parents=True)
        legacy_file.write_bytes(b"legacy")
        doc = SimpleNamespace(
            id=10,
            title="Old",
            content="Old",
            file_path=str(legacy_file),
            filename=legacy_file.name,
            file_size_bytes=legacy_file.stat().st_size,
        )
        commit_observation = []
        db = _FakeDb(
            doc,
            on_commit=lambda: commit_observation.append(legacy_file.exists()),
        )

        with (
            patch.object(documents, "_require_admin"),
            patch.object(documents, "_document_out", side_effect=lambda item: item),
        ):
            updated = await documents.admin_update_document(
                doc_id=doc.id,
                title=None,
                content=None,
                file=_docx_upload("..\\..\\replacement.docx"),
                authorization=None,
                db=db,
            )

        new_path = documents._resolve_document_path(updated.file_path)
        self.assertEqual(commit_observation, [True])
        self.assertFalse(legacy_file.exists())
        self.assertRegex(new_path.name, re.compile(r"^[0-9a-f]{32}\.docx$"))
        self.assertTrue(new_path.exists())
        self.assertEqual(updated.filename, "replacement.docx")

    async def test_update_commit_failure_keeps_old_and_removes_new(self) -> None:
        legacy_file = self.documents_root / "legacy.docx"
        legacy_file.parent.mkdir(parents=True)
        legacy_file.write_bytes(b"legacy")
        doc = SimpleNamespace(
            id=11,
            title="Old",
            content="Old",
            file_path=str(legacy_file),
            filename=legacy_file.name,
            file_size_bytes=legacy_file.stat().st_size,
        )
        db = _FakeDb(doc, fail_commit=True)

        with patch.object(documents, "_require_admin"):
            with self.assertRaisesRegex(RuntimeError, "commit failed"):
                await documents.admin_update_document(
                    doc_id=doc.id,
                    title=None,
                    content=None,
                    file=_docx_upload("replacement.docx"),
                    authorization=None,
                    db=db,
                )

        self.assertTrue(legacy_file.exists())
        self.assertEqual(list(self.documents_root.glob("*.docx")), [legacy_file])
        self.assertEqual(db.rollback_calls, 1)

    def test_download_rejects_outside_path_without_touching_file(self) -> None:
        outside_file = self.temporary_root / "outside.docx"
        outside_file.write_bytes(b"outside")
        doc = SimpleNamespace(
            id=12,
            file_path=str(outside_file),
            filename="outside.docx",
        )

        with self.assertRaises(HTTPException) as raised:
            documents.download_document_file(doc_id=doc.id, db=_FakeDb(doc))

        self.assertEqual(raised.exception.status_code, 404)
        self.assertTrue(outside_file.exists())

    def test_admin_delete_never_deletes_outside_path(self) -> None:
        outside_file = self.temporary_root / "outside.docx"
        outside_file.write_bytes(b"outside")
        doc = SimpleNamespace(
            id=13,
            file_path=str(outside_file),
            filename="outside.docx",
        )
        db = _FakeDb(doc)

        with patch.object(documents, "_require_admin"):
            result = documents.admin_delete_document(
                doc_id=doc.id,
                authorization=None,
                db=db,
            )

        self.assertIsNone(result)
        self.assertTrue(outside_file.exists())
        self.assertEqual(db.deleted, [doc])
        self.assertEqual(db.commit_calls, 1)

    def test_admin_delete_removes_inside_file_only_after_commit(self) -> None:
        stored_file = self.documents_root / "stored.docx"
        stored_file.parent.mkdir(parents=True)
        stored_file.write_bytes(b"stored")
        doc = SimpleNamespace(
            id=15,
            file_path=str(stored_file),
            filename=stored_file.name,
        )
        commit_observation = []
        db = _FakeDb(
            doc,
            on_commit=lambda: commit_observation.append(stored_file.exists()),
        )

        with patch.object(documents, "_require_admin"):
            documents.admin_delete_document(
                doc_id=doc.id,
                authorization=None,
                db=db,
            )

        self.assertEqual(commit_observation, [True])
        self.assertFalse(stored_file.exists())
        self.assertEqual(db.deleted, [doc])

    def test_admin_delete_commit_failure_preserves_inside_file(self) -> None:
        stored_file = self.documents_root / "stored.docx"
        stored_file.parent.mkdir(parents=True)
        stored_file.write_bytes(b"stored")
        doc = SimpleNamespace(
            id=16,
            file_path=str(stored_file),
            filename=stored_file.name,
        )
        db = _FakeDb(doc, fail_commit=True)

        with patch.object(documents, "_require_admin"):
            with self.assertRaisesRegex(RuntimeError, "commit failed"):
                documents.admin_delete_document(
                    doc_id=doc.id,
                    authorization=None,
                    db=db,
                )

        self.assertTrue(stored_file.exists())
        self.assertEqual(db.rollback_calls, 1)

    def test_download_supports_legitimate_legacy_path(self) -> None:
        legacy_file = self.documents_root / "legacy stored name.docx"
        legacy_file.parent.mkdir(parents=True)
        legacy_file.write_bytes(b"legacy")
        doc = SimpleNamespace(
            id=14,
            file_path=str(legacy_file),
            filename='legacy "display".docx',
        )

        response = documents.download_document_file(
            doc_id=doc.id,
            db=_FakeDb(doc),
        )

        self.assertEqual(Path(response.path).resolve(), legacy_file.resolve())
        disposition = response.headers["content-disposition"]
        self.assertNotIn("\r", disposition)
        self.assertNotIn("\n", disposition)

    def test_write_failure_removes_partial_file(self) -> None:
        stored_path, destination = documents._new_document_storage_path()
        upload = SimpleNamespace(file=_FailingStream())

        with self.assertRaisesRegex(RuntimeError, "read failed"):
            documents._write_document_upload(upload, destination)

        self.assertFalse(documents._resolve_document_path(stored_path).exists())


if __name__ == "__main__":
    unittest.main()
