from __future__ import annotations

from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

try:
    from backend.scripts import migrate_user_code_reservations as migration
except ModuleNotFoundError:
    from scripts import migrate_user_code_reservations as migration


class UserCodeReservationsMigrationTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="user-code-migration-test-")
        self.addCleanup(directory.cleanup)
        self.db_path = Path(directory.name) / "isolated.db"
        database_path = patch.object(migration, "SQLITE_PATH", str(self.db_path))
        database_path.start()
        self.addCleanup(database_path.stop)

    def create_legacy_users(self):
        # Only the old columns: the migration must not depend on ORM/new schema.
        with closing(sqlite3.connect(self.db_path)) as conn, conn:
            conn.execute("CREATE TABLE users (personal_id TEXT, code TEXT)")
            conn.executemany("INSERT INTO users VALUES (?, ?)", [
                ("00000000001", "0000000001"),
                ("00000000002", "0000000002"),
            ])

    def dump_database(self):
        with closing(sqlite3.connect(self.db_path)) as conn:
            return list(conn.iterdump())

    def reservations(self):
        with closing(sqlite3.connect(self.db_path)) as conn:
            return conn.execute(
                "SELECT personal_id, code FROM user_code_reservations ORDER BY personal_id"
            ).fetchall()

    def test_backfill_twice_preserves_all_existing_tables_and_values(self):
        with closing(sqlite3.connect(self.db_path)) as conn, conn:
            conn.execute("""
                CREATE TABLE users (
                    id INTEGER PRIMARY KEY,
                    personal_id VARCHAR(11) NOT NULL UNIQUE,
                    code VARCHAR(10) NOT NULL UNIQUE,
                    first_name TEXT, is_admin BOOLEAN, exam_permission BOOLEAN
                )
            """)
            conn.executemany("INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)", [
                (1, "00000000001", "0000000001", "Unchanged candidate", 0, 0),
                (2, "00000000002", "0000000002", "Unchanged administrator", 1, 1),
            ])
            conn.execute("CREATE TABLE certificates (id INTEGER PRIMARY KEY, user_id INTEGER, data BLOB)")
            conn.execute("INSERT INTO certificates VALUES (1, 1, ?)", (b"certificate bytes",))
            conn.execute("CREATE TABLE exam_sessions (id INTEGER PRIMARY KEY, user_id INTEGER, score INTEGER)")
            conn.execute("INSERT INTO exam_sessions VALUES (1, 2, 97)")
            conn.execute("CREATE TABLE sentinel (value TEXT)")
            conn.execute("INSERT INTO sentinel VALUES ('do not change')")
            original_schema = conn.execute(
                "SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name"
            ).fetchall()
            original_rows = {
                name: conn.execute(f'SELECT * FROM "{name}"').fetchall()
                for name, _sql in original_schema
            }

        migration.run()
        first_dump = self.dump_database()
        migration.run()

        self.assertEqual(self.dump_database(), first_dump)
        self.assertEqual(self.reservations(), [
            ("00000000001", "0000000001"), ("00000000002", "0000000002"),
        ])
        with closing(sqlite3.connect(self.db_path)) as conn:
            for name, sql in original_schema:
                self.assertEqual(conn.execute(
                    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (name,)
                ).fetchone(), (sql,))
                self.assertEqual(conn.execute(f'SELECT * FROM "{name}"').fetchall(), original_rows[name])

    def test_offline_legacy_table_requires_only_personal_id_and_code(self):
        self.create_legacy_users()
        migration.run()
        self.assertEqual(self.reservations(), [
            ("00000000001", "0000000001"), ("00000000002", "0000000002"),
        ])

    def test_deleted_user_reservations_survive_delete_and_rerun(self):
        self.create_legacy_users()
        migration.run()
        original_reservations = self.reservations()
        with closing(sqlite3.connect(self.db_path)) as conn, conn:
            conn.execute("PRAGMA foreign_keys=ON")
            self.assertEqual(conn.execute("PRAGMA foreign_key_list(user_code_reservations)").fetchall(), [])
            conn.execute("DELETE FROM users WHERE personal_id='00000000001'")
        migration.run()
        self.assertEqual(self.reservations(), original_reservations)

    def test_new_users_are_backfilled_without_losing_deleted_user_reservations(self):
        self.create_legacy_users()
        migration.run()
        with closing(sqlite3.connect(self.db_path)) as conn, conn:
            conn.execute("DELETE FROM users WHERE personal_id='00000000001'")
            conn.execute("INSERT INTO users VALUES ('00000000003', '0000000003')")
        migration.run()
        self.assertEqual(self.reservations(), [
            ("00000000001", "0000000001"),
            ("00000000002", "0000000002"),
            ("00000000003", "0000000003"),
        ])

    def test_conflicting_existing_personal_id_fails_without_partial_backfill(self):
        self.create_legacy_users()
        migration.run()
        with closing(sqlite3.connect(self.db_path)) as conn, conn:
            conn.execute("INSERT INTO users VALUES ('00000000003', '0000000003')")
            conn.execute("INSERT INTO users VALUES ('00000000004', '0000000004')")
            conn.execute("UPDATE users SET code='0000000999' WHERE personal_id='00000000002'")
        before = self.dump_database()

        with self.assertRaisesRegex(RuntimeError, "reservation conflicts"):
            migration.run()

        self.assertEqual(self.dump_database(), before)

    def test_conflicting_reserved_code_fails_without_partial_backfill(self):
        self.create_legacy_users()
        migration.run()
        with closing(sqlite3.connect(self.db_path)) as conn, conn:
            conn.execute("DELETE FROM users WHERE personal_id='00000000002'")
            conn.execute("INSERT INTO users VALUES ('00000000003', '0000000003')")
            conn.execute("INSERT INTO users VALUES ('00000000004', '0000000004')")
            conn.execute("INSERT INTO users VALUES ('00000000005', '0000000002')")
        before = self.dump_database()

        with self.assertRaisesRegex(RuntimeError, "belongs to another personal ID"):
            migration.run()

        self.assertEqual(self.dump_database(), before)

    def test_duplicate_legacy_user_values_roll_back_table_creation(self):
        for duplicate in [
            ("00000000001", "0000000099"),
            ("00000000099", "0000000001"),
        ]:
            with self.subTest(duplicate=duplicate):
                self.db_path = self.db_path.with_name(f"duplicate-{duplicate[0]}-{duplicate[1]}.db")
                self.create_legacy_users()
                with closing(sqlite3.connect(self.db_path)) as conn, conn:
                    conn.execute("INSERT INTO users VALUES (?, ?)", duplicate)
                before = self.dump_database()
                with patch.object(migration, "SQLITE_PATH", str(self.db_path)):
                    with self.assertRaises(sqlite3.IntegrityError):
                        migration.run()
                self.assertEqual(self.dump_database(), before)

    def test_registry_enforces_unique_non_null_personal_id_and_code(self):
        self.create_legacy_users()
        migration.run()
        for invalid in [
            ("00000000001", "0000000003"),
            ("00000000003", "0000000001"),
            (None, "0000000003"),
            ("00000000003", None),
        ]:
            with self.subTest(invalid=invalid):
                with closing(sqlite3.connect(self.db_path)) as conn, conn:
                    with self.assertRaises(sqlite3.IntegrityError):
                        conn.execute("INSERT INTO user_code_reservations VALUES (?, ?)", invalid)
        self.assertEqual(len(self.reservations()), 2)

    def test_missing_database_and_missing_users_table_are_safe_no_ops(self):
        migration.run()
        self.assertFalse(self.db_path.exists())
        with closing(sqlite3.connect(self.db_path)) as conn, conn:
            conn.execute("CREATE TABLE sentinel (value TEXT)")
            conn.execute("INSERT INTO sentinel VALUES ('do not change')")
        before = self.dump_database()
        migration.run()
        self.assertEqual(self.dump_database(), before)


if __name__ == "__main__":
    unittest.main()
