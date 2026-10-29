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
from .services.exam_lifecycle import register_expired_session_tasks
from .services.media_storage import ensure_media_root
try:
    # When running from project root (e.g. `python -m backend.app.main`)
    from backend.scripts.migrate_results_cols import run as run_results_migration
    from backend.scripts.migrate_media_table import run as run_media_migration
    from backend.scripts.migrate_certificate_score import run as run_certificate_score_migration
    from backend.scripts.migrate_certificate_file_cols import run as run_certificate_file_cols_migration
    from backend.scripts.migrate_statements_attachment import run as run_statements_attachment_migration
    from backend.scripts.migrate_statements_answered import run as run_statements_answered_migration
    from backend.scripts.migrate_user_code_reservations import run as run_user_code_reservations_migration
    from backend.scripts.migrate_exam_schedules import run as run_exam_schedules_migration
    from backend.scripts.migrate_planning_letters import run as run_planning_letters_migration
    from backend.scripts.migrate_exam_permission import run as run_exam_permission_migration
    from backend.scripts.migrate_exam_stage_grants import run as run_exam_stage_grants_migration
    from backend.scripts.migrate_multi_apartment import run as run_multi_apartment_migration
    from backend.scripts.migrate_multi_functional import run as run_multi_functional_migration
    from backend.scripts.migrate_guide_videos import run as run_guide_videos_migration
    from backend.scripts.migrate_user_sessions import run as run_user_sessions_migration
    from backend.scripts.migrate_session_user_id import run as run_session_user_id_migration
    from backend.scripts.migrate_fix_answers_fk import run as run_fix_answers_fk_migration
    from backend.scripts.migrate_taxonomy import run as run_taxonomy_migration
    from backend.scripts.migrate_documents import run as run_documents_migration
    from backend.scripts.migrate_doc_numbers import run as run_doc_numbers_migration
    from backend.scripts.migrate_candidate_status import run as run_candidate_status_migration
except ImportError:  # pragma: no cover - fallback for `cd backend; uvicorn app.main:app`
    from scripts.migrate_results_cols import run as run_results_migration  # type: ignore
    from scripts.migrate_media_table import run as run_media_migration  # type: ignore
    from scripts.migrate_certificate_score import run as run_certificate_score_migration  # type: ignore
    from scripts.migrate_certificate_file_cols import run as run_certificate_file_cols_migration  # type: ignore
    from scripts.migrate_statements_attachment import run as run_statements_attachment_migration  # type: ignore
    from scripts.migrate_statements_answered import run as run_statements_answered_migration  # type: ignore
    from scripts.migrate_user_code_reservations import run as run_user_code_reservations_migration  # type: ignore
    from scripts.migrate_exam_schedules import run as run_exam_schedules_migration  # type: ignore
    from scripts.migrate_planning_letters import run as run_planning_letters_migration  # type: ignore
    from scripts.migrate_exam_permission import run as run_exam_permission_migration  # type: ignore
    from scripts.migrate_exam_stage_grants import run as run_exam_stage_grants_migration  # type: ignore
    from scripts.migrate_multi_apartment import run as run_multi_apartment_migration  # type: ignore
    from scripts.migrate_multi_functional import run as run_multi_functional_migration  # type: ignore
    from scripts.migrate_guide_videos import run as run_guide_videos_migration  # type: ignore
    from scripts.migrate_user_sessions import run as run_user_sessions_migration  # type: ignore
    from scripts.migrate_session_user_id import run as run_session_user_id_migration  # type: ignore
    from scripts.migrate_fix_answers_fk import run as run_fix_answers_fk_migration  # type: ignore
    from scripts.migrate_taxonomy import run as run_taxonomy_migration  # type: ignore
    from scripts.migrate_documents import run as run_documents_migration  # type: ignore
    from scripts.migrate_doc_numbers import run as run_doc_numbers_migration  # type: ignore
    from scripts.migrate_candidate_status import run as run_candidate_status_migration  # type: ignore


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
        run_session_user_id_migration,
        run_fix_answers_fk_migration,
        run_taxonomy_migration,
        run_documents_migration,
    ):
        try:
            migrate()
        except Exception:
            pass

    # Required by the Statement mapper: surface a migration failure instead of
    # starting with missing columns and failing all statement operations later.
    run_statements_answered_migration()
    # Preserve all currently assigned registration codes before accepting
    # registrations/deletions. Conflicts must not be silently overwritten.
    run_user_code_reservations_migration()
    # Scheduling is additive and independent of examination access/results.
    # Fail startup visibly if its required table/indexes cannot be created.
    run_exam_schedules_migration()
    run_planning_letters_migration()
    run_doc_numbers_migration()
    run_candidate_status_migration()
    # Independent stage grants are authoritative for every exam start/result.
    # Run after the legacy permission/project migrations and fail visibly if
    # the required columns, indexes, or lossless backfill cannot be created.
    run_exam_stage_grants_migration()

    ensure_media_root()

    app = FastAPI(title=settings.app_name)
    register_expired_session_tasks(app)
    
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
        allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$|^https://([a-z0-9-]+\.)?gipc\.(org\.)?ge$",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    from fastapi.responses import JSONResponse

    @app.middleware("http")
    async def security_headers_and_docs_guard(request: Request, call_next):
        if request.url.path in ("/docs", "/redoc", "/openapi.json", "/docs/oauth2-redirect"):
            peer_host = (request.client.host if request.client else "").strip()
            proxied_ip = (
                request.headers.get("x-real-ip")
                or request.headers.get("x-forwarded-for")
                or ""
            ).split(",")[0].strip()
            is_local_direct = peer_host in ("127.0.0.1", "::1", "localhost", "testclient") and proxied_ip in ("", "127.0.0.1", "::1")
            if not is_local_direct:
                return JSONResponse(status_code=404, content={"detail": "Not Found"})

        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        return response

    from .routers import auth, exam, admin, users, statements, registry, reviews, expert_uploads, multi_apartment, multi_functional, guide, app_files, regulations, documents, taxonomy
    from .routers import exam_schedules, planning_letters, ai_assistant, cert_bookings

    app.include_router(auth.router, prefix="/auth", tags=["auth"])
    app.include_router(exam.router, prefix="/exam", tags=["exam"])
    app.include_router(admin.router, prefix="/admin", tags=["admin"])
    app.include_router(exam_schedules.router, prefix="/admin", tags=["admin"])
    app.include_router(planning_letters.router, prefix="/admin", tags=["admin"])
    app.include_router(cert_bookings.admin_router, prefix="/admin", tags=["admin-cert-bookings"])
    app.include_router(ai_assistant.router, prefix="/admin", tags=["admin-ai"])
    app.include_router(ai_assistant.public_router, tags=["public-ai"])
    app.include_router(taxonomy.router, prefix="/taxonomy", tags=["taxonomy"])
    app.include_router(users.router, prefix="/users", tags=["users"])
    app.include_router(cert_bookings.user_router, prefix="/users", tags=["user-cert-bookings"])
    app.include_router(statements.router, prefix="/statements", tags=["statements"])
    app.include_router(registry.router, prefix="/certified-persons", tags=["registry"])
    app.include_router(reviews.router, prefix="/reviews", tags=["reviews"])
    app.include_router(expert_uploads.router, prefix="/expert-uploads", tags=["expert-uploads"])
    app.include_router(multi_apartment.router, tags=["multi-apartment"])
    app.include_router(multi_functional.router, tags=["multi-functional"])
    app.include_router(guide.router, tags=["guide"])
    app.include_router(app_files.router, tags=["app-files"])
    app.include_router(regulations.router, tags=["regulations"])
    app.include_router(documents.router, tags=["documents"])

    return app


app = create_app()


