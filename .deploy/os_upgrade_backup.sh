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
ARCHIVE_TMP="/root/gipc-backups/.pre-os-upgrade-20260804-offhost.tar.gz.tmp"
ARCHIVE="${BACKUP_DIR}/offhost-backup.tar.gz"

test -f "$DB_PATH"
test ! -e "$BACKUP_DIR"
test ! -e "$ARCHIVE_TMP"
systemctl is-active --quiet gipc.service
sshd -t
nginx -t

install -d -o root -g root -m 0700 "$BACKUP_DIR" "$STATE_DIR"

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
ss -lntup > "$STATE_DIR/listeners.txt"
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
    -czf "$ARCHIVE_TMP" \
    etc \
    var/www/gipc \
    var/lib/dpkg \
    var/lib/apt/extended_states \
    home/gipcadmin/.ssh \
    root/gipc-backups/pre-os-upgrade-20260804

gzip -t "$ARCHIVE_TMP"
tar -tzf "$ARCHIVE_TMP" | grep -qx 'etc/ssh/sshd_config.d/00-gipc-hardening.conf'
tar -tzf "$ARCHIVE_TMP" | grep -qx 'etc/systemd/system/gipc.service'
tar -tzf "$ARCHIVE_TMP" | grep -qx 'var/www/gipc/backend/.env'
tar -tzf "$ARCHIVE_TMP" | grep -qx 'root/gipc-backups/pre-os-upgrade-20260804/app.db.sqlite-backup'
mv -- "$ARCHIVE_TMP" "$ARCHIVE"
chmod 0600 "$ARCHIVE"
sha256sum "$ARCHIVE" > "$BACKUP_DIR/offhost-backup.tar.gz.sha256"

echo "DATABASE_BACKUP"
cat "$STATE_DIR/database-counts.txt"
cat "$STATE_DIR/app.db.sqlite-backup.sha256"
echo "OFFHOST_ARCHIVE"
cat "$BACKUP_DIR/offhost-backup.tar.gz.sha256"
du -h "$DB_BACKUP" "$ARCHIVE"
echo "OS_UPGRADE_BACKUP_OK"
