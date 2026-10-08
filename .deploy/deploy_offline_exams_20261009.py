"""Scoped offline 1.1.12 backend release; production writer with local recovery only."""
import base64
import json
from pathlib import Path
import sys
import urllib.request

import deploy_exam_stages_20261008 as previous

release = previous.release
ROOT = release.ROOT
STORE = ROOT / '.deploy/offline-release-20261009-01'
BASELINE = ROOT / '.deploy/one-use-release-20261009-01/manifest.json'
FILES = [
    'backend/app/models.py', 'backend/app/schemas.py',
    'backend/app/routers/admin.py', 'backend/app/routers/exam.py',
    'backend/app/routers/multi_apartment.py', 'backend/app/routers/multi_functional.py',
    'backend/app/services/exam_lifecycle.py',
    'backend/app/services/offline_attempts.py', 'backend/app/services/offline_grading.py',
]
NEW = set(FILES[-2:])
release.FILES = FILES
release.REMOTE += r'''
OFFLINE_TABLES = {'offline_exam_attempts','offline_exam_content'}

def contract(before, after):
    assert set(after['paths']) - set(before['paths']) == {
        '/exam/offline/capabilities', '/exam/{session_id}/offline-final'}
    assert set(before['paths']).issubset(after['paths'])
    for path, operations in before['paths'].items():
        candidate = json.loads(json.dumps(after['paths'][path]))
        if path == '/exam/{session_id}/begin':
            params = candidate['post']['parameters']
            offline = [p for p in params if p['name'] == 'offline']
            assert len(offline) == 1 and not offline[0]['required']
            assert offline[0]['schema'].get('default') is False
            candidate['post']['parameters'] = [p for p in params if p['name'] != 'offline']
        assert candidate == operations, 'Unexpected route change: ' + path
    additions = {
        'StartSessionResponse': {'offline_submission_token', 'server_now', 'started_at'},
        'ExamStageStartRequest': {'projectCode', 'offline', 'startRequestId'},
        'ExamStageStartResponse': {'offlineSubmissionToken', 'endsAt', 'serverNow'},
        'MultiApartmentEvaluationSubmitRequest': {'offlineSubmissionToken', 'submissionId', 'finishedAt'},
        'MultiFunctionalEvaluationSubmitFullRequest': {'offlineSubmissionToken', 'submissionId', 'finishedAt'},
        'MultiApartmentEvaluationResponse': {'offlineSubmissionId'},
        'MultiFunctionalEvaluationResponse': {'offlineSubmissionId'},
    }
    for name, schema in before['components']['schemas'].items():
        candidate = json.loads(json.dumps(after['components']['schemas'][name]))
        added = additions.get(name, set())
        for field in added:
            assert field not in candidate.get('required', []), 'New required field: '+name+'.'+field
            candidate.get('properties', {}).pop(field, None)
        assert candidate == schema, 'Unexpected schema change: ' + name

def verify_additive_db(path, before):
    after = db_snapshot(path)
    assert set(after) - set(before) == OFFLINE_TABLES, 'Unexpected added tables'
    assert all(after.get(name) == value for name, value in before.items()), 'Existing data/schema changed'
    assert all(after[name][1] == 0 for name in OFFLINE_TABLES), 'Offline tables not empty'
    with closing(sqlite3.connect(path.as_uri()+'?mode=ro',uri=True)) as db:
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'

def offline_checks():
    assert get_json('/exam/offline/capabilities') == {'protocol':1,'grading_snapshots':True}
    result = public_checks()
    request = urllib.request.Request('http://127.0.0.1:8000/exam/0/offline-final',
        data=json.dumps({'stage_grant_id':0,'submission_id':'00000000-0000-0000-0000-000000000001',
            'finished_at':'2026-10-09T00:00:00Z','answers':[]}).encode(),
        method='POST', headers={'Content-Type':'application/json'})
    try:
        urllib.request.urlopen(request, timeout=5)
        raise AssertionError('Offline final accepted without authorization')
    except urllib.error.HTTPError as error:
        assert error.code in (401,403)
    return {**result, 'offline_capabilities_verified':True, 'offline_final_protected':True}
'''


def preflight():
    result = release.remote(r'''
env=service_env()
with closing(sqlite3.connect(DB.as_uri()+'?mode=ro',uri=True)) as db:
    counts = {
        'unfinished_sessions':db.execute('SELECT count(*) FROM sessions WHERE active=1 AND finished_at IS NULL').fetchone()[0],
        'available_or_started_grants':db.execute("SELECT count(*) FROM user_exam_stage_grants WHERE consumed_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL AND (started_at IS NOT NULL OR datetime(expires_at)>datetime('now'))").fetchone()[0],
    }
    slot = db.execute('SELECT id,filename,size_bytes FROM app_files ORDER BY id').fetchall()
    tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'offline_exam_%'")]
print(json.dumps({'pid':service_pid(), **counts,'app_files':slot,'offline_tables':tables,
    'free_bytes':__import__('shutil').disk_usage(DB.parent).free}))
''')
    release.write_json(STORE/'preflight.json', result)
    print(json.dumps(result))


def prepare():
    assert STORE.is_dir() and (STORE/'.gitignore').is_file()
    assert not (STORE/'manifest.json').exists()
    baseline = json.loads(BASELINE.read_text(encoding='utf-8'))
    expected = dict(baseline['python_hashes'])
    expected.update({n:entry['after'] for n,entry in baseline['files'].items() if n.endswith('.py')})
    data = release.remote('expected='+repr(expected)+r'''
service_env(); exam_gate()
sources=source_files()
assert {n:digest(b) for n,b in sources.items()} == expected, 'Unreviewed production source drift'
with closing(sqlite3.connect(DB.as_uri()+'?mode=ro',uri=True)) as db:
    assert not db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('offline_exam_attempts','offline_exam_content')").fetchall()
print(json.dumps({'pid':service_pid(),'hashes':{n:digest(b) for n,b in sources.items()},
    'files':{n:digest(target(n).read_bytes()) if target(n).is_file() else None for n in FILES},
    'openapi':get_json('/openapi.json')}))
''')
    manifest={'pid':data['pid'],'files':{},'python_hashes':expected}
    for name in FILES:
        # Use prior local release sources for recovery. No production source or DB export.
        if name in NEW:
            old=None
        else:
            folder='after' if name in baseline['files'] else 'live-python'
            old=(BASELINE.parent/folder/name).read_bytes()
        new=(ROOT/name).read_bytes()
        assert (old is None) == (name in NEW)
        assert data['files'][name]==(release.digest(old) if old is not None else None)
        if old is not None: assert release.digest(old)==expected[name]
        compile(new,name,'exec')
        for folder,content in [('before',old),('after',new)]:
            if content is not None:
                path=STORE/folder/name; path.parent.mkdir(parents=True,exist_ok=True); path.write_bytes(content)
        manifest['files'][name]={'before':release.digest(old) if old is not None else None,'after':release.digest(new)}
    assert data['hashes']==expected
    release.write_json(STORE/'before-openapi.json',data['openapi'])
    release.write_json(STORE/'manifest.json',manifest)
    print(json.dumps({'status':'prepared','runtime_files':len(FILES),'active_exams':0,
        'recovery':'existing local release source','database_exported':False}))


def payload():
    manifest=json.loads((STORE/'manifest.json').read_text(encoding='utf-8'))
    assert set(manifest['files'])==set(FILES)
    data={}
    for name,entry in manifest['files'].items():
        content=(STORE/'after'/name).read_bytes()
        assert release.digest(content)==entry['after']==release.digest((ROOT/name).read_bytes()), name
        if entry['before'] is not None: assert release.digest((STORE/'before'/name).read_bytes())==entry['before']
        data[name]=base64.b64encode(content).decode()
    return manifest,data


def validate():
    manifest,data=payload()
    tests={p.relative_to(ROOT).as_posix():base64.b64encode(p.read_bytes()).decode() for p in (ROOT/'backend/tests').glob('test_*.py')}
    result=release.remote('manifest='+repr(manifest)+'\npayload='+repr(data)+'\ntests='+repr(tests)+r'''
env=service_env(); assert_baseline(manifest); exam_gate()
before_api=get_json('/openapi.json')
with tempfile.TemporaryDirectory(prefix='gipc-offline-test-') as directory:
    stage=Path(directory)
    for name,content in source_files().items():
        path=stage/name; path.parent.mkdir(parents=True,exist_ok=True); path.write_bytes(content)
    for name,encoded in {**payload,**tests}.items():
        assert name.startswith('backend/') and '..' not in Path(name).parts
        path=stage/name; path.parent.mkdir(parents=True,exist_ok=True); path.write_bytes(base64.b64decode(encoded))
        compile(path.read_bytes(),name,'exec')
    result=subprocess.run([PYTHON,'-B','-W','ignore::ResourceWarning','-m','unittest','discover','-s','backend/tests','-q'],
        cwd=stage,env=isolated_env(env,stage/'test.db',stage/'test-media'),capture_output=True,text=True,timeout=240)
    assert result.returncode==0,result.stderr[-4500:]
    summary=result.stderr[-800:]
    clone=stage/'clone.db'; backup_db(clone); before=db_snapshot(clone)
    command="import json; from app.main import app,create_app; create_app(); print('SCHEMA_JSON='+json.dumps(app.openapi()))"
    result=subprocess.run([PYTHON,'-B','-c',command],cwd=stage/'backend',env=isolated_env(env,clone,stage/'clone-media'),capture_output=True,text=True,timeout=120)
    assert result.returncode==0,result.stderr[-3000:]
    schema=json.loads(next(line[len('SCHEMA_JSON='):] for line in result.stdout.splitlines() if line.startswith('SCHEMA_JSON=')))
    contract(before_api,schema); verify_additive_db(clone,before)
print(json.dumps({'status':'validated','tests':summary,'additive_contract_verified':True,'existing_data_preserved':True,
    'only_two_new_empty_tables':True,'startup_twice_verified':True,'server_staging_removed':True}))
''')
    result['manifest_sha256']=release.digest((STORE/'manifest.json').read_bytes())
    release.write_json(STORE/'validation.json',result); print(json.dumps(result))


def apply():
    manifest,data=payload()
    assert not (STORE/'receipt.json').exists(), 'Already deployed'
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
    exam_gate(); snapshot=db_snapshot(DB)
    for name in FILES:
        replace(target(name),new[name],metadata[name]); changed.append(name)
    migration_env={**os.environ,**env,'GIPC_DATABASE_PATH':str(DB),'PYTHONDONTWRITEBYTECODE':'1'}
    # Execute the same startup/migrations while stopped, before checking every
    # old table verbatim and reopening normal traffic.
    command='from app.main import app,create_app; create_app()'
    result=subprocess.run([PYTHON,'-B','-c',command],cwd=LIVE/'backend',env=migration_env,capture_output=True,text=True,timeout=60)
    assert result.returncode==0,result.stderr[-2000:]
    verify_additive_db(DB,snapshot)
    subprocess.run(['systemctl','start','gipc.service'],check=True); healthy()
    downtime=round(time.monotonic()-started,2)
    contract(before_api,get_json('/openapi.json')); checks=offline_checks()
    assert all(digest(target(n).read_bytes())==manifest['files'][n]['after'] for n in FILES)
    print(json.dumps({'status':'deployed','files':len(FILES),'pid':service_pid(),'backend_unavailable_seconds':downtime,
        'existing_data_preserved':True,'only_two_additive_tables':True,'server_backups_retained':False,**checks}))
except BaseException:
    if stopped:
        subprocess.run(['systemctl','stop','gipc.service'],check=True)
        # Never revert an offline-capable runtime after an actual offline attempt was created.
        with closing(sqlite3.connect(DB.as_uri()+'?mode=ro',uri=True)) as db:
            exists=db.execute("SELECT 1 FROM sqlite_master WHERE name='offline_exam_attempts'").fetchone()
            pending=db.execute('SELECT count(*) FROM offline_exam_attempts').fetchone()[0] if exists else 0
        if pending:
            subprocess.run(['systemctl','start','gipc.service'],check=True)
            raise RuntimeError('Offline attempt exists: new runtime retained; manual investigation required')
        for name in reversed(changed):
            p=target(name)
            if old[name] is None:
                assert digest(p.read_bytes())==manifest['files'][name]['after']; p.unlink()
            else: replace(p,old[name],metadata[name])
        subprocess.run(['systemctl','start','gipc.service'],check=True); healthy()
        print('ROLLBACK_OK: prior runtime restored; additive tables retained; no database replacement',file=__import__('sys').stderr)
    raise
''')
    release.write_json(STORE/'receipt.json',result); print(json.dumps(result))


def verify():
    manifest,_=payload()
    receipt=json.loads((STORE/'receipt.json').read_text())
    assert receipt['status']=='deployed'
    for host in ('https://gipc.org.ge','https://www.gipc.org.ge'):
        for path in ('/', '/pages/registry.html'):
            with urllib.request.urlopen(host+path,timeout=20) as response: assert response.status==200
        with urllib.request.urlopen(host+'/exam/offline/capabilities',timeout=20) as response:
            assert json.load(response)=={'protocol':1,'grading_snapshots':True}
    result=release.remote('manifest='+repr(manifest)+'\nexpected_pid='+repr(receipt['pid'])+r'''
assert service_pid()==expected_pid
assert all(digest(target(n).read_bytes())==manifest['files'][n]['after'] for n in FILES)
print(json.dumps({'pid':service_pid(),**offline_checks(),'runtime_hashes_verified':True}))
''')
    result.update(both_hostnames_verified=True)
    release.write_json(STORE/'verification.json',result); print(json.dumps(result))


if __name__=='__main__':
    {'preflight':preflight,'prepare':prepare,'validate':validate,'apply':apply,'verify':verify}[sys.argv[1]]()
