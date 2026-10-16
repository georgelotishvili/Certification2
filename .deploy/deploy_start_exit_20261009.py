"""Scoped interruption API release: three Python files, no DB migrations/exports."""
import base64
import json
import sys
import urllib.request

import deploy_offline_exams_20261009 as previous

release = previous.release
ROOT = release.ROOT
STORE = ROOT / '.deploy/start-exit-release-20261009-01'
BASELINE = ROOT / '.deploy/offline-release-20261009-01/manifest.json'
FILES = ['backend/app/schemas.py', 'backend/app/routers/exam.py',
         'backend/app/services/offline_attempts.py']
CAPABILITIES = {'protocol': 1, 'grading_snapshots': True, 'interruption_cancellation': True}
release.FILES = FILES
release.REMOTE += r'''
def exam_counts():
    with closing(sqlite3.connect(DB.as_uri()+'?mode=ro',uri=True)) as db:
        return {
            'active_sessions': db.execute('SELECT count(*) FROM sessions WHERE active=1 AND finished_at IS NULL').fetchone()[0],
            'started_open_grants': db.execute('SELECT count(*) FROM user_exam_stage_grants WHERE started_at IS NOT NULL AND consumed_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL').fetchone()[0],
            'unsubmitted_offline_attempts': db.execute('SELECT count(*) FROM offline_exam_attempts WHERE submitted_at IS NULL').fetchone()[0],
            'unstarted_available_grants': db.execute("SELECT count(*) FROM user_exam_stage_grants WHERE started_at IS NULL AND consumed_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL AND datetime(expires_at)>datetime('now')").fetchone()[0],
            'unstarted_prepared_sessions': db.execute('SELECT count(*) FROM sessions s LEFT JOIN user_exam_stage_grants g ON g.id=s.stage_grant_id WHERE s.active=0 AND s.finished_at IS NULL AND g.started_at IS NULL AND NOT EXISTS(SELECT 1 FROM offline_exam_attempts a WHERE a.session_id=s.id)').fetchone()[0],
        }

def exam_gate():
    counts = exam_counts()
    assert all(counts[name] == 0 for name in ('active_sessions','started_open_grants','unsubmitted_offline_attempts')), 'Started or offline-unfinished exam exists; release postponed: '+json.dumps(counts)
    return counts

def contract(before, after):
    assert set(after['paths']) - set(before['paths']) == {'/exam/offline/cancel'}
    assert set(before['paths']).issubset(after['paths'])
    for path, operations in before['paths'].items():
        assert after['paths'][path] == operations, 'Unexpected existing route change: '+path
    for name, schema in before['components']['schemas'].items():
        assert after['components']['schemas'][name] == schema, 'Unexpected existing schema change: '+name
    assert set(after['components']['schemas']) - set(before['components']['schemas']) == {'OfflineAttemptCancelRequest'}
    route = after['paths']['/exam/offline/cancel']
    assert set(route) == {'post'}
    request = after['components']['schemas']['OfflineAttemptCancelRequest']
    assert request['additionalProperties'] is False
    assert set(request['required']) == {'stage','cancellation_id'}

def exact_db_snapshot(path):
    snapshot = db_snapshot(path)
    with closing(sqlite3.connect(path.as_uri()+'?mode=ro',uri=True)) as db:
        schema = db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").fetchall()
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    return {'data': snapshot, 'schema': schema}

def cancellation_checks():
    assert get_json('/exam/offline/capabilities') == {'protocol':1,'grading_snapshots':True,'interruption_cancellation':True}
    result = public_checks()
    for body in (
        {'stage':'theory','session_id':1,'stage_grant_id':None,'cancellation_id':'00000000-0000-0000-0000-000000000001'},
        {'stage':'theory','session_id':1,'stage_grant_id':None,'cancellation_id':'00000000-0000-0000-0000-000000000001','offline_submission_token':'synthetic-invalid-capability'},
    ):
        request = urllib.request.Request('http://127.0.0.1:8000/exam/offline/cancel',data=json.dumps(body).encode(),method='POST',headers={'Content-Type':'application/json'})
        try:
            urllib.request.urlopen(request,timeout=5)
            raise AssertionError('Cancellation accepted without valid authorization')
        except urllib.error.HTTPError as error:
            assert error.code == 401
    return {**result,'interruption_capability_verified':True,'cancellation_unauthorized_rejected':True}
'''


def expected_baseline():
    baseline = json.loads(BASELINE.read_text(encoding='utf-8'))
    deployed = json.loads((BASELINE.parent / 'receipt.json').read_text(encoding='utf-8'))
    assert deployed['status'] == 'deployed'
    expected = dict(baseline['python_hashes'])
    expected.update({name: entry['after'] for name, entry in baseline['files'].items() if name.endswith('.py')})
    return baseline, expected


def preflight():
    _, expected = expected_baseline()
    data = release.remote('expected='+repr(expected)+r'''
service_env()
hashes = {name:digest(content) for name,content in source_files().items()}
counts = exam_counts()
with closing(sqlite3.connect(DB.as_uri()+'?mode=ro',uri=True)) as db:
    slots = db.execute('SELECT id,filename,size_bytes FROM app_files ORDER BY id').fetchall()
print(json.dumps({'pid':service_pid(),**counts,'source_baseline_matches':hashes==expected,
    'capabilities':get_json('/exam/offline/capabilities'),'app_files':slots,
    'free_bytes':__import__('shutil').disk_usage(DB.parent).free}))
''')
    release.write_json(STORE / 'preflight.json', data)
    print(json.dumps(data))


def prepare():
    assert STORE.is_dir() and (STORE / '.gitignore').is_file()
    assert not (STORE / 'manifest.json').exists(), 'Already prepared'
    baseline, expected = expected_baseline()
    data = release.remote('expected='+repr(expected)+r'''
service_env(); counts=exam_gate()
hashes={name:digest(content) for name,content in source_files().items()}
assert hashes==expected,'Unreviewed production Python drift'
print(json.dumps({'pid':service_pid(),'counts':counts,'hashes':hashes,
    'openapi':get_json('/openapi.json'),'files':{name:digest(target(name).read_bytes()) for name in FILES}}))
''')
    manifest = {'pid': data['pid'], 'files': {}, 'python_hashes': expected,
                'baseline_manifest_sha256': release.digest(BASELINE.read_bytes()), 'no_database_migration': True}
    for name in FILES:
        old = (BASELINE.parent / 'after' / name).read_bytes()
        new = (ROOT / name).read_bytes()
        assert release.digest(old) == baseline['files'][name]['after'] == expected[name] == data['files'][name]
        assert old != new, 'Unchanged file must not be deployed: '+name
        compile(new, name, 'exec')
        for folder, content in [('before', old), ('after', new)]:
            destination = STORE / folder / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
        manifest['files'][name] = {'before': release.digest(old), 'after': release.digest(new)}
    release.write_json(STORE / 'before-openapi.json', data['openapi'])
    release.write_json(STORE / 'manifest.json', manifest)
    print(json.dumps({'status': 'prepared', 'runtime_files': len(FILES), 'counts': data['counts'],
                      'recovery': 'prior local release source', 'database_exported': False}))


def payload():
    manifest = json.loads((STORE / 'manifest.json').read_text(encoding='utf-8'))
    assert set(manifest['files']) == set(FILES)
    data = {}
    for name, entry in manifest['files'].items():
        assert release.digest((STORE / 'before' / name).read_bytes()) == entry['before']
        content = (STORE / 'after' / name).read_bytes()
        assert release.digest(content) == entry['after'] == release.digest((ROOT / name).read_bytes()), name
        data[name] = base64.b64encode(content).decode()
    return manifest, data


def validate():
    manifest, data = payload()
    tests = {file.relative_to(ROOT).as_posix(): base64.b64encode(file.read_bytes()).decode()
             for file in (ROOT / 'backend/tests').glob('test_*.py')}
    result = release.remote('manifest='+repr(manifest)+'\npayload='+repr(data)+'\ntests='+repr(tests)+r'''
env=service_env(); assert_baseline(manifest); counts=exam_gate()
before_api=get_json('/openapi.json')
with tempfile.TemporaryDirectory(prefix='gipc-start-exit-test-') as directory:
    stage=Path(directory)
    for name,content in source_files().items():
        p=stage/name; p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(content)
    for name,encoded in {**payload,**tests}.items():
        assert name.startswith('backend/') and '..' not in Path(name).parts
        p=stage/name; p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(base64.b64decode(encoded,validate=True))
        compile(p.read_bytes(),name,'exec')
    check=subprocess.run([PYTHON,'-B','-W','ignore::ResourceWarning','-m','unittest','discover','-s','backend/tests','-q'],cwd=stage,
        env=isolated_env(env,stage/'test.db',stage/'test-media'),capture_output=True,text=True,timeout=240)
    assert check.returncode==0,check.stderr[-4500:]
    summary=check.stderr[-1000:]
    clone=stage/'clone.db'; backup_db(clone); before=exact_db_snapshot(clone)
    command="import json; from app.main import app,create_app; create_app(); print('SCHEMA_JSON='+json.dumps(app.openapi()))"
    check=subprocess.run([PYTHON,'-B','-c',command],cwd=stage/'backend',
        env=isolated_env(env,clone,stage/'clone-media'),capture_output=True,text=True,timeout=120)
    assert check.returncode==0,check.stderr[-3000:]
    schema=json.loads(next(line[len('SCHEMA_JSON='):] for line in check.stdout.splitlines() if line.startswith('SCHEMA_JSON=')))
    contract(before_api,schema)
    assert exact_db_snapshot(clone)==before,'Startup changed existing data or schema'
assert_baseline(manifest)
print(json.dumps({'status':'validated','tests':summary,'counts':counts,'only_new_route':'/exam/offline/cancel',
    'existing_api_contracts_unchanged':True,'exact_database_and_schema_preserved':True,
    'startup_twice_verified':True,'temporary_server_staging_removed':True,'database_exported':False}))
''')
    result['manifest_sha256'] = release.digest((STORE / 'manifest.json').read_bytes())
    release.write_json(STORE / 'validation.json', result)
    print(json.dumps(result))


def apply():
    """Root must explicitly approve this step after validation review."""
    manifest, data = payload()
    assert not (STORE / 'receipt.json').exists(), 'Already deployed'
    validation = json.loads((STORE / 'validation.json').read_text(encoding='utf-8'))
    assert validation['status'] == 'validated'
    assert validation['manifest_sha256'] == release.digest((STORE / 'manifest.json').read_bytes())
    result = release.remote('manifest='+repr(manifest)+'\npayload='+repr(data)+r'''
env=service_env(); assert_baseline(manifest); counts=exam_gate()
before_api=get_json('/openapi.json')
old,metadata,new={},{},{}
for name in FILES:
    p=target(name); old[name]=p.read_bytes(); st=p.stat()
    metadata[name]=(st.st_uid,st.st_gid,st.st_mode&0o777)
    new[name]=base64.b64decode(payload[name],validate=True)
    assert digest(new[name])==manifest['files'][name]['after']
changed=[]; stopped=False; reopened=False; started=time.monotonic()
try:
    subprocess.run(['systemctl','stop','gipc.service'],check=True); stopped=True
    exam_gate(); snapshot=exact_db_snapshot(DB)
    for name in FILES:
        replace(target(name),new[name],metadata[name]); changed.append(name)
    assert exact_db_snapshot(DB)==snapshot,'Source replacement changed database'
    # No migration or database mutation is performed by this release helper.
    subprocess.run(['systemctl','start','gipc.service'],check=True); reopened=True; healthy()
    downtime=round(time.monotonic()-started,2)
    contract(before_api,get_json('/openapi.json')); checks=cancellation_checks()
    assert all(digest(target(name).read_bytes())==manifest['files'][name]['after'] for name in FILES)
    print(json.dumps({'status':'deployed','files':len(FILES),'pid':service_pid(),
        'backend_unavailable_seconds':downtime,'no_database_migration':True,
        'database_untouched_while_stopped':True,'server_backups_retained':False,**checks}))
except BaseException:
    if stopped:
        subprocess.run(['systemctl','stop','gipc.service'],check=True)
        if reopened:
            # The old runtime cannot understand cancellation receipts. Never
            # restore it after any client might have made this terminal event.
            with closing(sqlite3.connect(DB.as_uri()+'?mode=ro',uri=True)) as db:
                cancellations=sum(1 for (raw,) in db.execute('SELECT receipt FROM offline_exam_attempts WHERE receipt IS NOT NULL')
                    if isinstance(json.loads(raw),dict) and json.loads(raw).get('cancelled') is True)
            if cancellations:
                subprocess.run(['systemctl','start','gipc.service'],check=True)
                raise RuntimeError('Cancellation receipt exists: new runtime retained; manual investigation required')
        for name in reversed(changed): replace(target(name),old[name],metadata[name])
        subprocess.run(['systemctl','start','gipc.service'],check=True); healthy()
        print('ROLLBACK_OK: previous runtime restored; no database replacement',file=__import__('sys').stderr)
    raise
''')
    release.write_json(STORE / 'receipt.json', result)
    print(json.dumps(result))


def verify():
    manifest, _ = payload()
    receipt = json.loads((STORE / 'receipt.json').read_text(encoding='utf-8'))
    assert receipt['status'] == 'deployed'
    for host in ('https://gipc.org.ge', 'https://www.gipc.org.ge'):
        for url in ('/', '/pages/registry.html'):
            with urllib.request.urlopen(host+url, timeout=20) as response:
                assert response.status == 200
        with urllib.request.urlopen(host+'/exam/offline/capabilities', timeout=20) as response:
            assert json.load(response) == CAPABILITIES
    result = release.remote('manifest='+repr(manifest)+'\nexpected_pid='+repr(receipt['pid'])+r'''
assert service_pid()==expected_pid
assert all(digest(target(name).read_bytes())==manifest['files'][name]['after'] for name in FILES)
print(json.dumps({'pid':service_pid(),'runtime_hashes_verified':True,**cancellation_checks()}))
''')
    result['both_hostnames_verified'] = True
    release.write_json(STORE / 'verification.json', result)
    print(json.dumps(result))


if __name__ == '__main__':
    {'preflight': preflight, 'prepare': prepare, 'validate': validate,
     'apply': apply, 'verify': verify}[sys.argv[1]]()
