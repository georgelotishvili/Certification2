"""
Migration script: Convert guide_videos table from file-based to URL-based storage.

Changes:
- Drops columns: storage_path, filename, mime_type, size_bytes
- Adds columns: title, url

Run from backend directory:
    python -m scripts.migrate_guide_videos_links
"""

import sqlite3
import sys
from pathlib import Path


def migrate():
    db_path = Path(__file__).parent.parent / "app.db"
    if not db_path.exists():
        print(f"Database not found at {db_path}")
        sys.exit(1)

    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()

    try:
        # Check if table exists
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='guide_videos'")
        if not cursor.fetchone():
            print("Table 'guide_videos' does not exist. Creating fresh table...")
            cursor.execute("""
                CREATE TABLE guide_videos (
                    id INTEGER PRIMARY KEY,
                    order_index INTEGER DEFAULT 0,
                    title VARCHAR(500) DEFAULT '',
                    url VARCHAR(2048) DEFAULT '',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            """)
            cursor.execute("CREATE INDEX IF NOT EXISTS ix_guide_videos_id ON guide_videos (id)")
            cursor.execute("CREATE INDEX IF NOT EXISTS ix_guide_videos_order_index ON guide_videos (order_index)")
            cursor.execute("CREATE INDEX IF NOT EXISTS ix_guide_videos_created_at ON guide_videos (created_at)")
            conn.commit()
            print("Created fresh guide_videos table with url and title columns.")
            return

        # Check current columns
        cursor.execute("PRAGMA table_info(guide_videos)")
        columns = {row[1] for row in cursor.fetchall()}
        print(f"Current columns: {columns}")

        # Check if already migrated
        if "url" in columns and "title" in columns:
            print("Table already has 'url' and 'title' columns. Migration not needed.")
            return

        # Need to recreate table (SQLite doesn't support DROP COLUMN well)
        print("Recreating table with new structure...")

        # Delete any existing data (old file-based entries are useless now)
        cursor.execute("DELETE FROM guide_videos")
        print("Deleted old file-based entries.")

        # Drop old table and create new one
        cursor.execute("DROP TABLE guide_videos")
        cursor.execute("""
            CREATE TABLE guide_videos (
                id INTEGER PRIMARY KEY,
                order_index INTEGER DEFAULT 0,
                title VARCHAR(500) DEFAULT '',
                url VARCHAR(2048) DEFAULT '',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        cursor.execute("CREATE INDEX IF NOT EXISTS ix_guide_videos_id ON guide_videos (id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS ix_guide_videos_order_index ON guide_videos (order_index)")
        cursor.execute("CREATE INDEX IF NOT EXISTS ix_guide_videos_created_at ON guide_videos (created_at)")

        conn.commit()
        print("Migration completed successfully!")
        print("Table now has: id, order_index, title, url, created_at")

    except Exception as e:
        conn.rollback()
        print(f"Migration failed: {e}")
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    migrate()

