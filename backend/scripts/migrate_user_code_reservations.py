"""Reserve existing personal-ID/code pairs without changing user records."""
from __future__ import annotations

import sqlite3
from contextlib import closing
from pathlib import Path

try:
    from backend.app.database import SQLITE_PATH
except ImportError:  # pragma: no cover - fallback for running from backend/
    from app.database import SQLITE_PATH  # type: ignore


def run():
    db_path = Path(SQLITE_PATH)
    if not db_path.is_file():
        return

    with closing(sqlite3.connect(str(db_path))) as conn, conn:
        # Include DDL and every inserted reservation in the same transaction.
        # Serialize against registration/deletion while taking this snapshot.
        conn.execute("BEGIN IMMEDIATE")
        if not conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'"
        ).fetchone():
            return

        conn.execute("""
            CREATE TABLE IF NOT EXISTS user_code_reservations (
                personal_id VARCHAR(11) NOT NULL PRIMARY KEY,
                code VARCHAR(10) NOT NULL,
                CONSTRAINT uq_user_code_reservations_code UNIQUE (code)
            )
        """)

        # Never replace an established mapping, including a deleted user's code.
        # Error messages deliberately omit personal IDs and certification codes.
        if conn.execute("""
            SELECT 1
            FROM users AS u
            JOIN user_code_reservations AS r ON r.personal_id = u.personal_id
            WHERE r.code IS NOT u.code
            LIMIT 1
        """).fetchone():
            raise RuntimeError("Existing personal-ID/code reservation conflicts with a user")
        if conn.execute("""
            SELECT 1
            FROM users AS u
            JOIN user_code_reservations AS r ON r.code = u.code
            WHERE r.personal_id IS NOT u.personal_id
            LIMIT 1
        """).fetchone():
            raise RuntimeError("Existing code reservation belongs to another personal ID")

        conn.execute("""
            INSERT INTO user_code_reservations (personal_id, code)
            SELECT u.personal_id, u.code
            FROM users AS u
            WHERE NOT EXISTS (
                SELECT 1 FROM user_code_reservations AS r
                WHERE r.personal_id = u.personal_id
            )
        """)


if __name__ == "__main__":
    run()
