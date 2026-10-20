from __future__ import annotations

import sys
from pathlib import Path

from sqlalchemy import inspect, text

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.app.database import engine  # noqa: E402


def run() -> None:
    """
    Ensure guide_videos and guide_documents tables exist.
    """
    try:
        with engine.connect() as connection:
            inspector = inspect(connection)
            tables = {table for table in inspector.get_table_names()}

            statements: list[str] = []

            required_new = {"id", "order_index", "title", "url", "created_at"}

            if "guide_videos" in tables:
                cols = {col["name"] for col in inspector.get_columns("guide_videos")}
                if "storage_path" in cols or not required_new.issubset(cols):
                    statements.append("DROP TABLE guide_videos")
                    tables.discard("guide_videos")

            if "guide_videos" not in tables:
                statements.append(
                    """
                    CREATE TABLE guide_videos (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        order_index INTEGER NOT NULL DEFAULT 0,
                        title VARCHAR(500) NOT NULL DEFAULT '',
                        url VARCHAR(2048) NOT NULL DEFAULT '',
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )
                statements.append(
                    "CREATE INDEX idx_guide_videos_order ON guide_videos(order_index, id)"
                )

            if "guide_documents" not in tables:
                statements.append(
                    """
                    CREATE TABLE guide_documents (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        title VARCHAR(255) NOT NULL DEFAULT 'გზამკვლევი',
                        content TEXT NOT NULL DEFAULT '',
                        order_index INTEGER NOT NULL DEFAULT 0,
                        file_path VARCHAR(1024),
                        filename VARCHAR(255),
                        file_size_bytes INTEGER,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )
                statements.append(
                    "CREATE INDEX idx_guide_documents_order ON guide_documents(order_index, id)"
                )
            else:
                gdoc_cols = {col["name"] for col in inspector.get_columns("guide_documents")}
                if "order_index" not in gdoc_cols:
                    statements.append(
                        "ALTER TABLE guide_documents ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0"
                    )
                    statements.append(
                        "CREATE INDEX IF NOT EXISTS idx_guide_documents_order ON guide_documents(order_index, id)"
                    )

            for sql in statements:
                connection.execute(text(sql))

            if statements:
                connection.commit()
                print("Migration completed: guide tables verified/created")
            else:
                print("guide tables already exist with correct structure, no migration needed")
    except Exception as exc:  # pragma: no cover - defensive
        print(f"Error during guide tables migration: {exc}")
        import traceback

        traceback.print_exc()
        raise


if __name__ == "__main__":
    run()
