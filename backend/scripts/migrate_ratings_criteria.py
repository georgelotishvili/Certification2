from sqlalchemy import create_engine, text

# Simple one-off migration to add five criteria columns to the ratings table.
# Usage:
#   python backend/scripts/migrate_ratings_criteria.py
#
# Safe to re-run; each ALTER is wrapped in try/except.

def main():
    engine = create_engine("sqlite:///backend/app.db")
    statements = [
        "ALTER TABLE ratings ADD COLUMN integrity NUMERIC DEFAULT 0.00",
        "ALTER TABLE ratings ADD COLUMN responsibility NUMERIC DEFAULT 0.00",
        "ALTER TABLE ratings ADD COLUMN knowledge_experience NUMERIC DEFAULT 0.00",
        "ALTER TABLE ratings ADD COLUMN professional_skills NUMERIC DEFAULT 0.00",
        "ALTER TABLE ratings ADD COLUMN price_quality NUMERIC DEFAULT 0.00",
    ]
    with engine.begin() as conn:
        for stmt in statements:
            try:
                conn.execute(text(stmt))
            except Exception:
                # Column may already exist; ignore
                pass
    print("Migration complete: ratings table now has five criteria columns.")


if __name__ == "__main__":
    main()


