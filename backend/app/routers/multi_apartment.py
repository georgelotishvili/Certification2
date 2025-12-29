from __future__ import annotations

import random
import string
from datetime import datetime

from fastapi import APIRouter, Depends, Header, HTTPException, status, Path as FPath, UploadFile, File
from fastapi.responses import FileResponse
from sqlalchemy import select, func, exists
from sqlalchemy.orm import Session, selectinload

from ..database import get_db
from ..models import MultiApartmentProject, MultiApartmentAnswer, MultiApartmentSubmission, MultiApartmentSettings, User, UserSession
from ..schemas import (
    MultiApartmentProjectsResponse,
    MultiApartmentProjectsUpdateRequest,
    MultiApartmentProjectPayload,
    MultiApartmentAnswerPayload,
    PublicMultiApartmentProjectResponse,
    MultiApartmentEvaluationSubmitRequest,
    MultiApartmentSettingsResponse,
    MultiApartmentPublicSettingsResponse,
    MultiApartmentSettingsUpdateRequest,
    MultiApartmentGateVerifyRequest,
    MultiApartmentGateVerifyResponse,
)
from ..services.media_storage import (
    multi_apartment_pdf_path,
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
    """Generate a unique 5-digit code for multi-apartment projects."""
    while True:
        candidate = "".join(random.choices(string.digits, k=5))
        exists = db.scalar(select(MultiApartmentProject).where(MultiApartmentProject.code == candidate))
        if not exists:
            return candidate


def _safe_public_pdf_url(project: MultiApartmentProject | None) -> str | None:
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
    return f"/public/multi-apartment/projects/{project.code}/pdf"


def _get_or_create_settings(db: Session) -> MultiApartmentSettings:
    """Return existing multi-apartment settings or create with defaults."""
    settings = db.scalar(select(MultiApartmentSettings).limit(1))
    if settings:
        return settings

    settings = MultiApartmentSettings(duration_minutes=60)
    db.add(settings)
    db.commit()
    db.refresh(settings)
    return settings


@router.get("/public/multi-apartment/settings", response_model=MultiApartmentPublicSettingsResponse)
def get_public_multi_apartment_settings(
    db: Session = Depends(get_db),
):
    """
    Public endpoint exposing only the evaluation duration (in minutes)
    for the multi-apartment project evaluation. Does NOT expose gate password.
    """
    settings = _get_or_create_settings(db)
    return settings


@router.post(
    "/public/multi-apartment/gate/verify",
    response_model=MultiApartmentGateVerifyResponse,
)
def verify_multi_apartment_gate(
    payload: MultiApartmentGateVerifyRequest,
    db: Session = Depends(get_db),
):
    """
    Verify admin gate password for the public multi-apartment evaluation screen.

    The password is configured in MultiApartmentSettings.gate_password from
    the admin interface. We never expose the password itself; only whether
    the provided value matches.
    """
    settings = _get_or_create_settings(db)
    expected = (settings.gate_password or "").strip()
    provided = (payload.password or "").strip()
    valid = bool(expected) and provided == expected
    return MultiApartmentGateVerifyResponse(valid=valid)


# Admin endpoints
@router.get("/admin/multi-apartment/settings", response_model=MultiApartmentSettingsResponse)
def get_multi_apartment_settings(
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    settings = _get_or_create_settings(db)
    return settings


@router.put("/admin/multi-apartment/settings", response_model=MultiApartmentSettingsResponse)
def update_multi_apartment_settings(
    payload: MultiApartmentSettingsUpdateRequest,
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


@router.get("/admin/multi-apartment/projects", response_model=MultiApartmentProjectsResponse)
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
        select(MultiApartmentProject)
        .order_by(MultiApartmentProject.order_index, MultiApartmentProject.id)
    ).all()
    
    payloads = []
    for project in projects:
        answers = sorted(project.answers, key=lambda a: (a.order_index, a.id))
        # Collect all correct answers; legacy clients still see the first one
        # via correctAnswerId for backwards compatibility.
        correct_answer_ids = [str(a.id) for a in answers if a.is_correct]
        first_correct_id = correct_answer_ids[0] if correct_answer_ids else None
        
        payloads.append(
            MultiApartmentProjectPayload(
                id=str(project.id),
                number=project.number,
                code=project.code,
                pdfFile=project.pdf_filename,
                answers=[
                    MultiApartmentAnswerPayload(id=str(a.id), text=a.text)
                    for a in answers
                ],
                correctAnswerId=first_correct_id,
                correctAnswerIds=correct_answer_ids or None,
            )
        )
    
    return MultiApartmentProjectsResponse(projects=payloads)


@router.post("/admin/multi-apartment/projects", response_model=MultiApartmentProjectsResponse)
async def update_projects(
    payload: MultiApartmentProjectsUpdateRequest,
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
        for p in db.scalars(select(MultiApartmentProject)).all()
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
            select(MultiApartmentProject).where(MultiApartmentProject.code == code_candidate)
        )
        if existing_with_code and (project_id_int is None or existing_with_code.id != project_id_int):
            code_candidate = _gen_unique_code(db)
        
        if project_id_int and str(project_id_int) in existing_projects:
            project = existing_projects[str(project_id_int)]
        else:
            project = MultiApartmentProject()
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
                answer = MultiApartmentAnswer(project_id=project.id)
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
                    .select_from(MultiApartmentSubmission)
                    .where(MultiApartmentSubmission.selected_answer_id == answer.id)
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
            db.query(MultiApartmentSubmission).filter(
                MultiApartmentSubmission.project_id == project.id
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


@router.delete("/admin/multi-apartment/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(
    project_id: int = FPath(...),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    project = db.get(MultiApartmentProject, project_id)
    if not project:
        return
    
    # Delete all submissions for this project first
    db.query(MultiApartmentSubmission).filter(
        MultiApartmentSubmission.project_id == project.id
    ).delete()
    
    # Delete PDF file if path is stored
    if project.pdf_path:
        try:
            delete_storage_file(project.pdf_path)
        except Exception:
            # Best-effort: continue even if file deletion fails
            pass
    
    # Also delete entire project directory and all its contents
    # This ensures cleanup even if pdf_path was not stored correctly
    try:
        from ..services.media_storage import ensure_media_root
        media_root = ensure_media_root()
        project_dir = media_root / "multi_apartment" / str(project_id)
        if project_dir.exists() and project_dir.is_dir():
            # Delete all files in the directory
            for file_path in project_dir.iterdir():
                try:
                    if file_path.is_file():
                        file_path.unlink()
                    elif file_path.is_dir():
                        # Recursively delete subdirectories
                        import shutil
                        shutil.rmtree(file_path)
                except OSError:
                    # Best-effort: continue if file deletion fails
                    pass
            # Try to remove the directory if it's now empty
            try:
                project_dir.rmdir()
            except OSError:
                # Directory not empty or other error, that's okay
                pass
    except Exception:
        # Best-effort: continue even if directory deletion fails
        pass
    
    db.delete(project)
    db.commit()
    return


@router.post("/admin/multi-apartment/projects/{project_id}/pdf")
async def upload_pdf(
    project_id: int = FPath(...),
    file: UploadFile = File(...),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    project = db.get(MultiApartmentProject, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    
    if file.content_type != "application/pdf":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only PDF files allowed")
    
    filename = file.filename or "project.pdf"
    pdf_path = multi_apartment_pdf_path(project.id, filename)
    
    with open(pdf_path, "wb") as f:
        content = await file.read()
        f.write(content)
    
    project.pdf_path = relative_storage_path(pdf_path)
    project.pdf_filename = filename
    db.add(project)
    db.commit()
    
    return {"message": "PDF uploaded successfully"}


@router.get("/admin/multi-apartment/projects/{project_id}/pdf")
def download_pdf(
    project_id: int = FPath(...),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    project = db.get(MultiApartmentProject, project_id)
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


@router.delete("/admin/multi-apartment/projects/{project_id}/pdf", status_code=status.HTTP_204_NO_CONTENT)
def delete_project_pdf(
    project_id: int = FPath(...),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """Delete project's PDF and clear its path/filename."""
    _require_admin(db, authorization)
    project = db.get(MultiApartmentProject, project_id)
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
@router.get("/public/multi-apartment/projects/random", response_model=PublicMultiApartmentProjectResponse)
def get_random_project(
    db: Session = Depends(get_db),
):
    """Get a random multi-apartment project."""
    # Load all projects (with answers eagerly loaded)
    projects = db.scalars(
        select(MultiApartmentProject).options(selectinload(MultiApartmentProject.answers))
    ).all()

    if not projects:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No projects configured"
        )

    # Prefer projects that actually have answers; if none have answers,
    # fall back to any existing project so that at least the PDF/code are shown.
    projects_with_answers = [p for p in projects if p.answers]
    project = random.choice(projects_with_answers or projects)

    answers = sorted(project.answers, key=lambda a: (a.order_index, a.id))
    pdf_url = _safe_public_pdf_url(project)

    return PublicMultiApartmentProjectResponse(
        id=project.id,
        number=project.number,
        code=project.code,
        pdfUrl=pdf_url,
        answers=[
            MultiApartmentAnswerPayload(id=str(a.id), text=a.text)
            for a in answers
        ],
    )


@router.get("/public/multi-apartment/projects/{code}", response_model=PublicMultiApartmentProjectResponse)
def get_public_project(
    code: str = FPath(...),
    db: Session = Depends(get_db),
):
    project = db.scalar(
        select(MultiApartmentProject).where(MultiApartmentProject.code == code.strip())
    )
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    
    answers = sorted(project.answers, key=lambda a: (a.order_index, a.id))
    pdf_url = _safe_public_pdf_url(project)
    
    return PublicMultiApartmentProjectResponse(
        id=project.id,
        number=project.number,
        code=project.code,
        pdfUrl=pdf_url,
        answers=[
            MultiApartmentAnswerPayload(id=str(a.id), text=a.text)
            for a in answers
        ],
    )


@router.get("/public/multi-apartment/projects/{code}/pdf")
def get_public_pdf(
    code: str = FPath(...),
    db: Session = Depends(get_db),
):
    project = db.scalar(
        select(MultiApartmentProject).where(MultiApartmentProject.code == code.strip())
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
    # შემთხვევაში ვაბრუნებთ 404-ს, რომ მომხმარებელმა დაინახოს „PDF არ არის ხელმისაწვდომი“
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


@router.post("/public/multi-apartment/evaluations", status_code=status.HTTP_201_CREATED)
def submit_evaluation(
    payload: MultiApartmentEvaluationSubmitRequest,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    # Get user
    user = _require_auth(db, authorization)
    
    # Get project
    project = db.scalar(
        select(MultiApartmentProject).where(MultiApartmentProject.code == payload.projectCode.strip())
    )
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    
    # Verify answer exists and belongs to project
    answer = db.scalar(
        select(MultiApartmentAnswer)
        .where(
            MultiApartmentAnswer.id == payload.selectedAnswerId,
            MultiApartmentAnswer.project_id == project.id,
        )
    )
    if not answer:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid answer")
    
    # Check if already submitted
    existing = db.scalar(
        select(MultiApartmentSubmission)
        .where(
            MultiApartmentSubmission.project_id == project.id,
            MultiApartmentSubmission.user_id == user.id,
        )
    )
    
    if existing:
        existing.selected_answer_id = answer.id
        db.add(existing)
    else:
        submission = MultiApartmentSubmission(
            project_id=project.id,
            user_id=user.id,
            selected_answer_id=answer.id,
        )
        db.add(submission)
    
    db.commit()
    return {"message": "Evaluation submitted successfully"}

