from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, Header, HTTPException, status, UploadFile, File, Query, Path as FPath
from fastapi.responses import FileResponse
from sqlalchemy import select, func
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import GuideVideo
from ..schemas import GuideVideoOut, GuideVideosReorderRequest
from ..services.media_storage import ensure_media_root, resolve_storage_path, delete_storage_file, relative_storage_path
from ..routers.admin import _require_admin


router = APIRouter()


def _guide_video_out(video: GuideVideo) -> GuideVideoOut:
  return GuideVideoOut(
      id=video.id,
      filename=video.filename,
      mime_type=video.mime_type,
      size_bytes=video.size_bytes,
      order_index=video.order_index or 0,
      created_at=video.created_at,
      url=f"/guide/videos/{video.id}/file",
  )


def _ensure_guide_dir():
  root = ensure_media_root()
  guide_dir = root / "guide"
  guide_dir.mkdir(parents=True, exist_ok=True)
  return guide_dir


MAX_GUIDE_VIDEO_BYTES = 1024 * 1024 * 1024  # 1GB
ALLOWED_VIDEO_EXTS = {".mp4", ".webm", ".mov", ".mkv", ".avi"}


def _validate_video_file(upload: UploadFile | None) -> None:
  import os

  if not upload:
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="file is required")

  ext = os.path.splitext(upload.filename or "")[1].lower()
  if ext not in ALLOWED_VIDEO_EXTS:
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="video type not allowed")

  try:
    upload.file.seek(0, os.SEEK_END)
    size = upload.file.tell()
    upload.file.seek(0)
    if size and size > MAX_GUIDE_VIDEO_BYTES:
      raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="file too large")
  except Exception:
    # If size probing fails, we still rely on upstream limits
    pass


async def _save_video_file(upload: UploadFile) -> tuple[str, str, str, int | None]:
  """
  Persist uploaded video under media/guide and return:
  (relative_storage_path, stored_filename, mime_type, size_bytes)
  """
  import os

  guide_dir = _ensure_guide_dir()
  original_name = os.path.basename(upload.filename or "video")
  if not original_name:
    original_name = "video"

  base, ext = os.path.splitext(original_name)
  if not ext:
    ext = ".mp4"

  candidate = guide_dir / (base + ext)
  suffix = 1
  while candidate.exists() and suffix < 1000:
    candidate = guide_dir / f"{base}_{suffix}{ext}"
    suffix += 1

  size = 0
  with open(candidate, "wb") as out:
    while True:
      chunk = await upload.read(1024 * 1024)
      if not chunk:
        break
      out.write(chunk)
      size += len(chunk)

  rel_path = relative_storage_path(candidate)
  mime_type = upload.content_type or "video/mp4"
  return rel_path, os.path.basename(candidate), mime_type, size or None


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
async def admin_create_guide_video(
    file: UploadFile = File(...),
    x_actor_email: str | None = Header(None, alias="x-actor-email"),
    db: Session = Depends(get_db),
):
  _require_admin(db, x_actor_email)
  _validate_video_file(file)

  max_order = db.scalar(select(func.max(GuideVideo.order_index))) or 0
  storage_path, stored_filename, mime_type, size_bytes = await _save_video_file(file)

  video = GuideVideo(
      order_index=int(max_order) + 1,
      storage_path=storage_path,
      filename=stored_filename,
      mime_type=mime_type,
      size_bytes=size_bytes,
  )
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

  if video.storage_path:
    try:
      delete_storage_file(video.storage_path)
    except Exception:
      # Best-effort: ignore filesystem errors
      pass

  db.delete(video)
  db.commit()
  return


# ----------------- Public endpoints -----------------


@router.get("/guide/videos", response_model=List[GuideVideoOut])
def public_list_guide_videos(db: Session = Depends(get_db)):
  videos = db.scalars(select(GuideVideo).order_by(GuideVideo.order_index.asc(), GuideVideo.id.asc())).all()
  return [_guide_video_out(v) for v in videos]


@router.get("/guide/videos/{video_id}/file")
def public_guide_video_file(
    video_id: int = FPath(..., ge=1),
    db: Session = Depends(get_db),
):
  video = db.get(GuideVideo, video_id)
  if not video or not video.storage_path:
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Video not found")

  try:
    path = resolve_storage_path(video.storage_path)
  except ValueError as exc:
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Video not found") from exc

  if not path.exists() or not path.is_file():
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Video file missing")

  try:
    return FileResponse(
        path,
        media_type=video.mime_type or "video/mp4",
        filename=video.filename or path.name,
    )
  except Exception as exc:  # pragma: no cover - safety net
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Video not found") from exc


