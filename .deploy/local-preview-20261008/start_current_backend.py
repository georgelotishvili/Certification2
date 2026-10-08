"""Start the local preview only, with its verified isolated database and media."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import time
import urllib.request
import psutil

root = Path(__file__).resolve().parents[2]
backend = root / "backend"
preview = Path(__file__).resolve().parent
assert not any(c.status == psutil.CONN_LISTEN and c.laddr.port == 8000 for c in psutil.net_connections(kind="tcp")), "Port 8000 is already in use"
environment = dict(os.environ)
environment.update(GIPC_DATABASE_PATH=str(preview / "app.db"), MEDIA_ROOT=str(backend / "app" / "media"), EMAIL_MODE="console", PYTHONDONTWRITEBYTECODE="1")

def snapshot():
    with sqlite3.connect((preview / "app.db").as_uri() + "?mode=ro", uri=True) as db:
        assert db.execute("PRAGMA quick_check").fetchone()[0] == "ok"
        tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        return {name: db.execute('SELECT COUNT(*) FROM "' + name.replace('"', '""') + '"').fetchone()[0] for name in tables}

before = snapshot()
command = [str(backend / ".venv" / "Scripts" / "python.exe"), "-B", "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000"]
with (preview / "backend-current.stdout.log").open("ab") as out, (preview / "backend-current.stderr.log").open("ab") as err:
    process = subprocess.Popen(command, cwd=backend, env=environment, stdin=subprocess.DEVNULL, stdout=out, stderr=err, creationflags=subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP)
for _ in range(60):
    try:
        with urllib.request.urlopen("http://127.0.0.1:8000/certified-persons/registry/page?limit=2", timeout=2) as response:
            data = json.load(response)
            assert isinstance(data["items"], list)
            break
    except Exception:
        if process.poll() is not None:
            raise RuntimeError("Local backend exited; inspect local startup log")
        time.sleep(0.5)
else:
    raise RuntimeError("Local readiness timed out")
print(json.dumps({"local_only": True, "launcher_pid": process.pid, "registry_status": 200, "registry_total": data["total"], "same_database": True, "table_counts_unchanged": before == snapshot(), "integrity": "ok"}))
