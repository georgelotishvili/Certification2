"""Add independent, historical exam-stage grants and bind existing sessions.

The migration is deliberately idempotent.  It preserves the retained legacy
permission columns and copies their timestamps instead of issuing a fresh
one-hour window.
"""
from __future__ import annotations

from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sqlite3

try:
    from backend.app.database import SQLITE_PATH
except ImportError:  # pragma: no cover - running from backend/
    from app.database import SQLITE_PATH  # type: ignore


STAGES = ("theory", "project_stage_1", "project_stage_2")


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {str(row[1]) for row in conn.execute(f'PRAGMA table_info("{table}")')}


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone() is not None


def _as_datetime(value: object) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is not None:
            parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
        return parsed
    except (TypeError, ValueError):
        return None


def _stamp(value: datetime) -> str:
    return value.isoformat(sep=" ")


def _open_grant(
    conn: sqlite3.Connection, user_id: int, stage: str
) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT * FROM user_exam_stage_grants
        WHERE user_id = ? AND stage = ?
          AND consumed_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL
        ORDER BY id DESC LIMIT 1
        """,
        (user_id, stage),
    ).fetchone()


def _latest_grant(
    conn: sqlite3.Connection, user_id: int, stage: str
) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT * FROM user_exam_stage_grants
        WHERE user_id = ? AND stage = ?
        ORDER BY id DESC LIMIT 1
        """,
        (user_id, stage),
    ).fetchone()


def _insert_grant(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    stage: str,
    granted_at: datetime,
    expires_at: datetime,
    started_at: datetime | None,
    revoked_at: datetime | None = None,
    expired_at: datetime | None = None,
) -> int:
    cursor = conn.execute(
        """
        INSERT INTO user_exam_stage_grants (
            user_id, stage, granted_at, expires_at, started_at, revoked_at, expired_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            user_id,
            stage,
            _stamp(granted_at),
            _stamp(expires_at),
            _stamp(started_at) if started_at else None,
            _stamp(revoked_at) if revoked_at else None,
            _stamp(expired_at) if expired_at else None,
        ),
    )
    return int(cursor.lastrowid)


def _ensure_session_grant(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    session_started_at: datetime | None,
    session_ends_at: datetime | None,
    active: bool,
    now: datetime,
) -> int | None:
    existing = _open_grant(conn, user_id, "theory")
    if existing is not None:
        grant_id = int(existing["id"])
        # An active legacy session had visibly started.  An inactive prepared
        # session must never turn the grant into a started one during backfill.
        if active and existing["started_at"] is None:
            started_at = session_started_at or now
            conn.execute(
                "UPDATE user_exam_stage_grants SET started_at=? WHERE id=?",
                (_stamp(started_at), grant_id),
            )
        return grant_id

    started_at = (session_started_at or now) if active else None
    expires_at = session_ends_at
    if expires_at is None:
        # A missing legacy deadline must not create a new authorization window.
        expires_at = started_at or now
    granted_at = expires_at - timedelta(hours=1)
    if started_at is not None and granted_at > started_at:
        granted_at = started_at
    # An inactive session without an eligible legacy permission is only a
    # historical prepared binding.  Keep it closed even if its preload
    # deadline is still in the future; migration must not resurrect access.
    revoked_at = now if not active else None
    return _insert_grant(
        conn,
        user_id=user_id,
        stage="theory",
        granted_at=granted_at,
        expires_at=expires_at,
        started_at=started_at,
        revoked_at=revoked_at,
    )


def run() -> None:
    db_path = Path(SQLITE_PATH)
    if not db_path.is_file():
        return

    with closing(sqlite3.connect(str(db_path))) as conn, conn:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("BEGIN IMMEDIATE")
        if not _table_exists(conn, "users"):
            return

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS user_exam_stage_grants (
                id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                stage VARCHAR(32) NOT NULL,
                granted_at DATETIME NOT NULL,
                expires_at DATETIME NOT NULL,
                started_at DATETIME,
                consumed_at DATETIME,
                revoked_at DATETIME,
                expired_at DATETIME,
                CONSTRAINT ck_user_exam_stage_grants_stage CHECK (
                    stage IN ('theory', 'project_stage_1', 'project_stage_2')
                )
            )
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS ix_user_exam_stage_grants_user_id
            ON user_exam_stage_grants(user_id)
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS ix_user_exam_stage_grants_stage
            ON user_exam_stage_grants(stage)
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS ix_user_exam_stage_grants_user_stage
            ON user_exam_stage_grants(user_id, stage, id)
            """
        )
        conn.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS uq_user_exam_stage_grants_open
            ON user_exam_stage_grants(user_id, stage)
            WHERE consumed_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL
            """
        )

        for table in (
            "sessions",
            "multi_apartment_evaluations",
            "multi_functional_evaluations",
        ):
            if _table_exists(conn, table) and "stage_grant_id" not in _columns(conn, table):
                conn.execute(
                    f'ALTER TABLE "{table}" ADD COLUMN stage_grant_id INTEGER '
                    "REFERENCES user_exam_stage_grants(id) ON DELETE SET NULL"
                )

        if _table_exists(conn, "sessions"):
            conn.execute(
                "CREATE INDEX IF NOT EXISTS ix_sessions_stage_grant_id "
                "ON sessions(stage_grant_id)"
            )
        for table in ("multi_apartment_evaluations", "multi_functional_evaluations"):
            if _table_exists(conn, table):
                conn.execute(
                    f"CREATE UNIQUE INDEX IF NOT EXISTS ix_{table}_stage_grant_id "
                    f"ON {table}(stage_grant_id) WHERE stage_grant_id IS NOT NULL"
                )

        now = datetime.utcnow()
        user_columns = _columns(conn, "users")
        legacy_columns = {
            "is_admin",
            "exam_permission",
            "exam_stage",
            "exam_stage_expires_at",
            "exam_stage_started_at",
        }
        if legacy_columns.issubset(user_columns):
            users = conn.execute(
                """
                SELECT id, exam_stage, exam_stage_expires_at, exam_stage_started_at
                FROM users
                WHERE COALESCE(is_admin, 0) = 0 AND COALESCE(exam_permission, 0) = 1
                  AND exam_stage IN ('theory', 'project_stage_1', 'project_stage_2')
                """
            ).fetchall()
            for user in users:
                user_id = int(user["id"])
                stage = str(user["exam_stage"])
                if _latest_grant(conn, user_id, stage) is not None:
                    continue
                expires_at = _as_datetime(user["exam_stage_expires_at"])
                started_at = _as_datetime(user["exam_stage_started_at"])
                if stage == "theory" and _table_exists(conn, "sessions"):
                    session_columns = _columns(conn, "sessions")
                    if {"user_id", "started_at", "finished_at", "active"}.issubset(
                        session_columns
                    ):
                        active_session = conn.execute(
                            """
                            SELECT started_at FROM sessions
                            WHERE user_id=? AND finished_at IS NULL
                              AND COALESCE(active, 0)=1
                            ORDER BY id LIMIT 1
                            """,
                            (user_id,),
                        ).fetchone()
                        prepared_session = conn.execute(
                            """
                            SELECT ends_at FROM sessions
                            WHERE user_id=? AND finished_at IS NULL
                              AND COALESCE(active, 0)=0
                            ORDER BY id DESC LIMIT 1
                            """,
                            (user_id,),
                        ).fetchone()
                        if active_session is not None:
                            started_at = _as_datetime(active_session["started_at"]) or started_at
                        elif prepared_session is not None:
                            # The old prepare endpoint set the legacy user's
                            # started timestamp before the visible Start click.
                            started_at = None
                            expires_at = expires_at or _as_datetime(
                                prepared_session["ends_at"]
                            )
                # Missing/elapsed unstarted windows are retained as history,
                # but marked expired so migration never grants extra access.
                safe_expires_at = expires_at or started_at or now
                granted_at = safe_expires_at - timedelta(hours=1)
                if started_at is not None and granted_at > started_at:
                    granted_at = started_at
                expired_at = (
                    now if started_at is None and safe_expires_at <= now else None
                )
                _insert_grant(
                    conn,
                    user_id=user_id,
                    stage=stage,
                    granted_at=granted_at,
                    expires_at=safe_expires_at,
                    started_at=started_at,
                    expired_at=expired_at,
                )

        if _table_exists(conn, "sessions"):
            session_columns = _columns(conn, "sessions")
            needed = {
                "id",
                "user_id",
                "started_at",
                "ends_at",
                "finished_at",
                "active",
                "stage_grant_id",
            }
            if needed.issubset(session_columns):
                sessions = conn.execute(
                    """
                    SELECT id, user_id, started_at, ends_at, active
                    FROM sessions
                    WHERE user_id IS NOT NULL AND stage_grant_id IS NULL
                      AND finished_at IS NULL
                    ORDER BY id
                    """
                ).fetchall()
                for session in sessions:
                    grant_id = _ensure_session_grant(
                        conn,
                        user_id=int(session["user_id"]),
                        session_started_at=_as_datetime(session["started_at"]),
                        session_ends_at=_as_datetime(session["ends_at"]),
                        active=bool(session["active"]),
                        now=now,
                    )
                    if grant_id is not None:
                        conn.execute(
                            "UPDATE sessions SET stage_grant_id=? WHERE id=?",
                            (grant_id, int(session["id"])),
                        )


if __name__ == "__main__":
    run()
