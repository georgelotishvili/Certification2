#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
    echo "This cutover must run as root." >&2
    exit 1
fi

STAGE_DIR="${1:?stage directory is required}"
FINAL_UNIT="$STAGE_DIR/.deploy/gipc-final.service"
ROLLBACK_DIR="/root/gipc-backups/nonroot-cutover-20260803"
OLD_DB="/var/www/gipc/backend/app.db"
NEW_DB_DIR="/var/lib/gipc/db"
NEW_DB="$NEW_DB_DIR/app.db"
MEDIA_DIR="/var/www/gipc/backend/app/media"
UPLOADS_DIR="/var/www/gipc/backend/uploads"
CANDIDATE_VENV="/var/www/gipc/backend/venv-hardening-20260803"
MUTATED=0

rollback_on_error() {
    local exit_code=$?
    local rollback_failed=0
    trap - ERR

    if [[ "$MUTATED" -eq 1 ]]; then
        echo "Non-root cutover failed; restoring the tested root service unit." >&2
        set +e
        systemctl stop gipc.service || rollback_failed=1
        install -o root -g root -m 0644 \
            "$ROLLBACK_DIR/gipc-stage.service" \
            /etc/systemd/system/gipc.service \
            || rollback_failed=1
        systemctl daemon-reload || rollback_failed=1
        systemctl start gipc.service || rollback_failed=1
        for _rollback_attempt in $(seq 1 20); do
            if systemctl is-active --quiet gipc.service && \
               curl --fail --silent --show-error \
                   http://127.0.0.1:8000/regulations -o /dev/null; then
                break
            fi
            sleep 1
        done
        systemctl is-active --quiet gipc.service || rollback_failed=1
        curl --fail --silent --show-error \
            http://127.0.0.1:8000/regulations -o /dev/null \
            || rollback_failed=1
        systemctl start nginx.service || rollback_failed=1
        systemctl is-active --quiet nginx.service || rollback_failed=1
        if [[ "$rollback_failed" -ne 0 ]]; then
            echo "NONROOT_ROLLBACK_FAILED: manual recovery is required." >&2
        else
            echo "NONROOT_ROLLBACK_OK" >&2
        fi
        set -e
    fi

    exit "$exit_code"
}
trap rollback_on_error ERR

test -f "$FINAL_UNIT"
test -x "$CANDIDATE_VENV/bin/python"
test -f "$OLD_DB"
test -d "$MEDIA_DIR"
test -d "$UPLOADS_DIR"
test -f /var/www/gipc/backend/.env
test ! -e "$NEW_DB"
test ! -e "$ROLLBACK_DIR"
systemctl is-active --quiet gipc.service
[[ "$(systemctl show gipc.service -p User --value)" == "root" ]]

if find "$MEDIA_DIR" "$UPLOADS_DIR" -xdev -type l -print -quit | grep -q .; then
    echo "Unexpected symlink found in a writable storage tree." >&2
    exit 1
fi

while IFS= read -r mount_target; do
    case "$mount_target" in
        "$MEDIA_DIR"/*|"$UPLOADS_DIR"/*)
            echo "Unexpected nested mount in a writable storage tree." >&2
            exit 1
            ;;
    esac
done < <(findmnt -rn -o TARGET)

if ! getent passwd gipcapp >/dev/null; then
    useradd \
        --system \
        --user-group \
        --home-dir /nonexistent \
        --shell /usr/sbin/nologin \
        gipcapp
fi
[[ "$(getent passwd gipcapp | cut -d: -f7)" == "/usr/sbin/nologin" ]]
getent group gipcapp >/dev/null

install -d -o root -g gipcapp -m 0750 /var/lib/gipc
install -d -o gipcapp -g gipcapp -m 0750 "$NEW_DB_DIR"
install -d -o root -g root -m 0700 "$ROLLBACK_DIR"
install -o root -g root -m 0600 \
    /etc/systemd/system/gipc.service \
    "$ROLLBACK_DIR/gipc-stage.service"

"$CANDIDATE_VENV/bin/python" -c \
    "import sqlite3; source=sqlite3.connect('$OLD_DB'); target=sqlite3.connect('$ROLLBACK_DIR/app.db-online-backup'); source.backup(target); target.close(); source.close()"
chmod 600 "$ROLLBACK_DIR/app.db-online-backup"

chown root:gipcapp /var/www/gipc/backend/.env
chmod 0640 /var/www/gipc/backend/.env
chown root:root "$OLD_DB" /var/www/gipc/backend/verification_codes.txt
chmod 0600 "$OLD_DB" /var/www/gipc/backend/verification_codes.txt

chown -R gipcapp:gipcapp "$MEDIA_DIR" "$UPLOADS_DIR"
find "$MEDIA_DIR" "$UPLOADS_DIR" -xdev -type d -exec chmod 0750 {} +
find "$MEDIA_DIR" "$UPLOADS_DIR" -xdev -type f -exec chmod 0640 {} +

runuser -u gipcapp -- test -r /var/www/gipc/backend/.env
runuser -u gipcapp -- test -w "$MEDIA_DIR"
runuser -u gipcapp -- test -w "$UPLOADS_DIR"
runuser -u gipcapp -- test -w "$NEW_DB_DIR"
runuser -u gipcapp -- test -r /var/www/gipc/backend/app/main.py
runuser -u gipcapp -- test -x "$CANDIDATE_VENV/bin/python"
runuser -u gipcapp -- "$CANDIDATE_VENV/bin/python" -c "import fastapi, sqlalchemy, uvicorn"
if runuser -u gipcapp -- test -w /var/www/gipc/backend/app/routers/auth.py; then
    echo "Service user can unexpectedly write application source." >&2
    exit 1
fi

install -o root -g root -m 0644 "$FINAL_UNIT" /run/gipc-final-candidate.service
systemd-analyze verify /run/gipc-final-candidate.service
rm -f /run/gipc-final-candidate.service

MUTATED=1
systemctl stop nginx.service
if systemctl is-active --quiet nginx.service; then
    echo "Nginx did not stop; refusing DB cutover." >&2
    exit 1
fi
systemctl stop gipc.service
OLD_DB_HASH="$(sha256sum "$OLD_DB" | awk '{print $1}')"

"$CANDIDATE_VENV/bin/python" -c \
    "import sqlite3; source=sqlite3.connect('$OLD_DB'); stopped=sqlite3.connect('$ROLLBACK_DIR/app.db-stopped-backup'); source.backup(stopped); stopped.close(); target=sqlite3.connect('$NEW_DB'); source.backup(target); target.close(); source.close()"
chmod 0600 "$ROLLBACK_DIR/app.db-stopped-backup"
chown gipcapp:gipcapp "$NEW_DB"
chmod 0640 "$NEW_DB"
"$CANDIDATE_VENV/bin/python" -c \
    "import sqlite3; results=[]; [(results.append(sqlite3.connect(path).execute('PRAGMA quick_check').fetchone()[0])) for path in ('$OLD_DB','$NEW_DB')]; assert results == ['ok','ok'], results"
install -o root -g root -m 0644 "$FINAL_UNIT" /etc/systemd/system/gipc.service
systemd-analyze verify /etc/systemd/system/gipc.service
systemctl daemon-reload
systemctl start gipc.service

for _attempt in $(seq 1 20); do
    if systemctl is-active --quiet gipc.service && \
       curl --fail --silent --show-error \
           http://127.0.0.1:8000/openapi.json -o /dev/null; then
        break
    fi
    sleep 1
done

systemctl is-active --quiet gipc.service
[[ "$(systemctl show gipc.service -p User --value)" == "gipcapp" ]]
[[ "$(systemctl show gipc.service -p Group --value)" == "gipcapp" ]]
MAIN_PID="$(systemctl show gipc.service -p MainPID --value)"
test "$MAIN_PID" -gt 1
[[ "$(ps -o user= -p "$MAIN_PID" | xargs)" == "gipcapp" ]]
tr '\0' '\n' < "/proc/$MAIN_PID/environ" | \
    grep -qx 'GIPC_DATABASE_PATH=/var/lib/gipc/db/app.db'

[[ "$(sha256sum "$OLD_DB" | awk '{print $1}')" == "$OLD_DB_HASH" ]]
runuser -u gipcapp -- "$CANDIDATE_VENV/bin/python" -c \
    "import sqlite3; connection=sqlite3.connect('$NEW_DB'); result=connection.execute('PRAGMA quick_check').fetchone()[0]; connection.close(); assert result == 'ok', result; print('NEW_DB_QUICK_CHECK_OK')"

test "$(stat -c %U "$NEW_DB")" = "gipcapp"
test "$(stat -c %G "$NEW_DB")" = "gipcapp"
if find "$NEW_DB_DIR" -maxdepth 1 -type f ! -user gipcapp -print -quit | grep -q .; then
    echo "A database sidecar has unexpected ownership." >&2
    exit 1
fi

curl --fail --silent --show-error http://127.0.0.1:8000/openapi.json -o /dev/null
curl --fail --silent --show-error http://127.0.0.1:8000/regulations -o /dev/null
curl --fail --silent --show-error http://127.0.0.1:8000/public/multi-apartment/settings -o /dev/null
curl --fail --silent --show-error http://127.0.0.1:8000/public/multi-functional/settings -o /dev/null

LISTENER="$(ss -H -ltn 'sport = :8000')"
grep -q '127.0.0.1:8000' <<< "$LISTENER"
if grep -Eq '0\.0\.0\.0:8000|\[::\]:8000|\*:8000' <<< "$LISTENER"; then
    echo "Uvicorn is unexpectedly publicly bound." >&2
    exit 1
fi

systemctl start nginx.service
systemctl is-active --quiet nginx.service
MUTATED=0
trap - ERR

curl --fail --silent --show-error \
    --resolve gipc.org.ge:443:127.0.0.1 \
    https://gipc.org.ge/regulations \
    -o /dev/null
CORS_HEADERS="$(mktemp)"
curl --fail --silent --show-error \
    --resolve gipc.org.ge:443:127.0.0.1 \
    -D "$CORS_HEADERS" \
    -o /dev/null \
    -X OPTIONS \
    -H 'Origin: null' \
    -H 'Access-Control-Request-Method: POST' \
    https://gipc.org.ge/auth/login
grep -qi '^access-control-allow-origin: null' "$CORS_HEADERS"
rm -f "$CORS_HEADERS"

echo "NONROOT_CUTOVER_OK"
