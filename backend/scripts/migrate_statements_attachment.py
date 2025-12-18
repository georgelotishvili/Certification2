"""Add attachment columns to statements table if they don't exist."""
from __future__ import annotations

import sqlite3
from pathlib import Path


def run():
    base_dir = Path(__file__).parent.parent
    db_path = base_dir / "app.db"
    if not db_path.exists():
        print("Database not found, skipping migration")
        return

    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()

    # Check if columns exist
    cursor.execute("PRAGMA table_info(statements)")
    columns = [row[1] for row in cursor.fetchall()]

    changes = False

    if "attachment_path" not in columns:
        cursor.execute("ALTER TABLE statements ADD COLUMN attachment_path VARCHAR(1024)")
        changes = True
        print("Added attachment_path column")

    if "attachment_filename" not in columns:
        cursor.execute("ALTER TABLE statements ADD COLUMN attachment_filename VARCHAR(255)")
        changes = True
        print("Added attachment_filename column")

    if "attachment_mime_type" not in columns:
        cursor.execute("ALTER TABLE statements ADD COLUMN attachment_mime_type VARCHAR(128)")
        changes = True
        print("Added attachment_mime_type column")

    if "attachment_size_bytes" not in columns:
        cursor.execute("ALTER TABLE statements ADD COLUMN attachment_size_bytes INTEGER")
        changes = True
        print("Added attachment_size_bytes column")

    if changes:
        conn.commit()
        print("Migration completed successfully")
    else:
        print("All columns already exist, no migration needed")

    conn.close()


if __name__ == "__main__":
    run()

