from __future__ import annotations

from contextlib import nullcontext
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from fastapi import UploadFile
from starlette.datastructures import Headers

try:
    from backend.app.routers import expert_uploads
    from backend.app.services import media_storage
except ModuleNotFoundError:
    from app.routers import expert_uploads
    from app.services import media_storage


def _upload(content: bytes = b"small expert file") -> UploadFile:
    return UploadFile(
        BytesIO(content),
        filename="project.pdf",
        headers=Headers({"content-type": "application/pdf"}),
    )


class ExpertUploadPathSecurityTests(unittest.TestCase):
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

    def test_traversal_absolute_nested_and_invalid_codes_are_rejected(self) -> None:
        invalid_codes = (
            None,
            "",
            "EX-",
            "OTHER-2026-001",
            "../EX-outside",
            "EX-nested/child",
            r"EX-nested\child",
            "EX-nested/../EX-valid",
            "EX-/absolute",
            str((self.workspace / "EX-absolute").resolve()),
        )

        for code in invalid_codes:
            with self.subTest(code=code):
                with self.assertRaises(ValueError):
                    expert_uploads._expert_dir(code)  # type: ignore[arg-type]

        self.assertFalse((self.media_root / "expert").exists())

    def test_valid_new_and_existing_directories_still_write(self) -> None:
        code = "EX-2026-08-03-001"
        created = expert_uploads._expert_dir(code)
        marker = created / "existing.marker"
        marker.write_bytes(b"keep")

        existing = expert_uploads._expert_dir(code)
        storage_path, display_name = expert_uploads._save_file(code, _upload())
        stored = media_storage.resolve_storage_path(storage_path)

        self.assertEqual(existing, created)
        self.assertEqual(created.parent, self.media_root.resolve() / "expert")
        self.assertEqual(display_name, "project.pdf")
        self.assertEqual(stored.parent, created)
        self.assertEqual(stored.read_bytes(), b"small expert file")
        self.assertEqual(marker.read_bytes(), b"keep")

    def test_symlinked_expert_root_is_rejected_before_file_write(self) -> None:
        outside = self.workspace / "outside-expert-root"
        outside.mkdir()
        expert_root = self.media_root / "expert"
        try:
            expert_root.symlink_to(outside, target_is_directory=True)
        except (NotImplementedError, OSError):
            expert_root.mkdir()
            original_is_symlink = Path.is_symlink

            def simulated_symlink(path: Path) -> bool:
                if path == expert_root:
                    return True
                return original_is_symlink(path)

            symlink_guard = patch.object(
                Path,
                "is_symlink",
                new=simulated_symlink,
            )
        else:
            symlink_guard = nullcontext()

        with (
            symlink_guard,
            patch.object(expert_uploads, "save_upload_stream") as writer,
        ):
            with self.assertRaises(ValueError):
                expert_uploads._save_file("EX-2026-001", _upload())

        writer.assert_not_called()
        self.assertEqual(list(outside.iterdir()), [])

    def test_symlinked_code_directory_is_rejected_before_file_write(self) -> None:
        outside = self.workspace / "outside-code-root"
        outside.mkdir()
        expert_root = self.media_root / "expert"
        expert_root.mkdir()
        code_link = expert_root / "EX-2026-002"
        try:
            code_link.symlink_to(outside, target_is_directory=True)
        except (NotImplementedError, OSError):
            code_link.mkdir()
            original_is_symlink = Path.is_symlink

            def simulated_symlink(path: Path) -> bool:
                if path == code_link:
                    return True
                return original_is_symlink(path)

            symlink_guard = patch.object(
                Path,
                "is_symlink",
                new=simulated_symlink,
            )
        else:
            symlink_guard = nullcontext()

        with (
            symlink_guard,
            patch.object(expert_uploads, "save_upload_stream") as writer,
        ):
            with self.assertRaises(ValueError):
                expert_uploads._save_file("EX-2026-002", _upload())

        writer.assert_not_called()
        self.assertEqual(list(outside.iterdir()), [])

    def test_non_directory_aliases_are_rejected_before_file_write(self) -> None:
        expert_root = self.media_root / "expert"
        expert_root.mkdir()
        code_file = expert_root / "EX-2026-003"
        code_file.write_bytes(b"not a directory")

        with patch.object(expert_uploads, "save_upload_stream") as writer:
            with self.assertRaises(ValueError):
                expert_uploads._save_file("EX-2026-003", _upload())

        writer.assert_not_called()
        self.assertEqual(code_file.read_bytes(), b"not a directory")


if __name__ == "__main__":
    unittest.main()
