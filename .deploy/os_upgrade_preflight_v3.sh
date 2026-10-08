#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
    echo "This preflight must run as root." >&2
    exit 1
fi

DB_PATH="/var/lib/gipc/db/app.db"
SIMULATION_FILE="$(mktemp /tmp/gipc-apt-simulation-XXXXXX.txt)"
trap 'rm -f -- "$SIMULATION_FILE"' EXIT

source /etc/os-release
[[ "$ID" == "ubuntu" ]]
[[ "$VERSION_ID" == "22.04" ]]
[[ "${VERSION_CODENAME:-}" == "jammy" ]]
grep -Rhsq jammy /etc/apt/sources.list /etc/apt/sources.list.d
if grep -RhsiE '(focal|noble|oracular|plucky|questing|devel|stable)' \
    /etc/apt/sources.list /etc/apt/sources.list.d; then
    echo "Unexpected release name found in APT sources." >&2
    exit 1
fi

test -f "$DB_PATH"
systemctl is-active --quiet ssh.service
systemctl is-active --quiet nginx.service
systemctl is-active --quiet gipc.service
systemctl is-active --quiet ufw.service
systemctl is-active --quiet fail2ban.service
systemctl is-enabled --quiet ssh.service
systemctl is-enabled --quiet nginx.service
systemctl is-enabled --quiet gipc.service
systemctl is-enabled --quiet ufw.service
systemctl is-enabled --quiet fail2ban.service

FAILED_UNITS="$(systemctl --failed --no-legend --plain | awk '{print $1}')"
UNEXPECTED_FAILED_UNITS="$(printf '%s\n' "$FAILED_UNITS" | grep -v '^$' | grep -vx 'fwupd-refresh.service' || true)"
[[ -z "$UNEXPECTED_FAILED_UNITS" ]]
if grep -qx 'fwupd-refresh.service' <<< "$FAILED_UNITS"; then
    echo "KNOWN_FAILED_UNIT=fwupd-refresh.service"
fi

[[ -z "$(dpkg --audit)" ]]
apt-get check >/dev/null
[[ -z "$(apt-mark showhold)" ]]
if pgrep -x apt-get >/dev/null \
    || pgrep -x dpkg >/dev/null \
    || pgrep -f '^/usr/bin/python3 /usr/bin/unattended-upgrade( |$)' >/dev/null \
    || fuser /var/lib/dpkg/lock-frontend \
        /var/lib/dpkg/lock \
        /var/lib/apt/lists/lock \
        /var/cache/apt/archives/lock >/dev/null 2>&1; then
    echo "An APT/dpkg/unattended-upgrade transaction or package lock is active." >&2
    exit 1
fi

sshd -t
nginx -t
fail2ban-client ping
echo "TIME_SYNC"
timedatectl show -p NTPSynchronized -p Timezone

python3 - "$DB_PATH" <<'PY'
import sqlite3
import sys

db_path = sys.argv[1]
connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
try:
    quick_check = connection.execute("PRAGMA quick_check").fetchone()[0]
    if quick_check != "ok":
        raise SystemExit(f"Database quick_check failed: {quick_check}")
    active_unfinished = connection.execute(
        "SELECT count(*) FROM sessions WHERE active = 1 AND finished_at IS NULL"
    ).fetchone()[0]
    active_not_expired = connection.execute(
        """
        SELECT count(*) FROM sessions
        WHERE active = 1
          AND finished_at IS NULL
          AND datetime(ends_at) > datetime('now')
        """
    ).fetchone()[0]
    active_in_grace = connection.execute(
        """
        SELECT count(*) FROM sessions
        WHERE active = 1
          AND finished_at IS NULL
          AND datetime(ends_at) > datetime('now', '-5 minutes')
        """
    ).fetchone()[0]
    sessions = connection.execute("SELECT count(*) FROM sessions").fetchone()[0]
    answers = connection.execute("SELECT count(*) FROM answers").fetchone()[0]
finally:
    connection.close()

print("DB_QUICK_CHECK=ok")
print(f"ACTIVE_UNFINISHED={active_unfinished}")
print(f"ACTIVE_NOT_EXPIRED={active_not_expired}")
print(f"ACTIVE_IN_GRACE={active_in_grace}")
print(f"SESSION_ROWS={sessions}")
print(f"ANSWER_ROWS={answers}")
if active_unfinished != 0:
    raise SystemExit("Active unfinished exam sessions are a maintenance blocker")
PY

apt-get --simulate --no-remove dist-upgrade > "$SIMULATION_FILE"
if grep -q '^Remv ' "$SIMULATION_FILE"; then
    echo "APT simulation contains package removals." >&2
    exit 1
fi

echo "OS_RELEASE=${PRETTY_NAME}"
echo "KERNEL=$(uname -r)"
echo "APT_SIMULATION_SUMMARY"
grep -E '^[0-9]+ upgraded,' "$SIMULATION_FILE"
echo "SIMULATED_KERNEL_PACKAGES"
grep -E '^Inst (linux-image|linux-headers|linux-modules|linux-generic)' "$SIMULATION_FILE" || true
echo "FILESYSTEM_SPACE"
df -h / /boot /var
echo "FILESYSTEM_INODES"
df -i / /boot /var
echo "BACKUP_INPUT_SIZES"
du -sh \
    /var/lib/gipc/db \
    /var/www/gipc/backend/app/media \
    /var/www/gipc/backend/uploads \
    /var/www/gipc/frontend \
    /etc/nginx \
    /etc/ssh \
    /etc/letsencrypt
echo "INSTALLED_KERNELS"
dpkg-query -W 'linux-image-*' 2>/dev/null | grep '^linux-image-[0-9]' || true
echo "DKMS"
if command -v dkms >/dev/null 2>&1; then
    dkms status
else
    echo "not-installed"
fi
echo "LISTENERS"
ss -lntH
echo "OS_UPGRADE_PREFLIGHT_OK"
