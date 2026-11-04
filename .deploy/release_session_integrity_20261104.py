"""Scoped release; import/check never mutate production.

Backend uses the established deployment transport and local rollback copies.
App publication updates only the existing download slot after exact-content
package verification. Candidate rows, grades, mail and existing EXEs are untouched.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess

import deploy_admin_release_20261016 as base

ROOT = base.ROOT
STATE = ROOT / ".deploy/session-integrity-20261104"
FILES = [
    "backend/app/main.py", "backend/app/models.py", "backend/app/database.py",
    "backend/app/security.py", "backend/app/routers/admin.py",
    "backend/app/routers/auth.py", "backend/app/routers/users.py",
    "backend/app/routers/statements.py", "backend/app/services/exam_lifecycle.py",
    "backend/app/routers/exam.py", "backend/app/routers/multi_apartment.py",
    "backend/app/routers/multi_functional.py",
    "backend/app/services/offline_attempts.py", "backend/app/services/desktop_sessions.py",
    "backend/app/services/audit_log.py", "backend/scripts/migrate_desktop_sessions.py",
    "backend/scripts/migrate_audit_events.py", "frontend/pages/admin.html",
    "frontend/scripts/admin/shared.js", "frontend/styles/admin.css",
]
OLD_HASH = "fcbf246e7bdb038261fd872be0af7405553588ed057f91899c5a48b97e83de19"
VERSION = "1.1.27"
NAME = f"GIPC_exam_{VERSION}.exe"


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def configure():
    missing = [name for name in FILES if not (ROOT / name).is_file()]
    if missing:
        raise RuntimeError("Release is incomplete: " + ", ".join(missing))
    base.CANDIDATE_FILES = FILES
    base.DEPLOY_DIR = STATE / "backend"
    base.BEFORE_DIR = base.DEPLOY_DIR / "before"
    base.AFTER_DIR = base.DEPLOY_DIR / "after"


REMOTE_READ = r'''
import hashlib, json, sqlite3, subprocess, urllib.request
from pathlib import Path
root=Path('/var/www/gipc')
db=sqlite3.connect('file:/var/lib/gipc/db/app.db?mode=ro', uri=True)
db.row_factory=sqlite3.Row
tables={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
active=db.execute("SELECT COUNT(*) FROM sessions WHERE finished_at IS NULL AND (ends_at IS NULL OR datetime(ends_at)>=datetime('now','-5 minutes'))").fetchone()[0]
if 'offline_exam_attempts' in tables:
    active+=db.execute("SELECT COUNT(*) FROM offline_exam_attempts WHERE submitted_at IS NULL AND (ends_at IS NULL OR datetime(ends_at)>=datetime('now','-5 minutes'))").fetchone()[0]
records=[dict(r) for r in db.execute('SELECT id,storage_path,filename,size_bytes,mime_type,created_at FROM app_files')]
columns={name:[row[1] for row in db.execute('PRAGMA table_info("'+name+'")')] for name in ('user_sessions','sessions','offline_exam_attempts','audit_events')}
triggers=[r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='audit_events'")]
counts={name:db.execute('SELECT COUNT(*) FROM "'+name+'"').fetchone()[0] for name in ('users','sessions','answers','multi_apartment_evaluations','multi_functional_evaluations') if name in tables}
audit_count=db.execute('SELECT COUNT(*) FROM audit_events').fetchone()[0] if 'audit_events' in tables else None
db.close()
media=root/'backend/app/media'
for record in records:
    p=(media/record['storage_path']).resolve()
    assert p.parent==media/'app_files' and p.is_file()
    record['sha256']=hashlib.sha256(p.read_bytes()).hexdigest()
hashes={name:hashlib.sha256((root/name).read_bytes()).hexdigest() if (root/name).is_file() else None for name in PAYLOAD.get('files',[])}
versions=json.loads(subprocess.check_output(['/var/www/gipc/backend/venv-hardening-20260803/bin/python','-c',"import json,importlib.metadata as m; print(json.dumps({n:m.version(n) for n in ['fastapi','starlette','SQLAlchemy','pydantic']}))"],text=True))
with urllib.request.urlopen('http://127.0.0.1:8000/openapi.json',timeout=10) as response:
    spec=json.load(response)
audit_parameters=[p['name'] for p in spec.get('paths',{}).get('/admin/audit-logs',{}).get('get',{}).get('parameters',[])]
print(json.dumps({'active_exams':active,'apps':records,'hashes':hashes,'columns':columns,'triggers':triggers,'audit_count':audit_count,'record_counts':counts,'versions':versions,
    'audit_parameters':audit_parameters,
    'service':subprocess.check_output(['systemctl','is-active','gipc.service'],text=True).strip()}))
'''


def remote_state():
    return base.run_remote_python(REMOTE_READ, {"files": FILES})


def package_proof():
    proof = json.loads((STATE / "package-verification.json").read_text(encoding="utf-8"))
    assert proof["passed"] and proof["version"] == VERSION
    assert proof["tests"]["passed"] and proof["tests"]["failures"] == 0
    for key in ("smoke", "uxSmoke", "launcherSmoke", "pdfSmoke"):
        assert proof[key]["passed"], key
    executable = ROOT / "desktop_app/dist" / NAME
    assert digest(executable) == proof["exe"]["sha256"]
    assert executable.stat().st_size == proof["exe"]["size"]
    archive = ROOT / "desktop_app/dist/win-unpacked/resources/app.asar"
    assert digest(archive) == proof["archive"]["sha256"]
    current = {p.relative_to(ROOT / "desktop_app").as_posix(): digest(p)
               for p in (ROOT / "desktop_app/src").rglob("*") if p.is_file()}
    assert current == proof["matchedSources"], "Desktop sources changed after verification"
    return proof, executable


def verify_live():
    import urllib.request
    import urllib.error
    state = remote_state()
    assert state["service"] == "active"
    assert all(state["hashes"][name] == digest(ROOT / name) for name in FILES)
    assert {"client_type", "device_id"}.issubset(state["columns"]["user_sessions"])
    for table in ("sessions", "offline_exam_attempts"):
        assert "device_id" in state["columns"][table]
    assert {"audit_events_no_update", "audit_events_no_delete"}.issubset(state["triggers"])
    assert state["audit_count"] >= 1
    assert {"before_id", "snapshot_id"}.issubset(state["audit_parameters"])
    checks = {}
    # Never impersonate a real user to smoke-test production.
    for route, expected in (("/admin/audit-logs", 401), ("/app-files/2/download", 401), ("/pages/admin.html", 200)):
        request = urllib.request.Request("https://gipc.org.ge" + route, headers={"User-Agent": "gipc-release-readonly-verifier", "Cache-Control": "no-cache"})
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                status = response.status
                if route == "/pages/admin.html":
                    assert hashlib.sha256(response.read()).hexdigest() == digest(ROOT / "frontend/pages/admin.html")
        except urllib.error.HTTPError as error:
            status = error.code
        assert status == expected, (route, status)
        checks[route] = status
    result = {"passed": True, "state": state, "public_http": checks}
    STATE.mkdir(parents=True, exist_ok=True)
    (STATE / "live-verification.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def publish_app():
    proof, executable = package_proof()
    before = remote_state()
    assert before["service"] == "active"
    assert all(before["hashes"][name] == digest(ROOT / name) for name in FILES), "Backend release not verified"
    assert len(before["apps"]) == 1 and before["apps"][0]["id"] == 2
    record = before["apps"][0]
    new_hash = proof["exe"]["sha256"]
    if record["sha256"] == new_hash:
        return {"already_published": True, "sha256": new_hash}
    assert record["sha256"] == OLD_HASH, "App download changed concurrently"
    stage = base.run_remote_python("import json,tempfile,os,pwd; p=tempfile.mkdtemp(prefix='gipc-session-release-',dir='/tmp'); u=pwd.getpwnam('gipcadmin'); os.chown(p,u.pw_uid,u.pw_gid); print(json.dumps(p))")
    assert stage.startswith("/tmp/gipc-session-release-") and "/" not in stage[len("/tmp/"):]
    upload = stage + "/" + NAME
    # Reviewed transport; stage contains only this newly built release artifact.
    subprocess.run(["scp", "-i", base.SSH_KEY, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
                    str(executable), base.HOST + ":" + upload], check=True)
    result = base.run_remote_python(r'''
import fcntl,hashlib,json,os,shutil,sqlite3
from pathlib import Path
from datetime import datetime,timezone
release_lock=open('/run/lock/gipc-release.lock','a')
fcntl.flock(release_lock,fcntl.LOCK_EX | fcntl.LOCK_NB)
for name,expected_hash in PAYLOAD['backend_hashes'].items():
    assert hashlib.sha256((Path('/var/www/gipc')/name).read_bytes()).hexdigest()==expected_hash,'Backend changed before app publication'
upload=Path(PAYLOAD['upload'])
assert upload.parent.parent==Path('/tmp') and upload.parent.name.startswith('gipc-session-release-')
assert upload.name=='GIPC_exam_1.1.27.exe' and upload.resolve()==upload and not upload.is_symlink()
assert upload.is_file() and hashlib.sha256(upload.read_bytes()).hexdigest()==PAYLOAD['hash']
media=Path('/var/www/gipc/backend/app/media')
directory=media/'app_files'
assert directory.is_dir() and directory.resolve()==directory
filename='GIPC_exam_1.1.27-'+PAYLOAD['hash']+'.exe'
target=directory/filename
assert target.resolve()==target and not target.is_symlink()
expected=PAYLOAD['before'].copy(); expected.pop('sha256')
previous=media/expected['storage_path']
assert previous.resolve().parent==directory and hashlib.sha256(previous.read_bytes()).hexdigest()==PAYLOAD['before']['sha256']
# All large disk I/O is outside the SQLite transaction; only the metadata CAS
# briefly takes a writer lock, without holding up candidate result submissions.
if target.exists():
    assert hashlib.sha256(target.read_bytes()).hexdigest()==PAYLOAD['hash']
else:
    temporary=target.with_suffix('.upload-tmp')
    assert not temporary.exists()
    shutil.copyfile(upload,temporary)
    stat=previous.stat()
    os.chown(temporary,stat.st_uid,stat.st_gid); os.chmod(temporary,stat.st_mode & 0o777)
    assert hashlib.sha256(temporary.read_bytes()).hexdigest()==PAYLOAD['hash']
    os.replace(temporary,target)
db=sqlite3.connect('/var/lib/gipc/db/app.db',timeout=30)
db.row_factory=sqlite3.Row
try:
    db.execute('BEGIN IMMEDIATE')
    assert db.execute('SELECT COUNT(*) FROM app_files').fetchone()[0]==1
    old=dict(db.execute('SELECT id,storage_path,filename,size_bytes,mime_type,created_at FROM app_files WHERE id=2').fetchone())
    assert old==expected,'Download metadata changed concurrently'
    db.execute('UPDATE app_files SET storage_path=?,filename=?,size_bytes=?,created_at=? WHERE id=2',
       ('app_files/'+filename,'GIPC_exam_1.1.27.exe',target.stat().st_size,datetime.now(timezone.utc).replace(tzinfo=None).isoformat(' ')))
    db.commit()
except BaseException:
    db.rollback(); raise
finally:
    db.close()
upload.unlink(); upload.parent.rmdir()
print(json.dumps({'published':True,'version':'1.1.27','sha256':PAYLOAD['hash'],'storage_path':'app_files/'+filename,'old_binary_retained':True}))
''', {"upload": upload, "hash": new_hash, "before": record, "backend_hashes": before["hashes"]})
    STATE.mkdir(parents=True, exist_ok=True)
    (STATE / "app-publication.json").write_text(json.dumps({"before": before, "result": result}, indent=2), encoding="utf-8")
    assert remote_state()["apps"][0]["sha256"] == new_hash
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("inspect", "check", "deploy", "publish-app", "verify-live"))
    mode = parser.parse_args().mode
    if mode == "inspect":
        result = remote_state()
    elif mode == "verify-live":
        result = verify_live()
    elif mode == "publish-app":
        result = publish_app()
    else:
        configure()
        diff = base.check_diff()
        if mode == "check":
            result = diff
        else:
            assert remote_state()["active_exams"] == 0, "Active exams: postpone deployment"
            result = base.deploy(diff["changed"]) if diff["changed"] else {"unchanged": True}
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
