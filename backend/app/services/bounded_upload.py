from __future__ import annotations

from pathlib import Path
from typing import Protocol


MEBIBYTE = 1024 * 1024
DEFAULT_UPLOAD_MAX_BYTES = 100 * MEBIBYTE
APP_RELEASE_UPLOAD_MAX_BYTES = 1024 * MEBIBYTE
UPLOAD_CHUNK_BYTES = MEBIBYTE


class _SyncReadable(Protocol):
    def read(self, size: int = -1) -> bytes: ...


class _AsyncReadable(Protocol):
    async def read(self, size: int = -1) -> bytes: ...


class UploadTooLarge(ValueError):
    """Raised after an upload crosses its configured byte limit."""

    def __init__(self, max_bytes: int):
        self.max_bytes = max_bytes
        super().__init__(f"upload exceeds {max_bytes} bytes")


def _read_size(total: int, max_bytes: int, chunk_bytes: int) -> int:
    if max_bytes < 0:
        raise ValueError("max_bytes must not be negative")
    if chunk_bytes <= 0:
        raise ValueError("chunk_bytes must be positive")
    return min(chunk_bytes, max_bytes - total + 1)


def _remove_partial_file(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def save_upload_stream(
    stream: _SyncReadable,
    destination: Path,
    *,
    max_bytes: int = DEFAULT_UPLOAD_MAX_BYTES,
    chunk_bytes: int = UPLOAD_CHUNK_BYTES,
) -> int:
    """Copy a synchronous stream to a new file with a hard byte limit."""
    total = 0
    created = False
    try:
        with open(destination, "xb") as output:
            created = True
            while True:
                chunk = stream.read(_read_size(total, max_bytes, chunk_bytes))
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise UploadTooLarge(max_bytes)
                output.write(chunk)
    except BaseException:
        if created:
            _remove_partial_file(destination)
        raise
    return total


async def save_async_upload(
    stream: _AsyncReadable,
    destination: Path,
    *,
    max_bytes: int = DEFAULT_UPLOAD_MAX_BYTES,
    chunk_bytes: int = UPLOAD_CHUNK_BYTES,
) -> int:
    """Copy an asynchronous stream to a new file with a hard byte limit."""
    total = 0
    created = False
    try:
        with open(destination, "xb") as output:
            created = True
            while True:
                chunk = await stream.read(_read_size(total, max_bytes, chunk_bytes))
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise UploadTooLarge(max_bytes)
                output.write(chunk)
    except BaseException:
        if created:
            _remove_partial_file(destination)
        raise
    return total
