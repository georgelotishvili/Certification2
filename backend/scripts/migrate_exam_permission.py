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
            if "exam_stage" not in columns:
                statements.append("ALTER TABLE users ADD COLUMN exam_stage VARCHAR(32) DEFAULT 'none'")
            if "exam_stage_expires_at" not in columns:
                statements.append("ALTER TABLE users ADD COLUMN exam_stage_expires_at DATETIME")
            if "exam_stage_started_at" not in columns:
                statements.append("ALTER TABLE users ADD COLUMN exam_stage_started_at DATETIME")
            for sql in statements:
                connection.execute(text(sql))
            if statements:
                connection.execute(text("UPDATE users SET exam_stage = 'none' WHERE exam_stage IS NULL OR exam_stage = ''"))
                connection.commit()
                print("Migration completed: ensured exam permission/stage columns on users table")
            else:
                print("exam permission/stage columns already exist, no migration needed")
    except Exception as e:
        print(f"Error during migration: {e}")
        import traceback
        traceback.print_exc()
        raise


if __name__ == "__main__":
    run()
