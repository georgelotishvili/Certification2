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
        yield db
    finally:
        db.close()

