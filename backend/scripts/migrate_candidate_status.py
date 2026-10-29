"""Add candidate_status, candidate_category, and candidate_updated_at columns to users table."""
from __future__ import annotations

import sqlite3
from contextlib import closing
from pathlib import Path

try:
    from backend.app.database import SQLITE_PATH
except ImportError:  # pragma: no cover - fallback for running from backend/
    from app.database import SQLITE_PATH  # type: ignore


def run() -> None:
    db_path = Path(SQLITE_PATH)
    if not db_path.is_file():
        return

    with closing(sqlite3.connect(str(db_path))) as conn, conn:
        user_cols = {row[1] for row in conn.execute("PRAGMA table_info(users)")}
        if not user_cols:
            return
        if "candidate_status" not in user_cols:
            conn.execute("ALTER TABLE users ADD COLUMN candidate_status VARCHAR(32)")
        if "candidate_category" not in user_cols:
            conn.execute("ALTER TABLE users ADD COLUMN candidate_category VARCHAR(16)")
        if "candidate_updated_at" not in user_cols:
            conn.execute("ALTER TABLE users ADD COLUMN candidate_updated_at DATETIME")
        conn.execute("CREATE INDEX IF NOT EXISTS ix_users_candidate_status ON users (candidate_status)")

        cert_cols = {row[1] for row in conn.execute("PRAGMA table_info(certificates)")}
        if cert_cols and "is_transitional" not in cert_cols:
            conn.execute("ALTER TABLE certificates ADD COLUMN is_transitional BOOLEAN NOT NULL DEFAULT 0")


if __name__ == "__main__":
    run()
