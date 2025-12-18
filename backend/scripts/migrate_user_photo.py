"""
Migration script to add photo_path and photo_filename columns to users table.
Run: python -m scripts.migrate_user_photo
"""

from sqlalchemy import text
from app.database import engine


def migrate():
    with engine.connect() as conn:
        # Check if column exists
        result = conn.execute(text("PRAGMA table_info(users)"))
        columns = [row[1] for row in result.fetchall()]

        if "photo_path" not in columns:
            conn.execute(text("ALTER TABLE users ADD COLUMN photo_path VARCHAR(1024)"))
            print("Added photo_path column to users table")
        else:
            print("photo_path column already exists")

        if "photo_filename" not in columns:
            conn.execute(text("ALTER TABLE users ADD COLUMN photo_filename VARCHAR(255)"))
            print("Added photo_filename column to users table")
        else:
            print("photo_filename column already exists")

        conn.commit()
        print("Migration completed successfully")


if __name__ == "__main__":
    migrate()
