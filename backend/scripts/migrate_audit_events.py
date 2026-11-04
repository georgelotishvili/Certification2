"""Add a permanent journal; never manufacture historical events from current rows."""
from datetime import datetime
from sqlalchemy import select


def run(bind=None):
    try:
        from backend.app.database import engine
        from backend.app.models import AuditEvent
        from backend.app.services.audit_log import COVERAGE_NOTE, protect_audit_table
    except ModuleNotFoundError:
        from app.database import engine
        from app.models import AuditEvent
        from app.services.audit_log import COVERAGE_NOTE, protect_audit_table
    bind = bind if bind is not None else engine
    with bind.begin() as connection:
        AuditEvent.__table__.create(connection, checkfirst=True)
        protect_audit_table(connection)
        if connection.execute(select(AuditEvent.id).limit(1)).first() is None:
            connection.execute(AuditEvent.__table__.insert().values(
                occurred_at=datetime.utcnow(), category="system", action="journal.started",
                actor_id=None, actor_label="სისტემა", target_type="audit_events",
                target_id=None, target_label="მუდმივი ჟურნალი", details=COVERAGE_NOTE,
            ))


if __name__ == "__main__":
    run()
