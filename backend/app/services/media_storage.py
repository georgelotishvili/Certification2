from __future__ import annotations

from pathlib import Path
from typing import Optional, Protocol
import unicodedata
from uuid import uuid4

from ..config import get_settings
from .bounded_upload import DEFAULT_UPLOAD_MAX_BYTES

_MEDIA_ROOT_CACHE: Optional[Path] = None

PDF_MAGIC = b'%PDF-'
PDF_UPLOAD_MAX_BYTES = DEFAULT_UPLOAD_MAX_BYTES
PDF_UPLOAD_CHUNK_BYTES = 1024 * 1024


class _AsyncReadable(Protocol):
    async def read(self, size: int = -1) -> bytes: ...


class InvalidPdfUpload(ValueError):
    '''Raised when an uploaded file does not have a PDF signature.'''


class PdfUploadTooLarge(ValueError):
    '''Raised when an uploaded PDF exceeds the configured size limit.'''


def _contained_path(path: Path, parent: Path) -> Path:
    '''Resolve path and require it to remain under the resolved parent.'''
    resolved_parent = parent.resolve()
    resolved_path = path.resolve()
    try:
        resolved_path.relative_to(resolved_parent)
    except ValueError as exc:
        raise ValueError('Invalid media storage path') from exc
    return resolved_path


def _compute_root() -> Path:
    settings = get_settings()
    candidate = settings.media_root or "media"
    path = Path(candidate)
    if not path.is_absolute():
        path = Path(__file__).resolve().parent.parent / path
    return path


def ensure_media_root() -> Path:
    """Create and return the absolute media root directory."""
    global _MEDIA_ROOT_CACHE
    if _MEDIA_ROOT_CACHE is None:
        _MEDIA_ROOT_CACHE = _compute_root()
    _MEDIA_ROOT_CACHE.mkdir(parents=True, exist_ok=True)
    return _MEDIA_ROOT_CACHE


def ensure_session_dir(session_id: int) -> Path:
    """Ensure and return the directory for a specific exam session."""
    root = ensure_media_root()
    session_dir = root / f"session_{session_id}"
    session_dir.mkdir(parents=True, exist_ok=True)
    return session_dir


def ensure_file_path(session_id: int, filename: str) -> Path:
    """Return an absolute path for storing the final media file."""
    safe_name = filename or f"session_{session_id}.webm"
    return ensure_session_dir(session_id) / safe_name


def write_chunk(session_id: int, filename: str, data: bytes, reset: bool = False) -> Path:
    """Write a chunk to disk, overwriting when reset=True."""
    destination = ensure_file_path(session_id, filename)
    mode = "wb" if reset else "ab"
    with open(destination, mode) as handler:
        handler.write(data)
    return destination


def relative_storage_path(path: Path) -> str:
    """Return a path relative to the media root for persistence."""
    root = ensure_media_root()
    return str(path.resolve().relative_to(root.resolve()))


def resolve_storage_path(storage_path: str) -> Path:
    """Convert a stored relative path back to an absolute path under the media root."""
    root = ensure_media_root().resolve()
    return _contained_path(root / storage_path, root)


def delete_storage_file(storage_path: str, *, remove_empty_parents: bool = True, max_depth: int = 5) -> None:
    """
    Delete a stored file (by its relative storage path) and optionally
    clean up any now-empty parent directories up to the media root.

    All filesystem errors are swallowed – this helper is best-effort only.
    """
    try:
        path = resolve_storage_path(storage_path)
    except ValueError:
        # Invalid/legacy path – nothing to do
        return

    try:
        if path.exists():
            path.unlink()
    except OSError:
        # If we couldn't delete the file, don't attempt to remove parents
        return

    if not remove_empty_parents:
        return

    root = ensure_media_root().resolve()
    current = path.parent.resolve()
    depth = 0

    # Walk upwards, removing empty directories, but never beyond media root
    while current != root and depth < max_depth:
        try:
            current.rmdir()
        except OSError:
            # Directory not empty or other OS error – stop trying higher
            break
        current = current.parent.resolve()
        depth += 1


def _delete_replaced_project_pdf(
    storage_path: str | None,
    expected_project_dir: Path,
) -> bool:
    """Delete only a direct child of the exact expected project directory."""
    if not storage_path:
        return False

    media_root = ensure_media_root().resolve()
    try:
        safe_project_dir = _contained_path(expected_project_dir, media_root)
        target = resolve_storage_path(storage_path)
    except ValueError:
        return False

    if target.parent != safe_project_dir:
        return False

    try:
        target.unlink()
    except OSError:
        return False
    return True


def delete_replaced_multi_apartment_pdf(
    project_id: int,
    storage_path: str | None,
) -> bool:
    """Delete a replaced PDF only from its multi-apartment project directory."""
    expected_dir = ensure_media_root() / "multi_apartment" / str(project_id)
    return _delete_replaced_project_pdf(storage_path, expected_dir)


def delete_replaced_multi_functional_pdf(
    project_id: int,
    storage_path: str | None,
) -> bool:
    """Delete a replaced PDF only from its multi-functional project directory."""
    expected_dir = ensure_media_root() / "multi_functional" / str(project_id)
    return _delete_replaced_project_pdf(storage_path, expected_dir)


def ensure_certificate_dir(user_id: int) -> Path:
    """Ensure and return the directory for a specific user's certificate files."""
    root = ensure_media_root()
    cert_dir = root / "certificates" / str(user_id)
    cert_dir.mkdir(parents=True, exist_ok=True)
    return cert_dir


def certificate_file_path(user_id: int, filename: str = "certificate.pdf") -> Path:
    """Return an absolute path for storing the user's certificate PDF."""
    safe_name = filename or "certificate.pdf"
    return ensure_certificate_dir(user_id) / safe_name


def ensure_statement_dir(user_id: int, statement_id: int) -> Path:
    """Ensure and return the directory for a specific user's statement attachments."""
    root = ensure_media_root()
    d = root / "statements" / str(user_id) / str(statement_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


def ensure_multi_apartment_dir(project_id: int) -> Path:
    """Ensure and return the directory for a specific multi-apartment project."""
    root = ensure_media_root()
    project_dir = root / "multi_apartment" / str(project_id)
    project_dir.mkdir(parents=True, exist_ok=True)
    return project_dir


def _generated_project_pdf_path(project_dir: Path) -> Path:
    """Return a server-named PDF path, contained under project and media roots."""
    media_root = ensure_media_root().resolve()
    safe_project_dir = _contained_path(project_dir, media_root)
    destination = _contained_path(
        safe_project_dir / f"{uuid4().hex}.pdf",
        safe_project_dir,
    )
    return _contained_path(destination, media_root)


def multi_apartment_pdf_path(
    project_id: int,
    filename: str | None = None,
) -> Path:
    """Return a server-generated path; the legacy filename argument is ignored."""
    return _generated_project_pdf_path(ensure_multi_apartment_dir(project_id))


def ensure_multi_functional_dir(project_id: int) -> Path:
    """Ensure and return the directory for a specific multi-functional project."""
    root = ensure_media_root()
    project_dir = root / "multi_functional" / str(project_id)
    project_dir.mkdir(parents=True, exist_ok=True)
    return project_dir


def multi_functional_pdf_path(
    project_id: int,
    filename: str | None = None,
) -> Path:
    """Return a server-generated path; the legacy filename argument is ignored."""
    return _generated_project_pdf_path(ensure_multi_functional_dir(project_id))


def safe_pdf_display_filename(filename: str | None) -> str:
    """Preserve a display name while removing path and header-control content."""
    candidate = (filename or "").replace("\\", "/").rsplit("/", 1)[-1]
    candidate = "".join(
        character
        for character in candidate
        if not unicodedata.category(character).startswith("C")
    ).strip()
    if candidate in {"", ".", ".."}:
        return "project.pdf"

    if len(candidate) > 255:
        suffix = ".pdf" if candidate.lower().endswith(".pdf") else ""
        candidate = candidate[: 255 - len(suffix)].rstrip() + suffix
    return candidate or "project.pdf"


async def save_pdf_upload(
    upload: _AsyncReadable,
    destination: Path,
    *,
    max_bytes: int = PDF_UPLOAD_MAX_BYTES,
    chunk_bytes: int = PDF_UPLOAD_CHUNK_BYTES,
) -> int:
    """Validate and stream a PDF to a pre-generated contained destination."""
    media_root = ensure_media_root().resolve()
    safe_destination = _contained_path(destination, media_root)

    header = await upload.read(len(PDF_MAGIC))
    if header != PDF_MAGIC:
        raise InvalidPdfUpload("Only PDF files allowed")

    total = len(header)
    if total > max_bytes:
        raise PdfUploadTooLarge("file too large (max 100MB)")

    try:
        # UUID4 naming plus exclusive creation prevents accidental overwrites.
        with open(safe_destination, "xb") as handler:
            handler.write(header)
            while True:
                chunk = await upload.read(chunk_bytes)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise PdfUploadTooLarge("file too large (max 100MB)")
                handler.write(chunk)
    except BaseException:
        try:
            safe_destination.unlink(missing_ok=True)
        except OSError:
            pass
        raise

    return total


