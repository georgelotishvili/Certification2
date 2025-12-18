from __future__ import annotations

import sys
from pathlib import Path

from sqlalchemy import inspect, text

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.app.database import engine

try:
    with engine.connect() as connection:
        inspector = inspect(connection)
        columns = {column["name"] for column in inspector.get_columns("users")}
        print(f"Users table columns: {', '.join(sorted(columns))}")
        print(f"exam_permission exists: {'exam_permission' in columns}")
        
        if "exam_permission" not in columns:
            print("\nAdding exam_permission column...")
            connection.execute(text("ALTER TABLE users ADD COLUMN exam_permission BOOLEAN DEFAULT 0"))
            connection.commit()
            print("✓ exam_permission column added successfully")
        else:
            print("\n✓ exam_permission column already exists")
except Exception as e:
    print(f"Error: {e}")
    import traceback
    traceback.print_exc()
