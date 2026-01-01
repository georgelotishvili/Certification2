from __future__ import annotations

import random
import string
from datetime import datetime

from fastapi import APIRouter, Depends, Header, HTTPException, status, Path as FPath, UploadFile, File
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
)
from ..services.media_storage import (
    multi_functional_pdf_path,
    relative_storage_path,
    resolve_storage_path,
    delete_storage_file,
)
from ..routers.admin import _require_admin

router = APIRouter()


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
    
    filename = file.filename or "project.pdf"
    pdf_path = multi_functional_pdf_path(project.id, filename)
    
    with open(pdf_path, "wb") as f:
        content = await file.read()
        f.write(content)
    
    project.pdf_path = relative_storage_path(pdf_path).replace("\\", "/")
    project.pdf_filename = filename
    db.add(project)
    db.commit()
    
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
            headers={
                "Content-Disposition": f'inline; filename="{project.pdf_filename or "project.pdf"}"',
            },
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
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """
    Get a random multi-functional project for evaluation.
    
    Logic:
    - Random project is selected from projects NOT yet completed by this user
    - Once all projects are completed, the cycle restarts
    - If no auth provided, falls back to pure random selection
    """
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
    
    # Try to get user for personalized selection
    user = _get_user_from_token(db, authorization)
    
    if user:
        # Get all project IDs this user has already completed (from submissions)
        completed_project_ids = set(
            db.scalars(
                select(MultiFunctionalSubmission.project_id)
                .where(MultiFunctionalSubmission.user_id == user.id)
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
    else:
        # No auth - pure random
        project = random.choice(available_projects)

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
            headers={
                "Content-Disposition": f'inline; filename="{project.pdf_filename or "project.pdf"}"',
            },
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
    user = _require_auth(db, authorization)
    
    # Get project
    project = db.scalar(
        select(MultiFunctionalProject).where(MultiFunctionalProject.code == payload.projectCode.strip())
    )
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    
    now = datetime.utcnow()
    
    # Create evaluation record
    evaluation = MultiFunctionalEvaluation(
        user_id=user.id,
        project_id=project.id,
        project_code=payload.projectCode,
        project_name=payload.projectName,
        percentage=payload.percentage,
        correct_count=payload.correctCount,
        wrong_count=payload.wrongCount,
        total_correct_answers=payload.totalCorrectAnswers,
        selected_answer_ids=json.dumps(payload.selectedAnswerIds),
        finished_at=now,
        duration_seconds=payload.durationSeconds,
    )
    
    db.add(evaluation)
    db.commit()
    db.refresh(evaluation)
    
    return MultiFunctionalEvaluationResponse(
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
    )


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
    if project and project.answers:
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
