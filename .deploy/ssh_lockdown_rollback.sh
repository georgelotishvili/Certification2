#!/usr/bin/env bash
set -Eeuo pipefail

TARGET="/etc/ssh/sshd_config.d/00-gipc-hardening.conf"

if [[ "$(id -u)" -ne 0 ]]; then
    exit 1
fi

rm -f -- "$TARGET"
sshd -t
systemctl reload ssh.service
logger -t gipc-ssh-hardening "Automatic SSH rollback restored the pre-hardening root/password policy."
