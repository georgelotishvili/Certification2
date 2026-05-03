from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sqlalchemy import text

from backend.app.database import engine


def _column_exists(table_name: str, column_name: str) -> bool:
    with engine.connect() as conn:
        columns = conn.execute(text(f"PRAGMA table_info({table_name})")).fetchall()
    return any(row[1] == column_name for row in columns)


def _safe_add_column(table_name: str, column_name: str, definition: str) -> None:
    if _column_exists(table_name, column_name):
        return
    with engine.begin() as conn:
        conn.execute(text(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {definition}"))


def run() -> None:
    with engine.begin() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS taxonomy_chapters (
                    id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                    name VARCHAR(255) NOT NULL,
                    order_index INTEGER NOT NULL DEFAULT 0,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    CONSTRAINT uq_taxonomy_chapters_name UNIQUE (name)
                )
                """
            )
        )
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS taxonomy_subchapters (
                    id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                    chapter_id INTEGER NOT NULL,
                    name VARCHAR(255) NOT NULL,
                    order_index INTEGER NOT NULL DEFAULT 0,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    CONSTRAINT uq_taxonomy_subchapters_chapter_name UNIQUE (chapter_id, name),
                    FOREIGN KEY(chapter_id) REFERENCES taxonomy_chapters(id) ON DELETE CASCADE
                )
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_taxonomy_chapters_id ON taxonomy_chapters (id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_taxonomy_subchapters_id ON taxonomy_subchapters (id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_taxonomy_subchapters_chapter_id ON taxonomy_subchapters (chapter_id)"))

    _safe_add_column(
        "blocks",
        "chapter_id",
        "INTEGER REFERENCES taxonomy_chapters(id) ON DELETE SET NULL",
    )
    _safe_add_column(
        "blocks",
        "subchapter_id",
        "INTEGER REFERENCES taxonomy_subchapters(id) ON DELETE SET NULL",
    )
    _safe_add_column("sessions", "exam_snapshot", "TEXT")

    with engine.begin() as conn:
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_blocks_chapter_id ON blocks (chapter_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_blocks_subchapter_id ON blocks (subchapter_id)"))


if __name__ == "__main__":
    run()
