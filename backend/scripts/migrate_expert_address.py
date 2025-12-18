from __future__ import annotations

import sqlite3
from pathlib import Path


def column_exists(conn: sqlite3.Connection, table: str, column: str) -> bool:
    cur = conn.execute(f"PRAGMA table_info({table})")
    return any(row[1] == column for row in cur.fetchall())


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    db_path = root / "app.db"
    conn = sqlite3.connect(db_path)
    try:
        if not column_exists(conn, "expert_uploads", "project_address"):
            conn.execute("ALTER TABLE expert_uploads ADD COLUMN project_address VARCHAR(255) DEFAULT ''")
            conn.commit()
            print("Added column expert_uploads.project_address")
        else:
            print("Column expert_uploads.project_address already exists")
    finally:
        conn.close()


if __name__ == "__main__":
    main()


