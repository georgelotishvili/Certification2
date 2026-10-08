#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ "$(id -u)" -ne 0 ]]; then
    echo "This backup step must run as root." >&2
    exit 1
fi

DB_PATH="/var/lib/gipc/db/app.db"
BACKUP_DIR="/root/gipc-backups/pre-os-upgrade-20260804"
STATE_DIR="${BACKUP_DIR}/state"
DB_BACKUP="${BACKUP_DIR}/app.db.sqlite-backup"
KEY_FILE="${BACKUP_DIR}/offhost-backup.key"
ARCHIVE_TMP="/root/gipc-backups/.pre-os-upgrade-20260804-offhost.tar.gz.enc.tmp"
ARCHIVE="${BACKUP_DIR}/offhost-backup.tar.gz.enc"
APP_STOPPED=0
NGINX_STOPPED=0
BACKUP_CREATED=0
SUCCESS=0

cleanup() {
    local exit_code=$?
    trap - EXIT
    if [[ "$APP_STOPPED" -eq 1 ]]; then
        systemctl start gipc.service >/dev/null 2>&1 || true
    fi
    if [[ "$NGINX_STOPPED" -eq 1 ]]; then
        systemctl start nginx.service >/dev/null 2>&1 || true
    fi
    rm -f -- "$ARCHIVE_TMP"
    if [[ "$SUCCESS" -ne 1 && "$BACKUP_CREATED" -eq 1 ]]; then
        rm -rf -- "$BACKUP_DIR"
    fi
    exit "$exit_code"
}
trap cleanup EXIT

active_exam_gate() {
    python3 - "$DB_PATH" <<'PY'
import sqlite3
import sys

connection = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True, timeout=30)
try:
    quick_check = connection.execute("PRAGMA quick_check").fetchone()[0]
    active = connection.execute(
        "SELECT count(*) FROM sessions WHERE active = 1 AND finished_at IS NULL"
    ).fetchone()[0]
finally:
    connection.close()
if quick_check != "ok":
    raise SystemExit(f"Database quick_check failed: {quick_check}")
print(f"ACTIVE_UNFINISHED={active}")
if active != 0:
    raise SystemExit("Active unfinished exam sessions block the backup window")
PY
}

test -f "$DB_PATH"
test ! -e "$BACKUP_DIR"
test ! -e "$ARCHIVE_TMP"
systemctl is-active --quiet gipc.service
systemctl is-active --quiet nginx.service
sshd -t
nginx -t
active_exam_gate

ROOT_SOURCE="$(findmnt -T / -n -o SOURCE)"
for path in \
    /var/www/gipc \
    /var/www/gipc/backend/app/media \
    /var/www/gipc/backend/uploads \
    /var/lib/gipc/db \
    /etc; do
    [[ "$(findmnt -T "$path" -n -o SOURCE)" == "$ROOT_SOURCE" ]]
done

mkdir -m 0700 -- "$BACKUP_DIR"
BACKUP_CREATED=1
install -d -o root -g root -m 0700 "$STATE_DIR"
openssl rand -hex 32 > "$KEY_FILE"
chmod 0600 "$KEY_FILE"

NGINX_STOPPED=1
systemctl stop nginx.service
if systemctl is-active --quiet nginx.service; then
    echo "Nginx did not stop for the traffic-drain window." >&2
    exit 1
fi
APP_STOPPED=1
systemctl stop gipc.service
if systemctl is-active --quiet gipc.service; then
    echo "Backend did not stop for the write-freeze window." >&2
    exit 1
fi
active_exam_gate

python3 - "$DB_PATH" "$DB_BACKUP" "$STATE_DIR/database-counts.txt" <<'PY'
import sqlite3
import sys

source_path, destination_path, counts_path = sys.argv[1:]
source = sqlite3.connect(f"file:{source_path}?mode=ro", uri=True, timeout=30)
destination = sqlite3.connect(destination_path)
try:
    source.backup(destination)
    destination.commit()
    quick_check = destination.execute("PRAGMA quick_check").fetchone()[0]
    if quick_check != "ok":
        raise SystemExit(f"Backup database quick_check failed: {quick_check}")
    counts = {
        "sessions": destination.execute("SELECT count(*) FROM sessions").fetchone()[0],
        "answers": destination.execute("SELECT count(*) FROM answers").fetchone()[0],
        "users": destination.execute("SELECT count(*) FROM users").fetchone()[0],
        "active_unfinished": destination.execute(
            "SELECT count(*) FROM sessions WHERE active = 1 AND finished_at IS NULL"
        ).fetchone()[0],
    }
finally:
    destination.close()
    source.close()

if counts["active_unfinished"] != 0:
    raise SystemExit("Active unfinished exam sessions block the backup window")
with open(counts_path, "w", encoding="utf-8", newline="\n") as output:
    output.write("quick_check=ok\n")
    for key, value in counts.items():
        output.write(f"{key}={value}\n")
PY

chmod 0600 "$DB_BACKUP" "$STATE_DIR/database-counts.txt"
sha256sum "$DB_BACKUP" > "$STATE_DIR/app.db.sqlite-backup.sha256"
uname -a > "$STATE_DIR/uname.txt"
cp -a /etc/os-release "$STATE_DIR/os-release"
dpkg --get-selections '*' > "$STATE_DIR/dpkg-selections.txt"
apt-mark showmanual > "$STATE_DIR/apt-manual.txt"
apt-mark showhold > "$STATE_DIR/apt-holds.txt"
dpkg-query -W > "$STATE_DIR/dpkg-query.txt"
/var/www/gipc/backend/venv-hardening-20260803/bin/python -m pip freeze > "$STATE_DIR/venv-pip-freeze.txt"
systemctl cat gipc.service > "$STATE_DIR/gipc-systemd-unit.txt"
systemctl show gipc.service > "$STATE_DIR/gipc-systemd-show.txt"
systemctl --failed --no-legend --plain > "$STATE_DIR/systemd-failed.txt" || true
ss -lntup > "$STATE_DIR/listeners-during-freeze.txt"
ufw status verbose > "$STATE_DIR/ufw-status.txt"
iptables-save > "$STATE_DIR/iptables-save.txt"
ip6tables-save > "$STATE_DIR/ip6tables-save.txt"
fail2ban-client status sshd > "$STATE_DIR/fail2ban-sshd.txt"
sshd -T > "$STATE_DIR/sshd-effective.txt"
nginx -T > "$STATE_DIR/nginx-effective.txt" 2>&1
timedatectl > "$STATE_DIR/timedatectl.txt"
df -h > "$STATE_DIR/df-h.txt"
df -i > "$STATE_DIR/df-i.txt"

tar \
    --acls \
    --xattrs \
    --numeric-owner \
    --one-file-system \
    -C / \
    -czf - \
    etc \
    var/www/gipc \
    var/lib/dpkg \
    var/lib/apt/extended_states \
    home/gipcadmin/.ssh \
    root/gipc-backups/pre-os-upgrade-20260804 \
    | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
        -pass "file:${KEY_FILE}" -out "$ARCHIVE_TMP"

openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
    -pass "file:${KEY_FILE}" -in "$ARCHIVE_TMP" \
    | tar -tzf - > "$STATE_DIR/archive-contents.txt"
grep -qx 'etc/ssh/sshd_config.d/00-gipc-hardening.conf' "$STATE_DIR/archive-contents.txt"
grep -qx 'etc/systemd/system/gipc.service' "$STATE_DIR/archive-contents.txt"
grep -qx 'var/www/gipc/backend/.env' "$STATE_DIR/archive-contents.txt"
grep -qx 'root/gipc-backups/pre-os-upgrade-20260804/app.db.sqlite-backup' "$STATE_DIR/archive-contents.txt"
mv -- "$ARCHIVE_TMP" "$ARCHIVE"
chmod 0600 "$ARCHIVE"
sha256sum "$ARCHIVE" > "$BACKUP_DIR/offhost-backup.tar.gz.enc.sha256"

systemctl start gipc.service
READY=0
for _ in $(seq 1 30); do
    if curl --fail --silent --connect-timeout 2 --max-time 5 http://127.0.0.1:8000/regulations -o /dev/null; then
        READY=1
        break
    fi
    sleep 1
done
[[ "$READY" -eq 1 ]]
systemctl is-active --quiet gipc.service
APP_STOPPED=0
systemctl start nginx.service
nginx -t
systemctl is-active --quiet nginx.service
curl --fail --silent --show-error --connect-timeout 5 --max-time 15 https://gipc.org.ge/regulations -o /dev/null
NGINX_STOPPED=0

SUCCESS=1
echo "DATABASE_BACKUP"
cat "$STATE_DIR/database-counts.txt"
cat "$STATE_DIR/app.db.sqlite-backup.sha256"
echo "ENCRYPTED_OFFHOST_ARCHIVE"
cat "$BACKUP_DIR/offhost-backup.tar.gz.enc.sha256"
sha256sum "$KEY_FILE"
du -h "$DB_BACKUP" "$ARCHIVE"
echo "OS_UPGRADE_BACKUP_OK"
