from __future__ import annotations

import sys
from pathlib import Path

from sqlalchemy import inspect, text

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.app.database import engine


def run() -> None:
    with engine.connect() as connection:
        inspector = inspect(connection)
        columns = {column["name"] for column in inspector.get_columns("certificates")}
        if "exam_score" in columns:
            return
        connection.execute(text("ALTER TABLE certificates ADD COLUMN exam_score INTEGER DEFAULT 0"))
        connection.commit()


if __name__ == "__main__":
    run()

