#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
    echo "This maintenance step must run as root." >&2
    exit 1
fi

BACKUP_FILE="${1:?backup file path is required}"

count_hooks() {
    iptables-save | grep -Ec '^-A INPUT .* -j f2b-sshd$'
}

systemctl is-active --quiet fail2ban.service
fail2ban-client ping >/dev/null
[[ "$(count_hooks)" -eq 2 ]]
test ! -e "$BACKUP_FILE"

iptables-save > "$BACKUP_FILE"
chmod 0600 "$BACKUP_FILE"
iptables -D INPUT -p tcp -m multiport --dports 22 -j f2b-sshd

[[ "$(count_hooks)" -eq 1 ]]
fail2ban-client ping
fail2ban-client status sshd
systemctl is-active --quiet ssh.service
systemctl is-active --quiet nginx.service
systemctl is-active --quiet gipc.service
curl --fail --silent --show-error http://127.0.0.1:8000/regulations -o /dev/null
echo "FAIL2BAN_HOOK_DEDUPLICATED_OK"
