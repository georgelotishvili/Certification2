"""Add per-statement answer tracking without changing existing statements."""
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
        columns = {row[1] for row in conn.execute("PRAGMA table_info(statements)")}
        if not columns:
            return
        if "answered_at" not in columns:
            conn.execute("ALTER TABLE statements ADD COLUMN answered_at DATETIME")
        if "answered_by" not in columns:
            conn.execute("ALTER TABLE statements ADD COLUMN answered_by VARCHAR(255)")
        # Deliberately no backfill: reading a statement never meant answering it.


if __name__ == "__main__":
    run()
