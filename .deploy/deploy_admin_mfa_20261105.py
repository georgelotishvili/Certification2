"""Scoped first MFA release; no secrets leave the production host.

The ordinary release guard checks active exams and stops admission BEFORE the
additive dependencies/key are provisioned. Rollback restores code; it never
deletes MFA tables or rotates a previously generated encryption key.
Keep /var/lib/gipc/secrets/admin-mfa.key in the restricted server recovery plan,
separately from database copies. Losing it prevents decrypting enrolled seeds.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("mfa_base_release", ROOT / ".deploy/deploy_admin_release_20261016.py")
BASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BASE)

# Executed only after the unchanged base deployer has locked/checkpointed the
# exam-admission boundary and stopped the backend; all source targets retain CAS.
PROVISION = r'''
    import grp, importlib.metadata, pwd
    service_user = subprocess.check_output(["systemctl", "show", "gipc.service", "--property=User", "--value"], text=True).strip()
    if service_user != "gipcapp":
        raise RuntimeError("Unexpected backend service identity")
    py = "/var/www/gipc/backend/venv-hardening-20260803/bin/python"
    pins = {"pyotp": "2.10.0", "cryptography": "50.0.2"}
    inspect_code = "import importlib.metadata as m,json; print(json.dumps({n:next((d.version for d in m.distributions() if d.metadata['Name'].lower()==n),None) for n in ['pyotp','cryptography']}))"
    installed = json.loads(subprocess.check_output([py, "-B", "-c", inspect_code], text=True))
    if any(installed[name] not in (None, version) for name, version in pins.items()):
        raise RuntimeError("Existing cryptographic package differs; manual review required")
    if any(installed[name] is None for name in pins):
        result = subprocess.run([py, "-B", "-m", "pip", "install", "--disable-pip-version-check", "--only-binary=:all:", "pyotp==2.10.0", "cryptography==50.0.2"], capture_output=True, text=True, timeout=120)
        if result.returncode:
            raise RuntimeError("MFA package installation failed; backend code will be restored")
    # Generate a key with the installed crypto library, directly into a
    # root-controlled file. Never print key material, including on errors.
    key_setup = r"""
import os, pathlib, pwd, stat
from cryptography.fernet import Fernet
directory = pathlib.Path('/var/lib/gipc/secrets')
if directory.parent.resolve() != pathlib.Path('/var/lib/gipc'):
    raise RuntimeError('Unexpected secret parent')
if directory.exists():
    if directory.is_symlink() or not directory.is_dir() or directory.stat().st_uid != 0:
        raise RuntimeError('Unsafe secret directory')
else:
    directory.mkdir(mode=0o750)
gid = pwd.getpwnam('gipcapp').pw_gid
os.chown(directory, 0, gid)
os.chmod(directory, 0o750)
key_path = directory / 'admin-mfa.key'
if key_path.exists():
    if key_path.is_symlink() or not key_path.is_file() or key_path.stat().st_uid != 0:
        raise RuntimeError('Unsafe existing MFA key')
    Fernet(key_path.read_bytes().strip())
else:
    fd = os.open(str(key_path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(Fernet.generate_key() + b'\n')
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        key_path.unlink(missing_ok=True)
        raise
os.chown(key_path, 0, gid)
os.chmod(key_path, 0o640)
"""
    subprocess.run([py, "-B", "-c", key_setup], check=True, capture_output=True, timeout=15)
    dropin_dir = Path("/etc/systemd/system/gipc.service.d")
    if dropin_dir.is_symlink():
        raise RuntimeError("Unsafe service drop-in directory")
    dropin_dir.mkdir(mode=0o755, exist_ok=True)
    dropin = dropin_dir / "40-admin-mfa-key.conf"
    content = b'[Service]\nEnvironment="ADMIN_MFA_KEY_FILE=/var/lib/gipc/secrets/admin-mfa.key"\n'
    if dropin.exists():
        if dropin.is_symlink() or dropin.read_bytes() != content:
            raise RuntimeError("Existing MFA configuration differs; refusing overwrite")
    else:
        fd = os.open(str(dropin), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
    subprocess.run(["systemctl", "daemon-reload"], check=True, timeout=15)
'''


def provisioned_transport(transport):
    def run(script, payload=None):
        if payload and "files" in payload:
            marker = '    ref_stat = (root / "backend/app/main.py").stat()'
            assert script.count(marker) == 1
            assert script.index('db.execute("BEGIN IMMEDIATE")') < script.index(marker)
            assert script.index('["systemctl", "stop", "gipc.service"]') < script.index(marker)
            script = script.replace(marker, PROVISION + "\n" + marker)
        return transport(script, payload)
    return run


def release(paths):
    if not paths or not set(paths) <= set(BASE.CANDIDATE_FILES):
        raise RuntimeError("Release must name explicit manifested runtime files")
    BASE.CANDIDATE_FILES = paths
    diff = BASE.check_diff()
    # Preserve unrelated remote changes. Compare bytes after newline
    # normalization to the local HEAD through a read-only remote hash check.
    expected = {}
    for path in paths:
        result = subprocess.run(["git", "show", "HEAD:" + path], cwd=ROOT, capture_output=True)
        expected[path] = BASE.sha256_bytes(result.stdout.replace(b"\r\n", b"\n")) if result.returncode == 0 else None
    script = '''import hashlib,json
from pathlib import Path
r=Path('/var/www/gipc')
print(json.dumps({p:hashlib.sha256((r/p).read_bytes().replace(b'\\r\\n',b'\\n')).hexdigest() if (r/p).is_file() else None for p in PAYLOAD['paths']}))'''
    actual = BASE.run_remote_python(script, {"paths": paths})
    if actual != expected:
        raise RuntimeError("Server differs from HEAD; inspect before deployment: " + ", ".join(p for p in paths if actual[p] != expected[p]))
    if not diff["changed"]:
        return {"unchanged": True}
    BASE.run_remote_python = provisioned_transport(BASE.run_remote_python)
    return BASE.deploy(diff["changed"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--paths", nargs="+", required=True)
    parser.add_argument("--deploy", action="store_true")
    args = parser.parse_args()
    if args.deploy:
        print(json.dumps(release(args.paths), indent=2))
    else:
        BASE.CANDIDATE_FILES = args.paths
        print(json.dumps(BASE.check_diff(), indent=2))
