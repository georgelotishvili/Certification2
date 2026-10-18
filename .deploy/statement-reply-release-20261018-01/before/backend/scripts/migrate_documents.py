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
    Ensure site_documents table exists.

    ეს მიგრაცია იძახება აპის გაშვებისას და ქმნის site_documents ცხრილს
    საიტის დოკუმენტების შესანახად.
    """
    try:
        with engine.connect() as connection:
            inspector = inspect(connection)
            tables = {table for table in inspector.get_table_names()}

            statements: list[str] = []

            if "site_documents" not in tables:
                statements.append(
                    """
                    CREATE TABLE site_documents (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        title VARCHAR(255) NOT NULL DEFAULT '',
                        content TEXT NOT NULL DEFAULT '',
                        order_index INTEGER NOT NULL DEFAULT 0,
                        file_path VARCHAR(1024),
                        filename VARCHAR(255),
                        file_size_bytes INTEGER,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )
                statements.append(
                    "CREATE INDEX idx_site_documents_order ON site_documents(order_index, id)"
                )
            else:
                # ცხრილი არსებობს - შევამოწმოთ ახალი ველები
                columns = {col["name"] for col in inspector.get_columns("site_documents")}
                
                if "file_path" not in columns:
                    statements.append(
                        "ALTER TABLE site_documents ADD COLUMN file_path VARCHAR(1024)"
                    )
                if "filename" not in columns:
                    statements.append(
                        "ALTER TABLE site_documents ADD COLUMN filename VARCHAR(255)"
                    )
                if "file_size_bytes" not in columns:
                    statements.append(
                        "ALTER TABLE site_documents ADD COLUMN file_size_bytes INTEGER"
                    )

            for sql in statements:
                connection.execute(text(sql))

            if statements:
                connection.commit()
                print("Migration completed: created site_documents table")
            else:
                print("site_documents table already exists, no migration needed")
    except Exception as exc:  # pragma: no cover - defensive
        print(f"Error during site_documents migration: {exc}")
        import traceback

        traceback.print_exc()
        raise


if __name__ == "__main__":
    run()
