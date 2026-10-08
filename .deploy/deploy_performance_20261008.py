"""Scoped performance release: local rollback copies, no DB migrations, guarded restart."""
import base64
import gzip
import json
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

import deploy_codes_schedules_20261008 as release

ROOT = release.ROOT
STORE = ROOT / '.deploy/performance-release-20261008-01'
FILES = [
    'backend/app/routers/admin.py', 'backend/app/routers/registry.py',
    'frontend/assets/fonts/dejavu-sans.woff2', 'frontend/assets/fonts/bpg_nino_mtavruli_bold.woff2',
    'frontend/styles/styles.css', 'frontend/styles/admin.css', 'frontend/styles/registry.css',
    'frontend/scripts/admin/shared.js', 'frontend/scripts/admin/documents.js',
    'frontend/scripts/admin/certificate.js', 'frontend/scripts/admin/results.js',
    'frontend/scripts/admin/project-results.js', 'frontend/scripts/admin/statements.js',
    'frontend/scripts/admin/users.js', 'frontend/scripts/my.js', 'frontend/scripts/registry.mini.js',
    'frontend/pages/admin.html', 'frontend/pages/index.html', 'frontend/pages/my.html',
    'frontend/pages/registry.html',
]
CONFIG = '/etc/nginx/sites-enabled/gipc'
CANDIDATE = ROOT / '.deploy/static-delivery-20261008/gipc.candidate.v2.conf'
release.FILES = FILES
release.REMOTE += r'''
CONFIG = Path('/etc/nginx/sites-enabled/gipc')

def config_target():
    assert CONFIG.is_file() and not CONFIG.is_symlink() and CONFIG.resolve() == CONFIG
    return CONFIG

def exam_gate():
    no_active_exams()
    with closing(sqlite3.connect(DB.as_uri() + '?mode=ro', uri=True)) as db:
        db.execute('PRAGMA query_only=ON')
        assert db.execute("SELECT count(*) FROM sessions WHERE active=1 AND finished_at IS NULL").fetchone()[0] == 0, 'Unfinished exams: postponed'
        count = db.execute("SELECT count(*) FROM users WHERE coalesce(is_admin,0)=0 AND exam_permission=1 AND exam_stage IN ('theory','project_stage_1','project_stage_2') AND (exam_stage_started_at IS NOT NULL OR datetime(exam_stage_expires_at)>datetime('now'))").fetchone()[0]
        assert count == 0, 'Candidate exam stages: postponed'

def nginx_test(candidate):
    main = Path('/etc/nginx/nginx.conf').read_text()
    anchor = 'include /etc/nginx/sites-enabled/*;'
    assert main.count(anchor) == 1
    assert list(Path('/etc/nginx/sites-enabled').iterdir()) == [CONFIG]
    fd = os.memfd_create('gipc-performance-nginx-check', 0)
    try:
        os.write(fd, main.replace(anchor, candidate.decode()).encode())
        os.lseek(fd, 0, os.SEEK_SET)
        result = subprocess.run(['nginx','-t','-c','/proc/self/fd/'+str(fd)], pass_fds=(fd,), capture_output=True, text=True)
    finally:
        os.close(fd)
    assert result.returncode == 0, result.stderr

def contract(before, after):
    for path, operations in before['paths'].items():
        if path == '/admin/users':
            old = json.loads(json.dumps(operations))
            new = json.loads(json.dumps(after['paths'][path]))
            extra = {'paginated','live','new_statements','pending_statements','qualification'}
            new['get']['parameters'] = [p for p in new['get']['parameters'] if p['name'] not in extra]
            # Legacy JSON remains UsersListResponse, but optional compact page
            # responses intentionally remove the fixed OpenAPI response model.
            assert new['get']['responses']['200']['content']['application/json']['schema'] == {}
            new['get']['responses']['200'] = old['get']['responses']['200']
            assert new == old, 'Unexpected admin contract change'
        else:
            assert after['paths'].get(path) == operations, 'Changed existing route: '+path
    for name, schema in before['components']['schemas'].items():
        if name == 'UsersListResponse' and name not in after['components']['schemas']:
            continue
        assert after['components']['schemas'].get(name) == schema, 'Changed existing schema: '+name
    assert '/certified-persons/registry/page' in after['paths']

def public_checks():
    page = get_json('/certified-persons/registry/page?limit=2&sort=name_asc')
    assert set(page) == {'items','total','filtered_total','offset','limit'}
    assert page['limit'] == 2 and len(page['items']) <= 2 and page['total'] >= len(page['items'])
    legacy = get_json('/certified-persons/registry?limit=2')
    assert isinstance(legacy, list)
    allowed = {'id','full_name','photo_url','unique_code','qualification','certificate_status','rating','registration_date'}
    assert all(set(row) == allowed for row in page['items'] + legacy)
    if legacy:
        row = legacy[0]
        profile = get_json('/users/'+str(row['id'])+'/public-details')
        assert set(profile) == {'id','code','first_name','last_name','email','created_at','certificate'}
    for path in ('/admin/users', '/admin/users?paginated=true&live=true', '/users/me', '/admin/users/1/exam-schedules'):
        try:
            get_json(path)
            raise AssertionError('Private route became public: '+path)
        except urllib.error.HTTPError as error:
            assert error.code == 401, (path,error.code)
    return {'registry_total':page['total'],'public_projection_safe':True,'legacy_registry_ok':True,'private_routes_require_auth':True}
'''


def norm(data):
    return data.decode('utf-8-sig').replace('\r\n', '\n')


def prepare():
    assert not (STORE/'manifest.json').exists()
    data = release.remote(r'''
service_env(); exam_gate()
print(json.dumps({'pid':service_pid(), 'nginx_pid':Path('/run/nginx.pid').read_text().strip(),
    'config':base64.b64encode(config_target().read_bytes()).decode(),
    'files':{name:base64.b64encode(target(name).read_bytes()).decode() if target(name).is_file() else None for name in FILES},
    'python_hashes':{name:digest(content) for name,content in source_files().items()},
    'openapi':get_json('/openapi.json')}))
''')
    manifest = {key:data[key] for key in ('pid','nginx_pid','python_hashes')}
    manifest['files'] = {}
    for name in FILES:
        old = base64.b64decode(data['files'][name]) if data['files'][name] else None
        new = (ROOT/name).read_bytes()
        if old is None:
            assert name.endswith('.woff2'), 'Unexpected missing production file: '+name
        else:
            original = subprocess.check_output(['git','show','HEAD:'+name], cwd=ROOT)
            assert norm(old) == norm(original), 'Unreviewed production drift: '+name
        for folder, content in [('before',old),('after',new)]:
            if content is not None:
                p=STORE/folder/name; p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(content)
        manifest['files'][name] = {'before':release.digest(old) if old is not None else None,'after':release.digest(new)}
    old_config = base64.b64decode(data['config'])
    assert norm(old_config) == norm((ROOT/'.deploy/gipc.nginx').read_bytes()), 'Nginx drift'
    (STORE/'nginx.before.conf').write_bytes(old_config)
    (STORE/'nginx.after.conf').write_bytes(CANDIDATE.read_bytes())
    manifest['config'] = {'before':release.digest(old_config),'after':release.digest(CANDIDATE.read_bytes())}
    release.write_json(STORE/'before-openapi.json',data['openapi'])
    release.write_json(STORE/'manifest.json',manifest)
    print(json.dumps({'status':'prepared','runtime_files':len(FILES),'rollback_copies':'local only','active_candidate_exams':0,'database_migration':False}))


def payload():
    manifest=json.loads((STORE/'manifest.json').read_text())
    data={}
    for name, entry in manifest['files'].items():
        if entry['before'] is not None:
            assert release.digest((STORE/'before'/name).read_bytes()) == entry['before']
        content=(STORE/'after'/name).read_bytes()
        assert release.digest(content) == entry['after'] == release.digest((ROOT/name).read_bytes())
        data[name]=base64.b64encode(content).decode()
    assert release.digest((STORE/'nginx.before.conf').read_bytes()) == manifest['config']['before']
    cfg=(STORE/'nginx.after.conf').read_bytes()
    assert release.digest(cfg) == manifest['config']['after'] == release.digest(CANDIDATE.read_bytes())
    return manifest,data,base64.b64encode(cfg).decode()


def validate():
    manifest,data,cfg=payload()
    tests={p.relative_to(ROOT).as_posix():base64.b64encode(p.read_bytes()).decode() for p in (ROOT/'backend/tests').glob('test_*.py')}
    action='manifest='+repr(manifest)+'\npayload='+repr(data)+'\nconfig='+repr(cfg)+'\ntests='+repr(tests)+r'''
env=service_env(); assert_baseline(manifest)
assert digest(config_target().read_bytes()) == manifest['config']['before']
nginx_test(base64.b64decode(config))
before_api=get_json('/openapi.json')
with tempfile.TemporaryDirectory(prefix='gipc-performance-test-') as directory:
    stage=Path(directory)
    for name,content in source_files().items():
        p=stage/name; p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(content)
    for name,encoded in {**payload,**tests}.items():
        if not name.startswith('backend/'): continue
        p=stage/name; p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(base64.b64decode(encoded,validate=True))
        compile(p.read_bytes(),name,'exec')
    # Test on an isolated empty DB; inspect startup separately on a consistent
    # disposable DB clone. No test or migration points at the production DB.
    test_env=isolated_env(env,stage/'test.db',stage/'test-media')
    result=subprocess.run([PYTHON,'-B','-m','unittest','discover','-s','tests','-q'],cwd=stage/'backend',env=test_env,capture_output=True,text=True)
    assert result.returncode == 0, result.stderr[-4000:]
    summary=result.stderr[-700:]
    clone=stage/'clone.db'; backup_db(clone); snapshot=db_snapshot(clone)
    startup_env=isolated_env(env,clone,stage/'clone-media')
    result=subprocess.run([PYTHON,'-B','-c',"import json; from app.main import app; print('SCHEMA_JSON='+json.dumps(app.openapi()))"],cwd=stage/'backend',env=startup_env,capture_output=True,text=True)
    assert result.returncode == 0, result.stderr[-2500:]
    schema=json.loads(next(line[len('SCHEMA_JSON='):] for line in result.stdout.splitlines() if line.startswith('SCHEMA_JSON=')))
    contract(before_api,schema)
    assert db_snapshot(clone) == snapshot, 'Existing data changed during candidate startup'
print(json.dumps({'status':'validated','tests':summary,'database_clone_unchanged':True,'existing_exam_api_contracts_unchanged':True,'nginx_syntax_ok':True,'temporary_staging_removed':True}))
'''
    receipt=release.remote(action)
    receipt['manifest_sha256']=release.digest((STORE/'manifest.json').read_bytes())
    release.write_json(STORE/'validation.json',receipt); print(json.dumps(receipt),flush=True)


def apply():
    manifest,data,cfg=payload()
    validation=json.loads((STORE/'validation.json').read_text())
    assert validation['status']=='validated' and validation['manifest_sha256']==release.digest((STORE/'manifest.json').read_bytes())
    action='manifest='+repr(manifest)+'\npayload='+repr(data)+'\nconfig='+repr(cfg)+r'''
service_env(); assert_baseline(manifest); exam_gate()
assert digest(config_target().read_bytes()) == manifest['config']['before']
new_config=base64.b64decode(config,validate=True); nginx_test(new_config)
before_api=get_json('/openapi.json')
old,metadata,new={},{},{}
for name in FILES:
    p=target(name); old[name]=p.read_bytes() if p.is_file() else None
    st=p.stat() if p.is_file() else None
    metadata[name]=(st.st_uid,st.st_gid,st.st_mode & 0o777) if st else (0,0,0o644)
    new[name]=base64.b64decode(payload[name],validate=True)
    assert digest(new[name])==manifest['files'][name]['after']
old_config=config_target().read_bytes(); st=CONFIG.stat(); config_metadata=(st.st_uid,st.st_gid,st.st_mode & 0o777)
changed=[]; config_changed=False; stopped=False; started_at=time.monotonic()
try:
    subprocess.run(['systemctl','stop','gipc.service'],check=True); stopped=True
    exam_gate()
    snapshot=db_snapshot(DB)
    for name in FILES:
        if name.startswith('backend/'):
            replace(target(name),new[name],metadata[name]); changed.append(name)
    # Verify that the release itself touched no production table.
    assert db_snapshot(DB)==snapshot
    subprocess.run(['systemctl','start','gipc.service'],check=True); healthy()
    backend_unavailable_seconds=round(time.monotonic()-started_at,2)
    contract(before_api,get_json('/openapi.json')); checks=public_checks()
    for name in FILES:
        if name.startswith('frontend/'):
            replace(target(name),new[name],metadata[name]); changed.append(name)
    replace(CONFIG,new_config,config_metadata); config_changed=True
    subprocess.run(['nginx','-t'],check=True,capture_output=True)
    subprocess.run(['systemctl','reload','nginx'],check=True)
    assert all(digest(target(name).read_bytes())==manifest['files'][name]['after'] for name in FILES)
    assert digest(CONFIG.read_bytes())==manifest['config']['after']
    assert Path('/run/nginx.pid').read_text().strip()==manifest['nginx_pid']
    print(json.dumps({'status':'deployed','files':len(FILES),'pid':service_pid(),'backend_unavailable_seconds':backend_unavailable_seconds,
      'nginx_graceful_reload':True,'nginx_master_pid_unchanged':True,'database_migration':False,'server_backups_retained':False,**checks}))
except BaseException:
    rollback_errors=[]
    if config_changed:
        try:
            replace(CONFIG,old_config,config_metadata)
            subprocess.run(['nginx','-t'],check=True,capture_output=True)
            subprocess.run(['systemctl','reload','nginx'],check=True)
        except BaseException as error:
            rollback_errors.append('nginx rollback: '+str(error))
    if stopped:
        try:
            subprocess.run(['systemctl','stop','gipc.service'],check=True)
        except BaseException as error:
            rollback_errors.append('application stop: '+str(error))
        for name in reversed(changed):
            try:
                p=target(name)
                if old[name] is None:
                    assert name.endswith('.woff2') and digest(p.read_bytes())==manifest['files'][name]['after']; p.unlink()
                else: replace(p,old[name],metadata[name])
            except BaseException as error:
                rollback_errors.append(name+': '+str(error))
        try:
            subprocess.run(['systemctl','start','gipc.service'],check=True); healthy()
        except BaseException as error:
            rollback_errors.append('application recovery: '+str(error))
        print('ROLLBACK_ERRORS: '+json.dumps(rollback_errors) if rollback_errors else 'ROLLBACK_OK: original code/config restored; no database rollback or deletion',file=__import__('sys').stderr)
    raise
'''
    receipt=release.remote(action); release.write_json(STORE/'receipt.json',receipt); print(json.dumps(receipt),flush=True)


def get(url, headers=None):
    req=urllib.request.Request(url,headers={'Cache-Control':'no-cache',**(headers or {})})
    try:
        with urllib.request.urlopen(req,timeout=20) as res:
            return res.status,res.headers,res.read()
    except urllib.error.HTTPError as error:
        return error.code,error.headers,error.read()


def verify():
    manifest,_,_=payload(); count=0
    for host in ('https://gipc.org.ge','https://www.gipc.org.ge'):
        for name in FILES:
            if not name.startswith('frontend/'): continue
            path='/'+name.removeprefix('frontend/')
            status,headers,raw=get(host+path+'?v=20261008-perf1',{'Accept-Encoding':'gzip'})
            assert status==200,(path,status)
            decoded=gzip.decompress(raw) if headers.get('Content-Encoding')=='gzip' else raw
            assert release.digest(decoded)==manifest['files'][name]['after'],path
            if name.endswith(('.js','.css')):
                assert headers.get('Content-Encoding')=='gzip',path
                assert 'max-age=3600' in headers.get('Cache-Control',''),path
            elif name.endswith('.woff2'):
                assert headers.get_content_type()=='font/woff2' and headers.get('Content-Encoding') is None,path
            elif name.endswith('.html'):
                assert 'no-cache' in headers.get('Cache-Control',''),path
            count+=1
        status,_,body=get(host+'/')
        assert status==200 and release.digest(body)==manifest['files']['frontend/pages/index.html']['after']
        status,headers,body=get(host+'/certified-persons/registry/page?limit=2')
        assert status==200 and set(json.loads(body))=={'items','total','filtered_total','offset','limit'}
        assert 'max-age=3600' not in headers.get('Cache-Control','')
        status,headers,body=get(host+'/admin/users?paginated=true&live=true')
        assert status==401 and 'max-age=3600' not in headers.get('Cache-Control','')
        status,headers,body=get(host+'/styles/styles.css')
        assert status==200 and 'no-cache' in headers.get('Cache-Control','')
        status,_,_=get(host+'/styles/styles.css',{'If-None-Match':headers['ETag']})
        assert status==304,'Static revalidation failed'
    checks=release.remote("print(json.dumps({'pid':service_pid(),'nginx_active':subprocess.run(['systemctl','is-active','--quiet','nginx']).returncode==0,**public_checks()}))")
    checks.update({'https_assets_verified':count,'both_hostnames_verified':True,'gzip_and_font_mime_ok':True,'cache_revalidation_ok':True,'private_api_not_cached':True})
    release.write_json(STORE/'verification.json',checks); print(json.dumps(checks),flush=True)


if __name__=='__main__':
    {'prepare':prepare,'validate':validate,'apply':apply,'verify':verify}[sys.argv[1]]()
