"""Publish verified desktop 1.1.23 only; never restart backend or delete 1.1.22.

No network on import. `local-check` is local only. `inspect` / `verify` are
read-only remotely. Only the explicit `publish` command uploads an artifact and
CAS-updates app_files slot 2 (confirmed read-only on 2026-10-30).
No user/exam rows, sessions or mail are touched.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess

from deploy_codes_schedules_20261008 import ROOT, SSH

VERSION = "1.1.23"
NEW_NAME = "GIPC_exam_1.1.23.exe"
OLD_NAME = "GIPC_exam_1.1.22.exe"
OLD_SIZE = 69892262
OLD_HASH = "e6613931931d5ff635202effe93c81d1ce959af87648d18b825fd7f082e8a70b"
DEFAULT_VERIFICATION = ROOT / ".deploy/desktop-busy-20261030/package-verification.json"
DEFAULT_STATE = ROOT / ".deploy/desktop-busy-20261030/publish"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def safe_local(path, *, file=True):
    path = Path(path).absolute()
    require(path.resolve() == path and not path.is_symlink(), "Redirected local path")
    require(path.is_relative_to(ROOT.resolve()), "Local path is outside repository")
    require(path.is_file() if file else path.is_dir(), "Missing local artifact: " + str(path))
    return path


def valid_hash(value):
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


def local_artifacts(verification_path):
    verification_path = safe_local(verification_path)
    proof = json.loads(verification_path.read_text(encoding="utf-8"))
    require(proof.get("passed") is True and proof.get("version") == VERSION, "Package verification did not pass")
    for name in ("tests", "smoke"):
        require(proof.get(name, {}).get("passed") is True, "Missing successful " + name + " verification")
    executable = safe_local(ROOT / "desktop_app/dist" / NEW_NAME)
    archive = safe_local(ROOT / "desktop_app/dist/win-unpacked/resources/app.asar")
    require(Path(proof["exe"]["path"]).resolve() == executable, "Unexpected executable in verification")
    require(Path(proof["archive"]["path"]).resolve() == archive, "Unexpected ASAR in verification")
    size, digest = proof["exe"]["size"], proof["exe"]["sha256"]
    require(isinstance(size, int) and 50 * 1024 * 1024 < size < 300 * 1024 * 1024 and valid_hash(digest), "Invalid executable metadata")
    require(executable.stat().st_size == size and sha256(executable) == digest, "Executable changed after verification")
    require(valid_hash(proof["archive"]["sha256"]) and sha256(archive) == proof["archive"]["sha256"], "ASAR changed after verification")
    require(proof.get("uxSmoke", {}).get("passed") is True and proof["uxSmoke"].get("archiveHash") == proof["archive"]["sha256"], "Packaged UX verification missing")
    require(proof.get("launcherSmoke", {}).get("passed") is True and proof["launcherSmoke"].get("exeSha256", "").lower() == digest, "Native portable launcher verification missing")
    current = {}
    for source in (ROOT / "desktop_app/src").rglob("*"):
        require(source.resolve() == source and not source.is_symlink(), "Redirected desktop source")
        if source.is_file():
            current[source.relative_to(ROOT / "desktop_app").as_posix()] = sha256(source)
    require(current and current == proof["matchedSources"] and len(current) == proof["sourceFileCount"], "Desktop sources changed after verification")
    expected_packages = {"package.json", "package-lock.json"}
    require(set(proof.get("packageHashes", {})) == expected_packages, "Package manifest verification missing")
    for name, expected in proof["packageHashes"].items():
        require(valid_hash(expected) and sha256(safe_local(ROOT / "desktop_app" / name)) == expected, "Package manifest changed: " + name)
    expected_build_scripts = {"build.cjs", "build/portable-launcher.cjs"}
    require(set(proof.get("buildHashes", {})) == expected_build_scripts, "Build script verification missing or unexpected")
    for name, expected in proof["buildHashes"].items():
        require(valid_hash(expected) and sha256(safe_local(ROOT / "desktop_app" / name)) == expected, "Build script changed: " + name)
    require(json.loads((ROOT / "desktop_app/package.json").read_text(encoding="utf-8"))["version"] == VERSION, "Wrong package version")
    old = safe_local(ROOT / "desktop_app/dist" / OLD_NAME)
    require(old.stat().st_size == OLD_SIZE and sha256(old) == OLD_HASH, "Local predecessor differs from reviewed 1.1.22")
    return {"version": VERSION, "new_name": NEW_NAME, "new_size": size, "new_hash": digest,
            "old_name": OLD_NAME, "old_size": OLD_SIZE, "old_hash": OLD_HASH,
            "verification_sha256": sha256(verification_path), "archive_sha256": proof["archive"]["sha256"]}


REMOTE = r'''
import hashlib, json, os, pwd, shutil, sqlite3, subprocess, tempfile, urllib.request, urllib.error
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

def require(condition, message):
    if not condition: raise RuntimeError(message)

require(os.geteuid() == 0, 'Expected reviewed sudo transport')
LIVE = Path('/var/www/gipc')
DB = Path('/var/lib/gipc/db/app.db')
MEDIA = Path('/var/www/gipc/backend/app/media')
DIRECTORY = MEDIA / 'app_files'
PYTHON = '/var/www/gipc/backend/venv-hardening-20260803/bin/python'
OLD_NAME = 'GIPC_exam_1.1.22.exe'
NEW_NAME = 'GIPC_exam_1.1.23.exe'
OLD_SIZE = 69892262
OLD_HASH = 'e6613931931d5ff635202effe93c81d1ce959af87648d18b825fd7f082e8a70b'
COLUMNS = ('id', 'storage_path', 'filename', 'mime_type', 'size_bytes', 'created_at')

def safe_path(path, *, file=True):
    require(path.is_absolute() and path.resolve() == path and not path.is_symlink(), 'Redirected remote path')
    require(path.is_file() if file else path.is_dir(), 'Missing scoped remote path')
    return path

def file_digest(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024*1024), b''): digest.update(block)
    return digest.hexdigest()

def service_pid():
    subprocess.run(['systemctl', 'is-active', '--quiet', 'gipc.service'], check=True)
    pid = subprocess.check_output(['systemctl','show','gipc.service','-p','MainPID','--value'], text=True).strip()
    require(pid.isdigit() and int(pid) > 0, 'Invalid service PID')
    return pid

def service_info():
    pid = service_pid()
    # Secrets are neither returned nor logged. Resolve settings without calling
    # ensure_media_root (which would mkdir) or importing application startup.
    env = dict(item.split('=',1) for item in (Path('/proc')/pid/'environ').read_bytes().decode().split('\0') if '=' in item)
    require(env.get('GIPC_DATABASE_PATH') == str(DB), 'Configured DB differs from reviewed target')
    safe_path(DB); safe_path(MEDIA, file=False); safe_path(DIRECTORY, file=False)
    code = "from app.config import get_settings; from pathlib import Path; import json; p=Path(get_settings().media_root or 'media'); print(json.dumps(str(p if p.is_absolute() else Path('/var/www/gipc/backend/app')/p)))"
    result = subprocess.run([PYTHON,'-B','-c',code], cwd=LIVE/'backend',
        env={**os.environ,**env,'PYTHONDONTWRITEBYTECODE':'1'}, capture_output=True, text=True, timeout=20)
    require(result.returncode == 0 and json.loads(result.stdout) == str(MEDIA), 'Configured media root differs from reviewed target')
    capabilities = {}
    for host in ('http://127.0.0.1:8000', 'https://gipc.org.ge', 'https://www.gipc.org.ge'):
        request = urllib.request.Request(host+'/exam/offline/capabilities', headers={'Cache-Control':'no-cache'})
        with urllib.request.urlopen(request, timeout=15) as response:
            value = json.load(response)
            require(response.status == 200 and value.get('protocol') == 1 and value.get('grading_snapshots') is True and value.get('interruption_cancellation') is True, 'Offline capabilities unavailable')
            capabilities[host] = {'protocol':1, 'grading_snapshots':True, 'interruption_cancellation':True}
    require(service_pid() == pid, 'Service changed during check')
    return {'pid':pid, 'media_root':str(MEDIA), 'capabilities':capabilities}

def app_record(db=None):
    if db is None:
        with closing(sqlite3.connect(DB.as_uri()+'?mode=ro', uri=True)) as source: return app_record(source)
    require(db.execute('SELECT COUNT(*) FROM app_files').fetchone()[0] == 1, 'Download slots changed')
    row = db.execute('SELECT '+','.join(COLUMNS)+' FROM app_files WHERE id=2').fetchone()
    require(row is not None, 'Download slot 2 missing')
    return dict(zip(COLUMNS, row))

def app_target(name):
    require(name in (OLD_NAME, NEW_NAME), 'Unexpected app filename')
    target = DIRECTORY/name
    require(target.parent == DIRECTORY and target.resolve() == target and not target.is_symlink(), 'Unsafe app target')
    return target

def old_verified():
    target = safe_path(app_target(OLD_NAME))
    require(target.stat().st_size == OLD_SIZE and file_digest(target) == OLD_HASH, 'Predecessor binary changed')
    return target

def new_verified(record, artifact):
    require(record['id'] == 2 and record['filename'] == NEW_NAME and record['storage_path'] == 'app_files/'+NEW_NAME and record['size_bytes'] == artifact['new_size'], 'Published slot mismatch')
    target = safe_path(app_target(NEW_NAME))
    require(target.stat().st_size == artifact['new_size'] and file_digest(target) == artifact['new_hash'], 'Published binary mismatch')
    return target

def baseline(manifest, artifact, allow_new=False):
    require(manifest['artifact'] == artifact, 'Local verification changed since inspection')
    info = service_info()
    require(info == manifest['service'], 'Service/capability drift; inspect again')
    old_verified()
    current = app_record()
    if allow_new and current['filename'] == NEW_NAME:
        new_verified(current, artifact)
        return current, True
    require(current == manifest['record'], 'Concurrent download metadata change')
    return current, False

def sync_directory(directory):
    fd = os.open(directory, os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)

def upload_path(value):
    path = Path(value)
    require(path.name == NEW_NAME and path.parent.parent == Path('/tmp') and path.parent.name.startswith('gipc-busy-1-1-23-'), 'Unexpected staging target')
    safe_path(path.parent, file=False)
    require(path.resolve() == path and not path.is_symlink(), 'Redirected staging file')
    return path

def clean_stage(path):
    path = upload_path(str(path))
    if path.exists():
        safe_path(path).unlink()
    # Only an empty task-owned exact staging directory may be removed.
    path.parent.rmdir()
'''


def remote(action, **values):
    script = REMOTE + "\n" + "\n".join(name + "=" + repr(value) for name, value in values.items()) + "\n" + action
    completed = subprocess.run(SSH, input=script.encode("utf-8"), capture_output=True, timeout=180)
    if completed.returncode:
        # Script errors contain only fixed paths, metadata and assertions.
        raise RuntimeError(completed.stderr.decode("utf-8", errors="replace")[-3000:])
    return json.loads(completed.stdout)


def state_directory(value):
    directory = Path(value).absolute()
    require(directory.is_relative_to(ROOT / ".deploy") and directory.resolve() == directory and not directory.is_symlink(), "Unsafe local state directory")
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def write_json(path, value):
    require(not path.is_symlink() and path.resolve() == path, "Redirected local receipt")
    temporary = path.with_suffix(path.suffix + ".tmp")
    require(not temporary.exists(), "Receipt temporary already exists")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


def load_manifest(args):
    artifact = local_artifacts(args.verification)
    state = state_directory(args.state_dir)
    manifest = json.loads(safe_local(state / "manifest.json").read_text(encoding="utf-8"))
    require(manifest["artifact"] == artifact, "Verified artifacts changed after inspection")
    record = manifest["record"]
    require(record["id"] == 2 and record["filename"] == OLD_NAME and record["storage_path"] == "app_files/" + OLD_NAME and record["size_bytes"] == OLD_SIZE, "Unexpected inspected download slot")
    require(manifest["service"]["media_root"] == "/var/www/gipc/backend/app/media", "Unexpected inspected media root")
    return state, artifact, manifest


def inspect(args):
    artifact = local_artifacts(args.verification)
    state = state_directory(args.state_dir)
    require(not (state / "receipt.json").exists(), "Publication receipt exists; use verify")
    result = remote(r'''
info = service_info(); record = app_record(); old = old_verified()
require(record['filename'] == OLD_NAME and record['storage_path'] == 'app_files/'+OLD_NAME and record['size_bytes'] == OLD_SIZE, 'Unexpected predecessor slot')
require(not app_target(NEW_NAME).exists(), 'New filename already exists; inspect existing publication before continuing')
print(json.dumps({'service':info, 'record':record, 'old_metadata':[old.stat().st_uid,old.stat().st_gid,old.stat().st_mode & 0o777]}))
''')
    result["artifact"] = artifact
    write_json(state / "manifest.json", result)
    return {"status": "inspected-read-only", "version": VERSION, "slot": 2, "service_pid": result["service"]["pid"], "old_binary_verified": True}


def publish(args):
    state, artifact, manifest = load_manifest(args)
    # Also recover an SSH disconnect after successful commit/staging cleanup.
    # A verified already-published slot needs no re-upload or second DB write.
    prior = remote("record,published=baseline(manifest,artifact,allow_new=True); print(json.dumps({'published':published}))", manifest=manifest, artifact=artifact)
    if prior["published"]:
        return verify(args)
    stage_record = state / "upload.json"
    if stage_record.exists():
        stage = json.loads(safe_local(stage_record).read_text(encoding="utf-8"))["path"]
        remote("baseline(manifest,artifact,allow_new=True); p=upload_path(stage); print(json.dumps({'valid':True}))", manifest=manifest, artifact=artifact, stage=stage)
    else:
        result = remote(r'''
current, already = baseline(manifest, artifact, allow_new=True)
if already:
    print(json.dumps({'already_published':True}))
else:
    directory = Path(tempfile.mkdtemp(prefix='gipc-busy-1-1-23-', dir='/tmp'))
    owner = pwd.getpwnam('gipcadmin'); os.chown(directory,owner.pw_uid,owner.pw_gid); directory.chmod(0o700)
    print(json.dumps({'path':str(directory/NEW_NAME)}))
''', manifest=manifest, artifact=artifact)
        if result.get("already_published"):
            return verify(args)
        stage = result["path"]
        write_json(stage_record, {"path": stage})
    # This is the only bulk upload. SSH host checking and key match reviewed transport.
    require(stage.startswith("/tmp/gipc-busy-1-1-23-") and stage.endswith("/" + NEW_NAME) and all(c.isalnum() or c in "/._-" for c in stage), "Unsafe staging destination")
    subprocess.run(["scp", "-q", "-i", "C:/Users/george/.ssh/gipc_admin_ed25519", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=15", str(ROOT / "desktop_app/dist" / NEW_NAME), "gipcadmin@148.251.167.229:" + stage], check=True, timeout=900)
    # Recheck immutable local artifacts after upload before switching the slot.
    require(local_artifacts(args.verification) == artifact, "Local package changed during upload")
    result = remote(r'''
current, already = baseline(manifest, artifact, allow_new=True)
source = safe_path(upload_path(stage))
require(source.stat().st_size == artifact['new_size'] and file_digest(source) == artifact['new_hash'], 'Uploaded binary hash mismatch')
new = app_target(NEW_NAME)
if not already:
    if not new.exists():
        fd, name = tempfile.mkstemp(prefix='.gipc-busy-1-1-23-',dir=DIRECTORY)
        temporary = Path(name); identity = (temporary.stat().st_dev, temporary.stat().st_ino)
        try:
            with os.fdopen(fd,'wb') as destination, source.open('rb') as content:
                shutil.copyfileobj(content,destination,1024*1024); destination.flush(); os.fsync(destination.fileno())
            require(file_digest(temporary) == artifact['new_hash'], 'Atomic-copy hash mismatch')
            uid,gid,mode = manifest['old_metadata']; os.chown(temporary,uid,gid); os.chmod(temporary,mode)
            os.link(temporary,new)  # O_EXCL-style publication, never overwrite.
            sync_directory(DIRECTORY)
        finally:
            if temporary.exists():
                require(temporary.parent == DIRECTORY and temporary.name.startswith('.gipc-busy-1-1-23-') and temporary.resolve() == temporary and not temporary.is_symlink(), 'Unsafe temporary cleanup')
                require((temporary.stat().st_dev,temporary.stat().st_ino) == identity, 'Temporary file replaced')
                temporary.unlink(); sync_directory(DIRECTORY)
    safe_path(new)
    require(new.stat().st_size == artifact['new_size'] and file_digest(new) == artifact['new_hash'], 'Existing new file differs')
    old_verified()
    with closing(sqlite3.connect(DB, timeout=15)) as db, db:
        db.execute('BEGIN IMMEDIATE')
        require(app_record(db) == manifest['record'], 'Concurrent slot change before CAS')
        require(service_pid() == manifest['service']['pid'], 'Service changed before CAS')
        previous = manifest['record']
        cursor = db.execute('UPDATE app_files SET filename=?,storage_path=?,size_bytes=?,created_at=? WHERE id=2 AND filename=? AND storage_path=? AND size_bytes IS ? AND mime_type IS ? AND created_at IS ?',
            (NEW_NAME,'app_files/'+NEW_NAME,artifact['new_size'],datetime.now(timezone.utc).replace(tzinfo=None).isoformat(sep=' '),previous['filename'],previous['storage_path'],previous['size_bytes'],previous['mime_type'],previous['created_at']))
        require(cursor.rowcount == 1, 'Slot CAS failed')
record = app_record(); new_verified(record,artifact); old_verified()
clean_stage(source)
print(json.dumps({'status':'published','version':'1.1.23','slot':2,'sha256':artifact['new_hash'],'size':artifact['new_size'],'service_pid':service_pid(),'old_binary_preserved':True,'backend_restarted':False,'user_rows_changed':False,'staging_removed':True}))
''', manifest=manifest, artifact=artifact, stage=stage)
    write_json(state / "receipt.json", result)
    return result


def verify(args):
    state, artifact, manifest = load_manifest(args)
    result = remote(r'''
record, published = baseline(manifest, artifact, allow_new=True)
require(published, 'Download slot has not been published')
new_verified(record, artifact); old_verified()
for host in ('http://127.0.0.1:8000','https://gipc.org.ge','https://www.gipc.org.ge'):
    try:
        with urllib.request.urlopen(host+'/app-files/2/download', timeout=15): pass
        raise RuntimeError('Protected download unexpectedly allowed anonymous access')
    except urllib.error.HTTPError as error:
        require(error.code == 401, 'Unexpected protected-download response')
print(json.dumps({'status':'verified-read-only','version':'1.1.23','slot':2,'sha256':artifact['new_hash'],'size':artifact['new_size'],'service_pid':service_pid(),'old_binary_preserved':True,'capabilities_verified':True,'admin_only_download_preserved':True,'authenticated_download_tested':False,'reason':'No user session or real candidate used'}))
''', manifest=manifest, artifact=artifact)
    write_json(state / "verification.json", result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("local-check", "inspect", "publish", "verify"))
    parser.add_argument("--verification", type=Path, default=DEFAULT_VERIFICATION)
    parser.add_argument("--state-dir", type=Path, default=DEFAULT_STATE)
    args = parser.parse_args()
    if args.command == "local-check":
        result = {"status": "local-artifacts-verified", **local_artifacts(args.verification), "network_used": False}
    else:
        result = {"inspect": inspect, "publish": publish, "verify": verify}[args.command](args)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()


