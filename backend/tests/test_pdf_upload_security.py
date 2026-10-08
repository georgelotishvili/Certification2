from __future__ import annotations

import asyncio
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
import re
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import UploadFile
from starlette.datastructures import Headers

try:
    from backend.app.routers import multi_apartment, multi_functional
    from backend.app.services import media_storage
except ModuleNotFoundError:
    from app.routers import multi_apartment, multi_functional
    from app.services import media_storage


class _Upload:
    def __init__(self, content: bytes):
        self._stream = BytesIO(content)

    async def read(self, size: int = -1) -> bytes:
        return self._stream.read(size)


class _CancellingUpload:
    def __init__(self):
        self._read_count = 0

    async def read(self, size: int = -1) -> bytes:
        self._read_count += 1
        if self._read_count == 1:
            return b"%PDF-"
        if self._read_count == 2:
            return b"partial content"
        raise asyncio.CancelledError()


class _ProjectDb:
    def __init__(self, project: SimpleNamespace, *, fail_commit: bool = False):
        self.project = project
        self.fail_commit = fail_commit
        self.added = []
        self.commit_calls = 0
        self.rollback_calls = 0

    def get(self, model, project_id: int):
        return self.project if project_id == self.project.id else None

    def add(self, project) -> None:
        self.added.append(project)

    def commit(self) -> None:
        self.commit_calls += 1
        if self.fail_commit:
            raise RuntimeError("commit failed")

    def rollback(self) -> None:
        self.rollback_calls += 1


def _pdf_upload(filename: str = "replacement.pdf") -> UploadFile:
    return UploadFile(
        BytesIO(b"%PDF-1.7\nreplacement"),
        filename=filename,
        headers=Headers({"content-type": "application/pdf"}),
    )


def _route_cases():
    return (
        (
            multi_apartment,
            media_storage.ensure_multi_apartment_dir,
            media_storage.delete_replaced_multi_apartment_pdf,
        ),
        (
            multi_functional,
            media_storage.ensure_multi_functional_dir,
            media_storage.delete_replaced_multi_functional_pdf,
        ),
    )


class PdfStorageTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._temporary_directory = TemporaryDirectory()
        self._previous_root = media_storage._MEDIA_ROOT_CACHE
        media_storage._MEDIA_ROOT_CACHE = Path(self._temporary_directory.name)

    def tearDown(self) -> None:
        media_storage._MEDIA_ROOT_CACHE = self._previous_root
        self._temporary_directory.cleanup()

    def test_project_paths_are_server_generated_and_contained(self) -> None:
        apartment_path = media_storage.multi_apartment_pdf_path(
            7,
            "../../attacker-controlled.pdf",
        )
        functional_path = media_storage.multi_functional_pdf_path(
            8,
            "..\\attacker-controlled.pdf",
        )

        self.assertRegex(apartment_path.name, re.compile(r"^[0-9a-f]{32}\.pdf$"))
        self.assertRegex(functional_path.name, re.compile(r"^[0-9a-f]{32}\.pdf$"))
        self.assertEqual(apartment_path.parent.name, "7")
        self.assertEqual(functional_path.parent.name, "8")
        self.assertTrue(apartment_path.is_relative_to(media_storage.ensure_media_root()))
        self.assertTrue(functional_path.is_relative_to(media_storage.ensure_media_root()))

    def test_resolver_rejects_a_sibling_with_the_same_path_prefix(self) -> None:
        root = media_storage.ensure_media_root().resolve()
        outside = root.parent / f"{root.name}-outside" / "project.pdf"

        with self.assertRaises(ValueError):
            media_storage.resolve_storage_path(str(outside))

    def test_display_filename_removes_paths_and_control_characters(self) -> None:
        result = media_storage.safe_pdf_display_filename(
            "../folder\\report\r\nInjected.pdf"
        )

        self.assertEqual(result, "reportInjected.pdf")
        self.assertEqual(media_storage.safe_pdf_display_filename(None), "project.pdf")

    async def test_valid_pdf_is_streamed_to_the_generated_path(self) -> None:
        destination = media_storage.multi_apartment_pdf_path(1)
        content = b"%PDF-1.7\nsmall test document"

        size = await media_storage.save_pdf_upload(
            _Upload(content),
            destination,
            chunk_bytes=4,
        )

        self.assertEqual(size, len(content))
        self.assertEqual(destination.read_bytes(), content)

    async def test_non_pdf_magic_is_rejected_without_creating_a_file(self) -> None:
        destination = media_storage.multi_functional_pdf_path(2)

        with self.assertRaises(media_storage.InvalidPdfUpload):
            await media_storage.save_pdf_upload(
                _Upload(b"not a pdf"),
                destination,
            )

        self.assertFalse(destination.exists())

    async def test_oversized_pdf_is_removed(self) -> None:
        destination = media_storage.multi_apartment_pdf_path(3)

        with self.assertRaises(media_storage.PdfUploadTooLarge):
            await media_storage.save_pdf_upload(
                _Upload(b"%PDF-123456789"),
                destination,
                max_bytes=8,
                chunk_bytes=2,
            )

        self.assertFalse(destination.exists())

    async def test_destination_outside_media_root_is_rejected_before_open(self) -> None:
        root = media_storage.ensure_media_root().resolve()
        outside = root.parent / "outside.pdf"

        with self.assertRaises(ValueError):
            await media_storage.save_pdf_upload(_Upload(b"%PDF-1.7"), outside)

        self.assertFalse(outside.exists())

    async def test_upload_routes_replace_legacy_pdf_after_commit(self) -> None:
        for index, (route_module, ensure_project_dir, _) in enumerate(
            _route_cases(),
            start=1,
        ):
            project_id = 200 + index
            legacy_file = ensure_project_dir(project_id) / "legacy project.pdf"
            legacy_file.write_bytes(b"%PDF-1.4\nlegacy")
            project = SimpleNamespace(
                id=project_id,
                pdf_path=media_storage.relative_storage_path(legacy_file),
                pdf_filename="legacy project.pdf",
            )
            db = _ProjectDb(project)

            with patch.object(route_module, "_require_admin"):
                result = await route_module.upload_pdf(
                    project_id=project_id,
                    file=_pdf_upload("../replacement project.pdf"),
                    authorization=None,
                    db=db,
                )

            stored_file = media_storage.resolve_storage_path(project.pdf_path)
            self.assertEqual(result, {"message": "PDF uploaded successfully"})
            self.assertEqual(project.pdf_filename, "replacement project.pdf")
            self.assertRegex(stored_file.name, re.compile(r"^[0-9a-f]{32}\.pdf$"))
            self.assertTrue(stored_file.exists())
            self.assertFalse(legacy_file.exists())
            self.assertEqual(db.commit_calls, 1)
            self.assertEqual(db.rollback_calls, 0)

    async def test_upload_routes_never_delete_corrupt_cross_area_path(self) -> None:
        protected_dir = media_storage.ensure_media_root() / "certificates" / "9"
        protected_dir.mkdir(parents=True)

        for index, (route_module, _, _) in enumerate(_route_cases(), start=1):
            project_id = 300 + index
            protected_file = protected_dir / f"protected-{index}.pdf"
            protected_file.write_bytes(b"%PDF-1.4\nprotected")
            project = SimpleNamespace(
                id=project_id,
                pdf_path=media_storage.relative_storage_path(protected_file),
                pdf_filename=protected_file.name,
            )
            db = _ProjectDb(project)

            with patch.object(route_module, "_require_admin"):
                await route_module.upload_pdf(
                    project_id=project_id,
                    file=_pdf_upload(),
                    authorization=None,
                    db=db,
                )

            self.assertTrue(protected_file.exists())
            self.assertTrue(
                media_storage.resolve_storage_path(project.pdf_path).exists()
            )

    async def test_commit_failure_removes_new_file_and_preserves_legacy(self) -> None:
        for index, (route_module, ensure_project_dir, _) in enumerate(
            _route_cases(),
            start=1,
        ):
            project_id = 400 + index
            project_dir = ensure_project_dir(project_id)
            legacy_file = project_dir / "legacy.pdf"
            legacy_file.write_bytes(b"%PDF-1.4\nlegacy")
            project = SimpleNamespace(
                id=project_id,
                pdf_path=media_storage.relative_storage_path(legacy_file),
                pdf_filename=legacy_file.name,
            )
            db = _ProjectDb(project, fail_commit=True)

            with patch.object(route_module, "_require_admin"):
                with self.assertRaisesRegex(RuntimeError, "commit failed"):
                    await route_module.upload_pdf(
                        project_id=project_id,
                        file=_pdf_upload(),
                        authorization=None,
                        db=db,
                    )

            self.assertTrue(legacy_file.exists())
            self.assertEqual(list(project_dir.glob("*.pdf")), [legacy_file])
            self.assertEqual(db.commit_calls, 1)
            self.assertEqual(db.rollback_calls, 1)

    async def test_precommit_error_does_not_leave_orphan_pdf(self) -> None:
        for index, (route_module, ensure_project_dir, _) in enumerate(
            _route_cases(),
            start=1,
        ):
            project_id = 500 + index
            project_dir = ensure_project_dir(project_id)
            project = SimpleNamespace(
                id=project_id,
                pdf_path=None,
                pdf_filename=None,
            )
            db = _ProjectDb(project)

            with (
                patch.object(route_module, "_require_admin"),
                patch.object(
                    route_module,
                    "relative_storage_path",
                    side_effect=RuntimeError("path conversion failed"),
                ),
            ):
                with self.assertRaisesRegex(RuntimeError, "path conversion failed"):
                    await route_module.upload_pdf(
                        project_id=project_id,
                        file=_pdf_upload(),
                        authorization=None,
                        db=db,
                    )

            self.assertEqual(list(project_dir.glob("*.pdf")), [])
            self.assertEqual(db.commit_calls, 0)
            self.assertEqual(db.rollback_calls, 1)

    def test_admin_download_routes_still_read_legacy_pdf_paths(self) -> None:
        for index, (route_module, ensure_project_dir, _) in enumerate(
            _route_cases(),
            start=1,
        ):
            project_id = 600 + index
            legacy_file = ensure_project_dir(project_id) / "legacy report.pdf"
            legacy_file.write_bytes(b"%PDF-1.4\nlegacy")
            project = SimpleNamespace(
                id=project_id,
                pdf_path=media_storage.relative_storage_path(legacy_file),
                pdf_filename='legacy "report".pdf',
            )
            db = _ProjectDb(project)

            with patch.object(route_module, "_require_admin"):
                response = route_module.download_pdf(
                    project_id=project_id,
                    authorization=None,
                    db=db,
                )

            self.assertEqual(Path(response.path).resolve(), legacy_file.resolve())
            disposition = response.headers["content-disposition"]
            self.assertTrue(disposition.startswith("inline;"))
            self.assertNotIn("\r", disposition)
            self.assertNotIn("\n", disposition)

    def test_replacement_deletion_is_limited_to_the_exact_project_dir(self) -> None:
        protected_dir = media_storage.ensure_media_root() / "certificates" / "1"
        protected_dir.mkdir(parents=True)

        for index, (_, ensure_project_dir, delete_replaced) in enumerate(
            _route_cases(),
            start=1,
        ):
            project_id = 100 + index
            expected_file = ensure_project_dir(project_id) / "legacy.pdf"
            expected_file.write_bytes(b"legacy")

            other_project_file = ensure_project_dir(project_id + 1000) / "other.pdf"
            other_project_file.write_bytes(b"other")

            protected_file = protected_dir / f"protected-{index}.pdf"
            protected_file.write_bytes(b"protected")

            self.assertFalse(
                delete_replaced(
                    project_id,
                    media_storage.relative_storage_path(other_project_file),
                )
            )
            self.assertTrue(other_project_file.exists())

            self.assertFalse(
                delete_replaced(
                    project_id,
                    media_storage.relative_storage_path(protected_file),
                )
            )
            self.assertTrue(protected_file.exists())

            self.assertTrue(
                delete_replaced(
                    project_id,
                    media_storage.relative_storage_path(expected_file),
                )
            )
            self.assertFalse(expected_file.exists())

    async def test_cancellation_removes_partial_file_and_is_not_swallowed(self) -> None:
        destination = media_storage.multi_apartment_pdf_path(4)

        with self.assertRaises(asyncio.CancelledError):
            await media_storage.save_pdf_upload(
                _CancellingUpload(),
                destination,
                chunk_bytes=4,
            )

        self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
