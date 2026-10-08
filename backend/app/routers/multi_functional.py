from __future__ import annotations

import random
import string
from datetime import datetime

from fastapi import APIRouter, Depends, Header, HTTPException, status, Path as FPath, Query, UploadFile, File
from fastapi.responses import FileResponse
from sqlalchemy import select, func, exists
from sqlalchemy.orm import Session, selectinload

from ..database import get_db
from ..models import MultiFunctionalProject, MultiFunctionalAnswer, MultiFunctionalSubmission, MultiFunctionalSettings, MultiFunctionalEvaluation, User, UserSession
from ..schemas import (
    MultiFunctionalProjectsResponse,
    MultiFunctionalProjectsUpdateRequest,
    MultiFunctionalProjectPayload,
    MultiFunctionalAnswerPayload,
    PublicMultiFunctionalProjectResponse,
    MultiFunctionalEvaluationSubmitRequest,
    MultiFunctionalEvaluationSubmitFullRequest,
    MultiFunctionalEvaluationResponse,
    MultiFunctionalEvaluationListResponse,
    MultiFunctionalEvaluationDetailResponse,
    MultiFunctionalAnswerDetail,
    MultiFunctionalSettingsResponse,
    MultiFunctionalPublicSettingsResponse,
    MultiFunctionalSettingsUpdateRequest,
    MultiFunctionalGateVerifyRequest,
    MultiFunctionalGateVerifyResponse,
    ExamStageStartRequest,
    ExamStageStartResponse,
)
from ..services.media_storage import (
    InvalidPdfUpload,
    PdfUploadTooLarge,
    delete_replaced_multi_functional_pdf,
    multi_functional_pdf_path,
    relative_storage_path,
    resolve_storage_path,
    safe_pdf_display_filename,
    save_pdf_upload,
    delete_storage_file,
)
from ..routers.admin import _require_admin
from ..services.exam_stage import STAGE_PROJECT_2, is_admin_like
from ..services.exam_stage_grants import (
    completion_grant,
    consume_stage_permission,
    lock_user_stage_transitions,
    require_stage_permission,
)

router = APIRouter()

from ..services.offline_attempts import (
    naive_utc, project_final_context, record_receipt,
    require_legacy_project_submission, start_project_attempt, utc_response,
)
from ..services.offline_grading import (
    bind_evaluation_snapshot, grade_project_snapshot, guard_pending_project_delete,
    project_report_answers, detach_evaluation_snapshot,
)


def _get_user_from_token(db: Session, authorization: str | None) -> User | None:
    """Get user from Bearer token."""
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    token = authorization.split(" ", 1)[1]
    session = db.scalar(
        select(UserSession).where(
            UserSession.token == token,
            UserSession.expires_at > datetime.utcnow()
        )
    )
    if not session:
        return None
    return db.get(User, session.user_id)


def _require_auth(db: Session, authorization: str | None) -> User:
    """Require authenticated user via Bearer token."""
    user = _get_user_from_token(db, authorization)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Bearer token required")
    return user


def _gen_unique_code(db: Session) -> str:
    """Generate a unique 5-digit code for multi-functional projects."""
    while True:
        candidate = "".join(random.choices(string.digits, k=5))
        exists = db.scalar(select(MultiFunctionalProject).where(MultiFunctionalProject.code == candidate))
        if not exists:
            return candidate


def _safe_public_pdf_url(project: MultiFunctionalProject | None) -> str | None:
    """
    Return public PDF URL for a project only if the underlying file
    really არსებობს და არის ფაილი. თუ რაიმე პრობლემა იქნება (არასწორი ბილიკი,
    არ არსებობს ფაილი და ა.შ.) ვაბრუნებთ None-ს, რომ ფრონტმა აჩვენოს
    'PDF ფაილი არ არის ხელმისაწვდომი' და არ დადოს iframe-ზე 500 შეცდომა.
    """
    if not project or not project.pdf_path:
        return None
    try:
        pdf_path = resolve_storage_path(project.pdf_path)
        try:
            if not pdf_path.exists() or not pdf_path.is_file():
                return None
        except OSError:
            return None
    except ValueError:
        # არასწორი relative ბილიკი
        return None
    except Exception:
        # ნებისმიერი სხვა დაუდასტურებელი შეცდომა – სჯობს ჩავთვალოთ, რომ PDF არ არის
        return None
    return f"/public/multi-functional/projects/{project.code}/pdf"


def _get_or_create_settings(db: Session) -> MultiFunctionalSettings:
    """Return existing multi-functional settings or create with defaults."""
    settings = db.scalar(select(MultiFunctionalSettings).limit(1))
    if settings:
        return settings

    settings = MultiFunctionalSettings(duration_minutes=60)
    db.add(settings)
    db.commit()
    db.refresh(settings)
    return settings


@router.get("/public/multi-functional/settings", response_model=MultiFunctionalPublicSettingsResponse)
def get_public_multi_functional_settings(
    db: Session = Depends(get_db),
):
    """
    Public endpoint exposing only the evaluation duration (in minutes)
    for the multi-functional project evaluation. Does NOT expose gate password.
    """
    settings = _get_or_create_settings(db)
    return settings


@router.post(
    "/public/multi-functional/gate/verify",
    response_model=MultiFunctionalGateVerifyResponse,
)
def verify_multi_functional_gate(
    payload: MultiFunctionalGateVerifyRequest,
    db: Session = Depends(get_db),
):
    """
    Verify admin gate password for the public multi-functional evaluation screen.

    The password is configured in MultiFunctionalSettings.gate_password from
    the admin interface. We never expose the password itself; only whether
    the provided value matches.
    """
    settings = _get_or_create_settings(db)
    expected = (settings.gate_password or "").strip()
    provided = (payload.password or "").strip()
    valid = bool(expected) and provided == expected
    return MultiFunctionalGateVerifyResponse(valid=valid)


# Admin endpoints
@router.get("/admin/multi-functional/settings", response_model=MultiFunctionalSettingsResponse)
def get_multi_functional_settings(
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    settings = _get_or_create_settings(db)
    return settings


@router.put("/admin/multi-functional/settings", response_model=MultiFunctionalSettingsResponse)
def update_multi_functional_settings(
    payload: MultiFunctionalSettingsUpdateRequest,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    settings = _get_or_create_settings(db)

    if payload.duration_minutes is not None:
        settings.duration_minutes = max(1, payload.duration_minutes)
    if payload.gate_password is not None:
        settings.gate_password = (payload.gate_password or "").strip()

    db.add(settings)
    db.commit()
    db.refresh(settings)
    return settings


@router.get("/admin/multi-functional/projects", response_model=MultiFunctionalProjectsResponse)
def get_projects_endpoint(
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    return get_projects(authorization, db)


def get_projects(
    authorization: str | None,
    db: Session,
):
    _require_admin(db, authorization)
    projects = db.scalars(
        select(MultiFunctionalProject)
        .order_by(MultiFunctionalProject.order_index, MultiFunctionalProject.id)
    ).all()
    
    payloads = []
    for project in projects:
        answers = sorted(project.answers, key=lambda a: (a.order_index, a.id))
        # Collect all correct answers; legacy clients still see the first one
        # via correctAnswerId for backwards compatibility.
        correct_answer_ids = [str(a.id) for a in answers if a.is_correct]
        first_correct_id = correct_answer_ids[0] if correct_answer_ids else None
        
        payloads.append(
            MultiFunctionalProjectPayload(
                id=str(project.id),
                number=project.number,
                code=project.code,
                pdfFile=project.pdf_filename,
                answers=[
                    MultiFunctionalAnswerPayload(id=str(a.id), text=a.text)
                    for a in answers
                ],
                correctAnswerId=first_correct_id,
                correctAnswerIds=correct_answer_ids or None,
            )
        )
    
    return MultiFunctionalProjectsResponse(projects=payloads)


@router.post("/admin/multi-functional/projects", response_model=MultiFunctionalProjectsResponse)
async def update_projects(
    payload: MultiFunctionalProjectsUpdateRequest,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    try:
        _require_admin(db, authorization)
    except HTTPException as e:
        raise e
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Admin verification failed: {str(e)}",
        )
    
    if not payload or not payload.projects:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Projects list is required",
        )
    
    existing_projects = {
        str(p.id): p
        for p in db.scalars(select(MultiFunctionalProject)).all()
    }
    retained_ids = set()
    for item in payload.projects:
        try:
            retained_ids.add(str(int(item.id)))
        except (TypeError, ValueError):
            pass
    for existing_id, existing_project in existing_projects.items():
        if existing_id not in retained_ids:
            guard_pending_project_delete(db, MultiFunctionalProject, STAGE_PROJECT_2, existing_project.id)
    processed_ids = set()
    
    for order_idx, project_payload in enumerate(payload.projects or [], start=1):
        project_id_str = project_payload.id
        project_id_int = None
        
        try:
            project_id_int = int(project_id_str)
        except (ValueError, TypeError):
            project_id_int = None
        
        # Ensure number and code even when frontend sends empty values
        project_number = project_payload.number or order_idx
        code_candidate = (project_payload.code or "").strip() or _gen_unique_code(db)
        
        # Check code uniqueness (excluding current project); if new project and code collides, regen
        existing_with_code = db.scalar(
            select(MultiFunctionalProject).where(MultiFunctionalProject.code == code_candidate)
        )
        if existing_with_code and (project_id_int is None or existing_with_code.id != project_id_int):
            code_candidate = _gen_unique_code(db)
        
        if project_id_int and str(project_id_int) in existing_projects:
            project = existing_projects[str(project_id_int)]
        else:
            project = MultiFunctionalProject()
            db.add(project)
        
        # assign fields before flushing so NOT NULL constraints are satisfied
        project.number = project_number
        project.code = code_candidate
        project.order_index = order_idx
        
        db.flush()
        existing_projects[str(project.id)] = project
        processed_ids.add(project.id)
        
        # Update answers
        answers_list = project_payload.answers or []
        # Allow projects without answers - user can add answers later

        # Determine which answers should be marked correct.
        # New multi-select API: correctAnswerIds (array of IDs).
        # Backwards-compatible: if only correctAnswerId is provided, treat it
        # as a single-element list.
        correct_ids: set[str] = set()
        if getattr(project_payload, "correctAnswerIds", None):
            correct_ids = {str(cid) for cid in project_payload.correctAnswerIds or []}
        elif getattr(project_payload, "correctAnswerId", None):
            correct_ids = {str(project_payload.correctAnswerId)}

        existing_answers = {str(a.id): a for a in project.answers}
        processed_answer_ids = set()
        
        for ans_idx, answer_payload in enumerate(answers_list, start=1):
            answer_id_str = answer_payload.id
            answer_id_int = None

            try:
                answer_id_int = int(answer_id_str)
            except (ValueError, TypeError):
                answer_id_int = None

            if answer_id_int and str(answer_id_int) in existing_answers:
                answer = existing_answers[str(answer_id_int)]
            else:
                # New answer for this project
                answer = MultiFunctionalAnswer(project_id=project.id)
                db.add(answer)

            # Normalize text; allow empty string but never leave it as None,
            # because the DB column is NOT NULL.
            answer_text = (answer_payload.text or "").strip()
            answer.text = answer_text
            answer.order_index = ans_idx
            # Mark answer as correct if its ID appears in the set of correct IDs.
            # We support both database IDs and the temporary frontend IDs sent
            # by the admin UI for newly created answers.
            is_correct = False
            if correct_ids:
                # First try to match by database ID (for existing answers)
                if str(answer.id) in correct_ids:
                    is_correct = True
                else:
                    # Fallback: match by the frontend ID from the payload
                    frontend_id = str(answer_payload.id)
                    if frontend_id in correct_ids:
                        is_correct = True
            answer.is_correct = is_correct

            db.flush()
            existing_answers[str(answer.id)] = answer
            processed_answer_ids.add(answer.id)
        
        # Delete unused answers
        for answer in list(project.answers):
            if answer.id not in processed_answer_ids:
                # Check if used in submissions
                has_submissions = db.scalar(
                    select(func.count())
                    .select_from(MultiFunctionalSubmission)
                    .where(MultiFunctionalSubmission.selected_answer_id == answer.id)
                ) or 0
                if has_submissions:
                    raise HTTPException(
                        status_code=status.HTTP_409_CONFLICT,
                        detail="ვერ წაშლით პასუხს, რადგან უკვე არსებობს შეფასებები",
                    )
                db.delete(answer)
    
    # Delete unused projects
    for project in list(existing_projects.values()):
        if project.id not in processed_ids:
            # Delete all submissions for this project first
            db.query(MultiFunctionalSubmission).filter(
                MultiFunctionalSubmission.project_id == project.id
            ).delete()
            # Delete PDF file (and its empty directory, if any)
            if project.pdf_path:
                delete_storage_file(project.pdf_path)
            db.delete(project)
    
    try:
        db.commit()
    except Exception as e:
        db.rollback()
        import traceback
        error_detail = f"Database error: {str(e)}\n{traceback.format_exc()}"
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=error_detail,
        )
    
    try:
        return get_projects(authorization, db)
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        error_detail = f"Failed to retrieve projects after save: {str(e)}\n{traceback.format_exc()}"
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=error_detail,
        )


@router.delete("/admin/multi-functional/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(
    project_id: int = FPath(...),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    project = db.get(MultiFunctionalProject, project_id)
    if not project:
        return
    guard_pending_project_delete(db, MultiFunctionalProject, STAGE_PROJECT_2, project.id)
    
    # Delete all submissions for this project first
    db.query(MultiFunctionalSubmission).filter(
        MultiFunctionalSubmission.project_id == project.id
    ).delete()
    
    if project.pdf_path:
        delete_storage_file(project.pdf_path)
    
    db.delete(project)
    db.commit()
    return


@router.post("/admin/multi-functional/projects/{project_id}/pdf")
async def upload_pdf(
    project_id: int = FPath(...),
    file: UploadFile = File(...),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    project = db.get(MultiFunctionalProject, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    
    if file.content_type != "application/pdf":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only PDF files allowed")
    
    previous_pdf_path = project.pdf_path
    display_filename = safe_pdf_display_filename(file.filename)
    pdf_path = multi_functional_pdf_path(project.id)

    try:
        await save_pdf_upload(file, pdf_path)
    except InvalidPdfUpload as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only PDF files allowed",
        ) from exc
    except PdfUploadTooLarge as exc:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="file too large (max 100MB)",
        ) from exc

    try:
        stored_pdf_path = relative_storage_path(pdf_path).replace("\\", "/")
        project.pdf_path = stored_pdf_path
        project.pdf_filename = display_filename
        db.add(project)
        db.commit()
    except BaseException:
        try:
            db.rollback()
        except Exception:
            pass
        try:
            pdf_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise

    if previous_pdf_path and previous_pdf_path != stored_pdf_path:
        delete_replaced_multi_functional_pdf(project.id, previous_pdf_path)
    
    return {"message": "PDF uploaded successfully"}


@router.get("/admin/multi-functional/projects/{project_id}/pdf")
def download_pdf(
    project_id: int = FPath(...),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    project = db.get(MultiFunctionalProject, project_id)
    if not project or not project.pdf_path:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="PDF not found")
    
    try:
        pdf_path = resolve_storage_path(project.pdf_path)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="PDF not found")
    
    if not pdf_path.exists() or not pdf_path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="PDF file missing")

    # PDF-ს დაბრუნება; ნებისმიერი გაუთვალისწინებელი შეცდომის შემთხვევაში 404-ს ვაბრუნებთ,
    # რომ არ მივიღოთ 500 Internal Server Error.
    try:
        return FileResponse(
            pdf_path,
            media_type="application/pdf",
            filename=safe_pdf_display_filename(project.pdf_filename),
            content_disposition_type="inline",
        )
    except Exception:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="PDF not found")


@router.delete("/admin/multi-functional/projects/{project_id}/pdf", status_code=status.HTTP_204_NO_CONTENT)
def delete_project_pdf(
    project_id: int = FPath(...),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """Delete project's PDF and clear its path/filename."""
    _require_admin(db, authorization)
    project = db.get(MultiFunctionalProject, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")

    if project.pdf_path:
        try:
            delete_storage_file(project.pdf_path)
        except Exception:
            # არაფერს ვუშვებთ – ფაილის წაშლა best-effort არის
            pass
        project.pdf_path = None
        project.pdf_filename = None
        db.add(project)
        db.commit()


# Public endpoints
@router.get("/public/multi-functional/projects/random", response_model=PublicMultiFunctionalProjectResponse)
def get_random_project(
    prepare_only: bool = Query(False),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """
    Get a random multi-functional project for evaluation.
    
    Logic:
    - Random project is selected from projects NOT yet completed by this user
    - Once all projects are completed, the cycle restarts
    """
    user = _require_auth(db, authorization)
    stage_grant = require_stage_permission(
        db, user, STAGE_PROJECT_2, mark_started=False
    )
    if stage_grant is not None and stage_grant.started_at is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This project attempt is already in progress",
        )
    if stage_grant is not None and not prepare_only:
        stage_grant = require_stage_permission(
            db,
            user,
            STAGE_PROJECT_2,
            mark_started=True,
            grant_id=stage_grant.id,
        )

    # Load all projects (with answers eagerly loaded)
    all_projects = db.scalars(
        select(MultiFunctionalProject).options(selectinload(MultiFunctionalProject.answers))
    ).all()

    if not all_projects:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No projects configured"
        )

    # Prefer projects that actually have answers
    projects_with_answers = [p for p in all_projects if p.answers]
    available_projects = projects_with_answers or all_projects
    
    # Get all project IDs this user has already completed
    completed_project_ids = set(
        db.scalars(
            select(MultiFunctionalEvaluation.project_id)
            .where(MultiFunctionalEvaluation.user_id == user.id)
        ).all()
    )

    # Filter out completed projects
    not_completed = [p for p in available_projects if p.id not in completed_project_ids]

    if not_completed:
        # Random from not-yet-completed projects
        project = random.choice(not_completed)
    else:
        # All projects completed - restart cycle (random from all)
        project = random.choice(available_projects)

    answers = sorted(project.answers, key=lambda a: (a.order_index, a.id))
    pdf_url = _safe_public_pdf_url(project)
    db.commit()

    return PublicMultiFunctionalProjectResponse(
        id=project.id,
        number=project.number,
        code=project.code,
        pdfUrl=pdf_url,
        answers=[
            MultiFunctionalAnswerPayload(id=str(a.id), text=a.text)
            for a in answers
        ],
        stageGrantId=stage_grant.id if stage_grant else None,
    )


@router.post(
    "/public/multi-functional/start", response_model=ExamStageStartResponse
)
def start_multi_functional_stage(
    payload: ExamStageStartRequest,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    user = _require_auth(db, authorization)
    if payload.offline:
        settings = _get_or_create_settings(db)
        attempt = start_project_attempt(db, user, STAGE_PROJECT_2, payload,
                                        MultiFunctionalProject, settings.duration_minutes)
        db.commit()
        return ExamStageStartResponse(
            stageGrantId=attempt.stage_grant_id, stage=STAGE_PROJECT_2,
            startedAt=utc_response(attempt.started_at),
            durationMinutes=int((attempt.ends_at - attempt.started_at).total_seconds() / 60),
            offlineSubmissionToken=attempt.token, endsAt=utc_response(attempt.ends_at),
            serverNow=utc_response(datetime.utcnow()),
        )
    grant = require_stage_permission(
        db,
        user,
        STAGE_PROJECT_2,
        mark_started=True,
        grant_id=payload.stageGrantId,
    )
    settings = _get_or_create_settings(db)
    db.commit()
    started_at = grant.started_at if grant else datetime.utcnow()
    return ExamStageStartResponse(
        stageGrantId=grant.id if grant else None,
        stage=STAGE_PROJECT_2,
        startedAt=started_at,
        durationMinutes=settings.duration_minutes,
    )


@router.get("/public/multi-functional/projects/{code}", response_model=PublicMultiFunctionalProjectResponse)
def get_public_project(
    code: str = FPath(...),
    db: Session = Depends(get_db),
):
    project = db.scalar(
        select(MultiFunctionalProject).where(MultiFunctionalProject.code == code.strip())
    )
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    
    answers = sorted(project.answers, key=lambda a: (a.order_index, a.id))
    pdf_url = _safe_public_pdf_url(project)
    
    return PublicMultiFunctionalProjectResponse(
        id=project.id,
        number=project.number,
        code=project.code,
        pdfUrl=pdf_url,
        answers=[
            MultiFunctionalAnswerPayload(id=str(a.id), text=a.text)
            for a in answers
        ],
    )


@router.get("/public/multi-functional/projects/{code}/pdf")
def get_public_pdf(
    code: str = FPath(...),
    db: Session = Depends(get_db),
):
    project = db.scalar(
        select(MultiFunctionalProject).where(MultiFunctionalProject.code == code.strip())
    )
    if not project or not project.pdf_path:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="PDF not found")

    try:
        pdf_path = resolve_storage_path(project.pdf_path)
        # თუ ფაილი არ არსებობს ან არის დირექტორია – ჩავთვალოთ, რომ PDF არ არის
        if not pdf_path.exists() or not pdf_path.is_file():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="PDF file missing")
    except HTTPException:
        raise
    except Exception:
        # ნებისმიერი სხვა გაუთვალისწინებელი შეცდომა – ვუბრუნებთ 404-ს, რომ არ იყოს 500
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="PDF not found")

    # PDF-ს აბრუნებს <iframe>-ში საჩვენებლად; ნებისმიერი გაუთვალისწინებელი შეცდომის
    # შემთხვევაში ვაბრუნებთ 404-ს, რომ მომხმარებელმა დაინახოს „PDF არ არის ხელმისაწვდომი"
    # და არ მიიღოს 500 Internal Server Error.
    try:
        return FileResponse(
            pdf_path,
            media_type="application/pdf",
            filename=safe_pdf_display_filename(project.pdf_filename),
            content_disposition_type="inline",
        )
    except Exception:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="PDF not found")


@router.post("/public/multi-functional/submissions", status_code=status.HTTP_201_CREATED)
def submit_simple_evaluation(
    payload: MultiFunctionalEvaluationSubmitRequest,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    # Get user
    user = _require_auth(db, authorization)
    stage_grant = completion_grant(db, user, STAGE_PROJECT_2, None)
    require_legacy_project_submission(db, stage_grant.id if stage_grant else None)
    
    # Get project
    project = db.scalar(
        select(MultiFunctionalProject).where(MultiFunctionalProject.code == payload.projectCode.strip())
    )
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    
    # Verify answer exists and belongs to project
    answer = db.scalar(
        select(MultiFunctionalAnswer)
        .where(
            MultiFunctionalAnswer.id == payload.selectedAnswerId,
            MultiFunctionalAnswer.project_id == project.id,
        )
    )
    if not answer:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid answer")
    
    # Check if already submitted
    existing = db.scalar(
        select(MultiFunctionalSubmission)
        .where(
            MultiFunctionalSubmission.project_id == project.id,
            MultiFunctionalSubmission.user_id == user.id,
        )
    )
    
    if existing:
        existing.selected_answer_id = answer.id
        db.add(existing)
    else:
        submission = MultiFunctionalSubmission(
            project_id=project.id,
            user_id=user.id,
            selected_answer_id=answer.id,
        )
        db.add(submission)
    
    db.commit()
    return {"message": "Evaluation submitted successfully"}


@router.post("/public/multi-functional/evaluations", status_code=status.HTTP_201_CREATED, response_model=MultiFunctionalEvaluationResponse)
def submit_full_evaluation(
    payload: MultiFunctionalEvaluationSubmitFullRequest,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """სრული შეფასების შენახვა - მრავალბინიანის მსგავსი"""
    import json
    
    # Get user
    offline_attempt = None
    offline_digest = None
    if payload.offlineSubmissionToken:
        offline_attempt, user, offline_digest, receipt = project_final_context(
            db, STAGE_PROJECT_2, payload)
        if receipt is not None:
            return MultiFunctionalEvaluationResponse.model_validate(receipt)
    else:
        user = _require_auth(db, authorization)
        require_legacy_project_submission(db, payload.stageGrantId)
    lock_user_stage_transitions(db, user)
    if payload.stageGrantId is not None:
        existing = db.scalar(
            select(MultiFunctionalEvaluation).where(
                MultiFunctionalEvaluation.stage_grant_id == payload.stageGrantId
            )
        )
        if existing is not None and existing.user_id == user.id:
            return MultiFunctionalEvaluationResponse(
                id=existing.id, userId=existing.user_id, projectId=existing.project_id,
                projectCode=existing.project_code, projectName=existing.project_name,
                percentage=existing.percentage, correctCount=existing.correct_count,
                wrongCount=existing.wrong_count,
                totalCorrectAnswers=existing.total_correct_answers,
                selectedAnswerIds=json.loads(existing.selected_answer_ids or "[]"),
                startedAt=existing.started_at, finishedAt=existing.finished_at,
                durationSeconds=existing.duration_seconds, createdAt=existing.created_at,
                stageGrantId=existing.stage_grant_id,
            )
    elif not is_admin_like(user):
        legacy_existing = db.scalar(
            select(MultiFunctionalEvaluation)
            .where(
                MultiFunctionalEvaluation.user_id == user.id,
                MultiFunctionalEvaluation.project_code == payload.projectCode.strip(),
            )
            .order_by(MultiFunctionalEvaluation.id.desc())
        )
        if legacy_existing is not None and sorted(
            json.loads(legacy_existing.selected_answer_ids or "[]")
        ) == sorted(payload.selectedAnswerIds):
            return MultiFunctionalEvaluationResponse(
                id=legacy_existing.id, userId=legacy_existing.user_id,
                projectId=legacy_existing.project_id,
                projectCode=legacy_existing.project_code,
                projectName=legacy_existing.project_name,
                percentage=legacy_existing.percentage,
                correctCount=legacy_existing.correct_count,
                wrongCount=legacy_existing.wrong_count,
                totalCorrectAnswers=legacy_existing.total_correct_answers,
                selectedAnswerIds=json.loads(legacy_existing.selected_answer_ids or "[]"),
                startedAt=legacy_existing.started_at,
                finishedAt=legacy_existing.finished_at,
                durationSeconds=legacy_existing.duration_seconds,
                createdAt=legacy_existing.created_at,
                stageGrantId=legacy_existing.stage_grant_id,
            )
    stage_grant = completion_grant(
        db, user, STAGE_PROJECT_2, payload.stageGrantId
    )
    if offline_attempt is None:
        require_legacy_project_submission(db, stage_grant.id if stage_grant else None)
    
    # Get project with answers
    project = (db.get(MultiFunctionalProject, offline_attempt.project_id) if offline_attempt else db.scalar(
        select(MultiFunctionalProject)
        .where(MultiFunctionalProject.code == payload.projectCode.strip())
        .options(selectinload(MultiFunctionalProject.answers))
    ))
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    
    now = datetime.utcnow()
    
    # Calculate results server-side (don't trust frontend values)
    answers = sorted(project.answers, key=lambda a: (a.order_index, a.id))
    correct_answer_ids = {a.id for a in answers if a.is_correct}
    selected_ids_set = set(payload.selectedAnswerIds)
    
    correct_count = len(selected_ids_set & correct_answer_ids)
    wrong_count = len(selected_ids_set - correct_answer_ids)
    total_correct = len(correct_answer_ids)
    percentage = round((correct_count / total_correct) * 100, 2) if total_correct > 0 else 0
    if offline_attempt is not None:
        percentage, correct_count, wrong_count, total_correct = grade_project_snapshot(
            db, offline_attempt, payload.selectedAnswerIds)
    
    # Create evaluation record
    evaluation = MultiFunctionalEvaluation(
        user_id=user.id,
        project_id=project.id,
        stage_grant_id=stage_grant.id if stage_grant else None,
        project_code=payload.projectCode,
        project_name=payload.projectName,
        percentage=percentage,
        correct_count=correct_count,
        wrong_count=wrong_count,
        total_correct_answers=total_correct,
        selected_answer_ids=json.dumps(payload.selectedAnswerIds),
        started_at=offline_attempt.started_at if offline_attempt else (stage_grant.started_at if stage_grant else now),
        finished_at=naive_utc(payload.finishedAt) if offline_attempt else now,
        duration_seconds=int((naive_utc(payload.finishedAt) - offline_attempt.started_at).total_seconds()) if offline_attempt else payload.durationSeconds,
    )
    
    db.add(evaluation)
    consume_stage_permission(
        db,
        user,
        STAGE_PROJECT_2,
        grant_id=stage_grant.id if stage_grant else None,
        now=now,
    )
    db.flush()
    db.refresh(evaluation)
    
    response = MultiFunctionalEvaluationResponse(
        id=evaluation.id,
        userId=evaluation.user_id,
        projectId=evaluation.project_id,
        projectCode=evaluation.project_code,
        projectName=evaluation.project_name,
        percentage=evaluation.percentage,
        correctCount=evaluation.correct_count,
        wrongCount=evaluation.wrong_count,
        totalCorrectAnswers=evaluation.total_correct_answers,
        selectedAnswerIds=json.loads(evaluation.selected_answer_ids),
        startedAt=evaluation.started_at,
        finishedAt=evaluation.finished_at,
        durationSeconds=evaluation.duration_seconds,
        createdAt=evaluation.created_at,
        stageGrantId=evaluation.stage_grant_id,
    )
    if offline_attempt is not None:
        response.offlineSubmissionId = str(payload.submissionId)
        bind_evaluation_snapshot(db, offline_attempt, evaluation.id)
        record_receipt(db, offline_attempt, payload.submissionId, offline_digest,
                       response.model_dump(mode="json"))
    db.commit()
    return response


@router.get("/admin/multi-functional/evaluations/{user_id}", response_model=MultiFunctionalEvaluationListResponse)
def get_user_evaluations(
    user_id: int = FPath(...),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """მომხმარებლის შეფასებების სია"""
    import json
    
    _require_admin(db, authorization)
    
    evaluations = db.scalars(
        select(MultiFunctionalEvaluation)
        .where(MultiFunctionalEvaluation.user_id == user_id)
        .order_by(MultiFunctionalEvaluation.created_at.desc())
    ).all()
    
    items = [
        MultiFunctionalEvaluationResponse(
            id=e.id,
            userId=e.user_id,
            projectId=e.project_id,
            projectCode=e.project_code,
            projectName=e.project_name,
            percentage=e.percentage,
            correctCount=e.correct_count,
            wrongCount=e.wrong_count,
            totalCorrectAnswers=e.total_correct_answers,
            selectedAnswerIds=json.loads(e.selected_answer_ids) if e.selected_answer_ids else [],
            startedAt=e.started_at,
            finishedAt=e.finished_at,
            durationSeconds=e.duration_seconds,
            createdAt=e.created_at,
            stageGrantId=e.stage_grant_id,
        )
        for e in evaluations
    ]
    
    return MultiFunctionalEvaluationListResponse(items=items, total=len(items))


@router.get("/admin/multi-functional/evaluations/detail/{evaluation_id}", response_model=MultiFunctionalEvaluationDetailResponse)
def get_evaluation_detail(
    evaluation_id: int = FPath(...),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """დეტალური შედეგი ერთი შეფასებისთვის - პასუხების ტექსტით"""
    import json
    
    _require_admin(db, authorization)
    
    evaluation = db.get(MultiFunctionalEvaluation, evaluation_id)
    if not evaluation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Evaluation not found")
    
    # Get project with answers
    project = db.scalar(
        select(MultiFunctionalProject)
        .where(MultiFunctionalProject.id == evaluation.project_id)
        .options(selectinload(MultiFunctionalProject.answers))
    )
    
    selected_ids = set(json.loads(evaluation.selected_answer_ids) if evaluation.selected_answer_ids else [])
    
    # Build answer details
    answer_details = []
    frozen_answers = project_report_answers(db, STAGE_PROJECT_2, evaluation)
    if frozen_answers is not None:
        answer_details = [MultiFunctionalAnswerDetail(
            id=answer["id"], text=answer["text"], isCorrect=answer["is_correct"],
            isSelected=answer["id"] in selected_ids) for answer in frozen_answers]
    elif project and project.answers:
        for answer in sorted(project.answers, key=lambda a: (a.order_index, a.id)):
            answer_details.append(MultiFunctionalAnswerDetail(
                id=answer.id,
                text=answer.text,
                isCorrect=answer.is_correct,
                isSelected=answer.id in selected_ids,
            ))
    
    return MultiFunctionalEvaluationDetailResponse(
        id=evaluation.id,
        userId=evaluation.user_id,
        projectId=evaluation.project_id,
        projectCode=evaluation.project_code,
        projectName=evaluation.project_name,
        percentage=evaluation.percentage,
        correctCount=evaluation.correct_count,
        wrongCount=evaluation.wrong_count,
        totalCorrectAnswers=evaluation.total_correct_answers,
        startedAt=evaluation.started_at,
        finishedAt=evaluation.finished_at,
        durationSeconds=evaluation.duration_seconds,
        createdAt=evaluation.created_at,
        answers=answer_details,
    )


@router.delete("/admin/multi-functional/evaluations/{evaluation_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_evaluation(
    evaluation_id: int = FPath(...),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """შეფასების წაშლა - სრულად იშლება ყველაფერი"""
    _require_admin(db, authorization)
    
    evaluation = db.get(MultiFunctionalEvaluation, evaluation_id)
    if not evaluation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Evaluation not found")
    
    detach_evaluation_snapshot(db, STAGE_PROJECT_2, evaluation)
    db.delete(evaluation)
    db.commit()
    return None
