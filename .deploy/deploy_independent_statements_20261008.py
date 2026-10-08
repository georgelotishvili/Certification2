"""Deploy two static files; rollback copies persist locally, never on the server."""
import base64
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
STORE = ROOT / '.deploy/independent-statements-20261008-01'
FILES = ['frontend/scripts/admin/users.js', 'frontend/pages/admin.html']
EXPECTED = {
    FILES[0]: 'e60ce58eccaadf8c2638edf303f0d4845428ea0ed59793a9def13fe21c78a474',
    FILES[1]: '31760d230e24a5174efae685d1b231fdc624ecb55422bc2b32da29e0cbea1901',
}
SSH = ['ssh', '-i', 'C:/Users/george/.ssh/gipc_admin_ed25519', '-o', 'BatchMode=yes',
       '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15',
       'gipcadmin@148.251.167.229', 'sudo -n python3 -']

REMOTE = r'''
import base64, hashlib, json, os, subprocess, tempfile
from pathlib import Path
assert os.geteuid() == 0
LIVE = Path('/var/www/gipc')
FILES = ['frontend/scripts/admin/users.js', 'frontend/pages/admin.html']
def digest(content):
    return hashlib.sha256(content).hexdigest()
def service_pid():
    subprocess.run(['systemctl', 'is-active', '--quiet', 'gipc.service'], check=True)
    return subprocess.check_output(['systemctl', 'show', 'gipc.service', '-p', 'MainPID', '--value'], text=True).strip()
def target(name):
    assert name in FILES
    p = LIVE / name
    assert p.is_file() and not p.is_symlink() and p.resolve() == p
    return p
def replace(p, content, metadata):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=str(p.parent), prefix='.gipc-static-', delete=False) as f:
            temporary = Path(f.name)
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.chown(temporary, metadata.st_uid, metadata.st_gid)
        os.chmod(temporary, metadata.st_mode & 0o777)
        os.replace(temporary, p)
    finally:
        if temporary is not None and temporary.exists():
            assert temporary.parent == p.parent and temporary.name.startswith('.gipc-static-')
            temporary.unlink()
'''

def digest(content):
    return hashlib.sha256(content).hexdigest()

def remote(action):
    result = subprocess.run(SSH, input=(REMOTE + '\n' + action).encode(),
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    return json.loads(result.stdout)

def prepare():
    assert not (STORE / 'manifest.json').exists()
    data = remote("print(json.dumps({'pid': service_pid(), 'files': {name: base64.b64encode(target(name).read_bytes()).decode() for name in FILES}}))")
    manifest = {'pid': data['pid'], 'files': {}}
    for name in FILES:
        old = base64.b64decode(data['files'][name], validate=True)
        assert digest(old) == EXPECTED[name], 'Production drift: ' + name
        new = (ROOT / name).read_bytes()
        for folder, content in [('before', old), ('after', new)]:
            destination = STORE / folder / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open('xb') as output:
                output.write(content)
        manifest['files'][name] = {'before': digest(old), 'after': digest(new)}
    (STORE / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print('LOCAL_ROLLBACK_COPIES_VERIFIED; two static files only', flush=True)

def apply():
    manifest = json.loads((STORE / 'manifest.json').read_text(encoding='utf-8'))
    payload = {}
    for name in FILES:
        entry = manifest['files'][name]
        assert digest((STORE / 'before' / name).read_bytes()) == entry['before']
        new = (STORE / 'after' / name).read_bytes()
        assert digest(new) == entry['after'] == digest((ROOT / name).read_bytes())
        payload[name] = {**entry, 'data': base64.b64encode(new).decode()}
    action = 'payload = ' + repr(payload) + '\nexpected_pid = ' + repr(manifest['pid']) + r'''
assert set(payload) == set(FILES)
assert service_pid() == expected_pid
old = {}
new = {}
metadata = {}
for name in FILES:
    p = target(name)
    old[name] = p.read_bytes()
    metadata[name] = p.stat()
    assert digest(old[name]) == payload[name]['before'], 'Production drift: ' + name
    new[name] = base64.b64decode(payload[name]['data'], validate=True)
    assert digest(new[name]) == payload[name]['after']
changed = []
try:
    for name in FILES:
        p = target(name)
        assert digest(p.read_bytes()) == payload[name]['before'], 'Production drift: ' + name
        replace(p, new[name], metadata[name])
        changed.append(name)
    for name in FILES:
        assert digest(target(name).read_bytes()) == payload[name]['after']
    assert service_pid() == expected_pid
    print(json.dumps({'status': 'deployed', 'files': FILES, 'backend_pid_unchanged': True, 'server_backup_created': False, 'server_staging_created': False}))
except BaseException:
    for name in reversed(changed):
        replace(target(name), old[name], metadata[name])
    raise
'''
    receipt = remote(action)
    (STORE / 'receipt.json').write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    print(json.dumps(receipt), flush=True)

def verify():
    manifest = json.loads((STORE / 'manifest.json').read_text(encoding='utf-8'))
    for path, name in [('/scripts/admin/users.js?v=20261008-6', FILES[0]), ('/pages/admin.html', FILES[1])]:
        request = urllib.request.Request('https://gipc.org.ge' + path, headers={'Cache-Control': 'no-cache'})
        with urllib.request.urlopen(request, timeout=20) as response:
            assert response.status == 200
            assert digest(response.read()) == manifest['files'][name]['after'], path
        print('LIVE_HASH_OK', path, flush=True)
    with urllib.request.urlopen('https://gipc.org.ge/', timeout=20) as response:
        assert response.status == 200
    print('HOMEPAGE_OK', flush=True)

if __name__ == '__main__':
    {'prepare': prepare, 'apply': apply, 'verify': verify}[sys.argv[1]]()
