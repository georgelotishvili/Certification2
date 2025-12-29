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
    Ensure guide_videos table exists with URL-based structure.

    ეს მიგრაცია იძახება აპის გაშვებისას და ქმნის/განაახლებს ცხრილს
    URL-ზე დაფუძნებული სტრუქტურით (title, url ნაცვლად storage_path, filename და ა.შ.)
    """
    try:
        with engine.connect() as connection:
            inspector = inspect(connection)
            tables = {table for table in inspector.get_table_names()}

            statements: list[str] = []

            # ახალი სტრუქტურა: title და url ველებით
            required_new = {"id", "order_index", "title", "url", "created_at"}

            if "guide_videos" in tables:
                cols = {col["name"] for col in inspector.get_columns("guide_videos")}
                
                # თუ ძველი სტრუქტურაა (storage_path არსებობს), ვშლით და ვქმნით ახალს
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

            for sql in statements:
                connection.execute(text(sql))

            if statements:
                connection.commit()
                print("Migration completed: created guide_videos table with URL structure")
            else:
                print("guide_videos table already exists with correct structure, no migration needed")
    except Exception as exc:  # pragma: no cover - defensive
        print(f"Error during guide_videos migration: {exc}")
        import traceback

        traceback.print_exc()
        raise


if __name__ == "__main__":
    run()
