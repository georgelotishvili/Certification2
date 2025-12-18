from __future__ import annotations

import sys
import io
from pathlib import Path

# Set UTF-8 encoding for output
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sqlalchemy import select
from backend.app.database import get_db
from backend.app.models import ExpertUpload, User


def find_expert_upload_owner(unique_code: str) -> None:
    """Find and display the owner of an expert upload by unique_code."""
    db = next(get_db())
    try:
        # Find the expert upload
        upload = db.scalar(select(ExpertUpload).where(ExpertUpload.unique_code == unique_code))
        
        if not upload:
            print(f"პროექტი '{unique_code}' ვერ მოიძებნა ბაზაში.")
            return
        
        # Find the user who created it
        user = db.get(User, upload.user_id)
        
        if not user:
            print(f"მომხმარებელი ID={upload.user_id} ვერ მოიძებნა.")
            return
        
        # Display information
        print(f"\n{'='*60}")
        print(f"პროექტის ინფორმაცია: {unique_code}")
        print(f"{'='*60}")
        print(f"პროექტის ID: {upload.id}")
        print(f"შექმნის თარიღი: {upload.created_at}")
        print(f"სტატუსი: {upload.status}")
        print(f"შენობის ფუნქცია: {upload.building_function or '(არ არის შევსებული)'}")
        print(f"მისამართი: {upload.project_address or '(არ არის შევსებული)'}")
        print(f"საკადასტრო კოდი: {upload.cadastral_code or '(არ არის შევსებული)'}")
        if upload.submitted_at:
            print(f"გაგზავნის თარიღი: {upload.submitted_at}")
        
        print(f"\n{'='*60}")
        print(f"პროექტის შემქმნელი:")
        print(f"{'='*60}")
        print(f"მომხმარებლის ID: {user.id}")
        print(f"სახელი: {user.first_name} {user.last_name}")
        print(f"ელფოსტა: {user.email}")
        print(f"ტელეფონი: {user.phone}")
        print(f"პირადი ნომერი: {user.personal_id}")
        print(f"კოდი: {user.code}")
        print(f"ადმინი: {'დიახ' if user.is_admin else 'არა'}")
        print(f"{'='*60}\n")
        
    except Exception as e:
        print(f"შეცდომა: {e}")
        import traceback
        traceback.print_exc()
    finally:
        db.close()


if __name__ == "__main__":
    unique_code = "EX-2025-12-16-001"
    if len(sys.argv) > 1:
        unique_code = sys.argv[1]
    
    find_expert_upload_owner(unique_code)
