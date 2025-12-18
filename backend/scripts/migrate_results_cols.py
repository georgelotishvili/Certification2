from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sqlalchemy import text

from backend.app.database import engine


def safe_add(sql: str) -> None:
    try:
        with engine.begin() as conn:
            conn.execute(text(sql))
    except Exception:
        # Column probably already exists or SQLite limitation; ignore
        pass


def run() -> None:
    # SQLite: simple additive migration (idempotent via try/except)
    safe_add("ALTER TABLE sessions ADD COLUMN candidate_first_name VARCHAR(100)")
    safe_add("ALTER TABLE sessions ADD COLUMN candidate_last_name VARCHAR(100)")
    safe_add("ALTER TABLE sessions ADD COLUMN candidate_code VARCHAR(64)")
    safe_add("ALTER TABLE sessions ADD COLUMN block_stats TEXT")
    safe_add("ALTER TABLE sessions ADD COLUMN score_percent FLOAT DEFAULT 0.0")
    safe_add("ALTER TABLE exams ADD COLUMN gate_password VARCHAR(128)")

    # Ensure sessions.code_id is nullable so admin-started sessions can be created
    from sqlalchemy import text

    try:
        with engine.begin() as conn:
            info = conn.execute(text("PRAGMA table_info(sessions)")).fetchall()
            code_col = next((row for row in info if row[1] == "code_id"), None)
            if code_col and code_col[3]:  # notnull flag is set
                conn.execute(text("PRAGMA foreign_keys=OFF"))
                conn.execute(text("ALTER TABLE sessions RENAME TO sessions__old"))
                conn.execute(text(
                    """
                    CREATE TABLE sessions (
                        id INTEGER PRIMARY KEY,
                        exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
                        code_id INTEGER REFERENCES exam_codes(id) ON DELETE SET NULL,
                        token VARCHAR(128) NOT NULL UNIQUE,
                        started_at DATETIME NOT NULL,
                        ends_at DATETIME NOT NULL,
                        finished_at DATETIME,
                        active BOOLEAN NOT NULL,
                        selected_map TEXT,
                        candidate_first_name VARCHAR(100),
                        candidate_last_name VARCHAR(100),
                        candidate_code VARCHAR(64),
                        block_stats TEXT,
                        score_percent FLOAT DEFAULT 0.0
                    )
                    """
                ))
                conn.execute(text(
                    """
                    INSERT INTO sessions (
                        id, exam_id, code_id, token, started_at, ends_at, finished_at,
                        active, selected_map, candidate_first_name, candidate_last_name,
                        candidate_code, block_stats, score_percent
                    )
                    SELECT
                        id, exam_id, code_id, token, started_at, ends_at, finished_at,
                        active, selected_map, candidate_first_name, candidate_last_name,
                        candidate_code, block_stats, score_percent
                    FROM sessions__old
                    """
                ))
                conn.execute(text("DROP TABLE sessions__old"))
                conn.execute(text("CREATE INDEX IF NOT EXISTS ix_sessions_exam_id ON sessions (exam_id)"))
                conn.execute(text("CREATE INDEX IF NOT EXISTS ix_sessions_code_id ON sessions (code_id)"))
                conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_sessions_token ON sessions (token)"))
                conn.execute(text("PRAGMA foreign_keys=ON"))
    except Exception:
        # If anything fails we simply leave the old schema in place
        pass


if __name__ == "__main__":
    run()
    print("Migration executed (ignored if columns already existed).")


