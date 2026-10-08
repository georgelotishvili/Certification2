#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
    echo "This deployment must run as root." >&2
    exit 1
fi

STAGE_DIR="${1:?stage directory is required}"
CANDIDATE_VENV="/var/www/gipc/backend/venv-hardening-20260803"
CURRENT_VENV="/var/www/gipc/backend/venv"
ROLLBACK_DIR="/root/gipc-backups/hardening-deploy-20260803"
BASELINE="$STAGE_DIR/.deploy/baseline.sha256"
MUTATED=0

rollback_on_error() {
    local exit_code=$?
    trap - ERR
    if [[ "$MUTATED" -eq 1 ]]; then
        echo "Deployment check failed; restoring the pre-deploy files." >&2
        set +e
        systemctl stop gipc.service
        rm -f \
            /var/www/gipc/backend/app/services/bounded_upload.py \
            /var/www/gipc/backend/app/services/expert_certificate_cleanup.py
        tar -xzf "$ROLLBACK_DIR/files-before.tar.gz" -C /
        systemctl daemon-reload
        nginx -t
        systemctl reload nginx
        systemctl start gipc.service
        systemctl is-active --quiet gipc.service
        set -e
    fi
    exit "$exit_code"
}
trap rollback_on_error ERR

test -d "$STAGE_DIR/backend/app"
test -f "$BASELINE"
test -f "$STAGE_DIR/.deploy/gipc.nginx"
test -f "$STAGE_DIR/.deploy/gipc-stage.service"
test -d /root/gipc-backups/pre-hardening-20260803T190101Z
test -x "$CURRENT_VENV/bin/python"
systemctl is-active --quiet gipc.service
nginx -t

echo "Checking that production has not drifted since the recorded baseline."
sha256sum -c "$BASELINE"
test ! -e /var/www/gipc/backend/app/services/bounded_upload.py
test ! -e /var/www/gipc/backend/app/services/expert_certificate_cleanup.py
test ! -e "$CANDIDATE_VENV"

EMAIL_MODE_VALUE="$(
    sed -n 's/^[[:space:]]*EMAIL_MODE[[:space:]]*=[[:space:]]*//p' \
        /var/www/gipc/backend/.env |
        tail -n 1 |
        tr -d '\r\"' |
        tr '[:upper:]' '[:lower:]' |
        xargs
)"
if [[ "$EMAIL_MODE_VALUE" != "smtp" ]]; then
    echo "Production EMAIL_MODE is not smtp; refusing deployment." >&2
    exit 1
fi

mkdir -p "$ROLLBACK_DIR"
chmod 700 "$ROLLBACK_DIR"

echo "Preparing an isolated candidate virtual environment."
cp -a "$CURRENT_VENV" "$CANDIDATE_VENV"
CANDIDATE_PREFIX="$("$CANDIDATE_VENV/bin/python" -c 'import sys; print(sys.prefix)')"
if [[ "$CANDIDATE_PREFIX" != "$CANDIDATE_VENV" ]]; then
    echo "Cloned virtualenv resolved to an unexpected prefix." >&2
    exit 1
fi

"$CURRENT_VENV/bin/python" -m pip freeze > "$ROLLBACK_DIR/pip-freeze-before.txt"
"$CANDIDATE_VENV/bin/python" -m pip install \
    --disable-pip-version-check \
    --upgrade \
    -r "$STAGE_DIR/backend/requirements.txt"
"$CANDIDATE_VENV/bin/python" -m pip check
"$CANDIDATE_VENV/bin/python" -m pip freeze > "$ROLLBACK_DIR/pip-freeze-candidate.txt"
"$CANDIDATE_VENV/bin/python" -c \
    "from importlib.metadata import version; expected={'fastapi':'0.133.0','starlette':'1.3.1','python-multipart':'0.0.32','uvicorn':'0.30.0'}; actual={name:version(name) for name in expected}; assert actual == expected, (actual, expected); print(actual)"

echo "Running the full backend suite against the candidate environment."
mkdir -p "$STAGE_DIR/test-state/media"
(
    cd "$STAGE_DIR/backend"
    export PYTHONDONTWRITEBYTECODE=1
    export GIPC_DATABASE_PATH="$STAGE_DIR/test-state/app.db"
    export MEDIA_ROOT="$STAGE_DIR/test-state/media"
    export EMAIL_MODE=console
    "$CANDIDATE_VENV/bin/python" -m unittest discover -s tests -q
    "$CANDIDATE_VENV/bin/python" -c \
        "from app.main import app; paths={getattr(route,'path','') for route in app.routes}; required={'/openapi.json','/auth/login','/auth/logout','/exam/{exam_id}/config','/regulations','/public/multi-apartment/settings','/public/multi-functional/settings'}; assert len(app.routes)==148, len(app.routes); assert required <= paths, required-paths; app.openapi(); print('REMOTE_STARTUP_ROUTES_OK', len(app.routes))"
)

systemd-analyze verify "$STAGE_DIR/.deploy/gipc-stage.service"

echo "Creating a deployment-specific rollback package."
tar -czf "$ROLLBACK_DIR/files-before.tar.gz" -C / \
    var/www/gipc/backend/app/database.py \
    var/www/gipc/backend/app/rate_limiter.py \
    var/www/gipc/backend/app/routers/admin.py \
    var/www/gipc/backend/app/routers/app_files.py \
    var/www/gipc/backend/app/routers/auth.py \
    var/www/gipc/backend/app/routers/documents.py \
    var/www/gipc/backend/app/routers/expert_uploads.py \
    var/www/gipc/backend/app/routers/multi_apartment.py \
    var/www/gipc/backend/app/routers/multi_functional.py \
    var/www/gipc/backend/app/routers/regulations.py \
    var/www/gipc/backend/app/routers/statements.py \
    var/www/gipc/backend/app/routers/users.py \
    var/www/gipc/backend/app/services/email_verification.py \
    var/www/gipc/backend/app/services/media_storage.py \
    var/www/gipc/backend/requirements.txt \
    var/www/gipc/backend/scripts/migrate_statements_attachment.py \
    var/www/gipc/frontend/scripts/admin/users.js \
    var/www/gipc/frontend/scripts/header.js \
    var/www/gipc/frontend/scripts/script.js \
    etc/nginx/sites-enabled/gipc \
    etc/systemd/system/gipc.service
sha256sum "$ROLLBACK_DIR/files-before.tar.gz" > "$ROLLBACK_DIR/files-before.tar.gz.sha256"
"$CURRENT_VENV/bin/python" -c \
    "import sqlite3; source=sqlite3.connect('/var/www/gipc/backend/app.db'); target=sqlite3.connect('$ROLLBACK_DIR/app.db-online-backup'); source.backup(target); target.close(); source.close()"
chmod 600 "$ROLLBACK_DIR/app.db-online-backup"

MUTATED=1
systemctl stop gipc.service
cp -a /var/www/gipc/backend/app.db "$ROLLBACK_DIR/app.db-stopped-copy"
chmod 600 "$ROLLBACK_DIR/app.db-stopped-copy"

install -o root -g root -m 0644 "$STAGE_DIR/backend/app/database.py" /var/www/gipc/backend/app/database.py
install -o root -g root -m 0644 "$STAGE_DIR/backend/app/rate_limiter.py" /var/www/gipc/backend/app/rate_limiter.py
install -o root -g root -m 0644 "$STAGE_DIR/backend/app/routers/admin.py" /var/www/gipc/backend/app/routers/admin.py
install -o root -g root -m 0644 "$STAGE_DIR/backend/app/routers/app_files.py" /var/www/gipc/backend/app/routers/app_files.py
install -o root -g root -m 0644 "$STAGE_DIR/backend/app/routers/auth.py" /var/www/gipc/backend/app/routers/auth.py
install -o root -g root -m 0644 "$STAGE_DIR/backend/app/routers/documents.py" /var/www/gipc/backend/app/routers/documents.py
install -o root -g root -m 0644 "$STAGE_DIR/backend/app/routers/expert_uploads.py" /var/www/gipc/backend/app/routers/expert_uploads.py
install -o root -g root -m 0644 "$STAGE_DIR/backend/app/routers/multi_apartment.py" /var/www/gipc/backend/app/routers/multi_apartment.py
install -o root -g root -m 0644 "$STAGE_DIR/backend/app/routers/multi_functional.py" /var/www/gipc/backend/app/routers/multi_functional.py
install -o root -g root -m 0644 "$STAGE_DIR/backend/app/routers/regulations.py" /var/www/gipc/backend/app/routers/regulations.py
install -o root -g root -m 0644 "$STAGE_DIR/backend/app/routers/statements.py" /var/www/gipc/backend/app/routers/statements.py
install -o root -g root -m 0644 "$STAGE_DIR/backend/app/routers/users.py" /var/www/gipc/backend/app/routers/users.py
install -o root -g root -m 0644 "$STAGE_DIR/backend/app/services/email_verification.py" /var/www/gipc/backend/app/services/email_verification.py
install -o root -g root -m 0644 "$STAGE_DIR/backend/app/services/media_storage.py" /var/www/gipc/backend/app/services/media_storage.py
install -o root -g root -m 0644 "$STAGE_DIR/backend/app/services/bounded_upload.py" /var/www/gipc/backend/app/services/bounded_upload.py
install -o root -g root -m 0644 "$STAGE_DIR/backend/app/services/expert_certificate_cleanup.py" /var/www/gipc/backend/app/services/expert_certificate_cleanup.py
install -o root -g root -m 0644 "$STAGE_DIR/backend/requirements.txt" /var/www/gipc/backend/requirements.txt
install -o root -g root -m 0644 "$STAGE_DIR/backend/scripts/migrate_statements_attachment.py" /var/www/gipc/backend/scripts/migrate_statements_attachment.py
install -o root -g root -m 0644 "$STAGE_DIR/frontend/scripts/admin/users.js" /var/www/gipc/frontend/scripts/admin/users.js
install -o root -g root -m 0644 "$STAGE_DIR/frontend/scripts/header.js" /var/www/gipc/frontend/scripts/header.js
install -o root -g root -m 0644 "$STAGE_DIR/frontend/scripts/script.js" /var/www/gipc/frontend/scripts/script.js
install -o root -g root -m 0644 "$STAGE_DIR/.deploy/gipc.nginx" /etc/nginx/sites-enabled/gipc
install -o root -g root -m 0644 "$STAGE_DIR/.deploy/gipc-stage.service" /etc/systemd/system/gipc.service

nginx -t
systemd-analyze verify /etc/systemd/system/gipc.service
systemctl daemon-reload
systemctl reload nginx
systemctl start gipc.service

for _attempt in $(seq 1 20); do
    if systemctl is-active --quiet gipc.service && \
       curl --fail --silent --show-error http://127.0.0.1:8000/openapi.json -o /dev/null; then
        break
    fi
    sleep 1
done
systemctl is-active --quiet gipc.service
curl --fail --silent --show-error http://127.0.0.1:8000/openapi.json -o /dev/null
curl --fail --silent --show-error http://127.0.0.1:8000/regulations -o /dev/null
curl --fail --silent --show-error http://127.0.0.1:8000/public/multi-apartment/settings -o /dev/null
curl --fail --silent --show-error http://127.0.0.1:8000/public/multi-functional/settings -o /dev/null

LISTENER="$(ss -H -ltn 'sport = :8000')"
grep -q '127.0.0.1:8000' <<< "$LISTENER"
if grep -Eq '0\.0\.0\.0:8000|\[::\]:8000|\*:8000' <<< "$LISTENER"; then
    echo "Uvicorn is still publicly bound." >&2
    exit 1
fi

curl --fail --silent --show-error https://gipc.org.ge/ -o /dev/null
curl --fail --silent --show-error https://gipc.org.ge/openapi.json -o /dev/null
curl --fail --silent --show-error https://gipc.org.ge/regulations -o /dev/null
curl --fail --silent --show-error https://gipc.org.ge/public/multi-apartment/settings -o /dev/null
curl --fail --silent --show-error https://gipc.org.ge/public/multi-functional/settings -o /dev/null
curl --fail --silent --show-error https://gipc.org.ge/scripts/header.js -o /dev/null

CORS_HEADERS="$(mktemp)"
curl --fail --silent --show-error \
    -D "$CORS_HEADERS" \
    -o /dev/null \
    -X OPTIONS \
    -H 'Origin: null' \
    -H 'Access-Control-Request-Method: POST' \
    https://gipc.org.ge/auth/login
grep -qi '^access-control-allow-origin: null' "$CORS_HEADERS"
rm -f "$CORS_HEADERS"

MUTATED=0
trap - ERR
echo "STAGE_DEPLOYMENT_OK"
