"""
Script to reset password hash for founder user (naormala@gmail.com)
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.app.database import SessionLocal
from backend.app.models import User
from backend.app.security import hash_code
from backend.app.config import get_settings


def reset_founder_password(new_password: str) -> None:
    """Reset password hash for founder user"""
    if not new_password or len(new_password) < 8:
        print("Error: პაროლი უნდა იყოს მინიმუმ 8 სიმბოლო")
        return
    
    settings = get_settings()
    founder_email = (settings.founder_admin_email or "").lower()
    
    if not founder_email:
        print("Error: founder_admin_email not configured")
        return
    
    db: Session = SessionLocal()
    try:
        user = db.scalar(select(User).where(User.email == founder_email))
        if not user:
            print(f"Error: User with email {founder_email} not found")
            return
        
        # Hash the new password
        password_hash = hash_code(new_password)
        
        # Update password hash
        user.password_hash = password_hash
        db.add(user)
        db.commit()
        
        print(f"SUCCESS: Password hash updated for {founder_email}")
        
    except Exception as e:
        print(f"Error: {e}")
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    print("=== Founder Password Reset ===")
    new_pass = input("შეიყვანე ახალი პაროლი: ").strip()
    if new_pass:
        confirm = input("დაადასტურე პაროლი: ").strip()
        if new_pass == confirm:
            reset_founder_password(new_pass)
        else:
            print("Error: პაროლები არ ემთხვევა")
    else:
        print("Error: პაროლი არ შეიყვანე")

