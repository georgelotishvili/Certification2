"""Scoped one-use stage release, local recovery only, no schema changes."""
import base64
import json
import sys

import deploy_exam_stages_20261008 as previous

release = previous.release
ROOT = release.ROOT
STORE = ROOT / '.deploy/one-use-release-20261009-01'
BASELINE = ROOT / '.deploy/exam-stages-release-20261008-01/manifest.json'
FILES = [
    'backend/app/schemas.py', 'backend/app/services/exam_stage_grants.py',
    'backend/app/routers/admin.py', 'backend/app/routers/exam.py',
    'backend/app/routers/multi_apartment.py', 'backend/app/routers/multi_functional.py',
    'frontend/scripts/admin/users.js', 'frontend/styles/admin.css', 'frontend/pages/admin.html',
]
previous.STORE = STORE
previous.FILES = FILES
release.FILES = FILES
release.REMOTE += r'''
def contract(before, after):
    assert before['paths'] == after['paths'], 'Existing API route contract changed'
    expected = {'replace_started', 'expected_grant_id'}
    for name, schema in before['components']['schemas'].items():
        candidate=json.loads(json.dumps(after['components']['schemas'][name]))
        if name == 'ToggleExamStagePermissionRequest':
            assert expected.issubset(candidate['properties'])
            assert candidate['properties']['replace_started']['default'] is False
            for field in expected:
                candidate['properties'].pop(field)
        assert candidate == schema, 'Unexpected API schema change: '+name
    assert before['components']['schemas'].keys() == after['components']['schemas'].keys()

def verify_no_database_changes(path, before):
    assert db_snapshot(path) == before, 'Existing schema, data, or foreign keys changed'
    with closing(sqlite3.connect(path.as_uri()+'?mode=ro',uri=True)) as db:
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
'''


def preflight():
    return previous.preflight()


def prepare():
    assert STORE.is_dir() and (STORE / '.gitignore').is_file()
    assert not (STORE / 'manifest.json').exists(), 'Already prepared'
    baseline=json.loads(BASELINE.read_text())
    data=release.remote(r'''
service_env(); exam_gate()
with tempfile.TemporaryDirectory(prefix='gipc-one-use-read-') as directory:
    copy=Path(directory)/'snapshot.db'; backup_db(copy)
    database=base64.b64encode(copy.read_bytes()).decode()
print(json.dumps({'pid':service_pid(),
 'files':{n:base64.b64encode(target(n).read_bytes()).decode() for n in FILES},
 'sources':{n:base64.b64encode(b).decode() for n,b in source_files().items()},
 'database':database,'openapi':get_json('/openapi.json')}))
''')
    manifest={'pid':data['pid'], 'files':{}, 'python_hashes':{}}
    for name in FILES:
        old=base64.b64decode(data['files'][name],validate=True)
        new=(ROOT/name).read_bytes()
        assert release.digest(old)==baseline['files'][name]['after'], 'Unreviewed production drift: '+name
        assert old!=new, 'Unnecessary file replacement: '+name
        for folder, content in [('before',old),('after',new)]:
            path=STORE/folder/name
            path.parent.mkdir(parents=True,exist_ok=True)
            path.write_bytes(content)
        manifest['files'][name]={'before':release.digest(old),'after':release.digest(new)}
    for name,encoded in data['sources'].items():
        content=base64.b64decode(encoded,validate=True)
        path=STORE/'live-python'/name
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_bytes(content)
        manifest['python_hashes'][name]=release.digest(content)
    database=base64.b64decode(data['database'],validate=True)
    (STORE/'before.db').write_bytes(database)
    manifest['database_snapshot_sha256']=release.digest(database)
    release.write_json(STORE/'before-openapi.json',data['openapi'])
    release.write_json(STORE/'manifest.json',manifest)
    print(json.dumps({'status':'prepared','files':len(FILES),'active_exams':0,'recovery':'local only','baseline_matches_previous_release':True}))


def validate():
    # Runs current tests against an isolated copy of actual production Python
    # sources using the production interpreter. App startup runs twice against
    # a disposable DB clone and verifies existing rows/columns remain unchanged.
    previous.validate()


def apply():
    manifest,data=previous.payload()
    validation=json.loads((STORE/'validation.json').read_text())
    assert validation['status']=='validated'
    assert validation['manifest_sha256']==release.digest((STORE/'manifest.json').read_bytes())
    assert not (STORE/'receipt.json').exists(), 'Already deployed'
    result=release.remote('manifest='+repr(manifest)+'\npayload='+repr(data)+r'''
env=service_env(); assert_baseline(manifest); exam_gate()
before_api=get_json('/openapi.json')
old,metadata,new={},{},{}
for name in FILES:
    path=target(name); old[name]=path.read_bytes(); stat=path.stat()
    metadata[name]=(stat.st_uid,stat.st_gid,stat.st_mode&0o777)
    new[name]=base64.b64decode(payload[name],validate=True)
    assert digest(new[name])==manifest['files'][name]['after']
changed=[]; stopped=False; started=time.monotonic()
try:
    subprocess.run(['systemctl','stop','gipc.service'],check=True); stopped=True
    exam_gate(); snapshot=db_snapshot(DB)
    for name in FILES:
        if name.startswith('backend/'):
            replace(target(name),new[name],metadata[name]); changed.append(name)
    verify_no_database_changes(DB,snapshot)
    subprocess.run(['systemctl','start','gipc.service'],check=True); healthy()
    downtime=round(time.monotonic()-started,2)
    contract(before_api,get_json('/openapi.json')); checks=public_checks()
    verify_no_database_changes(DB,snapshot)
    for name in FILES:
        if name.startswith('frontend/'):
            replace(target(name),new[name],metadata[name]); changed.append(name)
    assert all(digest(target(name).read_bytes())==manifest['files'][name]['after'] for name in FILES)
    print(json.dumps({'status':'deployed','files':FILES,'pid':service_pid(),
      'backend_unavailable_seconds':downtime,'existing_data_preserved':True,
      'database_schema_unchanged':True,'server_backups_retained':False,
      'server_staging_retained':False,**checks}))
except BaseException:
    if stopped:
        subprocess.run(['systemctl','stop','gipc.service'],check=True)
        for name in reversed(changed): replace(target(name),old[name],metadata[name])
        subprocess.run(['systemctl','start','gipc.service'],check=True); healthy()
        print('ROLLBACK_OK: previous runtime restored; production database not replaced',file=__import__('sys').stderr)
    raise
''')
    release.write_json(STORE/'receipt.json',result)
    print(json.dumps(result))


def verify():
    # HTTPS byte hashes on both canonical hostnames, homepage health, registry,
    # private endpoint protection and anonymous stage mutation rejection.
    previous.verify()
    path=STORE/'verification.json'
    result=json.loads(path.read_text())
    result['status']='verified'
    release.write_json(path,result)


if __name__ == '__main__':
    {'preflight':preflight,'prepare':prepare,'validate':validate,'apply':apply,'verify':verify}[sys.argv[1]]()
