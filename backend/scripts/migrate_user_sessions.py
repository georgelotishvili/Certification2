"""
Migration script to create user_sessions table.
This table stores user authentication sessions with tokens.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from sqlalchemy import text
from app.database import engine


def run():
    """Create user_sessions table if it doesn't exist."""
    with engine.connect() as conn:
        # Check if table exists
        result = conn.execute(
            text("""
                SELECT name FROM sqlite_master 
                WHERE type='table' AND name='user_sessions'
            """)
        )
        if result.fetchone():
            print("user_sessions table already exists, skipping migration")
            return
        
        # Create table
        conn.execute(
            text("""
                CREATE TABLE user_sessions (
                    id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    token VARCHAR(128) NOT NULL UNIQUE,
                    created_at DATETIME NOT NULL,
                    expires_at DATETIME NOT NULL,
                    last_used_at DATETIME,
                    FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
                )
            """)
        )
        
        # Create indexes
        conn.execute(text("CREATE INDEX ix_user_sessions_user_id ON user_sessions (user_id)"))
        conn.execute(text("CREATE INDEX ix_user_sessions_token ON user_sessions (token)"))
        conn.execute(text("CREATE INDEX ix_user_sessions_created_at ON user_sessions (created_at)"))
        conn.execute(text("CREATE INDEX ix_user_sessions_expires_at ON user_sessions (expires_at)"))
        conn.execute(text("CREATE UNIQUE INDEX uq_user_sessions_token ON user_sessions (token)"))
        
        conn.commit()
        print("Created user_sessions table and indexes")


if __name__ == "__main__":
    run()

