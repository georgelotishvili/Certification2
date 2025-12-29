from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, Header, HTTPException, status, Path as FPath
from sqlalchemy import select, func
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import GuideVideo
from ..schemas import GuideVideoOut, GuideVideoCreate, GuideVideoUpdate, GuideVideosReorderRequest
from ..routers.admin import _require_admin


router = APIRouter()


def _guide_video_out(video: GuideVideo) -> GuideVideoOut:
    return GuideVideoOut(
        id=video.id,
        title=video.title or "",
        url=video.url or "",
        order_index=video.order_index or 0,
        created_at=video.created_at,
    )


# ----------------- Admin endpoints -----------------


@router.get("/admin/guide/videos", response_model=List[GuideVideoOut])
def admin_list_guide_videos(
    x_actor_email: str | None = Header(None, alias="x-actor-email"),
    db: Session = Depends(get_db),
):
    _require_admin(db, x_actor_email)
    videos = db.scalars(select(GuideVideo).order_by(GuideVideo.order_index.asc(), GuideVideo.id.asc())).all()
    return [_guide_video_out(v) for v in videos]


@router.post("/admin/guide/videos", response_model=GuideVideoOut, status_code=status.HTTP_201_CREATED)
def admin_create_guide_video(
    payload: GuideVideoCreate,
    x_actor_email: str | None = Header(None, alias="x-actor-email"),
    db: Session = Depends(get_db),
):
    _require_admin(db, x_actor_email)

    max_order = db.scalar(select(func.max(GuideVideo.order_index))) or 0

    video = GuideVideo(
        order_index=int(max_order) + 1,
        title=payload.title.strip() if payload.title else "",
        url=payload.url.strip() if payload.url else "",
    )
    db.add(video)
    db.commit()
    db.refresh(video)

    return _guide_video_out(video)


@router.put("/admin/guide/videos/{video_id}", response_model=GuideVideoOut)
def admin_update_guide_video(
    payload: GuideVideoUpdate,
    video_id: int = FPath(..., ge=1),
    x_actor_email: str | None = Header(None, alias="x-actor-email"),
    db: Session = Depends(get_db),
):
    _require_admin(db, x_actor_email)
    video = db.get(GuideVideo, video_id)
    if not video:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Video not found")

    if payload.title is not None:
        video.title = payload.title.strip()
    if payload.url is not None:
        if not payload.url.strip():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="URL cannot be empty")
        video.url = payload.url.strip()

    db.add(video)
    db.commit()
    db.refresh(video)

    return _guide_video_out(video)


@router.post("/admin/guide/videos/reorder", status_code=status.HTTP_204_NO_CONTENT)
def admin_reorder_guide_videos(
    payload: GuideVideosReorderRequest,
    x_actor_email: str | None = Header(None, alias="x-actor-email"),
    db: Session = Depends(get_db),
):
    _require_admin(db, x_actor_email)
    ids = [int(v) for v in (payload.ids or []) if isinstance(v, int) or (isinstance(v, str) and v.isdigit())]
    if not ids:
        return

    # Load existing videos into a map for quick lookup
    videos = db.scalars(select(GuideVideo).where(GuideVideo.id.in_(ids))).all()
    by_id = {v.id: v for v in videos}

    order = 1
    for raw_id in ids:
        vid = by_id.get(int(raw_id))
        if not vid:
            continue
        vid.order_index = order
        db.add(vid)
        order += 1

    db.commit()
    return


@router.delete("/admin/guide/videos/{video_id}", status_code=status.HTTP_204_NO_CONTENT)
def admin_delete_guide_video(
    video_id: int = FPath(..., ge=1),
    x_actor_email: str | None = Header(None, alias="x-actor-email"),
    db: Session = Depends(get_db),
):
    _require_admin(db, x_actor_email)
    video = db.get(GuideVideo, video_id)
    if not video:
        return

    db.delete(video)
    db.commit()
    return


# ----------------- Public endpoints -----------------


@router.get("/guide/videos", response_model=List[GuideVideoOut])
def public_list_guide_videos(db: Session = Depends(get_db)):
    videos = db.scalars(select(GuideVideo).order_by(GuideVideo.order_index.asc(), GuideVideo.id.asc())).all()
    return [_guide_video_out(v) for v in videos]
