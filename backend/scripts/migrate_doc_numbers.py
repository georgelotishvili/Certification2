"""Add doc_number column to statements and planning_letters and backfill IN-YYYY-NNNN / OUT-YYYY-NNNN."""
from __future__ import annotations

from datetime import datetime
import sqlite3
from contextlib import closing
from pathlib import Path

try:
    from backend.app.database import SQLITE_PATH
except ImportError:  # pragma: no cover - fallback for running from backend/
    from app.database import SQLITE_PATH  # type: ignore


def _extract_year(raw_val: object, fallback_year: int) -> int:
    if not raw_val:
        return fallback_year
    s = str(raw_val).strip()
    if len(s) >= 4 and s[:4].isdigit():
        return int(s[:4])
    return fallback_year


def run() -> None:
    db_path = Path(SQLITE_PATH)
    if not db_path.is_file():
        return

    current_year = datetime.utcnow().year

    with closing(sqlite3.connect(str(db_path))) as conn, conn:
        # 1. statements table
        stmt_cols = {row[1] for row in conn.execute("PRAGMA table_info(statements)")}
        if stmt_cols:
            if "doc_number" not in stmt_cols:
                conn.execute("ALTER TABLE statements ADD COLUMN doc_number VARCHAR(64)")
            conn.execute("CREATE INDEX IF NOT EXISTS ix_statements_doc_number ON statements (doc_number)")
            has_created_at = "created_at" in stmt_cols
            select_sql = (
                "SELECT id, created_at FROM statements WHERE doc_number IS NULL OR TRIM(doc_number) = ''"
                if has_created_at
                else "SELECT id, NULL FROM statements WHERE doc_number IS NULL OR TRIM(doc_number) = ''"
            )
            for row_id, created_at in conn.execute(select_sql).fetchall():
                year = _extract_year(created_at, current_year)
                doc_num = f"IN-{year}-{int(row_id):04d}"
                conn.execute("UPDATE statements SET doc_number = ? WHERE id = ?", (doc_num, row_id))

        # 2. planning_letters table
        letter_cols = {row[1] for row in conn.execute("PRAGMA table_info(planning_letters)")}
        if letter_cols:
            if "doc_number" not in letter_cols:
                conn.execute("ALTER TABLE planning_letters ADD COLUMN doc_number VARCHAR(64)")
            conn.execute("CREATE INDEX IF NOT EXISTS ix_planning_letters_doc_number ON planning_letters (doc_number)")
            has_created_at = "created_at" in letter_cols
            select_sql = (
                "SELECT id, created_at FROM planning_letters WHERE doc_number IS NULL OR TRIM(doc_number) = ''"
                if has_created_at
                else "SELECT id, NULL FROM planning_letters WHERE doc_number IS NULL OR TRIM(doc_number) = ''"
            )
            for row_id, created_at in conn.execute(select_sql).fetchall():
                year = _extract_year(created_at, current_year)
                doc_num = f"OUT-{year}-{int(row_id):04d}"
                conn.execute("UPDATE planning_letters SET doc_number = ? WHERE id = ?", (doc_num, row_id))


if __name__ == "__main__":
    run()
