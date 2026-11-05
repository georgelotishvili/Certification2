import os
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker


DATABASE_PATH_ENV = 'GIPC_DATABASE_PATH'


def _sqlite_path() -> str:
    override = os.getenv(DATABASE_PATH_ENV)
    if override is not None:
        candidate = override.strip()
        if not candidate:
            raise RuntimeError('GIPC_DATABASE_PATH must not be blank')
        if not os.path.isabs(candidate):
            raise RuntimeError(
                'GIPC_DATABASE_PATH must be an absolute filesystem path'
            )
        if os.path.isdir(candidate):
            raise RuntimeError(
                'GIPC_DATABASE_PATH must point to a database file, not a directory'
            )
        return candidate

    base_dir = os.path.dirname(os.path.dirname(__file__))
    return os.path.join(base_dir, "app.db")


SQLITE_PATH = _sqlite_path()
DATABASE_URL = f"sqlite:///{SQLITE_PATH}"

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
)


@event.listens_for(engine, "connect")
def _enable_sqlite_foreign_keys(dbapi_connection, _connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db():
    db = SessionLocal()
    try:
        from .services.audit_log import enable_audit
        enable_audit(db)
        yield db
    finally:
        mfa_activity = db.info.pop("admin_mfa_activity", None)
        mfa_bind = db.get_bind() if mfa_activity else None
        db.close()
        if mfa_activity:
            # The endpoint's own transaction must be finished first. Activity
            # tracking may not commit unrelated application mutations.
            from .services.admin_mfa import touch_admin_mfa_activity
            try:
                touch_admin_mfa_activity(mfa_bind, mfa_activity)
            except Exception:
                # An activity timestamp failure must not turn an already
                # committed action into an apparent failure/retry. Without the
                # touch the grant simply expires earlier (fail closed).
                import logging
                logging.getLogger(__name__).warning("Admin MFA activity touch failed")

