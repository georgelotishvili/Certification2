"""Publish the verified portable desktop build to the existing admin download slot."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

import deploy_exam_stages_20261008 as stages
release = stages.release
ROOT, STORE = stages.ROOT, stages.STORE
NEW = ROOT/'desktop_app/dist/GIPC_exam_1.1.9.exe'
OLD = ROOT/'desktop_app/dist/GIPC_exam_1.1.8.exe'

release.REMOTE += r'''
def file_digest(path):
    checksum=hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda:source.read(1024*1024),b''): checksum.update(block)
    return checksum.hexdigest()

def app_record():
    with closing(sqlite3.connect(DB.as_uri()+'?mode=ro',uri=True)) as db:
        db.row_factory=sqlite3.Row
        assert db.execute('SELECT COUNT(*) FROM app_files').fetchone()[0]==1, 'Installer list changed; re-review before replacing'
        row=db.execute('SELECT * FROM app_files WHERE id=1').fetchone()
        assert row is not None
        return dict(row)

def app_root():
    env=service_env()
    code="import json; from app.services.media_storage import ensure_media_root; print(json.dumps(str(ensure_media_root().resolve())))"
    result=subprocess.run([PYTHON,'-B','-c',code],cwd=LIVE/'backend',env={**os.environ,**env,'PYTHONDONTWRITEBYTECODE':'1'},capture_output=True,text=True)
    assert result.returncode==0,result.stderr[-1000:]
    root=Path(json.loads(result.stdout))
    assert root.is_absolute() and root.is_dir() and root.resolve()==root
    return root

def app_target(root,relative):
    result=(root/relative).resolve()
    assert result.is_relative_to(root) and result.parent==root/'app_files'
    assert not (root/relative).is_symlink()
    return result

def remove_upload(upload):
    path=Path(upload)
    assert path.is_absolute() and path.resolve()==path and not path.is_symlink()
    assert path.parent.parent==Path('/tmp') and path.parent.name.startswith('gipc-app-1-1-9-')
    assert path.name=='GIPC_exam_1.1.9.exe'
    if path.exists(): path.unlink()
    if path.parent.exists(): path.parent.rmdir()

def sync_directory(path):
    fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)
'''


def hash_file(path):
    checksum=hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda:source.read(1024*1024),b''): checksum.update(block)
    return checksum.hexdigest()


def inspect():
    assert NEW.is_file() and OLD.is_file()
    result=release.remote(r'''
record=app_record(); assert record['filename']=='GIPC_exam_1.1.8.exe'
root=app_root(); old=app_target(root,record['storage_path'])
assert old.is_file() and old.stat().st_size==record['size_bytes']
print(json.dumps({'record':record,'media_root':str(root),'old_hash':file_digest(old),'old_metadata':[old.stat().st_uid,old.stat().st_gid,old.stat().st_mode&0o777]}))
''')
    assert result['old_hash']==hash_file(OLD), 'Local recovery executable does not match the server'
    result.update(new_hash=hash_file(NEW),new_size=NEW.stat().st_size,new_name=NEW.name)
    assert result['new_hash']=='3cba4842b94bab11d88eeb92ffc2d54a63aa1e3265a3ded42d71e71aa20bdf6e'
    release.write_json(STORE/'desktop-manifest.json',result)
    print(json.dumps({'status':'inspected','slot':1,'new_version':'1.1.9','old_recovery_copy_verified_locally':True,'new_size':result['new_size']}))


def upload():
    manifest=json.loads((STORE/'desktop-manifest.json').read_text())
    assert hash_file(NEW)==manifest['new_hash']
    assert not (STORE/'desktop-receipt.json').exists(), 'Already published'
    if (STORE/'desktop-upload.json').exists():
        result=json.loads((STORE/'desktop-upload.json').read_text())
    else:
        result=release.remote(r'''
import pwd
owner=pwd.getpwnam('gipcadmin')
directory=Path(tempfile.mkdtemp(prefix='gipc-app-1-1-9-',dir='/tmp'))
os.chown(directory,owner.pw_uid,owner.pw_gid); directory.chmod(0o700)
print(json.dumps({'path':str(directory/'GIPC_exam_1.1.9.exe')}))
''')
    release.write_json(STORE/'desktop-upload.json',result)
    command=['scp','-i','C:/Users/george/.ssh/gipc_admin_ed25519','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=15',str(NEW),'gipcadmin@148.251.167.229:'+result['path']]
    try:
        subprocess.run(command,check=True)
        verified=release.remote('manifest='+repr(manifest)+'\nupload='+repr(result['path'])+r'''
path=Path(upload)
assert path.is_file() and path.stat().st_size==manifest['new_size'] and file_digest(path)==manifest['new_hash']
print(json.dumps({'status':'uploaded','sha256_verified':True,'bytes':path.stat().st_size}))
''')
    except BaseException:
        cleanup=release.remote('remove_upload('+repr(result['path'])+'); print(json.dumps({"removed":True}))')
        assert cleanup['removed']
        (STORE/'desktop-upload.json').unlink()
        raise
    release.write_json(STORE/'desktop-upload-verified.json',verified); print(json.dumps(verified))


def publish():
    manifest=json.loads((STORE/'desktop-manifest.json').read_text())
    upload=json.loads((STORE/'desktop-upload.json').read_text())['path']
    assert json.loads((STORE/'desktop-upload-verified.json').read_text())['sha256_verified']
    assert json.loads((STORE/'verification.json').read_text())['new_routes_protected']
    result=release.remote('manifest='+repr(manifest)+'\nupload='+repr(upload)+r'''
import shutil
from datetime import datetime
root=app_root(); assert str(root)==manifest['media_root']
current=app_record()
if current['filename']==manifest['new_name']:
    published=app_target(root,current['storage_path'])
    assert current['storage_path']=='app_files/'+manifest['new_name'] and current['size_bytes']==manifest['new_size']
    assert published.is_file() and published.stat().st_size==manifest['new_size'] and file_digest(published)==manifest['new_hash']
    print(json.dumps({'status':'published','version':'1.1.9','download_slot':1,'filename':current['filename'],'size_bytes':current['size_bytes'],'sha256':file_digest(published),'same_download_url':True,'resumed_verified_publication':True}))
    raise SystemExit(0)
assert current==manifest['record'], 'App download slot changed since inspection'
old=app_target(root,manifest['record']['storage_path']); assert file_digest(old)==manifest['old_hash']
source=Path(upload); assert source.is_file() and file_digest(source)==manifest['new_hash']
new=app_target(root,'app_files/'+manifest['new_name']); assert not new.exists()
fd,name=tempfile.mkstemp(prefix='.gipc-release-',dir=new.parent); temporary=Path(name)
try:
    with os.fdopen(fd,'wb') as destination,source.open('rb') as contents:
        shutil.copyfileobj(contents,destination,1024*1024); destination.flush(); os.fsync(destination.fileno())
    assert file_digest(temporary)==manifest['new_hash']
    uid,gid,mode=manifest['old_metadata']; os.chown(temporary,uid,gid); os.chmod(temporary,mode)
    os.replace(temporary,new)
    sync_directory(new.parent)
    with closing(sqlite3.connect(DB)) as db,db:
        db.execute('BEGIN IMMEDIATE')
        db.row_factory=sqlite3.Row
        assert db.execute('SELECT COUNT(*) FROM app_files').fetchone()[0]==1
        assert dict(db.execute('SELECT * FROM app_files WHERE id=1').fetchone())==manifest['record']
        db.execute('UPDATE app_files SET filename=?,storage_path=?,size_bytes=?,created_at=? WHERE id=1',
                   (manifest['new_name'],'app_files/'+manifest['new_name'],manifest['new_size'],datetime.utcnow().isoformat(sep=' ')))
    record=app_record()
    assert record['filename']==manifest['new_name'] and record['size_bytes']==new.stat().st_size
    assert file_digest(new)==manifest['new_hash']
except BaseException:
    # The old binary remains intact until the separate verification/cleanup.
    if new.exists() and app_record()==manifest['record']:
        assert file_digest(new)==manifest['new_hash']; new.unlink()
    raise
finally:
    if temporary.exists():
        assert temporary.parent==new.parent and temporary.name.startswith('.gipc-release-'); temporary.unlink()
print(json.dumps({'status':'published','version':'1.1.9','download_slot':1,'filename':record['filename'],'size_bytes':record['size_bytes'],'sha256':file_digest(new),'same_download_url':True,'old_file_pending_verified_cleanup':True}))
''')
    release.write_json(STORE/'desktop-receipt.json',result); print(json.dumps(result))


def verify_cleanup():
    manifest=json.loads((STORE/'desktop-manifest.json').read_text())
    upload=json.loads((STORE/'desktop-upload.json').read_text())['path']
    assert hash_file(OLD)==manifest['old_hash'], 'Retain the matching old version locally'
    result=release.remote('manifest='+repr(manifest)+'\nupload='+repr(upload)+r'''
root=app_root(); assert str(root)==manifest['media_root']
record=app_record(); assert record['filename']==manifest['new_name']
new=app_target(root,record['storage_path'])
assert file_digest(new)==manifest['new_hash'] and new.stat().st_size==manifest['new_size']
# Keep the existing admin-only distribution policy: anonymous downloads fail.
for host in ('http://127.0.0.1:8000','https://gipc.org.ge','https://www.gipc.org.ge'):
    try:
        urllib.request.urlopen(host+'/app-files/1/download',timeout=15); raise AssertionError('Download became public')
    except urllib.error.HTTPError as error:
        assert error.code==401
old=app_target(root,manifest['record']['storage_path'])
assert old!=new and old.name=='GIPC_exam_1.1.8.exe'
if old.exists():
    assert file_digest(old)==manifest['old_hash']; old.unlink(); sync_directory(old.parent)
remove_upload(upload)
assert not old.exists() and new.is_file()
print(json.dumps({'status':'verified','version':'1.1.9','new_file_hash_verified':True,'admin_only_download_preserved':True,'old_server_version_removed':True,'old_version_recoverable_locally':True,'upload_staging_removed':True}))
''')
    release.write_json(STORE/'desktop-verification.json',result); print(json.dumps(result))


if __name__=='__main__':
    {'inspect':inspect,'upload':upload,'publish':publish,'verify-cleanup':verify_cleanup}[sys.argv[1]]()
