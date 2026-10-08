#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
    echo "This step must run as root." >&2
    exit 1
fi

STAGED_CONFIG="${1:?staged SSH config is required}"
STAGED_ROLLBACK="${2:?staged rollback script is required}"
ADMIN_USER="gipcadmin"
EXPECTED_FINGERPRINT="SHA256:z7js9k+/LeWN+3XOzBOEhmnMvrZ0vekF41XOLMij/pU"
TARGET="/etc/ssh/sshd_config.d/00-gipc-hardening.conf"
BACKUP_DIR="/root/gipc-backups/ssh-lockdown-20260804"
ROLLBACK_SCRIPT="${BACKUP_DIR}/rollback.sh"
ROLLBACK_UNIT="gipc-ssh-rollback-20260804"

test -f "$STAGED_CONFIG"
test -f "$STAGED_ROLLBACK"
test ! -e "$TARGET"
test ! -e "$BACKUP_DIR"
id "$ADMIN_USER" >/dev/null
id -nG "$ADMIN_USER" | tr ' ' '\n' | grep -qx sudo
[[ "$(ssh-keygen -lf "/home/${ADMIN_USER}/.ssh/authorized_keys" | awk '{print $2}')" == "$EXPECTED_FINGERPRINT" ]]
visudo -cf "/etc/sudoers.d/${ADMIN_USER}"
runuser -u "$ADMIN_USER" -- sudo -n true
sshd -t
systemctl is-active --quiet ssh.service
systemctl is-active --quiet ufw.service
systemctl is-active --quiet fail2ban.service
if systemctl list-units --all --full "${ROLLBACK_UNIT}.*" --no-legend | grep -q .; then
    echo "The rollback unit name is already in use." >&2
    exit 1
fi

install -d -o root -g root -m 0700 "$BACKUP_DIR"
cp -a /etc/ssh "$BACKUP_DIR/etc-ssh-before"
sshd -T > "$BACKUP_DIR/sshd-effective-before.txt"
chmod 0600 "$BACKUP_DIR/sshd-effective-before.txt"
install -o root -g root -m 0700 "$STAGED_ROLLBACK" "$ROLLBACK_SCRIPT"

systemd-run \
    --unit="$ROLLBACK_UNIT" \
    --on-active=5m \
    --property=Type=oneshot \
    /bin/bash "$ROLLBACK_SCRIPT"
systemctl is-active --quiet "${ROLLBACK_UNIT}.timer"

install -o root -g root -m 0644 "$STAGED_CONFIG" "$TARGET"
sshd -t
sshd -T | grep -qx 'permitrootlogin no'
sshd -T | grep -qx 'passwordauthentication no'
sshd -T | grep -qx 'kbdinteractiveauthentication no'
sshd -T | grep -qx 'pubkeyauthentication yes'
sshd -T | grep -qx 'maxauthtries 3'
sshd -T | grep -qx 'allowusers gipcadmin'
systemctl reload ssh.service
systemctl is-active --quiet ssh.service

echo "ROLLBACK_TIMER=${ROLLBACK_UNIT}.timer"
echo "SSH_LOCKDOWN_APPLIED_WITH_ROLLBACK_TIMER_OK"
