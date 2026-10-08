"""Add administrative exam planning/history, without modifying existing data."""
from __future__ import annotations

from contextlib import closing
from pathlib import Path
import sqlite3

try:
    from backend.app.database import SQLITE_PATH
except ImportError:  # pragma: no cover - running from backend/
    from app.database import SQLITE_PATH  # type: ignore


def run():
    db_path = Path(SQLITE_PATH)
    if not db_path.is_file():
        return
    with closing(sqlite3.connect(str(db_path))) as conn, conn:
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("BEGIN IMMEDIATE")
        if not conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'"
        ).fetchone():
            return
        conn.execute("""
            CREATE TABLE IF NOT EXISTS exam_schedules (
                id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                exam_date DATE NOT NULL,
                period VARCHAR(16) NOT NULL,
                created_at DATETIME NOT NULL,
                CONSTRAINT uq_exam_schedules_user_date_period UNIQUE (user_id, exam_date, period),
                CONSTRAINT ck_exam_schedules_period CHECK (period IN ('morning', 'evening'))
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS ix_exam_schedules_user_id
            ON exam_schedules(user_id)
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS ix_exam_schedules_date_period_user
            ON exam_schedules(exam_date, period, user_id)
        """)


if __name__ == "__main__":
    run()
