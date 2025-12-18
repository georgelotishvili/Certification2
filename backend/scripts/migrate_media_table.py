from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sqlalchemy import text

from backend.app.database import engine

MEDIA_TYPE_COLUMN = "media_type"
UNIQUE_INDEX_NAME = "uq_exam_media_session_type"


def _table_columns() -> set[str]:
    try:
        with engine.begin() as conn:
            rows = conn.execute(text("PRAGMA table_info(exam_media)")).fetchall()
        return {row[1] for row in rows}
    except Exception:
        return set()


def _create_unique_index() -> None:
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    f"CREATE UNIQUE INDEX IF NOT EXISTS {UNIQUE_INDEX_NAME} "
                    "ON exam_media (session_id, media_type)"
                )
            )
    except Exception:
        pass


def _rebuild_table() -> None:
    try:
        with engine.begin() as conn:
            conn.execute(text("PRAGMA foreign_keys=OFF"))
            conn.execute(text("ALTER TABLE exam_media RENAME TO exam_media__old"))
            conn.execute(
                text(
                    """
                    CREATE TABLE exam_media (
                        id INTEGER PRIMARY KEY,
                        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                        media_type VARCHAR(32) NOT NULL DEFAULT 'camera',
                        storage_path VARCHAR(1024) NOT NULL,
                        filename VARCHAR(255) NOT NULL,
                        mime_type VARCHAR(128),
                        size_bytes INTEGER,
                        duration_seconds INTEGER,
                        chunk_count INTEGER NOT NULL DEFAULT 0,
                        completed BOOLEAN NOT NULL DEFAULT 0,
                        created_at DATETIME NOT NULL,
                        updated_at DATETIME NOT NULL,
                        completed_at DATETIME
                    )
                    """
                )
            )
            conn.execute(
                text(
                    """
                    INSERT INTO exam_media (
                        id, session_id, media_type, storage_path, filename, mime_type,
                        size_bytes, duration_seconds, chunk_count, completed,
                        created_at, updated_at, completed_at
                    )
                    SELECT
                        id, session_id, 'camera', storage_path, filename, mime_type,
                        size_bytes, duration_seconds, chunk_count, completed,
                        created_at, updated_at, completed_at
                    FROM exam_media__old
                    """
                )
            )
            conn.execute(text("DROP TABLE exam_media__old"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_exam_media_session_id ON exam_media (session_id)"))
            conn.execute(
                text(
                    f"CREATE UNIQUE INDEX IF NOT EXISTS {UNIQUE_INDEX_NAME} "
                    "ON exam_media (session_id, media_type)"
                )
            )
            conn.execute(text("PRAGMA foreign_keys=ON"))
    except Exception:
        # Leave the original schema intact if anything fails
        pass


def run() -> None:
    columns = _table_columns()
    if not columns:
        return

    if MEDIA_TYPE_COLUMN not in columns:
        _rebuild_table()
    else:
        try:
            with engine.begin() as conn:
                conn.execute(
                    text(
                        "UPDATE exam_media "
                        "SET media_type = 'camera' "
                        "WHERE media_type IS NULL OR TRIM(media_type) = ''"
                    )
                )
        except Exception:
            pass
        _create_unique_index()


if __name__ == "__main__":
    run()
    print("Exam media migration executed.")


