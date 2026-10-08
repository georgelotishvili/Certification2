"""Publish portable 1.1.11 to slot 1 after the one-use website release.

Old production binary is recovered locally before any publication. This script
does not retain server backups and only removes the exact verified predecessor.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

import deploy_codes_schedules_20261008 as release

ROOT = release.ROOT
STORE = ROOT / '.deploy/one-use-release-20261009-01'
NEW_NAME = 'GIPC_exam_1.1.11.exe'
OLD_NAME = 'GIPC_exam_1.1.9.exe'
NEW = ROOT / 'desktop_app/dist' / NEW_NAME
RECOVERY = STORE / 'before/desktop' / OLD_NAME
NEW_SIZE = 69860888
NEW_HASH = '3b783fc93723558497080cbe08d915b180b9af7a227ebcd94330a2faee29100a'
OLD_SIZE = 69859322
OLD_HASH = '3cba4842b94bab11d88eeb92ffc2d54a63aa1e3265a3ded42d71e71aa20bdf6e'

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
    assert (root/'app_files').is_dir() and (root/'app_files').resolve()==root/'app_files'
    return root

def app_target(root,relative):
    assert relative in ('app_files/GIPC_exam_1.1.9.exe','app_files/GIPC_exam_1.1.11.exe')
    path=root/relative
    assert not path.is_symlink() and path.resolve()==path
    assert path.parent==root/'app_files' and path.is_relative_to(root)
    return path

def upload_path(upload):
    path=Path(upload)
    assert path.is_absolute() and path.resolve()==path and not path.is_symlink()
    assert path.parent.parent==Path('/tmp') and path.parent.name.startswith('gipc-app-1-1-11-')
    assert path.name=='GIPC_exam_1.1.11.exe' and not path.parent.is_symlink()
    return path

def remove_upload(upload):
    path=upload_path(upload)
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


def load_manifest():
    manifest=json.loads((STORE/'desktop-manifest.json').read_text(encoding='utf-8'))
    assert manifest['new_name']==NEW_NAME and manifest['new_size']==NEW_SIZE and manifest['new_hash']==NEW_HASH
    assert manifest['record']['id']==1 and manifest['record']['filename']==OLD_NAME
    assert manifest['record']['storage_path']=='app_files/'+OLD_NAME and manifest['record']['size_bytes']==OLD_SIZE
    assert manifest['old_hash']==OLD_HASH and manifest['media_root']=='/var/www/gipc/backend/app/media'
    assert NEW.is_file() and not NEW.is_symlink() and NEW.stat().st_size==NEW_SIZE and hash_file(NEW)==NEW_HASH
    assert RECOVERY.is_file() and not RECOVERY.is_symlink() and RECOVERY.stat().st_size==OLD_SIZE and hash_file(RECOVERY)==OLD_HASH
    return manifest


def recover_production_binary(manifest):
    assert RECOVERY.resolve().is_relative_to(STORE.resolve())
    RECOVERY.parent.mkdir(parents=True,exist_ok=True)
    assert not RECOVERY.is_symlink()
    if RECOVERY.exists():
        assert RECOVERY.is_file() and RECOVERY.stat().st_size==OLD_SIZE and hash_file(RECOVERY)==OLD_HASH
        return
    temporary=RECOVERY.with_suffix('.download')
    assert not temporary.exists() and not temporary.is_symlink(), 'Inspect existing incomplete recovery before retrying'
    action='manifest='+repr(manifest)+r'''
root=app_root(); assert str(root)==manifest['media_root']
assert app_record()==manifest['record'], 'Slot changed before recovery'
path=app_target(root,manifest['record']['storage_path'])
assert path.is_file() and path.stat().st_size==manifest['record']['size_bytes']
assert file_digest(path)==manifest['old_hash']
import shutil, sys
with path.open('rb') as source: shutil.copyfileobj(source,sys.stdout.buffer,1024*1024)
'''
    script=release.REMOTE+'\nFILES = []\n'+action
    try:
        with temporary.open('xb') as output:
            result=subprocess.run(release.SSH,input=script.encode(),stdout=output,stderr=subprocess.PIPE)
        assert result.returncode==0, 'Production binary recovery transfer failed'
        assert temporary.stat().st_size==OLD_SIZE and hash_file(temporary)==OLD_HASH
        temporary.replace(RECOVERY)
    finally:
        if temporary.exists():
            assert temporary.parent.resolve()==RECOVERY.parent.resolve() and temporary.name==OLD_NAME[:-4]+'.download'
            temporary.unlink()


def inspect():
    assert STORE.is_dir() and (STORE/'.gitignore').is_file()
    assert not (STORE/'desktop-receipt.json').exists(), 'Already published'
    assert NEW.is_file() and NEW.stat().st_size==NEW_SIZE and hash_file(NEW)==NEW_HASH
    result=release.remote(r'''
record=app_record()
assert record['filename']=='GIPC_exam_1.1.9.exe' and record['storage_path']=='app_files/GIPC_exam_1.1.9.exe'
assert record['size_bytes']==69859322
root=app_root(); old=app_target(root,record['storage_path'])
assert old.is_file() and old.stat().st_size==record['size_bytes']
assert file_digest(old)=='3cba4842b94bab11d88eeb92ffc2d54a63aa1e3265a3ded42d71e71aa20bdf6e'
assert not app_target(root,'app_files/GIPC_exam_1.1.11.exe').exists(), 'New filename already exists; re-review'
print(json.dumps({'record':record,'media_root':str(root),'old_hash':file_digest(old),'old_metadata':[old.stat().st_uid,old.stat().st_gid,old.stat().st_mode&0o777]}))
''')
    result.update(new_hash=NEW_HASH,new_size=NEW_SIZE,new_name=NEW_NAME)
    recover_production_binary(result)
    release.write_json(STORE/'desktop-manifest.json',result)
    load_manifest()
    print(json.dumps({'status':'inspected','slot':1,'new_version':'1.1.11','old_production_binary_recovered_locally':True,'new_size':NEW_SIZE}))


def upload():
    manifest=load_manifest()
    assert not (STORE/'desktop-receipt.json').exists(), 'Already published'
    if (STORE/'desktop-upload.json').exists():
        result=json.loads((STORE/'desktop-upload.json').read_text())
        release.remote('path=upload_path('+repr(result['path'])+'); assert path.parent.is_dir(); print(json.dumps({"valid":True}))')
    else:
        result=release.remote(r'''
import pwd
owner=pwd.getpwnam('gipcadmin')
directory=Path(tempfile.mkdtemp(prefix='gipc-app-1-1-11-',dir='/tmp'))
os.chown(directory,owner.pw_uid,owner.pw_gid); directory.chmod(0o700)
print(json.dumps({'path':str(directory/'GIPC_exam_1.1.11.exe')}))
''')
    release.write_json(STORE/'desktop-upload.json',result)
    command=['scp','-i','C:/Users/george/.ssh/gipc_admin_ed25519','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=15',str(NEW),'gipcadmin@148.251.167.229:'+result['path']]
    try:
        subprocess.run(command,check=True)
        verified=release.remote('manifest='+repr(manifest)+'\nupload='+repr(result['path'])+r'''
path=upload_path(upload)
assert path.is_file() and path.stat().st_size==manifest['new_size'] and file_digest(path)==manifest['new_hash']
print(json.dumps({'status':'uploaded','sha256_verified':True,'sha256':manifest['new_hash'],'bytes':path.stat().st_size}))
''')
    except BaseException:
        cleanup=release.remote('remove_upload('+repr(result['path'])+'); print(json.dumps({"removed":True}))')
        assert cleanup['removed']; (STORE/'desktop-upload.json').unlink()
        raise
    release.write_json(STORE/'desktop-upload-verified.json',verified)
    print(json.dumps(verified))


def publish():
    manifest=load_manifest()
    upload=json.loads((STORE/'desktop-upload.json').read_text())['path']
    uploaded=json.loads((STORE/'desktop-upload-verified.json').read_text())
    assert uploaded['sha256_verified'] and uploaded['sha256']==NEW_HASH and uploaded['bytes']==NEW_SIZE
    website=json.loads((STORE/'verification.json').read_text())
    website_receipt=json.loads((STORE/'receipt.json').read_text())
    assert website_receipt['status']=='deployed' and website['new_routes_protected'] and website['both_hostnames_verified'], 'Verify website release before publishing desktop'
    assert website['pid']==website_receipt['pid'], 'Service changed between site release and verification'
    result=release.remote('manifest='+repr(manifest)+'\nupload='+repr(upload)+r'''
import shutil
from datetime import datetime
root=app_root(); assert str(root)==manifest['media_root']
current=app_record()
if current['filename']==manifest['new_name']:
    published=app_target(root,current['storage_path'])
    assert current['storage_path']=='app_files/'+manifest['new_name'] and current['size_bytes']==manifest['new_size']
    assert published.is_file() and published.stat().st_size==manifest['new_size'] and file_digest(published)==manifest['new_hash']
    print(json.dumps({'status':'published','version':'1.1.11','download_slot':1,'filename':current['filename'],'size_bytes':current['size_bytes'],'sha256':file_digest(published),'same_download_url':True,'resumed_verified_publication':True}))
    raise SystemExit(0)
assert current==manifest['record'], 'App download slot changed since inspection'
old=app_target(root,manifest['record']['storage_path']); assert file_digest(old)==manifest['old_hash']
source=upload_path(upload)
assert source.is_file() and source.stat().st_size==manifest['new_size'] and file_digest(source)==manifest['new_hash']
new=app_target(root,'app_files/'+manifest['new_name']); assert not new.exists()
fd,name=tempfile.mkstemp(prefix='.gipc-release-',dir=new.parent); temporary=Path(name)
try:
    with os.fdopen(fd,'wb') as destination,source.open('rb') as contents:
        shutil.copyfileobj(contents,destination,1024*1024); destination.flush(); os.fsync(destination.fileno())
    assert file_digest(temporary)==manifest['new_hash']
    uid,gid,mode=manifest['old_metadata']; os.chown(temporary,uid,gid); os.chmod(temporary,mode)
    os.replace(temporary,new); sync_directory(new.parent)
    with closing(sqlite3.connect(DB)) as db,db:
        db.execute('BEGIN IMMEDIATE'); db.row_factory=sqlite3.Row
        assert db.execute('SELECT COUNT(*) FROM app_files').fetchone()[0]==1
        assert dict(db.execute('SELECT * FROM app_files WHERE id=1').fetchone())==manifest['record'], 'Concurrent download change'
        changed=db.execute('UPDATE app_files SET filename=?,storage_path=?,size_bytes=?,created_at=? WHERE id=1 AND filename=? AND storage_path=? AND size_bytes=?',
            (manifest['new_name'],'app_files/'+manifest['new_name'],manifest['new_size'],datetime.utcnow().isoformat(sep=' '),manifest['record']['filename'],manifest['record']['storage_path'],manifest['record']['size_bytes']))
        assert changed.rowcount==1
    record=app_record()
    assert record['filename']==manifest['new_name'] and record['size_bytes']==new.stat().st_size
    assert file_digest(new)==manifest['new_hash']
except BaseException:
    # Keep old production file intact until separate verification/cleanup.
    if new.exists() and app_record()==manifest['record']:
        assert file_digest(new)==manifest['new_hash']; new.unlink(); sync_directory(new.parent)
    raise
finally:
    if temporary.exists():
        assert temporary.parent==new.parent and temporary.name.startswith('.gipc-release-'); temporary.unlink()
print(json.dumps({'status':'published','version':'1.1.11','download_slot':1,'filename':record['filename'],'size_bytes':record['size_bytes'],'sha256':file_digest(new),'same_download_url':True,'old_file_pending_verified_cleanup':True}))
''')
    release.write_json(STORE/'desktop-receipt.json',result)
    print(json.dumps(result))


def verify_cleanup():
    manifest=load_manifest()
    upload=json.loads((STORE/'desktop-upload.json').read_text())['path']
    receipt=json.loads((STORE/'desktop-receipt.json').read_text())
    assert receipt['status']=='published' and receipt['sha256']==NEW_HASH
    result=release.remote('manifest='+repr(manifest)+'\nupload='+repr(upload)+r'''
root=app_root(); assert str(root)==manifest['media_root']
record=app_record(); assert record['filename']==manifest['new_name']
assert record['size_bytes']==manifest['new_size'] and record['storage_path']=='app_files/'+manifest['new_name']
new=app_target(root,record['storage_path'])
assert file_digest(new)==manifest['new_hash'] and new.stat().st_size==manifest['new_size']
for host in ('http://127.0.0.1:8000','https://gipc.org.ge','https://www.gipc.org.ge'):
    try:
        urllib.request.urlopen(host+'/app-files/1/download',timeout=15); raise AssertionError('Download became public')
    except urllib.error.HTTPError as error:
        assert error.code==401
assert app_record()==record and file_digest(new)==manifest['new_hash'], 'Concurrent app change during verification'
old=app_target(root,manifest['record']['storage_path'])
assert old!=new and old.name=='GIPC_exam_1.1.9.exe'
if old.exists():
    assert old.is_file() and old.stat().st_size==manifest['record']['size_bytes'] and file_digest(old)==manifest['old_hash']
    old.unlink(); sync_directory(old.parent)
remove_upload(upload)
assert not old.exists() and new.is_file()
print(json.dumps({'status':'verified','version':'1.1.11','new_file_hash_verified':True,'admin_only_download_preserved':True,'old_server_version_removed':True,'old_version_recoverable_locally':True,'upload_staging_removed':True,'authenticated_download_verified':False,'authenticated_check_skip_reason':'No user session borrowed; exact stored binary hash and protected download route verified'}))
''')
    release.write_json(STORE/'desktop-verification.json',result)
    print(json.dumps(result))


if __name__=='__main__':
    {'inspect':inspect,'upload':upload,'publish':publish,'verify-cleanup':verify_cleanup}[sys.argv[1]]()
