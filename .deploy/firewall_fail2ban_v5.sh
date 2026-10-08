#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
    echo "This hardening step must run as root." >&2
    exit 1
fi

STAGED_JAIL="${1:?staged fail2ban jail is required}"
BACKUP_ROOT="/root/gipc-backups"
BACKUP_DIR="$(mktemp -d "${BACKUP_ROOT}/firewall-fail2ban-20260803-XXXXXX")"

test -f "$STAGED_JAIL"
systemctl is-active --quiet ssh.service
systemctl is-active --quiet nginx.service
systemctl is-active --quiet gipc.service
[[ "$(ufw status | head -n 1)" == "Status: inactive" ]]
if ufw show added | grep -q '^ufw '; then
    echo "UFW already has user-defined rules; refusing to overwrite them." >&2
    exit 1
fi

chmod 0700 "$BACKUP_DIR"
install -d -o root -g root -m 0700 \
    "$BACKUP_DIR/etc" \
    "$BACKUP_DIR/etc/default" \
    "$BACKUP_DIR/lib"
cp -a /etc/ufw "$BACKUP_DIR/etc/"
cp -a /etc/default/ufw "$BACKUP_DIR/etc/default/"
cp -a /lib/ufw "$BACKUP_DIR/lib/"
iptables-save > "$BACKUP_DIR/iptables-before.rules"
ip6tables-save > "$BACKUP_DIR/ip6tables-before.rules"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends fail2ban python3-systemd

cp -a /etc/fail2ban "$BACKUP_DIR/fail2ban-package-defaults"
install -o root -g root -m 0644 "$STAGED_JAIL" /etc/fail2ban/jail.d/gipc-sshd.local
fail2ban-client -t

ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw allow 80/tcp comment 'HTTP'
ufw allow 443/tcp comment 'HTTPS'
ufw --force enable

# UFW reloads the netfilter rules, so start/restart fail2ban afterwards to
# guarantee that the sshd jail's chain is present in the final ruleset.
systemctl enable --now fail2ban.service
systemctl restart fail2ban.service
systemctl is-active --quiet fail2ban.service
fail2ban-client status sshd

ufw status verbose
ufw status numbered
systemctl is-active --quiet ssh.service
systemctl is-active --quiet nginx.service
systemctl is-active --quiet gipc.service
curl --fail --silent --show-error http://127.0.0.1:8000/regulations -o /dev/null
printf 'BACKUP_DIR=%s\n' "$BACKUP_DIR"
echo "FIREWALL_FAIL2BAN_OK"
