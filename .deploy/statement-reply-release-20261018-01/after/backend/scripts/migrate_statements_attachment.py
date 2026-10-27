"""Add attachment columns to statements table if they don't exist."""
from __future__ import annotations

import sqlite3
from pathlib import Path

try:
    from backend.app.database import SQLITE_PATH
except ImportError:  # pragma: no cover - fallback for running from backend/
    from app.database import SQLITE_PATH  # type: ignore


def run():
    db_path = Path(SQLITE_PATH)
    if not db_path.exists():
        print("Database not found, skipping migration")
        return

    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()

    # Check if columns exist
    cursor.execute("PRAGMA table_info(statements)")
    columns = [row[1] for row in cursor.fetchall()]

    changes = False

    for col_name, col_type in (
        ("attachment_path", "VARCHAR(1024)"),
        ("attachment_filename", "VARCHAR(255)"),
        ("attachment_mime_type", "VARCHAR(128)"),
        ("attachment_size_bytes", "INTEGER"),
        ("attachment2_path", "VARCHAR(1024)"),
        ("attachment2_filename", "VARCHAR(255)"),
        ("attachment2_mime_type", "VARCHAR(128)"),
        ("attachment2_size_bytes", "INTEGER"),
        ("attachment3_path", "VARCHAR(1024)"),
        ("attachment3_filename", "VARCHAR(255)"),
        ("attachment3_mime_type", "VARCHAR(128)"),
        ("attachment3_size_bytes", "INTEGER"),
    ):
        if col_name not in columns:
            cursor.execute(f"ALTER TABLE statements ADD COLUMN {col_name} {col_type}")
            changes = True
            print(f"Added {col_name} column")

    if changes:
        conn.commit()
        print("Migration completed successfully")
    else:
        print("All columns already exist, no migration needed")

    conn.close()


if __name__ == "__main__":
    run()
