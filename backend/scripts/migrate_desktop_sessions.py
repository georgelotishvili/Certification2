"""Add nullable device ownership without rewriting existing sessions/attempts."""
from sqlalchemy import inspect, text


def run(engine_override=None):
    if engine_override is None:
        try:
            from backend.app.database import engine as engine_override
        except ModuleNotFoundError:
            from app.database import engine as engine_override
    columns = {
        "user_sessions": {"client_type": "VARCHAR(16)", "device_id": "VARCHAR(36)"},
        "sessions": {"device_id": "VARCHAR(36)"},
        "offline_exam_attempts": {"device_id": "VARCHAR(36)"},
    }
    with engine_override.begin() as conn:
        for table, additions in columns.items():
            inspector = inspect(conn)
            if not inspector.has_table(table):
                continue
            existing = {col["name"] for col in inspector.get_columns(table)}
            for name, ddl_type in additions.items():
                if name not in existing:
                    conn.execute(text(f'ALTER TABLE "{table}" ADD COLUMN "{name}" {ddl_type}'))


if __name__ == "__main__":
    run()
