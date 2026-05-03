from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import delete, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from ..database import get_db
from ..models import Answer, Block, Option, Question, TaxonomyChapter, TaxonomySubchapter, User
from ..schemas import (
    TaxonomyChapterCreate,
    TaxonomyChapterOut,
    TaxonomyChapterUpdate,
    TaxonomySubchapterCreate,
    TaxonomySubchapterOut,
    TaxonomySubchapterUpdate,
)
from ..security import require_admin


router = APIRouter()


def _clean_name(value: str | None) -> str:
    name = (value or "").strip()
    if not name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Name is required")
    return name


def _commit_or_conflict(db: Session) -> None:
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Duplicate taxonomy item")


def _get_chapter(db: Session, chapter_id: int) -> TaxonomyChapter:
    chapter = db.get(TaxonomyChapter, chapter_id)
    if not chapter:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chapter not found")
    return chapter


def _get_subchapter(db: Session, subchapter_id: int) -> TaxonomySubchapter:
    subchapter = db.get(TaxonomySubchapter, subchapter_id)
    if not subchapter:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Subchapter not found")
    return subchapter


def _delete_blocks_deep(db: Session, block_ids: list[int]) -> None:
    if not block_ids:
        return
    question_ids = db.scalars(select(Question.id).where(Question.block_id.in_(block_ids))).all()
    if question_ids:
        db.execute(delete(Answer).where(Answer.question_id.in_(question_ids)))
        db.execute(delete(Option).where(Option.question_id.in_(question_ids)))
        db.execute(delete(Question).where(Question.id.in_(question_ids)))
    db.execute(delete(Block).where(Block.id.in_(block_ids)))


@router.get("/chapters", response_model=list[TaxonomyChapterOut])
def list_chapters(db: Session = Depends(get_db)):
    stmt = (
        select(TaxonomyChapter)
        .options(selectinload(TaxonomyChapter.subchapters))
        .order_by(TaxonomyChapter.order_index.asc(), TaxonomyChapter.id.asc())
    )
    return db.scalars(stmt).all()


@router.post("/chapters", response_model=TaxonomyChapterOut, status_code=status.HTTP_201_CREATED)
def create_chapter(
    payload: TaxonomyChapterCreate,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    chapter = TaxonomyChapter(
        name=_clean_name(payload.name),
        order_index=payload.order_index or 0,
    )
    db.add(chapter)
    _commit_or_conflict(db)
    db.refresh(chapter)
    return chapter


@router.put("/chapters/{chapter_id}", response_model=TaxonomyChapterOut)
def update_chapter(
    chapter_id: int,
    payload: TaxonomyChapterUpdate,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    chapter = _get_chapter(db, chapter_id)
    if payload.name is not None:
        chapter.name = _clean_name(payload.name)
    if payload.order_index is not None:
        chapter.order_index = payload.order_index
    _commit_or_conflict(db)
    db.refresh(chapter)
    return chapter


@router.delete("/chapters/{chapter_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_chapter(
    chapter_id: int,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    chapter = _get_chapter(db, chapter_id)
    subchapter_ids = db.scalars(
        select(TaxonomySubchapter.id).where(TaxonomySubchapter.chapter_id == chapter_id)
    ).all()
    block_filter = Block.chapter_id == chapter_id
    if subchapter_ids:
        block_filter = or_(block_filter, Block.subchapter_id.in_(subchapter_ids))
    block_ids = db.scalars(select(Block.id).where(block_filter)).all()
    _delete_blocks_deep(db, block_ids)
    db.delete(chapter)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/subchapters", response_model=list[TaxonomySubchapterOut])
def list_subchapters(
    chapter_id: int | None = Query(None),
    db: Session = Depends(get_db),
):
    stmt = select(TaxonomySubchapter).order_by(
        TaxonomySubchapter.order_index.asc(),
        TaxonomySubchapter.id.asc(),
    )
    if chapter_id is not None:
        stmt = stmt.where(TaxonomySubchapter.chapter_id == chapter_id)
    return db.scalars(stmt).all()


@router.post("/subchapters", response_model=TaxonomySubchapterOut, status_code=status.HTTP_201_CREATED)
def create_subchapter(
    payload: TaxonomySubchapterCreate,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _get_chapter(db, payload.chapter_id)
    subchapter = TaxonomySubchapter(
        chapter_id=payload.chapter_id,
        name=_clean_name(payload.name),
        order_index=payload.order_index or 0,
    )
    db.add(subchapter)
    _commit_or_conflict(db)
    db.refresh(subchapter)
    return subchapter


@router.put("/subchapters/{subchapter_id}", response_model=TaxonomySubchapterOut)
def update_subchapter(
    subchapter_id: int,
    payload: TaxonomySubchapterUpdate,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    subchapter = _get_subchapter(db, subchapter_id)
    if payload.chapter_id is not None:
        _get_chapter(db, payload.chapter_id)
        subchapter.chapter_id = payload.chapter_id
    if payload.name is not None:
        subchapter.name = _clean_name(payload.name)
    if payload.order_index is not None:
        subchapter.order_index = payload.order_index
    _commit_or_conflict(db)
    db.refresh(subchapter)
    return subchapter


@router.delete("/subchapters/{subchapter_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_subchapter(
    subchapter_id: int,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    subchapter = _get_subchapter(db, subchapter_id)
    block_ids = db.scalars(select(Block.id).where(Block.subchapter_id == subchapter_id)).all()
    _delete_blocks_deep(db, block_ids)
    db.delete(subchapter)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
