from __future__ import annotations

from functools import lru_cache
from typing import List, Optional

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_name: str = "Exam Backend"
    secret_key: str = "dev-secret-key"
    cors_origins: List[str] = [
        "http://127.0.0.1:3000",
        "http://localhost:3000",
        "http://127.0.0.1",
        "http://localhost",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:5500",
        "http://localhost:5500",
        "null",
    ]
    founder_admin_email: Optional[str] = "naormala@gmail.com"
    media_root: str = "media"
    
    # Email verification settings
    email_mode: str = "console"  # "console" for dev, "smtp" for production
    smtp_host: Optional[str] = None
    smtp_port: int = 587
    smtp_user: Optional[str] = None
    smtp_password: Optional[str] = None

    class Config:
        env_file = ".env"


@lru_cache
def get_settings() -> Settings:
    return Settings()


