from __future__ import annotations

import os
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

try:
    from backend.app import database
    from backend.scripts import migrate_statements_attachment
except ModuleNotFoundError:
    from app import database
    from scripts import migrate_statements_attachment


def _create_statements_table(path: Path) -> None:
    connection = sqlite3.connect(str(path))
    try:
        connection.execute("CREATE TABLE statements (id INTEGER PRIMARY KEY)")
        connection.commit()
    finally:
        connection.close()


def _statement_columns(path: Path) -> set[str]:
    connection = sqlite3.connect(str(path))
    try:
        return {
            row[1]
            for row in connection.execute("PRAGMA table_info(statements)")
        }
    finally:
        connection.close()


class DatabasePathConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary_directory = TemporaryDirectory()
        self.root = Path(self._temporary_directory.name)

    def tearDown(self) -> None:
        self._temporary_directory.cleanup()

    def test_missing_override_keeps_backend_app_db_default(self) -> None:
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop(database.DATABASE_PATH_ENV, None)
            resolved = Path(database._sqlite_path()).resolve()

        expected = Path(database.__file__).resolve().parent.parent / "app.db"
        self.assertEqual(resolved, expected)

    def test_empty_override_fails_clearly(self) -> None:
        with patch.dict(
            os.environ,
            {database.DATABASE_PATH_ENV: "   "},
            clear=False,
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "GIPC_DATABASE_PATH must not be blank",
            ):
                database._sqlite_path()

    def test_absolute_override_is_used_verbatim(self) -> None:
        configured = self.root / "production" / "gipc.db"
        with patch.dict(
            os.environ,
            {database.DATABASE_PATH_ENV: f"  {configured}  "},
            clear=False,
        ):
            resolved = database._sqlite_path()

        self.assertEqual(resolved, str(configured))

    def test_relative_override_fails_clearly(self) -> None:
        with patch.dict(
            os.environ,
            {database.DATABASE_PATH_ENV: "var/lib/gipc/app.db"},
            clear=False,
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "GIPC_DATABASE_PATH must be an absolute filesystem path",
            ):
                database._sqlite_path()

    def test_existing_directory_override_fails_clearly(self) -> None:
        configured_directory = self.root / "database-directory"
        configured_directory.mkdir()
        with patch.dict(
            os.environ,
            {database.DATABASE_PATH_ENV: str(configured_directory)},
            clear=False,
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "must point to a database file, not a directory",
            ):
                database._sqlite_path()

    def test_startup_migration_uses_configured_database_only(self) -> None:
        configured = self.root / "configured.db"
        legacy_default = self.root / "app.db"
        _create_statements_table(configured)
        _create_statements_table(legacy_default)

        with (
            patch.object(
                migrate_statements_attachment,
                "SQLITE_PATH",
                str(configured),
            ),
            patch("builtins.print"),
        ):
            migrate_statements_attachment.run()

        attachment_columns = {
            "attachment_path",
            "attachment_filename",
            "attachment_mime_type",
            "attachment_size_bytes",
        }
        self.assertTrue(
            attachment_columns.issubset(_statement_columns(configured))
        )
        self.assertEqual(_statement_columns(legacy_default), {"id"})


if __name__ == "__main__":
    unittest.main()
