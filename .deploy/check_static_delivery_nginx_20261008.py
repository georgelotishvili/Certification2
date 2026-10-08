"""Read-only Nginx syntax check: candidate lives in a Linux memory fd, not disk."""

import base64
import json
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]
candidate = (ROOT / ".deploy/static-delivery-20261008/gipc.candidate.v2.conf").read_bytes()
baseline = (ROOT / ".deploy/gipc.nginx").read_text(encoding="utf-8-sig").replace("\r\n", "\n")
payload = {"candidate": base64.b64encode(candidate).decode(), "baseline": baseline}

REMOTE = r'''
import base64, hashlib, json, os, subprocess
from pathlib import Path
payload = PAYLOAD
site = Path('/etc/nginx/sites-enabled/gipc')
before = site.read_bytes()
assert before.decode().replace('\r\n', '\n') == payload['baseline'], 'Production configuration drift'
main = Path('/etc/nginx/nginx.conf').read_text()
anchor = 'include /etc/nginx/sites-enabled/*;'
assert main.count(anchor) == 1
candidate = base64.b64decode(payload['candidate'], validate=True).decode()
test_config = main.replace(anchor, candidate)
nginx_pid = Path('/run/nginx.pid').read_bytes()
backend_pid = subprocess.check_output(['systemctl', 'show', 'gipc.service', '-p', 'MainPID', '--value'])
# nginx parses a file by fstat size; use a regular memory-backed fd, not a pipe.
fd = os.memfd_create('gipc-static-config-validation', 0)
try:
    os.write(fd, test_config.encode())
    os.lseek(fd, 0, os.SEEK_SET)
    check = subprocess.run(['nginx', '-t', '-c', '/proc/self/fd/' + str(fd)],
                           pass_fds=(fd,), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
finally:
    os.close(fd)
assert site.read_bytes() == before, 'Live config changed during read-only validation'
assert Path('/run/nginx.pid').read_bytes() == nginx_pid
assert subprocess.check_output(['systemctl', 'show', 'gipc.service', '-p', 'MainPID', '--value']) == backend_pid
print(json.dumps({'success': check.returncode == 0, 'diagnostic': check.stderr.decode(),
                  'live_config_sha256': hashlib.sha256(before).hexdigest(),
                  'nginx_pid_unchanged': True, 'backend_pid_unchanged': True,
                  'config_written_to_server': False, 'reload_performed': False}))
raise SystemExit(check.returncode)
'''.replace("PAYLOAD", repr(payload), 1)

ssh = ['ssh', '-i', 'C:/Users/george/.ssh/gipc_admin_ed25519', '-o', 'BatchMode=yes',
       '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15',
       'gipcadmin@148.251.167.229', 'sudo -n python3 -']
result = subprocess.run(ssh, input=REMOTE.encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
print(result.stdout.decode())
if result.stderr:
    print(result.stderr.decode())
raise SystemExit(result.returncode)
