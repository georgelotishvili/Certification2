"""Guarded independent-stage deployment; local recovery files, no retained server backups."""
import base64
import gzip
import json
from pathlib import Path
import subprocess
import sys
import urllib.error
import urllib.request

import deploy_codes_schedules_20261008 as release

ROOT = release.ROOT
STORE = ROOT / '.deploy/exam-stages-release-20261008-01'
FILES = [
    'backend/app/main.py', 'backend/app/models.py', 'backend/app/schemas.py',
    'backend/app/services/exam_stage_grants.py', 'backend/app/services/exam_lifecycle.py',
    'backend/app/routers/admin.py', 'backend/app/routers/auth.py', 'backend/app/routers/users.py',
    'backend/app/routers/exam.py', 'backend/app/routers/multi_apartment.py',
    'backend/app/routers/multi_functional.py', 'backend/scripts/migrate_exam_stage_grants.py',
    'frontend/pages/admin.html', 'frontend/scripts/admin/users.js', 'frontend/styles/admin.css',
]
NEW = {'backend/app/services/exam_stage_grants.py', 'backend/scripts/migrate_exam_stage_grants.py'}
release.FILES = FILES
release.REMOTE += r'''
def exam_gate():
    no_active_exams()
    with closing(sqlite3.connect(DB.as_uri()+'?mode=ro',uri=True)) as db:
        assert db.execute('SELECT count(*) FROM sessions WHERE active=1 AND finished_at IS NULL').fetchone()[0] == 0, 'Unfinished examination; postponed'
        assert db.execute("SELECT count(*) FROM users WHERE coalesce(is_admin,0)=0 AND exam_permission=1 AND exam_stage IN ('theory','project_stage_1','project_stage_2') AND (exam_stage_started_at IS NOT NULL OR datetime(exam_stage_expires_at)>datetime('now'))").fetchone()[0] == 0, 'Candidate permission in use; postponed'
        if db.execute("SELECT 1 FROM sqlite_master WHERE name='user_exam_stage_grants'").fetchone():
            assert db.execute("SELECT count(*) FROM user_exam_stage_grants WHERE consumed_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL AND (started_at IS NOT NULL OR datetime(expires_at)>datetime('now'))").fetchone()[0] == 0, 'Independent permission in use; postponed'

def projection_snapshot(path, columns=None):
    with closing(sqlite3.connect(path.as_uri()+'?mode=ro',uri=True)) as db:
        if columns is None:
            names=[r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
            columns={n:[r[1] for r in db.execute('PRAGMA table_info("'+n+'")')] for n in names}
        result={}
        for name,fields in columns.items():
            quoted=','.join('"'+f.replace('"','""')+'"' for f in fields)
            rows=db.execute('SELECT '+quoted+' FROM "'+name+'" ORDER BY rowid').fetchall()
            result[name]=[len(rows),digest(repr(rows).encode())]
        return columns,result,sorted(db.execute('PRAGMA foreign_key_check').fetchall())

def verify_projection(path, before):
    columns,rows,fks=before
    assert projection_snapshot(path,columns)[1:] == (rows,fks), 'Existing records or foreign key state changed'
    with closing(sqlite3.connect(path.as_uri()+'?mode=ro',uri=True)) as db:
        assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'

def contract(before, after):
    assert set(before['paths']).issubset(after['paths']), 'An existing route was removed'
    for path,operations in before['paths'].items():
        candidate=json.loads(json.dumps(after['paths'][path]))
        if path in ('/public/multi-apartment/projects/random','/public/multi-functional/projects/random'):
            candidate['get']['parameters']=[p for p in candidate['get']['parameters'] if p['name']!='prepare_only']
        assert candidate==operations, 'Unexpected existing route change: '+path
    additions={
        'UserOut':{'exam_stage_permissions'}, 'StartSessionRequest':{'prepare_only'},
        'StartSessionResponse':{'stage_grant_id'},
        'PublicMultiApartmentProjectResponse':{'stageGrantId'},
        'PublicMultiFunctionalProjectResponse':{'stageGrantId'},
        'MultiApartmentEvaluationSubmitRequest':{'stageGrantId'},
        'MultiApartmentEvaluationResponse':{'stageGrantId'},
        'MultiFunctionalEvaluationSubmitRequest':{'stageGrantId'},
        'MultiFunctionalEvaluationSubmitFullRequest':{'stageGrantId'},
        'MultiFunctionalEvaluationResponse':{'stageGrantId'},
    }
    for name,schema in before['components']['schemas'].items():
        candidate=json.loads(json.dumps(after['components']['schemas'][name]))
        for added in additions.get(name,()):
            candidate.get('properties',{}).pop(added,None)
        assert candidate==schema, 'Unexpected schema change: '+name
    for path in ('/admin/users/{user_id}/exam-stage-permissions/{stage}', '/public/multi-apartment/start', '/public/multi-functional/start'):
        assert path in after['paths']

def public_checks():
    page=get_json('/certified-persons/registry/page?limit=2')
    assert isinstance(page['items'],list)
    assert isinstance(get_json('/certified-persons/registry?limit=2'),list)
    for path in ('/admin/users?paginated=true&live=true','/users/me','/admin/app-files'):
        try:
            get_json(path); raise AssertionError('Private route became public')
        except urllib.error.HTTPError as error:
            assert error.code==401
    for path in ('/admin/users/1/exam-stage-permissions/theory','/public/multi-apartment/start','/public/multi-functional/start'):
        method='PATCH' if path.startswith('/admin/') else 'POST'
        body={'granted':True} if method=='PATCH' else {'stageGrantId':None}
        request=urllib.request.Request('http://127.0.0.1:8000'+path,data=json.dumps(body).encode(),method=method,headers={'Content-Type':'application/json'})
        try:
            urllib.request.urlopen(request,timeout=5); raise AssertionError('Unauthenticated stage mutation accepted')
        except urllib.error.HTTPError as error:
            assert error.code in (401,403)
    return {'registry_total':page['total'],'private_routes_protected':True,'new_routes_protected':True}
'''


def preflight():
    data = release.remote(r'''
env=service_env(); exam_gate()
with closing(sqlite3.connect(DB.as_uri()+'?mode=ro',uri=True)) as db:
    files=[dict(zip(('id','filename','storage_path','size_bytes'),row)) for row in db.execute('SELECT id,filename,storage_path,size_bytes FROM app_files ORDER BY id')]
print(json.dumps({'pid':service_pid(),'active_exams':0,'media_root':env.get('MEDIA_ROOT'), 'app_files':files,'free_bytes':__import__('shutil').disk_usage(DB.parent).free}))
''')
    release.write_json(STORE/'preflight.json',data)
    print(json.dumps(data))


def prepare():
    assert not (STORE/'manifest.json').exists()
    data=release.remote(r'''
service_env(); exam_gate()
with tempfile.TemporaryDirectory(prefix='gipc-stage-read-') as directory:
    copy=Path(directory)/'db'; backup_db(copy); database=base64.b64encode(copy.read_bytes()).decode()
print(json.dumps({'pid':service_pid(),'files':{n:base64.b64encode(target(n).read_bytes()).decode() if target(n).is_file() else None for n in FILES},
 'sources':{n:base64.b64encode(b).decode() for n,b in source_files().items()},'database':database,'openapi':get_json('/openapi.json')}))
''')
    manifest={'pid':data['pid'],'files':{},'python_hashes':{}}
    normalize=lambda b:b.decode('utf-8-sig').replace('\r\n','\n')
    for name in FILES:
        old=base64.b64decode(data['files'][name]) if data['files'][name] is not None else None
        new=(ROOT/name).read_bytes()
        if name in NEW:
            assert old is None, 'Unexpected existing new file: '+name
        else:
            baseline=subprocess.check_output(['git','show','HEAD:'+name],cwd=ROOT)
            assert old is not None and normalize(old)==normalize(baseline), 'Unreviewed live drift: '+name
        for folder,content in (('before',old),('after',new)):
            if content is not None:
                path=STORE/folder/name; path.parent.mkdir(parents=True,exist_ok=True); path.write_bytes(content)
        manifest['files'][name]={'before':release.digest(old) if old is not None else None,'after':release.digest(new)}
    for name,encoded in data['sources'].items():
        content=base64.b64decode(encoded)
        path=STORE/'live-python'/name; path.parent.mkdir(parents=True,exist_ok=True); path.write_bytes(content)
        manifest['python_hashes'][name]=release.digest(content)
    database=base64.b64decode(data['database']); (STORE/'before.db').write_bytes(database)
    manifest['database_snapshot_sha256']=release.digest(database)
    release.write_json(STORE/'before-openapi.json',data['openapi'])
    release.write_json(STORE/'manifest.json',manifest)
    print(json.dumps({'status':'prepared','files':len(FILES),'active_exams':0,'rollback_copies':'local only'}))


def payload():
    manifest=json.loads((STORE/'manifest.json').read_text())
    data={}
    for name,entry in manifest['files'].items():
        content=(STORE/'after'/name).read_bytes()
        assert release.digest(content)==entry['after']==release.digest((ROOT/name).read_bytes())
        if entry['before'] is not None:
            assert release.digest((STORE/'before'/name).read_bytes())==entry['before']
        data[name]=base64.b64encode(content).decode()
    return manifest,data


def validate():
    manifest,data=payload()
    tests={p.relative_to(ROOT).as_posix():base64.b64encode(p.read_bytes()).decode() for p in (ROOT/'backend/tests').glob('test_*.py')}
    result=release.remote('manifest='+repr(manifest)+'\npayload='+repr(data)+'\ntests='+repr(tests)+r'''
env=service_env(); assert_baseline(manifest); exam_gate()
before_api=get_json('/openapi.json')
with tempfile.TemporaryDirectory(prefix='gipc-stage-test-') as directory:
    stage=Path(directory)
    for name,content in source_files().items():
        path=stage/name; path.parent.mkdir(parents=True,exist_ok=True); path.write_bytes(content)
    for name,encoded in {**payload,**tests}.items():
        if not name.startswith('backend/'): continue
        path=stage/name; path.parent.mkdir(parents=True,exist_ok=True); path.write_bytes(base64.b64decode(encoded))
        compile(path.read_bytes(),name,'exec')
    test_env=isolated_env(env,stage/'test.db',stage/'test-media')
    # Run from stage root so both backend.app and app-style tests retain their
    # documented imports. The stage contains only Python source, no secrets.
    result=subprocess.run([PYTHON,'-B','-W','ignore::ResourceWarning','-m','unittest','discover','-s','backend/tests','-q'],cwd=stage,env=test_env,capture_output=True,text=True)
    assert result.returncode==0,result.stderr[-4000:]
    summary=result.stderr[-600:]
    clone=stage/'clone.db'; backup_db(clone); snapshot=projection_snapshot(clone)
    migration_env=isolated_env(env,clone,stage/'clone-media')
    command="import json; from app.main import app, create_app; create_app(); print('SCHEMA_JSON='+json.dumps(app.openapi()))"
    result=subprocess.run([PYTHON,'-B','-c',command],cwd=stage/'backend',env=migration_env,capture_output=True,text=True)
    assert result.returncode==0,result.stderr[-3000:]
    schema=json.loads(next(line[len('SCHEMA_JSON='):] for line in result.stdout.splitlines() if line.startswith('SCHEMA_JSON=')))
    contract(before_api,schema); verify_projection(clone,snapshot)
print(json.dumps({'status':'validated','tests':summary,'existing_columns_and_records_unchanged':True,'additive_contract_verified':True,'migration_twice_ok':True,'server_staging_removed':True}))
''')
    result['manifest_sha256']=release.digest((STORE/'manifest.json').read_bytes())
    release.write_json(STORE/'validation.json',result); print(json.dumps(result))


def apply():
    manifest,data=payload()
    validation=json.loads((STORE/'validation.json').read_text())
    assert validation['status']=='validated' and validation['manifest_sha256']==release.digest((STORE/'manifest.json').read_bytes())
    result=release.remote('manifest='+repr(manifest)+'\npayload='+repr(data)+r'''
env=service_env(); assert_baseline(manifest); exam_gate()
before_api=get_json('/openapi.json')
old,metadata,new={},{},{}
for name in FILES:
    p=target(name); old[name]=p.read_bytes() if p.is_file() else None
    st=p.stat() if p.is_file() else None
    metadata[name]=(st.st_uid,st.st_gid,st.st_mode&0o777) if st else (0,0,0o644)
    new[name]=base64.b64decode(payload[name],validate=True)
    assert digest(new[name])==manifest['files'][name]['after']
changed=[]; stopped=False; started=time.monotonic()
try:
    subprocess.run(['systemctl','stop','gipc.service'],check=True); stopped=True
    exam_gate(); snapshot=projection_snapshot(DB)
    for name in FILES:
        if name.startswith('backend/'):
            replace(target(name),new[name],metadata[name]); changed.append(name)
    migration_env={**os.environ,**env,'GIPC_DATABASE_PATH':str(DB),'PYTHONDONTWRITEBYTECODE':'1'}
    result=subprocess.run([PYTHON,'-B','-c','from scripts.migrate_exam_stage_grants import run; run()'],cwd=LIVE/'backend',env=migration_env,capture_output=True,text=True)
    assert result.returncode==0,result.stderr[-2000:]
    verify_projection(DB,snapshot)
    subprocess.run(['systemctl','start','gipc.service'],check=True); healthy()
    downtime=round(time.monotonic()-started,2)
    contract(before_api,get_json('/openapi.json')); checks=public_checks()
    verify_projection(DB,snapshot)
    for name in FILES:
        if name.startswith('frontend/'):
            replace(target(name),new[name],metadata[name]); changed.append(name)
    assert all(digest(target(name).read_bytes())==manifest['files'][name]['after'] for name in FILES)
    print(json.dumps({'status':'deployed','files':len(FILES),'pid':service_pid(),'backend_unavailable_seconds':downtime,'existing_data_preserved':True,'server_backups_retained':False,'server_staging_retained':False,**checks}))
except BaseException:
    if stopped:
        subprocess.run(['systemctl','stop','gipc.service'],check=True)
        for name in reversed(changed):
            p=target(name)
            if old[name] is None:
                assert digest(p.read_bytes())==manifest['files'][name]['after']; p.unlink()
            else: replace(p,old[name],metadata[name])
        subprocess.run(['systemctl','start','gipc.service'],check=True); healthy()
        print('ROLLBACK_OK: prior runtime restored; additive schema retained; no database replacement',file=__import__('sys').stderr)
    raise
''')
    release.write_json(STORE/'receipt.json',result); print(json.dumps(result))


def verify():
    manifest,_=payload(); checked=0
    for host in ('https://gipc.org.ge','https://www.gipc.org.ge'):
        for name in FILES:
            if not name.startswith('frontend/'): continue
            request=urllib.request.Request(host+'/'+name.removeprefix('frontend/')+'?v=20261008-stages1',headers={'Cache-Control':'no-cache','Accept-Encoding':'gzip'})
            with urllib.request.urlopen(request,timeout=20) as response:
                raw=response.read()
                if response.headers.get('Content-Encoding')=='gzip': raw=gzip.decompress(raw)
                assert response.status==200 and release.digest(raw)==manifest['files'][name]['after']
                checked+=1
        with urllib.request.urlopen(host+'/',timeout=20) as response: assert response.status==200
    result=release.remote('print(json.dumps({"pid":service_pid(),**public_checks()}))')
    result.update(https_assets_verified=checked,both_hostnames_verified=True)
    release.write_json(STORE/'verification.json',result); print(json.dumps(result))


if __name__=='__main__':
    {'preflight':preflight,'prepare':prepare,'validate':validate,'apply':apply,'verify':verify}[sys.argv[1]]()
