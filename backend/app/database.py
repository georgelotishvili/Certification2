import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


def _sqlite_path() -> str:
    base_dir = os.path.dirname(os.path.dirname(__file__))
    return os.path.join(base_dir, "app.db")


DATABASE_URL = f"sqlite:///{_sqlite_path()}"

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

