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
        statements: list[str] = []
        if "file_path" not in columns:
            statements.append("ALTER TABLE certificates ADD COLUMN file_path VARCHAR(1024)")
        if "filename" not in columns:
            statements.append("ALTER TABLE certificates ADD COLUMN filename VARCHAR(255)")
        if "mime_type" not in columns:
            statements.append("ALTER TABLE certificates ADD COLUMN mime_type VARCHAR(128) DEFAULT 'application/pdf'")
        if "size_bytes" not in columns:
            statements.append("ALTER TABLE certificates ADD COLUMN size_bytes INTEGER")
        for sql in statements:
            connection.execute(text(sql))
        if statements:
            connection.commit()


if __name__ == "__main__":
    run()


