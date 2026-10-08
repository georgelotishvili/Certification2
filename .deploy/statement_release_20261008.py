"""Narrow, reversible deployment of the October statement workflow."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request

RELEASE = 'statement-workflow-20261008-01'
LIVE = Path('/var/www/gipc')
STAGE = Path('/home/gipcadmin') / RELEASE
CANDIDATE = STAGE / 'candidate'
BACKUP = Path('/root/gipc-backups') / RELEASE
DB = Path('/var/lib/gipc/db/app.db')
PYTHON = '/var/www/gipc/backend/venv-hardening-20260803/bin/python'
FILES = [
    'backend/app/main.py', 'backend/app/models.py', 'backend/app/schemas.py',
    'backend/app/routers/admin.py', 'backend/scripts/migrate_statements_answered.py',
    'frontend/scripts/admin.js', 'frontend/scripts/admin/users.js',
    'frontend/scripts/admin/statements.js', 'frontend/styles/admin.css',
    'frontend/pages/admin.html',
]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def report(message):
    print(message, flush=True)


def pack():
    root = Path(__file__).resolve().parents[1]
    baseline = root / '.deploy' / RELEASE
    manifest = {}
    for relative in FILES:
        old = baseline / relative
        manifest[relative] = {'before': digest(old) if old.is_file() else None,
                              'after': digest(root / relative)}
    manifest_path = baseline / 'manifest.json'
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    with tarfile.open(baseline / 'payload.tar.gz', 'w:gz') as archive:
        for relative in FILES:
            archive.add(root / relative, arcname=relative, recursive=False)
        for test in sorted((root / 'backend/tests').glob('test_*.py')):
            archive.add(test, arcname=test.relative_to(root).as_posix(), recursive=False)
        archive.add(manifest_path, arcname='manifest.json', recursive=False)
    report('PAYLOAD_SHA256=' + digest(baseline / 'payload.tar.gz'))


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def get_json(path):
    with urllib.request.urlopen('http://127.0.0.1:8000' + path, timeout=8) as response:
        return json.load(response)


def manifest():
    return json.loads((CANDIDATE / 'manifest.json').read_text())


def check_before(data):
    for relative, expected in data.items():
        target = LIVE / relative
        actual = digest(target) if target.is_file() else None
        assert actual == expected['before'], 'Production drift: ' + relative
    assert DB.is_file() and not DB.is_symlink(), 'Unexpected production database'
    pid = subprocess.check_output(['systemctl', 'show', 'gipc.service', '-p', 'MainPID', '--value'], text=True).strip()
    env = dict(item.split('=', 1) for item in (Path('/proc') / pid / 'environ').read_bytes().decode().split('\0') if '=' in item)
    assert env.get('GIPC_DATABASE_PATH') == str(DB), 'Service database differs'


def backup_db(target):
    assert not target.exists(), 'Backup already exists'
    with sqlite3.connect(DB.as_uri() + '?mode=ro', uri=True) as source:
        with sqlite3.connect(target) as dest:
            source.backup(dest)
            assert dest.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    source.close()
    dest.close()
    target.chmod(0o600)


def isolated_env(db_path):
    return {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1',
            'GIPC_DATABASE_PATH': str(db_path), 'MEDIA_ROOT': str(CANDIDATE / 'test-state/media'),
            'EMAIL_MODE': 'console', 'MAIL_MAILER': 'console'}


def prepare():
    assert os.geteuid() == 0
    assert not CANDIDATE.exists()
    CANDIDATE.mkdir(mode=0o700)
    # Copy code only. Do not copy credentials, uploads, virtualenvs or live data.
    for directory in ('backend/app', 'backend/scripts'):
        origin = LIVE / directory
        for base, dirs, files in os.walk(origin):
            dirs[:] = [name for name in dirs if name not in {'media', '__pycache__', 'uploads'}]
            for name in files:
                if not name.endswith('.py'):
                    continue
                src = Path(base) / name
                assert not src.is_symlink()
                dest = CANDIDATE / src.relative_to(LIVE)
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dest)
    with tarfile.open(STAGE / 'payload.tar.gz') as archive:
        for member in archive.getmembers():
            name = member.name
            permitted = name in FILES or name == 'manifest.json' or (
                name.startswith('backend/tests/test_') and name.endswith('.py') and len(Path(name).parts) == 3)
            assert permitted and member.isfile() and '..' not in Path(name).parts, 'Unexpected bundle member'
            target = CANDIDATE / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as source, target.open('wb') as dest:
                shutil.copyfileobj(source, dest)
    data = manifest()
    assert set(data) == set(FILES)
    check_before(data)
    for relative in FILES:
        assert digest(CANDIDATE / relative) == data[relative]['after']
        if relative.endswith('.py'):
            compile((CANDIDATE / relative).read_bytes(), relative, 'exec')
    (CANDIDATE / 'test-state/media').mkdir(parents=True)
    backup_db(CANDIDATE / 'test-state/app.db')
    before = get_json('/openapi.json')
    (CANDIDATE / 'before-openapi.json').write_text(json.dumps(before), encoding='utf-8')
    env = isolated_env(CANDIDATE / 'test-state/app.db')
    run(PYTHON, '-B', '-m', 'unittest', 'discover', '-s', 'tests', '-q', cwd=CANDIDATE / 'backend', env=env)
    contract_check = '''
import json
from pathlib import Path
from app.main import app
before = json.loads(Path('../before-openapi.json').read_text())
after = app.openapi()
assert '/admin/statements/{statement_id}/answered' in after['paths']
assert any(p['name']=='statement_date' for p in after['paths']['/admin/users']['get']['parameters'])
exam_paths = {p:v for p,v in before['paths'].items() if p.startswith('/exam/')}
assert exam_paths == {p:v for p,v in after['paths'].items() if p.startswith('/exam/')}
refs = set()
def collect(value):
    if isinstance(value, dict):
        if '$ref' in value:
            name = value['$ref'].rsplit('/',1)[-1]
            if name not in refs:
                refs.add(name)
                collect(before['components']['schemas'][name])
        for child in value.values(): collect(child)
    elif isinstance(value, list):
        for child in value: collect(child)
collect(exam_paths)
for name in refs:
    assert before['components']['schemas'][name] == after['components']['schemas'][name], name
print('CANDIDATE_EXAM_CONTRACT_UNCHANGED', len(exam_paths), len(refs))
'''
    run(PYTHON, '-B', '-c', contract_check, cwd=CANDIDATE / 'backend', env=env)
    (CANDIDATE / 'prepared.json').write_text(json.dumps({'payload': digest(STAGE / 'payload.tar.gz')}))
    report('PREPARE_OK')


def data_snapshot():
    result = {}
    with sqlite3.connect(DB.as_uri() + '?mode=ro', uri=True) as conn:
        names = [row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        for name in names:
            columns = [row[1] for row in conn.execute('PRAGMA table_info("' + name.replace('"', '""') + '")')]
            result[name] = (columns, table_digest(conn, name, columns))
    conn.close()
    return result


def table_digest(conn, name, columns):
    quote = lambda value: '"' + value.replace('"', '""') + '"'
    checksum = hashlib.sha256()
    for row in conn.execute('SELECT ' + ','.join(map(quote, columns)) + ' FROM ' + quote(name) + ' ORDER BY rowid'):
        checksum.update(repr(row).encode('utf-8'))
        checksum.update(b'\n')
    return checksum.hexdigest()


def check_existing_data(snapshot):
    with sqlite3.connect(DB.as_uri() + '?mode=ro', uri=True) as conn:
        for name, (columns, old_digest) in snapshot.items():
            assert table_digest(conn, name, columns) == old_digest, 'Migration changed records: ' + name
        columns = {row[1] for row in conn.execute('PRAGMA table_info(statements)')}
        assert {'answered_at', 'answered_by'} <= columns
        assert conn.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    conn.close()


def check_no_active_exams():
    with sqlite3.connect(DB.as_uri() + '?mode=ro', uri=True) as conn:
        active = conn.execute("SELECT count(*) FROM sessions WHERE active=1 AND finished_at IS NULL AND (ends_at IS NULL OR datetime(ends_at) >= datetime('now', '-5 minutes'))").fetchone()[0]
    conn.close()
    assert active == 0, 'Active exams found; deployment postponed'


def replace_file(source, target):
    temp = target.with_name('.' + target.name + '.' + RELEASE)
    assert not temp.exists()
    shutil.copyfile(source, temp)
    if target.exists():
        previous = target.stat()
        os.chown(temp, previous.st_uid, previous.st_gid)
        os.chmod(temp, previous.st_mode & 0o777)
    else:
        os.chown(temp, 0, 0)
        os.chmod(temp, 0o644)
    os.replace(temp, target)


def wait_healthy():
    for _ in range(40):
        try:
            get_json('/regulations')
            return
        except (OSError, ValueError):
            time.sleep(0.5)
    raise RuntimeError('Backend health check failed')


def apply():
    assert os.geteuid() == 0
    prepared = json.loads((CANDIDATE / 'prepared.json').read_text())
    assert prepared['payload'] == digest(STAGE / 'payload.tar.gz')
    data = manifest()
    assert set(data) == set(FILES)
    for relative in FILES:
        assert digest(CANDIDATE / relative) == data[relative]['after'], 'Candidate drift: ' + relative
    check_before(data)
    check_no_active_exams()
    assert not BACKUP.exists()
    BACKUP.mkdir(mode=0o700)
    for relative in FILES:
        source = LIVE / relative
        if source.exists():
            target = BACKUP / 'code' / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
    (BACKUP / 'manifest.json').write_text(json.dumps(data, indent=2))
    changed = False
    try:
        changed = True
        run('systemctl', 'stop', 'gipc.service')
        check_no_active_exams()
        backup_db(BACKUP / 'app.db')
        snapshot = data_snapshot()
        run(PYTHON, '-B', '-m', 'scripts.migrate_statements_answered', cwd=CANDIDATE / 'backend', env=isolated_env(DB))
        check_existing_data(snapshot)
        for relative in FILES:
            if relative.startswith('backend/'):
                replace_file(CANDIDATE / relative, LIVE / relative)
        run('systemctl', 'start', 'gipc.service')
        wait_healthy()
        schema = get_json('/openapi.json')
        assert '/admin/statements/{statement_id}/answered' in schema['paths']
        assert any(p['name']=='statement_date' for p in schema['paths']['/admin/users']['get']['parameters'])
        # Publish the new HTML last, after the endpoint and JS/CSS are ready.
        for relative in FILES:
            if relative.startswith('frontend/'):
                replace_file(CANDIDATE / relative, LIVE / relative)
        for relative in FILES:
            assert digest(LIVE / relative) == data[relative]['after'], relative
        receipt = {'status': 'deployed', 'files': FILES, 'backup': str(BACKUP),
                   'database_existing_records_preserved': True,
                   'payload': prepared['payload']}
        (BACKUP / 'receipt.json').write_text(json.dumps(receipt, indent=2))
        report(json.dumps(receipt))
    except BaseException:
        if changed:
            report('ROLLBACK_STARTED (code only; live database is NOT restored)')
            run('systemctl', 'stop', 'gipc.service')
            for relative in FILES:
                old = BACKUP / 'code' / relative
                if old.exists():
                    replace_file(old, LIVE / relative)
            run('systemctl', 'start', 'gipc.service')
            wait_healthy()
            report('ROLLBACK_OK; additive database columns retained')
        raise


if __name__ == '__main__':
    {'pack': pack, 'prepare': prepare, 'apply': apply}[sys.argv[1]]()
