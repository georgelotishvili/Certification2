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


def run() -> None:
    if not _column_exists("sessions", "user_id"):
        with engine.begin() as conn:
            conn.execute(
                text(
                    "ALTER TABLE sessions "
                    "ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE"
                )
            )

    with engine.begin() as conn:
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_sessions_user_id ON sessions (user_id)"))


if __name__ == "__main__":
    run()
