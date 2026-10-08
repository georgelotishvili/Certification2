"""Offload explicitly inventoried retired artifacts, then remove only those paths."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tarfile

STORE = Path(__file__).resolve().parent / 'server-cleanup-20261008'
OLD_ARCHIVE = Path('C:/tmp/gipc-pre-os-upgrade-20260804/gipc-pre-os-upgrade-20260804.tar.gz.enc')
OLD_HASH = 'd3f98d4155cd821ddbb3a430d79837de80d84eedd456f6be9e58920b31b89ca3'
SSH = ['ssh', '-i', 'C:/Users/george/.ssh/gipc_admin_ed25519', '-o', 'BatchMode=yes',
       '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15',
       'gipcadmin@148.251.167.229', 'sudo -n python3 -']
TARGETS = [
    '/root/gipc-backups/pre-hardening-20260803T190101Z',
    '/root/gipc-backups/hardening-deploy-20260803',
    '/root/gipc-backups/firewall-fail2ban-20260803-iE5iAo',
    '/root/gipc-backups/nonroot-cutover-20260803',
    '/root/gipc-backups/ssh-admin-20260804',
    '/root/gipc-backups/ssh-lockdown-20260804',
    '/root/gipc-backups/pre-os-upgrade-20260804',
    '/root/gipc-backups/statement-workflow-20261008-01',
    '/root/gipc-backups/filter-labels-20261008-01',
    '/root/gipc-backups/full-filter-labels-20261008-01',
    '/home/gipcadmin/statement-workflow-20261008-01',
    '/home/gipcadmin/filter-labels-20261008-01',
    '/home/gipcadmin/full-filter-labels-20261008-01',
    '/root/gipc-deploys/20260803T195736Z',
    '/root/gipc-deploys/20260803T200751Z',
    '/root/gipc-deploys/20260803T200859Z',
    '/root/gipc-deploys/gipc-hardening-20260803T195736Z.tar.gz',
    '/root/gipc-deploys/gipc-hardening-v2-20260803T200751Z.tar.gz',
    '/root/gipc-deploys/gipc-hardening-v3-20260803T200859Z.tar.gz',
    '/root/gipc-staging/os_upgrade_preflight_v3.sh',
    '/root/gipc-staging/os_upgrade_backup_v2.sh',
    '/root/gipc_deploy_backups/20260803_a83f9c2e_public_profile_visibility',
]
SKIP = 'root/gipc-backups/pre-os-upgrade-20260804/offhost-backup.tar.gz.enc'

REMOTE = r'''
import hashlib, json, os, shutil, stat, subprocess
from pathlib import Path
assert os.geteuid() == 0
def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for part in iter(lambda: f.read(1024 * 1024), b''):
            h.update(part)
    return h.hexdigest()
def under(path):
    return any(path == target or path.startswith(target + '/') for target in TARGETS)
def validate():
    mounts = subprocess.check_output(['findmnt', '-rn', '-o', 'TARGET'], text=True).splitlines()
    for value in TARGETS:
        p = Path(value)
        assert p.exists() and not p.is_symlink() and str(p.resolve()) == value, value
        assert p.parent.as_posix() in ('/root/gipc-backups', '/root/gipc-deploys', '/root/gipc-staging', '/root/gipc_deploy_backups', '/home/gipcadmin')
        assert not any(m == value or m.startswith(value + '/') for m in mounts), 'Mounted target'
    for process in Path('/proc').iterdir():
        if not process.name.isdigit():
            continue
        links = [process / 'cwd', process / 'exe']
        try:
            links += list((process / 'fd').iterdir())
        except (FileNotFoundError, PermissionError):
            pass
        for link in links:
            try:
                assert not under(os.readlink(link)), 'Artifact still in use'
            except (FileNotFoundError, PermissionError, OSError):
                pass
    for folder in ('/etc/systemd/system', '/etc/cron.d', '/var/spool/cron/crontabs'):
        for p in Path(folder).rglob('*'):
            if p.is_file():
                content = p.read_bytes()
                assert not any(t.encode() in content for t in TARGETS), 'Scheduled artifact: ' + str(p)
def inventory():
    validate()
    result = {}
    for value in TARGETS:
        root = Path(value)
        paths = [root] + (list(root.rglob('*')) if root.is_dir() else [])
        for p in paths:
            info = p.lstat()
            record = {'mode': info.st_mode, 'size': info.st_size, 'mtime_ns': info.st_mtime_ns}
            if stat.S_ISLNK(info.st_mode):
                record.update(type='link', target=os.readlink(p))
            elif stat.S_ISDIR(info.st_mode):
                record.update(type='dir')
            elif stat.S_ISREG(info.st_mode):
                record.update(type='file', sha256=digest(p))
            else:
                raise RuntimeError('Unexpected file type: ' + str(p))
            result[p.as_posix().lstrip('/')] = record
    return result
def live_state():
    subprocess.run(['systemctl', 'is-active', '--quiet', 'gipc.service'], check=True)
    pid = subprocess.check_output(['systemctl', 'show', 'gipc.service', '-p', 'MainPID', '--value'], text=True).strip()
    base = Path('/var/www/gipc')
    files = {}
    for root in (base / 'frontend', base / 'backend/app', base / 'backend/scripts'):
        for p in root.rglob('*'):
            if p.is_file() and p.suffix in ('.py', '.js', '.html', '.css'):
                files[str(p)] = digest(p)
    assert Path('/var/lib/gipc/db/app.db').is_file()
    return {'pid': pid, 'files': files}
'''

def digest_stream(stream):
    h = hashlib.sha256()
    for part in iter(lambda: stream.read(1024 * 1024), b''):
        h.update(part)
    return h.hexdigest()

def remote(source, output=None):
    code = 'TARGETS = ' + repr(TARGETS) + '\n' + REMOTE + '\n' + source
    return subprocess.run(SSH, input=code.encode(), stdout=output or subprocess.PIPE,
                          stderr=subprocess.PIPE, check=True)

def verify_archive(expected):
    with OLD_ARCHIVE.open('rb') as stream:
        assert digest_stream(stream) == OLD_HASH == expected[SKIP]['sha256']
    found = set()
    with tarfile.open(STORE / 'retired-artifacts.tar', 'r|') as archive:
        for member in archive:
            name = member.name.rstrip('/')
            assert name in expected and name != SKIP and name not in found, name
            item = expected[name]
            if member.isfile():
                assert item['type'] == 'file'
                assert digest_stream(archive.extractfile(member)) == item['sha256'], name
            elif member.issym():
                assert item['type'] == 'link' and member.linkname == item['target']
            else:
                assert member.isdir() and item['type'] == 'dir', name
            found.add(name)
    assert found == set(expected) - {SKIP}, 'Incomplete local archive'

def copy():
    subprocess.run(['git', 'check-ignore', '--quiet', str(STORE / 'retired-artifacts.tar')], check=True)
    before = json.loads(remote("print(json.dumps({'inventory': inventory(), 'live': live_state()}))").stdout)
    (STORE / 'inventory.json').write_text(json.dumps(before, indent=2), encoding='utf-8')
    print('INVENTORY_OK', len(before['inventory']), flush=True)
    with (STORE / 'retired-artifacts.tar').open('xb') as output:
        remote("validate()\nsubprocess.run(['tar', '--hard-dereference', '--exclude=" + SKIP + "', '-cf', '-', '-C', '/'] + [p.lstrip('/') for p in TARGETS], check=True)", output)
    verify_archive(before['inventory'])
    print('LOCAL_ARCHIVE_VERIFIED', (STORE / 'retired-artifacts.tar').stat().st_size, flush=True)

def clean():
    before = json.loads((STORE / 'inventory.json').read_text(encoding='utf-8'))
    verify_archive(before['inventory'])
    action = 'expected = ' + repr(before) + r'''
assert inventory() == expected['inventory'], 'Artifact changed since offload'
assert live_state() == expected['live'], 'Site changed since inspection'
allocated = sum(Path('/' + p).lstat().st_blocks * 512 for p in expected['inventory'])
disk_before = shutil.disk_usage('/').free
for value in TARGETS:
    p = Path(value)
    assert str(p.resolve()) == value and not p.is_symlink()
    if p.is_dir():
        shutil.rmtree(p)
    else:
        p.unlink()
assert all(not Path(p).exists() for p in TARGETS)
assert live_state() == expected['live'], 'Post-cleanup site state differs'
disk_after = shutil.disk_usage('/').free
print(json.dumps({'status': 'cleaned', 'paths_removed': TARGETS, 'allocated_bytes_removed': allocated, 'free_bytes_before': disk_before, 'free_bytes_after': disk_after, 'backend_pid_unchanged': True, 'live_code_unchanged': True}))
'''
    result = remote(action)
    (STORE / 'receipt.json').write_bytes(result.stdout)
    print(result.stdout.decode())

if __name__ == '__main__':
    if sys.argv[1] == 'copy':
        copy()
    elif sys.argv[1] == 'clean':
        clean()
    else:
        raise ValueError('Unknown mode')
