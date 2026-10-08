"""Publish verified portable 1.1.12 after the compatible offline backend.

This helper is deliberately separate from prior baseline-specific releases.
The existing verified 1.1.11 recovery binary is reused locally, never copied
to a second backup or retained on the server. No network occurs on import.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

import deploy_codes_schedules_20261008 as release

ROOT = release.ROOT
STORE = ROOT / '.deploy/offline-release-20261009-01'
NEW_NAME = 'GIPC_exam_1.1.12.exe'
OLD_NAME = 'GIPC_exam_1.1.11.exe'
NEW = ROOT / 'desktop_app/dist' / NEW_NAME
RECOVERY = ROOT / '.deploy/offline-exams-20261009/before' / OLD_NAME
NEW_SIZE = 69901743
NEW_HASH = 'aecd5b23d88159fc1e3c8785ddad0d985b22bc145039e409c1f68614b39815e1'
OLD_SIZE = 69860888
OLD_HASH = '3b783fc93723558497080cbe08d915b180b9af7a227ebcd94330a2faee29100a'
BACKEND_FILES = [
    'backend/app/models.py', 'backend/app/schemas.py',
    'backend/app/routers/admin.py', 'backend/app/routers/exam.py',
    'backend/app/routers/multi_apartment.py', 'backend/app/routers/multi_functional.py',
    'backend/app/services/exam_lifecycle.py', 'backend/app/services/offline_attempts.py',
    'backend/app/services/offline_grading.py',
]
release.FILES = BACKEND_FILES

release.REMOTE += r'''
def file_digest(path):
    checksum=hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda:source.read(1024*1024),b''): checksum.update(block)
    return checksum.hexdigest()

def app_record():
    with closing(sqlite3.connect(DB.as_uri()+'?mode=ro',uri=True)) as db:
        db.row_factory=sqlite3.Row
        assert db.execute('SELECT COUNT(*) FROM app_files').fetchone()[0]==1, 'Download list changed'
        row=db.execute('SELECT * FROM app_files WHERE id=1').fetchone()
        assert row is not None
        return dict(row)

def app_root():
    env=service_env()
    code="import json; from app.services.media_storage import ensure_media_root; print(json.dumps(str(ensure_media_root().resolve())))"
    result=subprocess.run([PYTHON,'-B','-c',code],cwd=LIVE/'backend',env={**os.environ,**env,'PYTHONDONTWRITEBYTECODE':'1'},capture_output=True,text=True)
    assert result.returncode==0, 'Unable to resolve configured media root'
    root=Path(json.loads(result.stdout))
    assert root==Path('/var/www/gipc/backend/app/media')
    assert root.is_dir() and root.resolve()==root and not root.is_symlink()
    directory=root/'app_files'
    assert directory.is_dir() and directory.resolve()==directory and not directory.is_symlink()
    return root

def app_target(root,relative):
    assert relative in ('app_files/GIPC_exam_1.1.11.exe','app_files/GIPC_exam_1.1.12.exe')
    path=root/relative
    assert not path.is_symlink() and path.resolve()==path
    assert path.parent==root/'app_files' and path.is_relative_to(root)
    return path

def upload_path(upload):
    path=Path(upload)
    assert path.is_absolute() and path.resolve()==path and not path.is_symlink()
    assert path.parent.parent==Path('/tmp') and path.parent.name.startswith('gipc-app-1-1-12-')
    assert path.name=='GIPC_exam_1.1.12.exe' and not path.parent.is_symlink()
    return path

def remove_upload(upload):
    path=upload_path(upload)
    if path.exists():
        assert path.is_file()
        path.unlink()
    if path.parent.exists(): path.parent.rmdir()

def sync_directory(path):
    fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)

def backend_ready(gate):
    service_env()
    assert service_pid()==str(gate['pid']), 'Service changed since backend verification'
    assert set(gate['files'])==set(FILES) and len(FILES)==9, 'Backend release scope mismatch'
    for name,expected in gate['files'].items():
        path=target(name)
        assert path.is_file() and file_digest(path)==expected, 'Offline backend drift: '+name
    for host in ('http://127.0.0.1:8000','https://gipc.org.ge','https://www.gipc.org.ge'):
        request=urllib.request.Request(host+'/exam/offline/capabilities',headers={'Cache-Control':'no-cache'})
        with urllib.request.urlopen(request,timeout=15) as response:
            assert response.status==200
            metadata=json.load(response)
            assert metadata.get('protocol')==1 and metadata.get('grading_snapshots') is True, 'Offline protocol unavailable'
    assert service_pid()==str(gate['pid']), 'Service restarted during capability verification'

def verify_published(root,record,manifest):
    assert record['id']==1 and record['filename']==manifest['new_name']
    assert record['storage_path']=='app_files/'+manifest['new_name'] and record['size_bytes']==manifest['new_size']
    path=app_target(root,record['storage_path'])
    assert path.is_file() and path.stat().st_size==manifest['new_size'] and file_digest(path)==manifest['new_hash']
    return path
'''


def hash_file(path):
    checksum=hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda:source.read(1024*1024),b''): checksum.update(block)
    return checksum.hexdigest()


def local_artifacts():
    for path,size,expected in ((NEW,NEW_SIZE,NEW_HASH),(RECOVERY,OLD_SIZE,OLD_HASH)):
        assert path.resolve().is_relative_to(ROOT.resolve())
        assert path.resolve()==path and not path.is_symlink() and path.is_file(), 'Missing/redirected local artifact: '+str(path)
        assert path.stat().st_size==size and hash_file(path)==expected, 'Local artifact changed: '+str(path)
    package=json.loads((ROOT/'.deploy/offline-exams-20261009/package-verification.json').read_text(encoding='utf-8'))
    assert package['passed'] is True and package['version']=='1.1.12'
    assert package['exe']['size']==NEW_SIZE and package['exe']['sha256']==NEW_HASH
    assert Path(package['exe']['path']).resolve()==NEW.resolve()


def backend_gate():
    assert STORE.is_dir() and (STORE/'.gitignore').is_file()
    manifest=json.loads((STORE/'manifest.json').read_text(encoding='utf-8'))
    receipt=json.loads((STORE/'receipt.json').read_text(encoding='utf-8'))
    verification=json.loads((STORE/'verification.json').read_text(encoding='utf-8'))
    assert receipt['status']=='deployed', 'Deploy backend before desktop publication'
    for key in ('new_routes_protected','both_hostnames_verified','offline_capabilities_verified'):
        assert verification.get(key) is True, 'Backend verification missing: '+key
    assert str(verification['pid'])==str(receipt['pid']), 'Backend verification PID mismatch'
    assert set(manifest['files'])==set(BACKEND_FILES), 'Unexpected backend release scope'
    files={name:manifest['files'][name]['after'] for name in BACKEND_FILES}
    for name,expected in files.items():
        assert len(expected)==64 and all(char in '0123456789abcdef' for char in expected)
        assert hash_file(ROOT/name)==expected, 'Local backend changed since deployed manifest: '+name
    return {'pid':str(receipt['pid']),'files':files,
            'manifest_sha256':hash_file(STORE/'manifest.json')}


def load_manifest():
    local_artifacts()
    manifest=json.loads((STORE/'desktop-manifest.json').read_text(encoding='utf-8'))
    assert manifest['new_name']==NEW_NAME and manifest['new_size']==NEW_SIZE and manifest['new_hash']==NEW_HASH
    assert manifest['record']['id']==1 and manifest['record']['filename']==OLD_NAME
    assert manifest['record']['storage_path']=='app_files/'+OLD_NAME and manifest['record']['size_bytes']==OLD_SIZE
    assert manifest['old_hash']==OLD_HASH and manifest['media_root']=='/var/www/gipc/backend/app/media'
    assert Path(manifest['local_recovery']).resolve()==RECOVERY.resolve()
    assert manifest['backend_gate']==backend_gate(), 'Backend release changed since app inspection'
    return manifest


def inspect():
    local_artifacts()
    gate=backend_gate()
    assert not (STORE/'desktop-receipt.json').exists(), 'Already published'
    assert not (STORE/'desktop-manifest.json').exists(), 'Already inspected; use existing manifest'
    result=release.remote('gate='+repr(gate)+r'''
backend_ready(gate)
record=app_record()
assert record['filename']=='GIPC_exam_1.1.11.exe' and record['storage_path']=='app_files/GIPC_exam_1.1.11.exe'
assert record['size_bytes']==69860888
root=app_root(); old=app_target(root,record['storage_path'])
assert old.is_file() and old.stat().st_size==record['size_bytes']
assert file_digest(old)=='3b783fc93723558497080cbe08d915b180b9af7a227ebcd94330a2faee29100a'
assert not app_target(root,'app_files/GIPC_exam_1.1.12.exe').exists(), 'New filename already exists; re-review'
print(json.dumps({'record':record,'media_root':str(root),'old_hash':file_digest(old),'old_metadata':[old.stat().st_uid,old.stat().st_gid,old.stat().st_mode&0o777]}))
''')
    result.update(new_hash=NEW_HASH,new_size=NEW_SIZE,new_name=NEW_NAME,
                  local_recovery=str(RECOVERY),backend_gate=gate)
    release.write_json(STORE/'desktop-manifest.json',result)
    load_manifest()
    print(json.dumps({'status':'inspected','slot':1,'new_version':'1.1.12',
                      'existing_local_recovery_reused':True,'new_size':NEW_SIZE}))


def upload():
    manifest=load_manifest()
    assert not (STORE/'desktop-receipt.json').exists(), 'Already published'
    if (STORE/'desktop-upload.json').exists():
        result=json.loads((STORE/'desktop-upload.json').read_text(encoding='utf-8'))
        release.remote('path=upload_path('+repr(result['path'])+'); assert path.parent.is_dir(); print(json.dumps({"valid":True}))')
    else:
        result=release.remote(r'''
import pwd
owner=pwd.getpwnam('gipcadmin')
directory=Path(tempfile.mkdtemp(prefix='gipc-app-1-1-12-',dir='/tmp'))
os.chown(directory,owner.pw_uid,owner.pw_gid); directory.chmod(0o700)
print(json.dumps({'path':str(directory/'GIPC_exam_1.1.12.exe')}))
''')
    release.write_json(STORE/'desktop-upload.json',result)
    command=['scp','-i','C:/Users/george/.ssh/gipc_admin_ed25519','-o','BatchMode=yes',
             '-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=15',str(NEW),
             'gipcadmin@148.251.167.229:'+result['path']]
    try:
        subprocess.run(command,check=True)
        verified=release.remote('manifest='+repr(manifest)+'\nupload='+repr(result['path'])+r'''
path=upload_path(upload)
assert path.is_file() and path.stat().st_size==manifest['new_size'] and file_digest(path)==manifest['new_hash']
print(json.dumps({'status':'uploaded','sha256_verified':True,'sha256':manifest['new_hash'],'bytes':path.stat().st_size}))
''')
    except BaseException:
        cleanup=release.remote('remove_upload('+repr(result['path'])+'); print(json.dumps({"removed":True}))')
        assert cleanup['removed']
        (STORE/'desktop-upload.json').unlink()
        raise
    release.write_json(STORE/'desktop-upload-verified.json',verified)
    print(json.dumps(verified))


def publish():
    manifest=load_manifest()
    upload=json.loads((STORE/'desktop-upload.json').read_text(encoding='utf-8'))['path']
    uploaded=json.loads((STORE/'desktop-upload-verified.json').read_text(encoding='utf-8'))
    assert uploaded['sha256_verified'] is True and uploaded['sha256']==NEW_HASH and uploaded['bytes']==NEW_SIZE
    result=release.remote('manifest='+repr(manifest)+'\nupload='+repr(upload)+r'''
import shutil
from datetime import datetime
root=app_root(); assert str(root)==manifest['media_root']
backend_ready(manifest['backend_gate'])
current=app_record()
if current['filename']==manifest['new_name']:
    published=verify_published(root,current,manifest)
    print(json.dumps({'status':'published','version':'1.1.12','download_slot':1,'filename':current['filename'],'size_bytes':current['size_bytes'],'sha256':file_digest(published),'same_download_url':True,'resumed_verified_publication':True,'backend_pid':service_pid()}))
    raise SystemExit(0)
assert current==manifest['record'], 'App download slot changed since inspection'
old=app_target(root,manifest['record']['storage_path'])
assert old.is_file() and old.stat().st_size==manifest['record']['size_bytes'] and file_digest(old)==manifest['old_hash']
source=upload_path(upload)
assert source.is_file() and source.stat().st_size==manifest['new_size'] and file_digest(source)==manifest['new_hash']
new=app_target(root,'app_files/'+manifest['new_name']); assert not new.exists()
fd,name=tempfile.mkstemp(prefix='.gipc-release-',dir=new.parent); temporary=Path(name)
assert temporary.parent==new.parent and temporary.resolve()==temporary and not temporary.is_symlink()
try:
    with os.fdopen(fd,'wb') as destination,source.open('rb') as contents:
        shutil.copyfileobj(contents,destination,1024*1024); destination.flush(); os.fsync(destination.fileno())
    assert file_digest(temporary)==manifest['new_hash']
    uid,gid,mode=manifest['old_metadata']; os.chown(temporary,uid,gid); os.chmod(temporary,mode)
    # Probe the installed backend immediately before making this client downloadable.
    backend_ready(manifest['backend_gate'])
    os.replace(temporary,new); sync_directory(new.parent)
    with closing(sqlite3.connect(DB)) as db,db:
        db.execute('BEGIN IMMEDIATE'); db.row_factory=sqlite3.Row
        assert db.execute('SELECT COUNT(*) FROM app_files').fetchone()[0]==1
        assert dict(db.execute('SELECT * FROM app_files WHERE id=1').fetchone())==manifest['record'], 'Concurrent download change'
        assert service_pid()==str(manifest['backend_gate']['pid']), 'Backend changed before slot update'
        changed=db.execute('UPDATE app_files SET filename=?,storage_path=?,size_bytes=?,created_at=? WHERE id=1 AND filename=? AND storage_path=? AND size_bytes=?',
            (manifest['new_name'],'app_files/'+manifest['new_name'],manifest['new_size'],datetime.utcnow().isoformat(sep=' '),manifest['record']['filename'],manifest['record']['storage_path'],manifest['record']['size_bytes']))
        assert changed.rowcount==1
    record=app_record()
    verify_published(root,record,manifest)
except BaseException:
    # Never remove the predecessor until separately verified publication. Remove
    # only our exact new artifact if the slot demonstrably still references old.
    if new.exists() and app_record()==manifest['record']:
        assert new==app_target(root,'app_files/GIPC_exam_1.1.12.exe')
        assert file_digest(new)==manifest['new_hash']; new.unlink(); sync_directory(new.parent)
    raise
finally:
    if temporary.exists():
        assert temporary.parent==new.parent and temporary.name.startswith('.gipc-release-')
        assert temporary.resolve()==temporary and not temporary.is_symlink()
        temporary.unlink()
print(json.dumps({'status':'published','version':'1.1.12','download_slot':1,'filename':record['filename'],'size_bytes':record['size_bytes'],'sha256':file_digest(new),'same_download_url':True,'old_file_pending_verified_cleanup':True,'backend_pid':service_pid()}))
''')
    release.write_json(STORE/'desktop-receipt.json',result)
    print(json.dumps(result))


def verify_cleanup():
    manifest=load_manifest()
    upload=json.loads((STORE/'desktop-upload.json').read_text(encoding='utf-8'))['path']
    receipt=json.loads((STORE/'desktop-receipt.json').read_text(encoding='utf-8'))
    assert receipt['status']=='published' and receipt['sha256']==NEW_HASH
    assert str(receipt['backend_pid'])==str(manifest['backend_gate']['pid'])
    result=release.remote('manifest='+repr(manifest)+'\nupload='+repr(upload)+r'''
root=app_root(); assert str(root)==manifest['media_root']
backend_ready(manifest['backend_gate'])
record=app_record(); new=verify_published(root,record,manifest)
for host in ('http://127.0.0.1:8000','https://gipc.org.ge','https://www.gipc.org.ge'):
    try:
        urllib.request.urlopen(host+'/app-files/1/download',timeout=15); raise AssertionError('Download became public')
    except urllib.error.HTTPError as error:
        assert error.code==401
with closing(sqlite3.connect(DB)) as db,db:
    db.execute('BEGIN IMMEDIATE'); db.row_factory=sqlite3.Row
    assert db.execute('SELECT COUNT(*) FROM app_files').fetchone()[0]==1
    assert dict(db.execute('SELECT * FROM app_files WHERE id=1').fetchone())==record, 'Concurrent app change during verification'
    verify_published(root,record,manifest)
    old=app_target(root,manifest['record']['storage_path'])
    assert old!=new and old.name=='GIPC_exam_1.1.11.exe'
    if old.exists():
        assert old.is_file() and old.stat().st_size==manifest['record']['size_bytes'] and file_digest(old)==manifest['old_hash']
        old.unlink(); sync_directory(old.parent)
remove_upload(upload)
assert not old.exists() and new.is_file()
print(json.dumps({'status':'verified','version':'1.1.12','new_file_hash_verified':True,'admin_only_download_preserved':True,'offline_capabilities_verified':True,'backend_hashes_verified':True,'backend_pid':service_pid(),'old_server_version_removed':True,'old_version_recoverable_locally':True,'upload_staging_removed':True,'authenticated_download_verified':False,'authenticated_check_skip_reason':'No user session borrowed; exact stored binary hash and protected download route verified'}))
''')
    result['local_recovery']=str(RECOVERY)
    release.write_json(STORE/'desktop-verification.json',result)
    print(json.dumps(result))


if __name__=='__main__':
    {'inspect':inspect,'upload':upload,'publish':publish,'verify-cleanup':verify_cleanup}[sys.argv[1]]()
