from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import ExamSchedule, User
from ..schemas import ExamScheduleCreate, ExamScheduleOut, ExamSchedulesResponse
from .admin import _require_admin


router = APIRouter()


def _require_user(db: Session, user_id: int) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return user


@router.get("/users/{user_id}/exam-schedules", response_model=ExamSchedulesResponse)
def list_exam_schedules(
    user_id: int,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    _require_user(db, user_id)
    entries = db.scalars(
        select(ExamSchedule)
        .where(ExamSchedule.user_id == user_id)
        .order_by(ExamSchedule.exam_date.desc(), ExamSchedule.period.desc(), ExamSchedule.id.desc())
    ).all()
    return ExamSchedulesResponse(items=[ExamScheduleOut.model_validate(entry) for entry in entries])


@router.post(
    "/users/{user_id}/exam-schedules",
    response_model=ExamScheduleOut,
    status_code=status.HTTP_201_CREATED,
)
def create_exam_schedule(
    user_id: int,
    payload: ExamScheduleCreate,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    _require_user(db, user_id)
    entry = ExamSchedule(user_id=user_id, exam_date=payload.exam_date, period=payload.period)
    db.add(entry)
    try:
        # The unique constraint also protects simultaneous requests/retries.
        db.commit()
    except IntegrityError:
        db.rollback()
        _require_user(db, user_id)
        duplicate = db.scalar(select(ExamSchedule.id).where(
            ExamSchedule.user_id == user_id,
            ExamSchedule.exam_date == payload.exam_date,
            ExamSchedule.period == payload.period,
        ))
        if duplicate is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Exam already scheduled for this date and group",
            )
        raise
    db.refresh(entry)
    return ExamScheduleOut.model_validate(entry)


@router.delete(
    "/users/{user_id}/exam-schedules/{schedule_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_exam_schedule(
    user_id: int,
    schedule_id: int,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    _require_admin(db, authorization)
    _require_user(db, user_id)
    entry = db.scalar(select(ExamSchedule).where(
        ExamSchedule.id == schedule_id, ExamSchedule.user_id == user_id,
    ))
    if entry is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Exam schedule not found")
    db.delete(entry)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
