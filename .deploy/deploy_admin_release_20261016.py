from __future__ import annotations

import base64
import hashlib
import json
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEPLOY_DIR = ROOT / ".deploy" / "statement-reply-release-20261018-01"
BEFORE_DIR = DEPLOY_DIR / "before"
AFTER_DIR = DEPLOY_DIR / "after"

SSH_KEY = "C:/Users/george/.ssh/gipc_admin_ed25519"
HOST = "gipcadmin@148.251.167.229"
SSH = [
    "ssh",
    "-i",
    SSH_KEY,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=15",
    HOST,
]

CANDIDATE_FILES = [
    "backend/app/config.py",
    "backend/app/main.py",
    "backend/app/models.py",
    "backend/app/routers/admin.py",
    "backend/app/routers/ai_assistant.py",
    "backend/app/routers/documents.py",
    "backend/app/routers/exam_schedules.py",
    "backend/app/routers/guide.py",
    "backend/app/routers/planning_letters.py",
    "backend/app/routers/statements.py",
    "backend/app/routers/users.py",
    "backend/app/schemas.py",
    "backend/app/services/candidate_status.py",
    "backend/app/services/contract_assembler.py",
    "backend/app/services/email_verification.py",
    "backend/app/services/planning_email.py",
    "backend/app/data/contracts/01_სერტიფიკაციის_სქემა.md",
    "backend/app/data/contracts/01_სერტიფიკაციის_სქემა.docx",
    "backend/app/data/contracts/03_მიუკერძოებლობის_პოლიტიკა.md",
    "backend/app/data/contracts/03_მიუკერძოებლობის_პოლიტიკა.docx",
    "backend/app/data/contracts/04_კონფიდენციალურობის_პოლიტიკა.md",
    "backend/app/data/contracts/04_კონფიდენციალურობის_პოლიტიკა.docx",
    "backend/app/data/contracts/07_საჩივრებისა_და_აპელაციების_პროცედურა.md",
    "backend/app/data/contracts/07_საჩივრებისა_და_აპელაციების_პროცედურა.docx",
    "backend/app/data/contracts/08_სასერტიფიკაციო_ხელშეკრულება_არქიტექტორი.md",
    "backend/app/data/contracts/08_სასერტიფიკაციო_ხელშეკრულება_არქიტექტორი.docx",
    "backend/app/data/contracts/09_სასერტიფიკაციო_ხელშეკრულება_ექსპერტი.md",
    "backend/app/data/contracts/09_სასერტიფიკაციო_ხელშეკრულება_ექსპერტი.docx",
    "backend/app/data/contracts/09a_სასერტიფიკაციო_ხელშეკრულება_სპეციალისტი.md",
    "backend/app/data/contracts/09a_სასერტიფიკაციო_ხელშეკრულება_სპეციალისტი.docx",
    "backend/app/data/contracts/10_საგამოცდო_ხელშეკრულება.md",
    "backend/app/data/contracts/10_საგამოცდო_ხელშეკრულება.docx",
    "backend/scripts/migrate_candidate_status.py",
    "backend/scripts/migrate_documents.py",
    "backend/scripts/migrate_guide_videos.py",
    "backend/scripts/migrate_planning_letters.py",
    "backend/scripts/migrate_doc_numbers.py",
    "frontend/assets/svg/logo.svg",
    "frontend/pages/admin.html",
    "frontend/pages/documents.html",
    "frontend/pages/index.html",
    "frontend/pages/my.html",
    "frontend/pages/registry.html",
    "frontend/partials/header.html",
    "frontend/partials/site-info/guide.html",
    "frontend/scripts/admin.js",
    "frontend/scripts/admin/ai-assistant.js",
    "frontend/scripts/admin/app-files.js",
    "frontend/scripts/admin/certificate.js",
    "frontend/scripts/admin/documents.js",
    "frontend/scripts/admin/exam-schedules.js",
    "frontend/scripts/admin/guide-videos.js",
    "frontend/scripts/admin/project-results.js",
    "frontend/scripts/admin/results.js",
    "frontend/scripts/admin/statements.js",
    "frontend/scripts/admin/users.js",
    "frontend/scripts/documents.js",
    "frontend/scripts/header.js",
    "frontend/scripts/my.js",
    "frontend/scripts/registry.mini.js",
    "frontend/scripts/script.js",
    "frontend/styles/admin.css",
    "frontend/styles/documents.css",
    "frontend/styles/header.css",
    "frontend/styles/my.css",
    "frontend/styles/registry.css",
    "frontend/styles/styles.css",
]


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def run_remote_python(script: str, payload: dict | None = None) -> dict:
    input_bytes = script.encode("utf-8")
    cmd = SSH + ["sudo -n python3 -"]
    if payload is not None:
        wrapper = (
            "import json, sys\n"
            f"PAYLOAD = json.loads({json.dumps(json.dumps(payload))})\n"
            + script
        )
        input_bytes = wrapper.encode("utf-8")
    proc = subprocess.run(
        cmd,
        input=input_bytes,
        capture_output=True,
    )
    if proc.returncode != 0:
        print("STDOUT:", proc.stdout.decode("utf-8", errors="replace")[-2000:], file=sys.stderr)
        print("STDERR:", proc.stderr.decode("utf-8", errors="replace")[-5000:], file=sys.stderr)
        raise SystemExit(proc.returncode)
    out = proc.stdout.decode("utf-8", errors="replace").strip()
    return json.loads(out)


def check_diff() -> dict:
    local_rels = CANDIDATE_FILES
    local_hashes = {
        rel: sha256_bytes((ROOT / rel).read_bytes())
        for rel in local_rels
    }
    remote_script = """
import hashlib, json, sqlite3
from pathlib import Path

root = Path("/var/www/gipc")
rels = PAYLOAD["rels"]
remote_hashes = {}
for rel in rels:
    p = root / rel
    if p.exists() and p.is_file():
        remote_hashes[rel] = hashlib.sha256(p.read_bytes()).hexdigest()
    else:
        remote_hashes[rel] = None

con = sqlite3.connect("file:/var/lib/gipc/db/app.db?mode=ro", uri=True)
cur = con.cursor()
counts = {}
for name, sql in [
    ("active_exam_sessions", "SELECT COUNT(*) FROM sessions WHERE active=1 AND finished_at IS NULL AND (ends_at IS NULL OR datetime(ends_at)>=datetime('now','-5 minutes'))"),
]:
    try:
        counts[name] = cur.execute(sql).fetchone()[0]
    except Exception as exc:
        counts[name] = str(exc)
con.close()

print(json.dumps({"remote_hashes": remote_hashes, "exam_counts": counts}))
"""
    res = run_remote_python(remote_script, {"rels": local_rels})
    remote_hashes = res["remote_hashes"]
    changed = []
    for rel in local_rels:
        if remote_hashes.get(rel) != local_hashes[rel]:
            changed.append({
                "path": rel,
                "local_sha256": local_hashes[rel],
                "remote_sha256": remote_hashes.get(rel),
            })
    return {"changed": changed, "exam_counts": res["exam_counts"]}


def deploy(changed_items: list[dict]) -> dict:
    rels = [item["path"] for item in changed_items]
    fetch_script = """
import base64, hashlib, json
from pathlib import Path

root = Path("/var/www/gipc")
files = {}
for rel in PAYLOAD["rels"]:
    p = root / rel
    if p.exists():
        raw = p.read_bytes()
        st = p.stat()
        files[rel] = {
            "exists": True,
            "sha256": hashlib.sha256(raw).hexdigest(),
            "mode": oct(st.st_mode & 0o777),
            "uid": st.st_uid,
            "gid": st.st_gid,
            "b64": base64.b64encode(raw).decode("ascii"),
        }
    else:
        files[rel] = {"exists": False}
print(json.dumps(files))
"""
    remote_before = run_remote_python(fetch_script, {"rels": rels})

    DEPLOY_DIR.mkdir(parents=True, exist_ok=True)
    manifest = {
        "release": DEPLOY_DIR.name,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "host": HOST,
        "files": [],
    }
    upload_files = {}
    for rel in rels:
        info = remote_before[rel]
        if info.get("exists"):
            before_path = BEFORE_DIR / rel
            before_path.parent.mkdir(parents=True, exist_ok=True)
            before_path.write_bytes(base64.b64decode(info["b64"]))
        after_bytes = (ROOT / rel).read_bytes()
        after_path = AFTER_DIR / rel
        after_path.parent.mkdir(parents=True, exist_ok=True)
        after_path.write_bytes(after_bytes)
        manifest["files"].append({
            "path": rel,
            "before_sha256": info.get("sha256"),
            "after_sha256": sha256_bytes(after_bytes),
            "existed_before": bool(info.get("exists")),
        })
        upload_files[rel] = {
            "b64": base64.b64encode(after_bytes).decode("ascii"),
            "sha256": sha256_bytes(after_bytes),
        }

    (DEPLOY_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    apply_script = """
import base64, hashlib, json, os, subprocess, time, urllib.request
from pathlib import Path

root = Path("/var/www/gipc")
files = PAYLOAD["files"]
backups = {}
created = []

def wait_for_openapi():
    last_err = None
    for _ in range(40):
        try:
            with urllib.request.urlopen("http://127.0.0.1:8000/openapi.json", timeout=5) as resp:
                if resp.status == 200:
                    return resp.status, json.loads(resp.read().decode("utf-8"))
        except Exception as exc:
            last_err = exc
            time.sleep(0.4)
    raise RuntimeError(f"Backend did not become healthy: {last_err}")

def restore():
    for rel, raw in backups.items():
        p = root / rel
        st = p.stat()
        tmp = p.with_name(p.name + ".rollback-tmp")
        tmp.write_bytes(raw)
        os.chown(tmp, st.st_uid, st.st_gid)
        os.chmod(tmp, st.st_mode & 0o777)
        os.replace(tmp, p)
    for rel in created:
        p = root / rel
        if p.exists():
            p.unlink()
    subprocess.run(["systemctl", "restart", "gipc.service"], check=False)

try:
    ref_stat = (root / "backend/app/main.py").stat()
    for rel, item in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        raw = base64.b64decode(item["b64"])
        if hashlib.sha256(raw).hexdigest() != item["sha256"]:
            raise RuntimeError(f"hash mismatch for {rel}")
        if p.exists():
            backups[rel] = p.read_bytes()
            st = p.stat()
            uid, gid, mode = st.st_uid, st.st_gid, st.st_mode & 0o777
        else:
            created.append(rel)
            uid, gid, mode = ref_stat.st_uid, ref_stat.st_gid, 0o644
        tmp = p.with_name(p.name + ".deploy-tmp")
        tmp.write_bytes(raw)
        os.chown(tmp, uid, gid)
        os.chmod(tmp, mode)
        os.replace(tmp, p)

    contracts_dir = root / "backend/app/data/contracts"
    if contracts_dir.is_dir():
        for old_p in contracts_dir.glob("*_\u10d0\u10e0\u10d2\u10dd\u10dc.*"):
            try:
                old_p.unlink()
            except OSError:
                pass

    py_rels = [rel for rel in files if rel.endswith(".py")]
    if py_rels:
        subprocess.run(
            ["/var/www/gipc/backend/venv-hardening-20260803/bin/python", "-m", "py_compile", *[str(root / r) for r in py_rels]],
            check=True,
        )
        subprocess.run(["systemctl", "restart", "gipc.service"], check=True)
        subprocess.run(["systemctl", "is-active", "--quiet", "gipc.service"], check=True)

    openapi_status, openapi_data = wait_for_openapi()

    verified = {}
    for rel, item in files.items():
        p = root / rel
        verified[rel] = hashlib.sha256(p.read_bytes()).hexdigest() == item["sha256"]
        if not verified[rel]:
            raise RuntimeError(f"post-write hash mismatch for {rel}")

    print(json.dumps({
        "ok": True,
        "service": subprocess.check_output(["systemctl", "is-active", "gipc.service"], text=True).strip(),
        "openapi_status": openapi_status,
        "has_admin_users_route": "/admin/users" in openapi_data.get("paths", {}),
        "has_planning_templates_route": "/admin/planning-templates" in openapi_data.get("paths", {}),
        "verified_files": verified,
    }))
except Exception as exc:
    restore()
    raise
"""
    apply_res = run_remote_python(apply_script, {"files": upload_files})

    public_checks = {}
    for rel in rels:
        if not rel.startswith("frontend/"):
            continue
        url_path = rel[len("frontend/"):]
        url = f"https://gipc.org.ge/{url_path}"
        req = urllib.request.Request(url, headers={"Cache-Control": "no-cache", "User-Agent": "gipc-deploy-verifier/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read()
            expected = sha256_bytes((ROOT / rel).read_bytes())
            actual = sha256_bytes(body)
            public_checks[url] = {
                "status": resp.status,
                "sha256_match": actual == expected,
                "sha256": actual,
            }

    receipt = {
        "release": DEPLOY_DIR.name,
        "deployed_at": datetime.now(timezone.utc).isoformat(),
        "remote": apply_res,
        "public_checks": public_checks,
    }
    (DEPLOY_DIR / "receipt.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")
    return receipt


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "--check"
    diff = check_diff()
    if mode == "--check":
        print(json.dumps(diff, indent=2))
        return
    if mode == "--deploy":
        if not diff["changed"]:
            print(json.dumps({"message": "No changed files to deploy", "diff": diff}, indent=2))
            return
        receipt = deploy(diff["changed"])
        print(json.dumps({"diff": diff, "receipt": receipt}, indent=2))
        return
    raise SystemExit(f"Unknown mode: {mode}")


if __name__ == "__main__":
    main()
