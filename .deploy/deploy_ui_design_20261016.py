"""Deploy updated public UI/typography/footer/site-info frontend files."""
import base64
import hashlib
import json
from pathlib import Path
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
STORE = ROOT / '.deploy/ui-design-release-20261016-02'
FILES = [
    'frontend/assets/svg/logo.svg',
    'frontend/pages/index.html',
    'frontend/pages/my.html',
    'frontend/pages/registry.html',
    'frontend/partials/header.html',
    'frontend/partials/site-info/guide.html',
    'frontend/scripts/header.js',
    'frontend/scripts/my.js',
    'frontend/styles/header.css',
    'frontend/styles/my.css',
    'frontend/styles/registry.css',
    'frontend/styles/styles.css',
]
SSH = [
    'ssh', '-i', 'C:/Users/george/.ssh/gipc_admin_ed25519',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=15', 'gipcadmin@148.251.167.229',
    'sudo -n python3 -',
]

REMOTE = r'''
import base64, hashlib, json, os, subprocess, tempfile
from pathlib import Path
assert os.geteuid() == 0
LIVE = Path('/var/www/gipc')
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
            temporary.unlink()
'''


def digest(content):
    return hashlib.sha256(content).hexdigest()


def remote(action):
    script = REMOTE + '\nFILES = ' + repr(FILES) + '\n' + action
    result = subprocess.run(
        SSH,
        input=script.encode('utf-8'),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    return json.loads(result.stdout)


def main():
    data = remote(
        "print(json.dumps({'pid': service_pid(), 'files': {name: base64.b64encode(target(name).read_bytes()).decode() for name in FILES}}))"
    )
    manifest = {'pid': data['pid'], 'files': {}}
    payload = {}
    for name in FILES:
        old = base64.b64decode(data['files'][name], validate=True)
        new = (ROOT / name).read_bytes()
        for folder, content in [('before', old), ('after', new)]:
            dest = STORE / folder / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(content)
        entry = {'before': digest(old), 'after': digest(new)}
        manifest['files'][name] = entry
        payload[name] = {**entry, 'data': base64.b64encode(new).decode()}

    (STORE / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')

    action = 'payload = ' + repr(payload) + '\nexpected_pid = ' + repr(manifest['pid']) + r'''
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
        replace(p, new[name], metadata[name])
        changed.append(name)
    for name in FILES:
        assert digest(target(name).read_bytes()) == payload[name]['after']
    assert service_pid() == expected_pid
    print(json.dumps({'status': 'deployed', 'files_count': len(FILES), 'backend_pid_unchanged': True}))
except BaseException:
    for name in reversed(changed):
        replace(target(name), old[name], metadata[name])
    raise
'''
    receipt = remote(action)
    (STORE / 'receipt.json').write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    print('DEPLOY_RECEIPT:', json.dumps(receipt), flush=True)

    verified = 0
    for host in ['https://gipc.org.ge', 'https://www.gipc.org.ge']:
        for name in FILES:
            url = host + '/' + name.removeprefix('frontend/') + '?v=20261016-check'
            req = urllib.request.Request(url, headers={'Cache-Control': 'no-cache'})
            with urllib.request.urlopen(req, timeout=20) as resp:
                assert resp.status == 200, url
                assert digest(resp.read()) == manifest['files'][name]['after'], url
                verified += 1
        with urllib.request.urlopen(host + '/', timeout=20) as resp:
            assert resp.status == 200
            assert digest(resp.read()) == manifest['files']['frontend/pages/index.html']['after']
    verification = {'https_files_verified': verified, 'both_hosts_verified': True}
    (STORE / 'verification.json').write_text(json.dumps(verification, indent=2), encoding='utf-8')
    print('VERIFICATION:', json.dumps(verification), flush=True)


if __name__ == '__main__':
    main()
