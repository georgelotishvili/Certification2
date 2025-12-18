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
    Ensure guide_videos table exists.

    ეს მიგრაცია იძახება აპის გაშვებისას და მხოლოდ ამატებს ცხრილს,
    არაფერი არ შლის/ცვლის არსებულ სტრუქტურებს.
    """
    try:
        with engine.connect() as connection:
            inspector = inspect(connection)
            tables = {table for table in inspector.get_table_names()}

            statements: list[str] = []

            # თუ ცხრილი უკვე არსებობს, მაგრამ სქემა არ ემთხვევა მოსალოდნელს,
            # (მაგალითად, ადრე ტესტურად შეიქმნა სხვა ველებით),
            # ბოლომდე ვშლით და თავიდან ვქმნით. ამ ეტაპზე მონაცემები არ გვაქვს,
            # ამიტომ ეს უსაფრთხოა.
            if "guide_videos" in tables:
                cols = {col["name"] for col in inspector.get_columns("guide_videos")}
                required = {
                    "id",
                    "order_index",
                    "storage_path",
                    "filename",
                    "mime_type",
                    "size_bytes",
                    "created_at",
                }
                if not required.issubset(cols):
                    statements.append("DROP TABLE guide_videos")
                    tables.remove("guide_videos")

            if "guide_videos" not in tables:
                statements.append(
                    """
                    CREATE TABLE guide_videos (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        order_index INTEGER NOT NULL DEFAULT 0,
                        storage_path VARCHAR(1024) NOT NULL,
                        filename VARCHAR(255) NOT NULL,
                        mime_type VARCHAR(128) NOT NULL DEFAULT 'video/mp4',
                        size_bytes INTEGER,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )
                statements.append(
                    "CREATE INDEX idx_guide_videos_order ON guide_videos(order_index, id)"
                )

            for sql in statements:
                connection.execute(text(sql))

            if statements:
                connection.commit()
                print("Migration completed: created guide_videos table")
            else:
                print("guide_videos table already exists, no migration needed")
    except Exception as exc:  # pragma: no cover - defensive
        print(f"Error during guide_videos migration: {exc}")
        import traceback

        traceback.print_exc()
        raise


if __name__ == "__main__":
    run()


