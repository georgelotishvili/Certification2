"""Add shared letter templates and immutable planning/email history, losslessly."""
from __future__ import annotations

from pathlib import Path
from sqlalchemy import create_engine, inspect

try:
    from backend.app.database import SQLITE_PATH
    from backend.app.models import PlanningLetter, PlanningTemplate
except ImportError:  # pragma: no cover
    from app.database import SQLITE_PATH
    from app.models import PlanningLetter, PlanningTemplate


def run():
    if not Path(SQLITE_PATH).is_file():
        return
    engine = create_engine(f"sqlite:///{SQLITE_PATH}")
    try:
        with engine.begin() as connection:
            if not inspect(connection).has_table("users"):
                return
            if not inspect(connection).has_table("exam_schedules"):
                raise RuntimeError("Exam schedule migration must run before planning letters")
            PlanningTemplate.__table__.create(connection, checkfirst=True)
            PlanningLetter.__table__.create(connection, checkfirst=True)
    finally:
        engine.dispose()


if __name__ == "__main__":
    run()
