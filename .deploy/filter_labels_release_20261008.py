"""Publish three static admin files, preserving a verified rollback copy."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

NAME = 'filter-labels-20261008-01'
FILES = ['frontend/scripts/admin.js', 'frontend/scripts/admin/users.js', 'frontend/pages/admin.html']
LIVE = Path('/var/www/gipc')
STAGE = Path('/home/gipcadmin') / NAME
BACKUP = Path('/root/gipc-backups') / NAME


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pack():
    root = Path(__file__).resolve().parents[1]
    stage = root / '.deploy' / NAME
    stage.mkdir(mode=0o700)
    previous = json.loads((root / '.deploy/statement-workflow-20261008-01/manifest.json').read_text())
    manifest = {name: {'before': previous[name]['after'], 'after': digest(root / name)} for name in FILES}
    (stage / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    with tarfile.open(stage / 'payload.tar.gz', 'w:gz') as archive:
        for name in FILES:
            archive.add(root / name, arcname=name, recursive=False)
        archive.add(stage / 'manifest.json', arcname='manifest.json', recursive=False)
    print('PAYLOAD_SHA256=' + digest(stage / 'payload.tar.gz'))


def replace(source, target):
    temporary = target.with_name('.' + target.name + '.' + NAME)
    assert not temporary.exists()
    metadata = target.stat()
    shutil.copyfile(source, temporary)
    os.chown(temporary, metadata.st_uid, metadata.st_gid)
    os.chmod(temporary, metadata.st_mode & 0o777)
    os.replace(temporary, target)


def apply(expected_payload):
    assert os.geteuid() == 0
    assert digest(STAGE / 'payload.tar.gz') == expected_payload
    with tarfile.open(STAGE / 'payload.tar.gz') as archive:
        members = archive.getmembers()
        assert sorted(member.name for member in members) == sorted(FILES + ['manifest.json'])
        assert all(member.isfile() for member in members)
        manifest = json.load(archive.extractfile('manifest.json'))
        assert set(manifest) == set(FILES)
        candidate = STAGE / 'candidate'
        candidate.mkdir(mode=0o700)
        for name in FILES:
            source = LIVE / name
            assert source.is_file() and not source.is_symlink()
            assert digest(source) == manifest[name]['before'], 'Production drift: ' + name
            target = candidate / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(name) as incoming, target.open('wb') as dest:
                shutil.copyfileobj(incoming, dest)
            assert digest(target) == manifest[name]['after']
    subprocess.run(['systemctl', 'is-active', '--quiet', 'gipc.service'], check=True)
    pid_before = subprocess.check_output(['systemctl', 'show', 'gipc.service', '-p', 'MainPID', '--value'], text=True).strip()
    assert not BACKUP.exists()
    BACKUP.mkdir(mode=0o700)
    for name in FILES:
        target = BACKUP / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(LIVE / name, target)
    (BACKUP / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    changed = []
    try:
        for name in FILES:  # JS first, HTML last. No service reload/restart.
            assert digest(LIVE / name) == manifest[name]['before'], 'Production drift: ' + name
            replace(candidate / name, LIVE / name)
            changed.append(name)
        for name in FILES:
            assert digest(LIVE / name) == manifest[name]['after']
        subprocess.run(['systemctl', 'is-active', '--quiet', 'gipc.service'], check=True)
        pid_after = subprocess.check_output(['systemctl', 'show', 'gipc.service', '-p', 'MainPID', '--value'], text=True).strip()
        receipt = {'status': 'deployed', 'files': FILES, 'backup': str(BACKUP),
                   'payload': expected_payload, 'backend_pid_unchanged': pid_before == pid_after}
        (BACKUP / 'receipt.json').write_text(json.dumps(receipt, indent=2))
        print(json.dumps(receipt), flush=True)
    except BaseException:
        for name in reversed(changed):
            replace(BACKUP / name, LIVE / name)
        print('ROLLBACK_OK; three static files only', flush=True)
        raise


if __name__ == '__main__':
    if sys.argv[1] == 'pack':
        pack()
    elif sys.argv[1] == 'apply':
        apply(sys.argv[2])
    else:
        raise ValueError('Unknown mode')
