from __future__ import annotations

from typing import List
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status, Header, Path
from sqlalchemy import select, func
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import User, Certificate, Rating, Comment, UserSession
from ..schemas import ReviewRatingCreate, ReviewCommentCreate, ReviewCommentOut, ReviewsSummaryOut, ReviewCriteria


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


def _ensure_target_certified(db: Session, user_id: int) -> User:
    target = db.scalar(select(User).where(User.id == user_id))
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    cert = db.scalar(select(Certificate).where(Certificate.user_id == user_id))
    if not cert:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="User is not certified")
    return target


@router.get("/{user_id}/summary", response_model=ReviewsSummaryOut)
def reviews_summary(
    user_id: int = Path(..., ge=1),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    # Actor is optional; present only for actor-specific score
    actor = None
    if authorization:
        try:
            actor = _require_auth(db, authorization)
        except HTTPException:
            actor = None

    # Average across five criteria
    avg_expr = (
        (func.coalesce(Rating.integrity, 0)
         + func.coalesce(Rating.responsibility, 0)
         + func.coalesce(Rating.knowledge_experience, 0)
         + func.coalesce(Rating.professional_skills, 0)
         + func.coalesce(Rating.price_quality, 0)) / 5.0
    )
    avg_score = db.scalar(select(func.avg(avg_expr)).where(Rating.target_user_id == user_id)) or 0.0
    count = db.scalar(select(func.count(Rating.id)).where(Rating.target_user_id == user_id)) or 0

    # Actor's own criteria/score
    actor_row = None
    if actor is not None:
        actor_row = db.execute(
            select(
                Rating.integrity,
                Rating.responsibility,
                Rating.knowledge_experience,
                Rating.professional_skills,
                Rating.price_quality,
            )
            .where(Rating.target_user_id == user_id, Rating.author_user_id == actor.id)
        ).first()
    actor_criteria = None
    actor_score = None
    if actor_row:
        a, b, c, d, e = [float(x or 0.0) for x in actor_row]
        actor_criteria = ReviewCriteria(
            integrity=round(a, 2),
            responsibility=round(b, 2),
            knowledge_experience=round(c, 2),
            professional_skills=round(d, 2),
            price_quality=round(e, 2),
        )
        actor_score = round((a + b + c + d + e) / 5.0, 2)

    # Comments (chronological)
    rows = db.execute(
        select(
            Comment.id,
            Comment.target_user_id,
            Comment.author_user_id,
            Comment.message,
            Comment.created_at,
            User.first_name,
            User.last_name,
        )
        .join(User, User.id == Comment.author_user_id)
        .where(Comment.target_user_id == user_id)
        .order_by(Comment.created_at.asc(), Comment.id.asc())
    ).all()
    comments: List[ReviewCommentOut] = [
        ReviewCommentOut(
            id=row.id,
            target_user_id=row.target_user_id,
            author_user_id=row.author_user_id,
            author_first_name=row.first_name,
            author_last_name=row.last_name,
            message=row.message,
            created_at=row.created_at,
        )
        for row in rows
    ]

    return ReviewsSummaryOut(
        target_user_id=user_id,
        average=float(round(avg_score or 0.0, 2)),
        ratings_count=int(count or 0),
        actor_score=float(actor_score) if actor_score is not None else None,
        actor_criteria=actor_criteria,
        comments=comments,
    )


@router.post("/{user_id}/rating", response_model=ReviewsSummaryOut, status_code=status.HTTP_201_CREATED)
def set_rating(
    user_id: int,
    payload: ReviewRatingCreate,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    actor = _require_auth(db, authorization)
    target = _ensure_target_certified(db, user_id)
    if actor.id == target.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="self rating is not allowed")

    # Validate/normalize criteria values
    c = payload.criteria
    try:
        values = [
            round(max(0.0, min(5.0, float(c.integrity))), 2),
            round(max(0.0, min(5.0, float(c.responsibility))), 2),
            round(max(0.0, min(5.0, float(c.knowledge_experience))), 2),
            round(max(0.0, min(5.0, float(c.professional_skills))), 2),
            round(max(0.0, min(5.0, float(c.price_quality))), 2),
        ]
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid criteria values")

    average = round(sum(values) / 5.0, 2)

    # Upsert rating (one per actor-target). Keep legacy int score in sync (0..10).
    existing = db.scalar(
        select(Rating).where(
            Rating.target_user_id == user_id,
            Rating.author_user_id == actor.id,
        )
    )
    if existing:
        existing.integrity, existing.responsibility, existing.knowledge_experience, existing.professional_skills, existing.price_quality = values
        existing.score = int(round(average * 2))
        existing.updated_at = datetime.utcnow()
    else:
        db.add(
            Rating(
                target_user_id=user_id,
                author_user_id=actor.id,
                score=int(round(average * 2)),
                integrity=values[0],
                responsibility=values[1],
                knowledge_experience=values[2],
                professional_skills=values[3],
                price_quality=values[4],
            )
        )
    db.commit()

    return reviews_summary(user_id=user_id, authorization=authorization, db=db)


@router.post("/{user_id}/comments", response_model=ReviewCommentOut, status_code=status.HTTP_201_CREATED)
def add_comment(
    user_id: int,
    payload: ReviewCommentCreate,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    actor = _require_auth(db, authorization)
    _ensure_target_certified(db, user_id)
    message = (payload.message or "").strip()
    if not message:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="empty message")
    comment = Comment(target_user_id=user_id, author_user_id=actor.id, message=message)
    db.add(comment)
    db.commit()
    db.refresh(comment)

    return ReviewCommentOut(
        id=comment.id,
        target_user_id=comment.target_user_id,
        author_user_id=comment.author_user_id,
        author_first_name=actor.first_name,
        author_last_name=actor.last_name,
        message=comment.message,
        created_at=comment.created_at,
    )


@router.delete("/{user_id}/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_comment(
    user_id: int,
    comment_id: int,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """Delete a comment. Allowed to the author or any admin."""
    actor = _require_auth(db, authorization)
    # Ensure target exists and is certified (optional for safety)
    _ensure_target_certified(db, user_id)

    c = db.scalar(select(Comment).where(Comment.id == comment_id, Comment.target_user_id == user_id))
    if not c:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="comment not found")

    if actor.id != c.author_user_id and not bool(actor.is_admin):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="forbidden")

    db.delete(c)
    db.commit()
    return None
