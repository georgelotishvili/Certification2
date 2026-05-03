from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sqlalchemy import text

from backend.app.database import engine


def _answers_sql() -> str:
    with engine.connect() as conn:
        sql = conn.execute(
            text("SELECT sql FROM sqlite_master WHERE type='table' AND name='answers'")
        ).scalar()
    return sql or ""


def run() -> None:
    if "sessions__old" not in _answers_sql():
        return

    raw_conn = engine.raw_connection()
    cursor = raw_conn.cursor()
    committed = False
    try:
        cursor.execute("PRAGMA foreign_keys=OFF")
        cursor.execute("BEGIN")
        cursor.execute("ALTER TABLE answers RENAME TO answers__broken_fk")
        cursor.execute(
            """
            CREATE TABLE answers (
                id INTEGER NOT NULL,
                session_id INTEGER NOT NULL,
                question_id INTEGER NOT NULL,
                option_id INTEGER NOT NULL,
                is_correct BOOLEAN NOT NULL,
                answered_at DATETIME NOT NULL,
                PRIMARY KEY (id),
                FOREIGN KEY(session_id) REFERENCES sessions (id) ON DELETE CASCADE,
                FOREIGN KEY(question_id) REFERENCES questions (id) ON DELETE CASCADE,
                FOREIGN KEY(option_id) REFERENCES options (id) ON DELETE CASCADE
            )
            """
        )
        cursor.execute(
            """
            INSERT INTO answers (id, session_id, question_id, option_id, is_correct, answered_at)
            SELECT a.id, a.session_id, a.question_id, a.option_id, a.is_correct, a.answered_at
            FROM answers__broken_fk AS a
            WHERE EXISTS (SELECT 1 FROM sessions AS s WHERE s.id = a.session_id)
              AND EXISTS (SELECT 1 FROM questions AS q WHERE q.id = a.question_id)
              AND EXISTS (SELECT 1 FROM options AS o WHERE o.id = a.option_id)
            """
        )
        cursor.execute("DROP TABLE answers__broken_fk")
        cursor.execute("CREATE INDEX IF NOT EXISTS ix_answers_id ON answers (id)")
        cursor.execute("COMMIT")
        committed = True
        cursor.execute("PRAGMA foreign_keys=ON")
        violations = cursor.execute("PRAGMA foreign_key_check").fetchall()
        if violations:
            raise RuntimeError(f"foreign_key_check failed after answers FK migration: {violations}")
    except Exception:
        if not committed:
            cursor.execute("ROLLBACK")
        raise
    finally:
        cursor.close()
        raw_conn.close()


if __name__ == "__main__":
    run()
