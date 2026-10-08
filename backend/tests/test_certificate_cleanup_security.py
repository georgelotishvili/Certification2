from __future__ import annotations

import inspect
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

try:
    from backend.app.routers import admin, users
    from backend.app.services import expert_certificate_cleanup, media_storage
except ModuleNotFoundError:
    from app.routers import admin, users
    from app.services import expert_certificate_cleanup, media_storage


class _Rows:
    def __init__(self, items):
        self.items = items

    def all(self):
        return self.items


class _QueueDb:
    def __init__(
        self,
        *,
        get_value=None,
        scalar_results=None,
        scalars_results=None,
    ):
        self.get_value = get_value
        self.scalar_results = list(scalar_results or [])
        self.scalars_results = list(scalars_results or [])
        self.deleted = []
        self.added = []
        self.executed = []
        self.commit_calls = 0

    def get(self, model, object_id: int):
        if self.get_value is not None and self.get_value.id == object_id:
            return self.get_value
        return None

    def scalar(self, query):
        return self.scalar_results.pop(0)

    def scalars(self, query):
        return _Rows(self.scalars_results.pop(0))

    def delete(self, item) -> None:
        self.deleted.append(item)

    def add(self, item) -> None:
        self.added.append(item)

    def execute(self, statement):
        self.executed.append(statement)

    def commit(self) -> None:
        self.commit_calls += 1


class ExpertCertificateCleanupTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary_directory = TemporaryDirectory()
        self.media_root = Path(self._temporary_directory.name) / "media"
        self._previous_media_root = media_storage._MEDIA_ROOT_CACHE
        media_storage._MEDIA_ROOT_CACHE = self.media_root
        self.expert_root = self.media_root / "expert"
        self.expert_root.mkdir(parents=True)

    def tearDown(self) -> None:
        media_storage._MEDIA_ROOT_CACHE = self._previous_media_root
        self._temporary_directory.cleanup()

    def test_valid_direct_ex_code_removes_certificate_pdfs_and_empty_dirs(self) -> None:
        code_dir = self.expert_root / "EX-2026-001"
        empty_subdir = code_dir / "empty"
        empty_subdir.mkdir(parents=True)
        (code_dir / "certificate.pdf").write_bytes(b"pdf")
        (code_dir / "certificate-old.pdf").write_bytes(b"pdf")

        result = expert_certificate_cleanup.delete_expert_certificate_files(
            "  EX-2026-001  "
        )

        self.assertTrue(result)
        self.assertFalse(code_dir.exists())

    def test_cleanup_preserves_unrelated_files_and_other_code_directories(self) -> None:
        code_dir = self.expert_root / "EX-2026-002"
        code_dir.mkdir()
        certificate = code_dir / "certificate.pdf"
        unrelated = code_dir / "project.pdf"
        certificate.write_bytes(b"certificate")
        unrelated.write_bytes(b"project")

        other_dir = self.expert_root / "EX-2026-003"
        other_dir.mkdir()
        other_certificate = other_dir / "certificate.pdf"
        other_certificate.write_bytes(b"other")

        self.assertTrue(
            expert_certificate_cleanup.delete_expert_certificate_files(
                "EX-2026-002"
            )
        )

        self.assertFalse(certificate.exists())
        self.assertTrue(unrelated.exists())
        self.assertTrue(other_certificate.exists())

    def test_traversal_absolute_nested_and_backslash_codes_are_rejected(self) -> None:
        protected_dir = self.expert_root / "EX-protected"
        protected_dir.mkdir()
        protected_file = protected_dir / "certificate.pdf"
        protected_file.write_bytes(b"protected")

        invalid_codes = (
            "EX-../EX-protected",
            "EX-nested/../EX-protected",
            r"EX-nested\..\EX-protected",
            "EX-/absolute",
            str(protected_dir.resolve()),
        )

        for code in invalid_codes:
            with self.subTest(code=code):
                self.assertFalse(
                    expert_certificate_cleanup.delete_expert_certificate_files(code)
                )
                self.assertTrue(protected_file.exists())

    def test_invalid_values_are_no_op(self) -> None:
        for value in (None, "", "   ", "CERT-2026-001", "ex-2026-001", 17):
            with self.subTest(value=value):
                self.assertFalse(
                    expert_certificate_cleanup.delete_expert_certificate_files(value)
                )

    def test_directory_enumeration_error_remains_best_effort(self) -> None:
        code_dir = self.expert_root / "EX-enumeration-error"
        code_dir.mkdir()
        certificate = code_dir / "certificate.pdf"
        certificate.write_bytes(b"certificate")

        with patch.object(Path, "glob", side_effect=OSError("scan failed")):
            result = expert_certificate_cleanup.delete_expert_certificate_files(
                "EX-enumeration-error"
            )

        self.assertTrue(result)
        self.assertTrue(certificate.exists())

    def test_symlinked_code_directory_cannot_escape_expert_root(self) -> None:
        outside_dir = Path(self._temporary_directory.name) / "outside"
        outside_dir.mkdir()
        outside_file = outside_dir / "certificate.pdf"
        outside_file.write_bytes(b"outside")
        link = self.expert_root / "EX-link"
        try:
            link.symlink_to(outside_dir, target_is_directory=True)
        except OSError:
            # Windows may prohibit creating symlinks without elevated privileges.
            # Exercise the same guard deterministically in that environment.
            link.mkdir()
            original_is_symlink = Path.is_symlink

            def simulated_symlink(path: Path) -> bool:
                if path == link:
                    return True
                return original_is_symlink(path)

            with patch.object(Path, "is_symlink", new=simulated_symlink):
                self.assertFalse(
                    expert_certificate_cleanup.delete_expert_certificate_files(
                        "EX-link"
                    )
                )
        else:
            self.assertFalse(
                expert_certificate_cleanup.delete_expert_certificate_files("EX-link")
            )
            self.assertTrue(link.is_symlink())

        self.assertTrue(outside_file.exists())

    def test_users_cleanup_helper_dispatches_raw_code_once(self) -> None:
        cert = SimpleNamespace(
            file_path=None,
            level="expert",
            unique_code="EX-users-dispatch",
        )

        with patch.object(users, "delete_expert_certificate_files") as cleanup:
            users._delete_certificate_files(cert, user_id=41)

        cleanup.assert_called_once_with("EX-users-dispatch")

    def test_users_certificate_endpoint_dispatches_cleanup_wrapper(self) -> None:
        user = SimpleNamespace(id=42, photo_path=None, photo_filename=None)
        cert = SimpleNamespace(
            file_path=None,
            level="expert",
            unique_code="EX-users-endpoint",
        )
        db = _QueueDb(
            scalar_results=[user, cert],
            scalars_results=[[]],
        )

        with (
            patch.object(users, "_require_admin"),
            patch.object(users, "_delete_certificate_files") as cleanup,
        ):
            result = users.delete_certificate(
                user_id=user.id,
                authorization=None,
                db=db,
            )

        self.assertIsNone(result)
        cleanup.assert_called_once_with(cert, user.id)
        self.assertEqual(db.deleted, [cert])
        self.assertEqual(db.commit_calls, 1)

    def test_admin_single_delete_dispatches_contained_cleanup(self) -> None:
        user = SimpleNamespace(id=43, email="target@example.com")
        cert = SimpleNamespace(
            file_path=None,
            level="expert",
            unique_code="EX-admin-single",
        )
        db = _QueueDb(
            get_value=user,
            scalar_results=[cert],
            scalars_results=[[], []],
        )
        settings = SimpleNamespace(founder_admin_email="founder@example.com")

        with (
            patch.object(admin, "get_settings", return_value=settings),
            patch.object(admin, "_is_founder_actor", return_value=True),
            patch.object(admin, "remember_user_code") as preserve_code,
            patch.object(admin, "_delete_user_photo_file"),
            patch.object(admin, "delete_expert_certificate_files") as cleanup,
        ):
            result = admin.admin_delete_user(
                user_id=user.id,
                authorization=None,
                db=db,
            )

        self.assertIsNone(result)
        preserve_code.assert_called_once_with(db, user)
        cleanup.assert_called_once_with("EX-admin-single")
        self.assertEqual(db.deleted, [user])
        self.assertEqual(db.commit_calls, 1)

    def test_admin_bulk_delete_dispatches_contained_cleanup(self) -> None:
        founder = SimpleNamespace(id=1, email="founder@example.com")
        target = SimpleNamespace(id=44, email="target@example.com")
        cert = SimpleNamespace(
            file_path=None,
            level="expert",
            unique_code="EX-admin-bulk",
        )
        db = _QueueDb(
            scalar_results=[cert],
            scalars_results=[[founder, target], []],
        )
        settings = SimpleNamespace(founder_admin_email=founder.email)

        with (
            patch.object(admin, "get_settings", return_value=settings),
            patch.object(admin, "_is_founder_actor", return_value=True),
            patch.object(admin, "remember_user_code") as preserve_code,
            patch.object(admin, "_delete_user_photo_file"),
            patch.object(admin, "delete_expert_certificate_files") as cleanup,
        ):
            result = admin.admin_delete_all_users(
                authorization=None,
                db=db,
            )

        self.assertIsNone(result)
        preserve_code.assert_called_once_with(db, target)
        cleanup.assert_called_once_with("EX-admin-bulk")
        self.assertEqual(db.deleted, [target])
        self.assertEqual(db.commit_calls, 1)

    def test_routers_no_longer_join_unique_code_into_expert_path(self) -> None:
        raw_join = 'expert_dir = media_root / "expert" / unique_code'
        self.assertNotIn(raw_join, inspect.getsource(users))
        self.assertNotIn(raw_join, inspect.getsource(admin))


if __name__ == "__main__":
    unittest.main()
