#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
    echo "This step must run as root." >&2
    exit 1
fi

STAGED_PUBLIC_KEY="${1:?staged public key is required}"
STAGED_SUDOERS="${2:?staged sudoers file is required}"
ADMIN_USER="gipcadmin"
ADMIN_HOME="/home/${ADMIN_USER}"
EXPECTED_FINGERPRINT="SHA256:z7js9k+/LeWN+3XOzBOEhmnMvrZ0vekF41XOLMij/pU"
BACKUP_DIR="/root/gipc-backups/ssh-admin-20260804"
SUDOERS_TARGET="/etc/sudoers.d/${ADMIN_USER}"
CREATED_USER=0
CREATED_SUDOERS=0

rollback_partial() {
    local exit_code=$?
    trap - ERR
    if [[ "$CREATED_SUDOERS" -eq 1 ]]; then
        rm -f -- "$SUDOERS_TARGET"
    fi
    if [[ "$CREATED_USER" -eq 1 ]] && id "$ADMIN_USER" >/dev/null 2>&1; then
        userdel --remove "$ADMIN_USER" >/dev/null 2>&1 || true
    fi
    echo "SSH admin staging failed; only artifacts created by this run were rolled back." >&2
    exit "$exit_code"
}

# All absence and input checks happen before the rollback trap is armed, so a
# failed precondition can never remove a pre-existing account or sudoers file.
test -f "$STAGED_PUBLIC_KEY"
test -f "$STAGED_SUDOERS"
test ! -e "$BACKUP_DIR"
test ! -e "$ADMIN_HOME"
test ! -e "$SUDOERS_TARGET"
if id "$ADMIN_USER" >/dev/null 2>&1; then
    echo "The admin user already exists; refusing a non-idempotent first run." >&2
    exit 1
fi

ACTUAL_FINGERPRINT="$(ssh-keygen -lf "$STAGED_PUBLIC_KEY" | awk '{print $2}')"
[[ "$ACTUAL_FINGERPRINT" == "$EXPECTED_FINGERPRINT" ]]
visudo -cf "$STAGED_SUDOERS"
sshd -t

install -d -o root -g root -m 0700 "$BACKUP_DIR" "$BACKUP_DIR/etc"
cp -a /etc/passwd /etc/shadow /etc/group /etc/gshadow /etc/sudoers "$BACKUP_DIR/etc/"
cp -a /etc/sudoers.d "$BACKUP_DIR/etc/"

trap rollback_partial ERR
useradd --create-home --user-group --shell /bin/bash "$ADMIN_USER"
CREATED_USER=1
passwd --lock "$ADMIN_USER"
usermod --append --groups sudo "$ADMIN_USER"
chmod 0750 "$ADMIN_HOME"
install -d -o "$ADMIN_USER" -g "$ADMIN_USER" -m 0700 "$ADMIN_HOME/.ssh"
install -o "$ADMIN_USER" -g "$ADMIN_USER" -m 0600 "$STAGED_PUBLIC_KEY" "$ADMIN_HOME/.ssh/authorized_keys"
install -o root -g root -m 0440 "$STAGED_SUDOERS" "$SUDOERS_TARGET"
CREATED_SUDOERS=1

visudo -cf /etc/sudoers
visudo -cf "$SUDOERS_TARGET"
[[ "$(runuser -u "$ADMIN_USER" -- sudo -n /usr/bin/id -u)" == "0" ]]
[[ "$(ssh-keygen -lf "$ADMIN_HOME/.ssh/authorized_keys" | awk '{print $2}')" == "$EXPECTED_FINGERPRINT" ]]
[[ "$(stat -c '%U:%G:%a' "$ADMIN_HOME/.ssh")" == "${ADMIN_USER}:${ADMIN_USER}:700" ]]
[[ "$(stat -c '%U:%G:%a' "$ADMIN_HOME/.ssh/authorized_keys")" == "${ADMIN_USER}:${ADMIN_USER}:600" ]]
[[ "$(stat -c '%U:%G:%a' "$SUDOERS_TARGET")" == "root:root:440" ]]
id -nG "$ADMIN_USER" | tr ' ' '\n' | grep -qx sudo

trap - ERR
echo "ADMIN_USER=${ADMIN_USER}"
echo "KEY_FINGERPRINT=${EXPECTED_FINGERPRINT}"
echo "SSH_ADMIN_STAGE_OK"
