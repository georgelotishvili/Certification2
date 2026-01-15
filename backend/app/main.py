from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

# Try to import slowapi for rate limiting (optional)
try:
    from slowapi import Limiter, _rate_limit_exceeded_handler
    from slowapi.util import get_remote_address
    from slowapi.errors import RateLimitExceeded
    SLOWAPI_AVAILABLE = True
except ImportError:
    SLOWAPI_AVAILABLE = False

from .config import get_settings
from .database import engine
from .models import Base
from .services.media_storage import ensure_media_root
try:
    # When running from project root (e.g. `python -m backend.app.main`)
    from backend.scripts.migrate_results_cols import run as run_results_migration
    from backend.scripts.migrate_media_table import run as run_media_migration
    from backend.scripts.migrate_certificate_score import run as run_certificate_score_migration
    from backend.scripts.migrate_certificate_file_cols import run as run_certificate_file_cols_migration
    from backend.scripts.migrate_statements_attachment import run as run_statements_attachment_migration
    from backend.scripts.migrate_exam_permission import run as run_exam_permission_migration
    from backend.scripts.migrate_multi_apartment import run as run_multi_apartment_migration
    from backend.scripts.migrate_multi_functional import run as run_multi_functional_migration
    from backend.scripts.migrate_guide_videos import run as run_guide_videos_migration
    from backend.scripts.migrate_user_sessions import run as run_user_sessions_migration
    from backend.scripts.migrate_team import run as run_team_migration
    from backend.scripts.migrate_documents import run as run_documents_migration
except ImportError:  # pragma: no cover - fallback for `cd backend; uvicorn app.main:app`
    from scripts.migrate_results_cols import run as run_results_migration  # type: ignore
    from scripts.migrate_media_table import run as run_media_migration  # type: ignore
    from scripts.migrate_certificate_score import run as run_certificate_score_migration  # type: ignore
    from scripts.migrate_certificate_file_cols import run as run_certificate_file_cols_migration  # type: ignore
    from scripts.migrate_statements_attachment import run as run_statements_attachment_migration  # type: ignore
    from scripts.migrate_exam_permission import run as run_exam_permission_migration  # type: ignore
    from scripts.migrate_multi_apartment import run as run_multi_apartment_migration  # type: ignore
    from scripts.migrate_multi_functional import run as run_multi_functional_migration  # type: ignore
    from scripts.migrate_guide_videos import run as run_guide_videos_migration  # type: ignore
    from scripts.migrate_user_sessions import run as run_user_sessions_migration  # type: ignore
    from scripts.migrate_team import run as run_team_migration  # type: ignore
    from scripts.migrate_documents import run as run_documents_migration  # type: ignore


def create_app() -> FastAPI:
    settings = get_settings()

    Base.metadata.create_all(bind=engine)
    # Ensure additive columns for results exist (idempotent)
    for migrate in (
        run_results_migration,
        run_media_migration,
        run_certificate_score_migration,
        run_certificate_file_cols_migration,
        run_statements_attachment_migration,
        run_exam_permission_migration,
        run_multi_apartment_migration,
        run_multi_functional_migration,
        run_guide_videos_migration,
        run_user_sessions_migration,
        run_team_migration,
        run_documents_migration,
    ):
        try:
            migrate()
        except Exception:
            pass

    ensure_media_root()

    app = FastAPI(title=settings.app_name)
    
    # Initialize rate limiter (if slowapi is available)
    if SLOWAPI_AVAILABLE:
        limiter = Limiter(key_func=get_remote_address)
        app.state.limiter = limiter
        app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    else:
        # Create a dummy limiter object to avoid AttributeError
        class DummyLimiter:
            def limit(self, *args, **kwargs):
                def decorator(func):
                    return func
                return decorator
        app.state.limiter = DummyLimiter()

    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r".*",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    from .routers import auth, exam, admin, users, statements, registry, reviews, expert_uploads, multi_apartment, multi_functional, guide, app_files, regulations, team, documents

    app.include_router(auth.router, prefix="/auth", tags=["auth"])
    app.include_router(exam.router, prefix="/exam", tags=["exam"])
    app.include_router(admin.router, prefix="/admin", tags=["admin"])
    app.include_router(users.router, prefix="/users", tags=["users"])
    app.include_router(statements.router, prefix="/statements", tags=["statements"])
    app.include_router(registry.router, prefix="/certified-persons", tags=["registry"])
    app.include_router(reviews.router, prefix="/reviews", tags=["reviews"])
    app.include_router(expert_uploads.router, prefix="/expert-uploads", tags=["expert-uploads"])
    app.include_router(multi_apartment.router, tags=["multi-apartment"])
    app.include_router(multi_functional.router, tags=["multi-functional"])
    app.include_router(guide.router, tags=["guide"])
    app.include_router(app_files.router, tags=["app-files"])
    app.include_router(regulations.router, tags=["regulations"])
    app.include_router(team.router, tags=["team"])
    app.include_router(documents.router, tags=["documents"])

    return app


app = create_app()


