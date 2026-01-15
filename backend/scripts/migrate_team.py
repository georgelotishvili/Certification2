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
    Ensure team_members table exists.

    ეს მიგრაცია იძახება აპის გაშვებისას და ქმნის team_members ცხრილს
    გუნდის წევრების შესანახად.
    """
    try:
        with engine.connect() as connection:
            inspector = inspect(connection)
            tables = {table for table in inspector.get_table_names()}

            statements: list[str] = []

            if "team_members" not in tables:
                statements.append(
                    """
                    CREATE TABLE team_members (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        category INTEGER NOT NULL DEFAULT 1,
                        position VARCHAR(255) NOT NULL DEFAULT '',
                        first_name VARCHAR(100) NOT NULL DEFAULT '',
                        last_name VARCHAR(100) NOT NULL DEFAULT '',
                        email VARCHAR(255),
                        phone VARCHAR(50),
                        order_index INTEGER NOT NULL DEFAULT 0,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )
                statements.append(
                    "CREATE INDEX idx_team_members_category ON team_members(category)"
                )
                statements.append(
                    "CREATE INDEX idx_team_members_order ON team_members(category, order_index, id)"
                )

            for sql in statements:
                connection.execute(text(sql))

            if statements:
                connection.commit()
                print("Migration completed: created team_members table")
            else:
                print("team_members table already exists, no migration needed")
    except Exception as exc:  # pragma: no cover - defensive
        print(f"Error during team_members migration: {exc}")
        import traceback

        traceback.print_exc()
        raise


if __name__ == "__main__":
    run()
