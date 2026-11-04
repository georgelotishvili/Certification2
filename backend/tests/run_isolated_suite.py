"""Run backend unittests with temporary DB/media and fail-closed I/O guards.

Usage (from the repository):
    python -B backend/tests/run_isolated_suite.py
    python -B backend/tests/run_isolated_suite.py --modules test_exam_schedules test_candidate_status

Results, full tracebacks, warnings and captured stdout are retained in a unique
OS temporary directory printed at completion. No application startup or live
server is invoked. This runner must execute in its own process: its audit hook
cannot be removed.
"""
from __future__ import annotations

import argparse
from collections import Counter
from contextlib import redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import socket
import sys
import tempfile
import threading
import time
import unittest
import warnings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--modules", nargs="*", help="Test module basenames; omitted means every test_*.py")
    options = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    tests = repo / "backend/tests"
    names = options.modules or [p.stem for p in sorted(tests.glob("test_*.py"))]
    names = [name.removeprefix("backend.tests.").removesuffix(".py") for name in names]
    if any(not re.fullmatch(r"test_[a-z0-9_]+", name) or not (tests / f"{name}.py").is_file() for name in names):
        parser.error("--modules must name existing backend test_*.py modules")

    sys.dont_write_bytecode = True
    # On Windows this stdlib probe may invoke `ver`; do it before the test guard,
    # without loading app configuration, so subsequent imports use cached facts.
    platform.uname()
    platform.machine()
    root = Path(tempfile.mkdtemp(prefix="gipc-isolated-suite-")).resolve()
    os.chdir(root)
    tempfile.tempdir = str(root)
    for key in list(os.environ):
        if key.startswith(("SMTP_", "MAIL_")) or key in {"GEMINI_API_KEY", "OPENAI_API_KEY", "SECRET_KEY"}:
            os.environ.pop(key, None)
    os.environ.update(GIPC_DATABASE_PATH=str(root / "unused-default.db"),
                      MEDIA_ROOT=str(root / "media"), EMAIL_MODE="console",
                      SECRET_KEY="synthetic-test-suite-only", PYTHONDONTWRITEBYTECODE="1")
    sys.path.insert(0, str(repo))
    sys.path.insert(1, str(repo / "backend"))
    violations = []
    selfpipe = threading.local()
    original_socketpair = socket.socketpair

    def guarded_socketpair(*args, **kwargs):
        # Windows Python 3.10 implements asyncio's local wakeup pipe with TCP.
        # Permit that exact stdlib call, not general localhost API connections.
        selfpipe.active = True
        try:
            return original_socketpair(*args, **kwargs)
        finally:
            selfpipe.active = False

    socket.socketpair = guarded_socketpair

    def inside(value):
        return isinstance(value, int) or Path(os.fsdecode(value)).resolve().is_relative_to(root)

    def deny(event, detail):
        violations.append({"event": event, "detail": str(detail)})
        raise RuntimeError(f"ISOLATED TEST GUARD BLOCKED {event}: {detail}")

    def guard(event, args):
        if event in {"socket.connect", "socket.bind", "socket.sendto"}:
            address = args[1]
            if (getattr(selfpipe, "active", False) and isinstance(address, tuple)
                    and address[0] in {"127.0.0.1", "::1"}):
                return
            deny(event, address)
        elif event in {"socket.getaddrinfo", "socket.gethostbyname", "subprocess.Popen", "os.system", "os.startfile"}:
            deny(event, "external action forbidden")
        elif event == "sqlite3.connect":
            target = os.fsdecode(args[0])
            if target == ":memory:" or target.startswith("file::memory:"):
                return
            if target.startswith("file:"):
                target = target[5:].split("?", 1)[0]
            if not inside(target):
                deny(event, target)
        elif event == "open":
            path, mode, flags = args
            if isinstance(path, int) or os.fsdecode(path).lower() == os.devnull.lower():
                return
            actual = Path(os.fsdecode(path))
            if actual.name == ".env" and not inside(path):
                deny(event, "real .env access")
            writing = (any(c in (mode or "") for c in "wax+")
                       or flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
            if writing and not inside(path):
                deny(event, path)
        elif event in {"os.remove", "os.rmdir", "os.mkdir", "os.chmod", "os.chown"}:
            if not inside(args[0]):
                deny(event, args[0])
        elif event in {"os.rename", "os.link", "os.symlink"}:
            if not inside(args[0]) or not inside(args[1]):
                deny(event, "path outside temporary root")

    sys.addaudithook(guard)
    from backend.app import config
    config.Settings.model_config["env_file"] = None
    config.get_settings.cache_clear()
    monitored = [*sorted((repo / "backend/app").rglob("*.py")), *sorted(tests.glob("*.py"))]
    hashes = {str(path.relative_to(repo)): hashlib.sha256(path.read_bytes()).hexdigest() for path in monitored}
    captured = io.StringIO()
    start = time.monotonic()
    trace_path = root / "unittest-trace.txt"
    with trace_path.open("w", encoding="utf-8") as trace, warnings.catch_warnings(record=True) as seen, redirect_stdout(captured):
        warnings.simplefilter("always")
        suite = unittest.TestLoader().loadTestsFromNames(["backend.tests." + name for name in names])
        result = unittest.TextTestRunner(stream=trace, verbosity=2).run(suite)
    changed = [name for name, before in hashes.items()
               if hashlib.sha256((repo / name).read_bytes()).hexdigest() != before]
    warning_records = [{"category": type(w.message).__name__, "message": str(w.message),
                        "filename": w.filename, "line": w.lineno} for w in seen]
    entries = [{"type": kind, "test": test.id(), "traceback": trace}
               for kind, failures in (("failure", result.failures), ("error", result.errors))
               for test, trace in failures]
    identity_warnings = [w for w in warning_records if "identity" in w["message"].lower()]
    summary = {"modules": len(names), "tests": result.testsRun, "failures": len(result.failures),
               "errors": len(result.errors), "skipped": len(result.skipped),
               "duration_seconds": round(time.monotonic() - start, 3),
               "identity_warnings": identity_warnings, "warning_counts": dict(Counter(w["category"] for w in warning_records)),
               "sandbox_violations": violations, "changed_sources_during_run": changed,
               "report_directory": str(root), "failure_ids": [{"type": e["type"], "test": e["test"]} for e in entries]}
    (root / "summary.json").write_text(json.dumps(summary, ensure_ascii=True, indent=2), encoding="utf-8")
    (root / "failures.json").write_text(json.dumps(entries, ensure_ascii=True, indent=2), encoding="utf-8")
    (root / "warnings.json").write_text(json.dumps(warning_records, ensure_ascii=True, indent=2), encoding="utf-8")
    (root / "captured-stdout.txt").write_text(captured.getvalue(), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=True, indent=2))
    return 0 if result.wasSuccessful() and not violations and not changed and not identity_warnings else 1


if __name__ == "__main__":
    raise SystemExit(main())
