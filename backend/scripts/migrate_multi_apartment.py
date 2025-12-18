from __future__ import annotations

import sys
from pathlib import Path

from sqlalchemy import inspect, text

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.app.database import engine


def run() -> None:
    try:
        with engine.connect() as connection:
            inspector = inspect(connection)
            tables = {table for table in inspector.get_table_names()}
            
            statements: list[str] = []
            
            # Create multi_apartment_projects table
            if "multi_apartment_projects" not in tables:
                statements.append("""
                    CREATE TABLE multi_apartment_projects (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        number INTEGER NOT NULL,
                        code VARCHAR(32) NOT NULL,
                        order_index INTEGER DEFAULT 0,
                        pdf_path VARCHAR(1024),
                        pdf_filename VARCHAR(255),
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        UNIQUE(code)
                    )
                """)
                statements.append("CREATE INDEX idx_multi_apartment_projects_code ON multi_apartment_projects(code)")
            
            # Create multi_apartment_answers table
            if "multi_apartment_answers" not in tables:
                statements.append("""
                    CREATE TABLE multi_apartment_answers (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        project_id INTEGER NOT NULL,
                        text TEXT NOT NULL,
                        order_index INTEGER DEFAULT 0,
                        is_correct BOOLEAN DEFAULT 0,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        FOREIGN KEY (project_id) REFERENCES multi_apartment_projects(id) ON DELETE CASCADE
                    )
                """)
            
            # Create multi_apartment_submissions table
            if "multi_apartment_submissions" not in tables:
                statements.append("""
                    CREATE TABLE multi_apartment_submissions (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        project_id INTEGER NOT NULL,
                        user_id INTEGER NOT NULL,
                        selected_answer_id INTEGER,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        FOREIGN KEY (project_id) REFERENCES multi_apartment_projects(id) ON DELETE CASCADE,
                        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                        FOREIGN KEY (selected_answer_id) REFERENCES multi_apartment_answers(id) ON DELETE SET NULL
                    )
                """)
                statements.append("CREATE INDEX idx_multi_apartment_submissions_user ON multi_apartment_submissions(user_id)")

            # Create multi_apartment_settings table
            if "multi_apartment_settings" not in tables:
                statements.append("""
                    CREATE TABLE multi_apartment_settings (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        duration_minutes INTEGER NOT NULL DEFAULT 60,
                        gate_password VARCHAR(64) NOT NULL DEFAULT 'cpig',
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    )
                """)
            
            for sql in statements:
                connection.execute(text(sql))
            
            if statements:
                connection.commit()
                print("Migration completed: created multi-apartment tables")
            else:
                print("Multi-apartment tables already exist, no migration needed")
    except Exception as e:
        print(f"Error during migration: {e}")
        import traceback
        traceback.print_exc()
        raise


if __name__ == "__main__":
    run()

