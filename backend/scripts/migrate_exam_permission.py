from __future__ import annotations

import sys
from pathlib import Path

from sqlalchemy import inspect, text

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.app.database import engine


def run() -> None:
    try:
        with engine.connect() as connection:
            inspector = inspect(connection)
            columns = {column["name"] for column in inspector.get_columns("users")}
            statements: list[str] = []
            if "exam_permission" not in columns:
                statements.append("ALTER TABLE users ADD COLUMN exam_permission INTEGER DEFAULT 0")
            for sql in statements:
                connection.execute(text(sql))
            if statements:
                connection.commit()
                print("Migration completed: added exam_permission column to users table")
            else:
                print("exam_permission column already exists, no migration needed")
    except Exception as e:
        print(f"Error during migration: {e}")
        import traceback
        traceback.print_exc()
        raise


if __name__ == "__main__":
    run()
