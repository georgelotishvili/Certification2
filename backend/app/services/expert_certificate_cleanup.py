from __future__ import annotations

from pathlib import Path

from .media_storage import ensure_media_root


def delete_expert_certificate_files(unique_code: str | None) -> bool:
    """Best-effort cleanup for one direct ``media/expert`` code directory.

    Certificate codes are persisted data and must be treated as untrusted during
    deletion. Invalid, nested, absolute, or symlinked targets are ignored so a
    legacy value never interrupts the surrounding database operation.
    """
    if not isinstance(unique_code, str):
        return False

    code = unique_code.strip()
    if not code.startswith("EX-") or "/" in code or "\\" in code:
        return False

    code_path = Path(code)
    if code_path.is_absolute() or code_path.parts != (code,) or code_path.name != code:
        return False

    try:
        media_root = ensure_media_root().resolve()
        configured_expert_root = media_root / "expert"
        if configured_expert_root.is_symlink():
            return False
        expert_root = configured_expert_root.resolve()
        if expert_root != configured_expert_root or expert_root.parent != media_root:
            return False

        candidate = expert_root / code
        # The code must name its own real directory, never an alias to another
        # directory inside or outside media/expert.
        if candidate.is_symlink():
            return False

        expert_dir = candidate.resolve()
        if expert_dir != candidate or expert_dir.parent != expert_root:
            return False
        if not expert_dir.exists() or not expert_dir.is_dir():
            return False
    except (OSError, RuntimeError, ValueError):
        return False

    try:
        for pdf_file in expert_dir.glob("certificate*.pdf"):
            try:
                # Unlinking a file symlink removes the link itself, never its target.
                if pdf_file.is_file() or pdf_file.is_symlink():
                    pdf_file.unlink()
            except OSError:
                pass
    except (OSError, RuntimeError):
        # Directory enumeration is best-effort and must never block DB cleanup.
        pass

    try:
        if not any(expert_dir.iterdir()):
            expert_dir.rmdir()
        else:
            # Preserve the existing cleanup of immediate empty subdirectories,
            # without following directory symlinks.
            for item in expert_dir.iterdir():
                if item.is_dir() and not item.is_symlink():
                    try:
                        if not any(item.iterdir()):
                            item.rmdir()
                    except OSError:
                        pass
            try:
                if not any(expert_dir.iterdir()):
                    expert_dir.rmdir()
            except OSError:
                pass
    except OSError:
        pass

    return True
