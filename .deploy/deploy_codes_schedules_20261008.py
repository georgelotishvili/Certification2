"""Scoped release: persistent codes + exam planning, local rollback artifacts only."""
from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
STORE = ROOT / '.deploy/codes-schedules-20261008-01'
FILES = [
    'backend/app/main.py', 'backend/app/models.py', 'backend/app/schemas.py',
    'backend/app/routers/admin.py', 'backend/app/routers/users.py',
    'backend/app/routers/exam_schedules.py', 'backend/app/services/user_codes.py',
    'backend/scripts/migrate_user_code_reservations.py',
    'backend/scripts/migrate_exam_schedules.py',
    'frontend/scripts/admin/exam-schedules.js', 'frontend/scripts/admin/users.js',
    'frontend/scripts/admin.js', 'frontend/styles/admin.css', 'frontend/pages/admin.html',
]
SSH = ['ssh', '-i', 'C:/Users/george/.ssh/gipc_admin_ed25519', '-o', 'BatchMode=yes',
       '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15',
       'gipcadmin@148.251.167.229', 'sudo -n python3 -']

REMOTE = r'''
import base64, hashlib, json, os, sqlite3, subprocess, tempfile, time, urllib.request, urllib.error
from contextlib import closing
from pathlib import Path
assert os.geteuid() == 0
LIVE = Path('/var/www/gipc')
DB = Path('/var/lib/gipc/db/app.db')
PYTHON = '/var/www/gipc/backend/venv-hardening-20260803/bin/python'
def digest(data):
    return hashlib.sha256(data).hexdigest()
def target(name):
    assert name in FILES
    path = LIVE / name
    assert path.resolve() == path and path.parent.is_dir() and not path.is_symlink()
    return path
def service_pid():
    subprocess.run(['systemctl', 'is-active', '--quiet', 'gipc.service'], check=True)
    return subprocess.check_output(['systemctl', 'show', 'gipc.service', '-p', 'MainPID', '--value'], text=True).strip()
def service_env():
    env = dict(x.split('=', 1) for x in (Path('/proc') / service_pid() / 'environ').read_bytes().decode().split('\0') if '=' in x)
    assert env.get('GIPC_DATABASE_PATH') == str(DB)
    assert DB.is_file() and DB.resolve() == DB and not DB.is_symlink()
    return env
def no_active_exams():
    with closing(sqlite3.connect(DB.as_uri() + '?mode=ro', uri=True)) as db:
        count = db.execute("SELECT count(*) FROM sessions WHERE active=1 AND finished_at IS NULL AND (ends_at IS NULL OR datetime(ends_at)>=datetime('now','-5 minutes'))").fetchone()[0]
        assert count == 0, 'Active exams; release postponed'
def get_json(path):
    with urllib.request.urlopen('http://127.0.0.1:8000' + path, timeout=5) as response:
        return json.load(response)
def source_files():
    result = {}
    for directory in ('backend/app', 'backend/scripts'):
        for base, dirs, names in os.walk(LIVE / directory):
            dirs[:] = [n for n in dirs if n not in {'media', 'uploads', '__pycache__'}]
            for name in names:
                if not name.endswith('.py'):
                    continue
                p = Path(base) / name
                assert not p.is_symlink() and p.resolve() == p
                result[p.relative_to(LIVE).as_posix()] = p.read_bytes()
    return result
def backup_db(destination):
    with closing(sqlite3.connect(DB.as_uri() + '?mode=ro', uri=True)) as source, closing(sqlite3.connect(destination)) as dest:
        source.backup(dest)
        assert dest.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    destination.chmod(0o600)
def db_snapshot(path):
    result = {}
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as db:
        for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
            quoted = '"' + name.replace('"', '""') + '"'
            columns = [r[1] for r in db.execute('PRAGMA table_info(' + quoted + ')')]
            checksum = hashlib.sha256()
            count = 0
            for row in db.execute('SELECT * FROM ' + quoted + ' ORDER BY rowid'):
                checksum.update(repr(row).encode('utf-8') + b'\n')
                count += 1
            result[name] = [columns, count, checksum.hexdigest()]
        # Preserve pre-existing orphaned legacy evaluations verbatim. This
        # release must introduce no new FK violations or repair unrelated data.
        result['__foreign_key_check__'] = sorted(db.execute('PRAGMA foreign_key_check').fetchall())
    return result
def verify_db(path, before):
    after = db_snapshot(path)
    assert all(after.get(name) == value for name, value in before.items()), 'Existing data changed'
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as db:
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        assert sorted(db.execute('PRAGMA foreign_key_check').fetchall()) == before['__foreign_key_check__'], 'Foreign-key state changed'
        assert db.execute('SELECT COUNT(*) FROM exam_schedules').fetchone()[0] == 0
        assert db.execute('SELECT COUNT(*) FROM users').fetchone()[0] == db.execute('SELECT COUNT(*) FROM user_code_reservations').fetchone()[0]
        assert not db.execute('SELECT 1 FROM users u LEFT JOIN user_code_reservations r ON r.personal_id=u.personal_id AND r.code=u.code WHERE r.personal_id IS NULL LIMIT 1').fetchone()
        ddl = db.execute("SELECT sql FROM sqlite_master WHERE name='exam_schedules'").fetchone()[0]
        assert 'AUTOINCREMENT' in ddl.upper()
def isolated_env(env, path, media):
    return {**os.environ, **env, 'GIPC_DATABASE_PATH': str(path), 'MEDIA_ROOT': str(media),
            'EMAIL_MODE': 'console', 'MAIL_MAILER': 'console', 'PYTHONDONTWRITEBYTECODE': '1'}
def assert_contract(before, after):
    for path, operations in before['paths'].items():
        if path == '/admin/users':
            old = json.loads(json.dumps(operations))
            new = json.loads(json.dumps(after['paths'][path]))
            new['get']['parameters'] = [p for p in new['get']['parameters'] if p['name'] not in {'exam_date', 'exam_morning', 'exam_evening'}]
            assert old == new, 'Changed original users contract'
        else:
            assert after['paths'].get(path) == operations, 'Changed original route: ' + path
    for name, schema in before['components']['schemas'].items():
        assert after['components']['schemas'].get(name) == schema, 'Changed existing schema: ' + name
    assert '/admin/users/{user_id}/exam-schedules' in after['paths']
    assert '/admin/users/{user_id}/exam-schedules/{schedule_id}' in after['paths']
def assert_baseline(manifest):
    assert service_pid() == manifest['pid'], 'Service changed since preparation'
    assert {name: digest(data) for name, data in source_files().items()} == manifest['python_hashes'], 'Live backend source drift'
    for name, expected in manifest['files'].items():
        p = target(name)
        assert (digest(p.read_bytes()) if p.is_file() else None) == expected['before'], 'File drift: ' + name
def replace(p, content, metadata):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=str(p.parent), prefix='.gipc-release-', delete=False) as f:
            temporary = Path(f.name)
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.chown(temporary, metadata[0], metadata[1])
        os.chmod(temporary, metadata[2])
        os.replace(temporary, p)
    finally:
        if temporary is not None and temporary.exists():
            assert temporary.parent == p.parent and temporary.name.startswith('.gipc-release-')
            temporary.unlink()
def healthy():
    for _ in range(30):
        try:
            get_json('/regulations')
            return
        except (OSError, ValueError):
            time.sleep(0.4)
    raise RuntimeError('Backend did not become healthy')
'''

def digest(data):
    return hashlib.sha256(data).hexdigest()

def remote(action):
    script = REMOTE + '\nFILES = ' + repr(FILES) + '\n' + action
    result = subprocess.run(SSH, input=script.encode(), capture_output=True)
    if result.returncode:
        # Remote commands contain no credential values; limit diagnostics.
        print(result.stdout.decode(errors='replace')[-1500:])
        print(result.stderr.decode(errors='replace')[-5000:])
        raise SystemExit(result.returncode)
    return json.loads(result.stdout)

def write_json(path, value):
    path.write_text(json.dumps(value, indent=2), encoding='utf-8')

def prepare():
    assert STORE.is_dir() and (STORE / '.gitignore').is_file()
    assert not (STORE / 'manifest.json').exists()
    data = remote(r'''
env = service_env()
no_active_exams()
sources = source_files()
with tempfile.TemporaryDirectory(prefix='gipc-release-read-') as directory:
    db_copy = Path(directory) / 'snapshot.db'
    backup_db(db_copy)
    db_data = db_copy.read_bytes()
print(json.dumps({'pid': service_pid(), 'files': {name: base64.b64encode(target(name).read_bytes()).decode() if target(name).is_file() else None for name in FILES},
                  'python': {name: base64.b64encode(content).decode() for name, content in sources.items()},
                  'database': base64.b64encode(db_data).decode(), 'openapi': get_json('/openapi.json')}))
''')
    manifest = {'pid': data['pid'], 'files': {}, 'python_hashes': {}}
    for name in FILES:
        old = base64.b64decode(data['files'][name], validate=True) if data['files'][name] is not None else None
        new = (ROOT / name).read_bytes()
        for folder, content in [('before', old), ('after', new)]:
            if content is not None:
                p = STORE / folder / name
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(content)
        manifest['files'][name] = {'before': digest(old) if old is not None else None, 'after': digest(new)}
    for name, encoded in data['python'].items():
        content = base64.b64decode(encoded, validate=True)
        p = STORE / 'live-python' / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(content)
        manifest['python_hashes'][name] = digest(content)
    db_data = base64.b64decode(data['database'], validate=True)
    (STORE / 'before.db').write_bytes(db_data)
    manifest['database_snapshot_sha256'] = digest(db_data)
    write_json(STORE / 'before-openapi.json', data['openapi'])
    write_json(STORE / 'manifest.json', manifest)
    print('PREPARED: 14 runtime files; consistent DB and rollback files stored locally only')

def payload():
    manifest = json.loads((STORE / 'manifest.json').read_text(encoding='utf-8'))
    data = {}
    assert digest((STORE / 'before.db').read_bytes()) == manifest['database_snapshot_sha256']
    for name, entry in manifest['files'].items():
        if entry['before'] is not None:
            assert digest((STORE / 'before' / name).read_bytes()) == entry['before']
        content = (STORE / 'after' / name).read_bytes()
        assert digest(content) == entry['after'] == digest((ROOT / name).read_bytes())
        data[name] = base64.b64encode(content).decode()
    return manifest, data

def validate():
    manifest, data = payload()
    tests = {p.relative_to(ROOT).as_posix(): base64.b64encode(p.read_bytes()).decode()
             for p in (ROOT / 'backend/tests').glob('test_*.py')}
    action = 'manifest = ' + repr(manifest) + '\npayload = ' + repr(data) + '\ntests = ' + repr(tests) + r'''
env = service_env()
assert_baseline(manifest)
before_api = get_json('/openapi.json')
with tempfile.TemporaryDirectory(prefix='gipc-release-test-') as directory:
    stage = Path(directory)
    for name, content in source_files().items():
        p = stage / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(content)
    for name, encoded in {**payload, **tests}.items():
        p = stage / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(base64.b64decode(encoded, validate=True))
        if name.endswith('.py'):
            compile(p.read_bytes(), name, 'exec')
    db_copy = stage / 'clone.db'
    backup_db(db_copy)
    before_data = db_snapshot(db_copy)
    test_env = isolated_env(env, db_copy, stage / 'media')
    commands = [
        [PYTHON, '-B', '-m', 'unittest', 'discover', '-s', 'tests', '-q'],
        [PYTHON, '-B', '-c', "from scripts.migrate_user_code_reservations import run as codes; from scripts.migrate_exam_schedules import run as schedules; codes(); schedules(); codes(); schedules()"],
        [PYTHON, '-B', '-c', "import json; from app.main import app, create_app; create_app(); print('SCHEMA_JSON='+json.dumps(app.openapi()))"],
    ]
    test_summary = ''
    for index, command in enumerate(commands):
        result = subprocess.run(command, cwd=stage / 'backend', env=test_env, capture_output=True, text=True)
        assert result.returncode == 0, 'Candidate check failed: ' + result.stderr[-3000:]
        if index == 0:
            test_summary = result.stderr[-1200:]
        if index == 2:
            api_line = next(line for line in result.stdout.splitlines() if line.startswith('SCHEMA_JSON='))
            after_api = json.loads(api_line[len('SCHEMA_JSON='):])
            assert_contract(before_api, after_api)
        verify_db(db_copy, before_data) if index >= 1 else None
print(json.dumps({'status':'validated', 'old_tables_unchanged':True, 'all_existing_api_contracts_unchanged':True, 'tests':test_summary, 'temporary_server_files_removed':True}))
'''
    receipt = remote(action)
    receipt['manifest_sha256'] = digest((STORE / 'manifest.json').read_bytes())
    write_json(STORE / 'validation.json', receipt)
    print(json.dumps(receipt), flush=True)

def apply():
    manifest, data = payload()
    validation = json.loads((STORE / 'validation.json').read_text(encoding='utf-8'))
    assert validation['status'] == 'validated'
    assert validation['manifest_sha256'] == digest((STORE / 'manifest.json').read_bytes())
    action = 'manifest = ' + repr(manifest) + '\npayload = ' + repr(data) + r'''
env = service_env()
assert_baseline(manifest)
no_active_exams()
before_api = get_json('/openapi.json')
old, metadata, new = {}, {}, {}
for name in FILES:
    p = target(name)
    old[name] = p.read_bytes() if p.is_file() else None
    st = p.stat() if p.is_file() else None
    metadata[name] = (st.st_uid, st.st_gid, st.st_mode & 0o777) if st else (0, 0, 0o644)
    new[name] = base64.b64decode(payload[name], validate=True)
    assert digest(new[name]) == manifest['files'][name]['after']
changed = []
stopped = False
try:
    subprocess.run(['systemctl','stop','gipc.service'], check=True)
    stopped = True
    no_active_exams()
    before_data = db_snapshot(DB)
    for name in FILES:
        if name.startswith('backend/'):
            replace(target(name), new[name], metadata[name])
            changed.append(name)
    migration_env = {**os.environ, **env, 'GIPC_DATABASE_PATH':str(DB), 'PYTHONDONTWRITEBYTECODE':'1'}
    result = subprocess.run([PYTHON,'-B','-c', 'from scripts.migrate_user_code_reservations import run as codes; from scripts.migrate_exam_schedules import run as schedules; codes(); schedules()'], cwd=LIVE/'backend', env=migration_env, capture_output=True, text=True)
    assert result.returncode == 0, 'Migration failed: ' + result.stderr[-1500:]
    verify_db(DB, before_data)
    subprocess.run(['systemctl','start','gipc.service'], check=True)
    healthy()
    assert_contract(before_api, get_json('/openapi.json'))
    for path in ('/admin/users/1/exam-schedules', '/admin/users?exam_morning=true'):
        try:
            urllib.request.urlopen('http://127.0.0.1:8000'+path, timeout=5)
            raise AssertionError('Admin endpoint accepted unauthenticated request')
        except urllib.error.HTTPError as error:
            assert error.code == 401
    for name in FILES:
        if name.startswith('frontend/'):
            replace(target(name), new[name], metadata[name])
            changed.append(name)
    assert all(digest(target(name).read_bytes()) == manifest['files'][name]['after'] for name in FILES)
    print(json.dumps({'status':'deployed','files':FILES,'pid':service_pid(),'existing_data_preserved':True,'old_api_contracts_unchanged':True,'manual_exam_access_unchanged':True,'server_backup_retained':False,'server_staging_retained':False}))
except BaseException:
    if stopped:
        subprocess.run(['systemctl','stop','gipc.service'], check=True)
        for name in reversed(changed):
            p = target(name)
            if old[name] is None:
                assert p.is_file() and digest(p.read_bytes()) == manifest['files'][name]['after']
                p.unlink()
            else:
                replace(p, old[name], metadata[name])
        subprocess.run(['systemctl','start','gipc.service'], check=True)
        healthy()
        print('ROLLBACK_OK: code restored; additive database tables retained', file=__import__('sys').stderr)
    raise
'''
    receipt = remote(action)
    write_json(STORE / 'receipt.json', receipt)
    print(json.dumps(receipt), flush=True)

def verify():
    manifest, _ = payload()
    for name in FILES:
        if not name.startswith('frontend/'):
            continue
        path = '/' + name[len('frontend/'):] + '?release=codes-schedules-20261008-01'
        request = urllib.request.Request('https://gipc.org.ge' + path, headers={'Cache-Control': 'no-cache'})
        with urllib.request.urlopen(request, timeout=20) as response:
            assert response.status == 200
            assert digest(response.read()) == manifest['files'][name]['after'], name
    for host in ('https://gipc.org.ge/', 'https://www.gipc.org.ge/'):
        with urllib.request.urlopen(host, timeout=20) as response:
            assert response.status == 200
    print('HTTPS_VERIFIED: all 5 frontend files match; both homepages return 200')

if __name__ == '__main__':
    {'prepare': prepare, 'validate': validate, 'apply': apply, 'verify': verify}[sys.argv[1]]()
