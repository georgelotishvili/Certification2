"""Scoped QR/public-view/registry release. Rollback material retained locally only."""
from __future__ import annotations

import base64
import json
from pathlib import Path
import sys
import urllib.request

import deploy_codes_schedules_20261008 as release

ROOT = Path(__file__).resolve().parents[1]
STORE = ROOT / '.deploy/public-qr-20261008-01'
FILES = [
    'backend/app/schemas.py', 'backend/app/routers/users.py',
    'frontend/scripts/vendor/qrcode-generator.js',
    'frontend/scripts/vendor/qrcode-generator.LICENSE.txt',
    'frontend/scripts/vendor/qrcode-generator.SOURCE.txt',
    'frontend/scripts/certificate-qr.js', 'frontend/scripts/admin/certificate.js',
    'frontend/scripts/my.js', 'frontend/scripts/header.js', 'frontend/scripts/registry.mini.js',
    'frontend/styles/styles.css', 'frontend/styles/registry.css',
    'frontend/pages/registry.html', 'frontend/robots.txt', 'frontend/sitemap.xml',
    'frontend/partials/header.html',
    'frontend/pages/my.html', 'frontend/pages/index.html', 'frontend/pages/admin.html',
]
release.STORE = STORE
release.FILES = FILES
release.REMOTE += r'''

def target(name):
    assert name in FILES
    path = LIVE / name
    assert path.resolve() == path and not path.is_symlink()
    assert path.is_relative_to(LIVE)
    return path

def assert_contract(before, after):
    for path, operations in before['paths'].items():
        assert after['paths'].get(path) == operations, 'Changed original route: ' + path
    for name, schema in before['components']['schemas'].items():
        assert after['components']['schemas'].get(name) == schema, 'Changed existing schema: ' + name
    assert '/users/public/by-code/{code}' in after['paths']
    assert '/users/{user_id}/public-details' in after['paths']

def verify_db(path, before):
    assert db_snapshot(path) == before, 'Existing database contents changed'
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as db:
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'

def public_checks():
    with closing(sqlite3.connect(DB.as_uri()+'?mode=ro',uri=True)) as db:
        row = db.execute("SELECT u.id,u.code FROM users u JOIN certificates c ON c.user_id=u.id WHERE c.status IN ('active','suspended','expired') ORDER BY u.id LIMIT 1").fetchone()
    if row:
        user_id, code = row
        first = get_json('/users/public/by-code/'+urllib.parse.quote(str(code)))
        second = get_json('/users/'+str(user_id)+'/public-details')
        assert first == second and first['id'] == user_id and first['code'] == code
        assert set(first) == {'id','code','first_name','last_name','email','created_at','certificate'}
        assert set(first['certificate']) == {'unique_code','level','status','issue_date','validity_term','valid_until'}
    for path in ('/admin/users','/expert-uploads/mine'):
        try:
            get_json(path)
            raise AssertionError('Private endpoint became public')
        except urllib.error.HTTPError as error:
            assert error.code == 401
    return bool(row)
'''


def preflight():
    data = release.remote(r'''
env=service_env()
no_active_exams()
with closing(sqlite3.connect(DB.as_uri()+'?mode=ro',uri=True)) as db:
    code_mismatches=db.execute("SELECT count(*) FROM users u LEFT JOIN user_code_reservations r ON r.personal_id=u.personal_id AND r.code=u.code WHERE r.personal_id IS NULL").fetchone()[0]
    invalid_codes=db.execute("SELECT count(*) FROM users WHERE length(code) != 10 OR code GLOB '*[^0-9]*'").fetchone()[0]
    assert code_mismatches == 0 and invalid_codes == 0
print(json.dumps({'service':'active','pid':service_pid(),'active_exams':0,'all_current_codes_reserved':True,'code_format_valid':True}))
''')
    print(json.dumps(data))


def prepare():
    release.prepare()


def validate():
    manifest, data = release.payload()
    tests = {p.relative_to(ROOT).as_posix(): base64.b64encode(p.read_bytes()).decode()
             for p in (ROOT/'backend/tests').glob('test_*.py')}
    action = 'manifest='+repr(manifest)+'\npayload='+repr(data)+'\ntests='+repr(tests)+r'''
env=service_env()
assert_baseline(manifest)
before_api=get_json('/openapi.json')
with tempfile.TemporaryDirectory(prefix='gipc-qr-test-') as directory:
    stage=Path(directory)
    for name,content in source_files().items():
        p=stage/name; p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(content)
    for name,encoded in {**payload,**tests}.items():
        p=stage/name; p.parent.mkdir(parents=True,exist_ok=True)
        p.write_bytes(base64.b64decode(encoded,validate=True))
        if name.endswith('.py'): compile(p.read_bytes(),name,'exec')
    clone=stage/'clone.db'
    backup_db(clone)
    before=db_snapshot(clone)
    test_env=isolated_env(env,clone,stage/'media')
    result=subprocess.run([PYTHON,'-B','-m','unittest','discover','-s','tests','-q'],cwd=stage/'backend',env=test_env,capture_output=True,text=True)
    assert result.returncode==0, 'Tests failed: '+result.stderr[-5000:]
    summary=result.stderr[-1800:]
    run=subprocess.run([PYTHON,'-B','-c',"import json; from app.main import app; print('SCHEMA_JSON='+json.dumps(app.openapi()))"],cwd=stage/'backend',env=test_env,capture_output=True,text=True)
    assert run.returncode==0, 'Startup failed: '+run.stderr[-2000:]
    schema=json.loads(next(line[len('SCHEMA_JSON='):] for line in run.stdout.splitlines() if line.startswith('SCHEMA_JSON=')))
    assert_contract(before_api,schema)
    verify_db(clone,before)
print(json.dumps({'status':'validated','existing_database_unchanged':True,'old_api_contracts_unchanged':True,'temporary_files_removed':True,'tests':summary}))
'''
    receipt=release.remote(action)
    receipt['manifest_sha256']=release.digest((STORE/'manifest.json').read_bytes())
    release.write_json(STORE/'validation.json',receipt)
    print(json.dumps(receipt))


def apply():
    manifest,data=release.payload()
    validation=json.loads((STORE/'validation.json').read_text(encoding='utf-8'))
    assert validation['status']=='validated'
    assert validation['manifest_sha256']==release.digest((STORE/'manifest.json').read_bytes())
    action='manifest='+repr(manifest)+'\npayload='+repr(data)+r'''
env=service_env()
assert_baseline(manifest)
no_active_exams()
before_api=get_json('/openapi.json')
old,metadata,new={},{},{}
for name in FILES:
    p=target(name)
    old[name]=p.read_bytes() if p.is_file() else None
    st=p.stat() if p.is_file() else None
    metadata[name]=(st.st_uid,st.st_gid,st.st_mode & 0o777) if st else (0,0,0o644)
    new[name]=base64.b64decode(payload[name],validate=True)
    assert digest(new[name])==manifest['files'][name]['after']
changed=[]
created_dirs=[]
stopped=False
try:
    # No schema migrations in this release. Stop only for the two Python files.
    subprocess.run(['systemctl','stop','gipc.service'],check=True)
    stopped=True
    no_active_exams()
    before=db_snapshot(DB)
    for name in FILES:
        if name.startswith('backend/'):
            replace(target(name),new[name],metadata[name]); changed.append(name)
    subprocess.run(['systemctl','start','gipc.service'],check=True)
    healthy()
    verify_db(DB,before)
    assert_contract(before_api,get_json('/openapi.json'))
    public_checked=public_checks()
    # Assets before HTML: both previous pages and new pages remain compatible.
    for name in FILES:
        if name.startswith('frontend/'):
            p=target(name)
            if not p.parent.exists():
                assert p.parent==LIVE/'frontend/scripts/vendor'
                p.parent.mkdir(mode=0o755); created_dirs.append(p.parent)
            replace(p,new[name],metadata[name]); changed.append(name)
    assert all(digest(target(name).read_bytes())==manifest['files'][name]['after'] for name in FILES)
    print(json.dumps({'status':'deployed','files':FILES,'pid':service_pid(),'existing_data_preserved':True,'old_api_contracts_unchanged':True,'public_profile_checked':public_checked,'server_backup_retained':False,'server_staging_retained':False}))
except BaseException:
    if stopped:
        subprocess.run(['systemctl','stop','gipc.service'],check=True)
        for name in reversed(changed):
            p=target(name)
            if old[name] is None:
                assert p.is_file() and digest(p.read_bytes())==manifest['files'][name]['after']; p.unlink()
            else: replace(p,old[name],metadata[name])
        for p in reversed(created_dirs):
            assert p==LIVE/'frontend/scripts/vendor'; p.rmdir()
        subprocess.run(['systemctl','start','gipc.service'],check=True)
        healthy()
        print('ROLLBACK_OK: original code restored; database not modified by release',file=__import__('sys').stderr)
    raise
'''
    receipt=release.remote(action)
    release.write_json(STORE/'receipt.json',receipt)
    print(json.dumps(receipt))


def verify():
    manifest,_=release.payload()
    count=0
    for name in FILES:
        if not name.startswith('frontend/'): continue
        url='https://gipc.org.ge/'+name[len('frontend/'):]+'?release=public-qr-20261008-01'
        req=urllib.request.Request(url,headers={'Cache-Control':'no-cache'})
        with urllib.request.urlopen(req,timeout=20) as response:
            assert response.status==200 and release.digest(response.read())==manifest['files'][name]['after'], name
        count+=1
    for host in ('https://gipc.org.ge/','https://www.gipc.org.ge/'):
        with urllib.request.urlopen(host,timeout=20) as response: assert response.status==200
    status=release.remote(r'''
assert public_checks()
info=subprocess.check_output(['systemctl','show','gipc.service','-p','ActiveState','-p','SubState','-p','NRestarts','-p','ExecMainStatus'],text=True)
assert 'ActiveState=active' in info and 'ExecMainStatus=0' in info
print(json.dumps({'service':info,'pid':service_pid(),'anonymous_profile_ok':True}))
''')
    status['https_assets_verified']=count
    release.write_json(STORE/'final-health.json',status)
    print(json.dumps(status))


if __name__=='__main__':
    {'preflight':preflight,'prepare':prepare,'validate':validate,'apply':apply,'verify':verify}[sys.argv[1]]()
