"""Durable domain events, in the same transaction as their successful mutation.

Only explicitly opted-in application Sessions are observed. No SQL interception
outside SQLAlchemy Sessions, no network, no commits, no credentials, answers or
document text. Existing history is not invented from mutable domain rows.
"""
from __future__ import annotations

import json
from threading import Lock
from datetime import date, datetime, timezone
from sqlalchemy import event, inspect, select
from sqlalchemy.orm import Session

FIELDS = {
    "users": ("id", "is_admin", "candidate_status", "candidate_category"),
    "user_sessions": ("id", "user_id", "client_type"),
    "statements": ("id", "user_id", "seen_at", "answered_at"),
    "planning_letters": ("id", "user_id", "kind", "status", "attempts", "sent_at"),
    "user_exam_stage_grants": ("id", "user_id", "stage", "granted_at", "expires_at", "started_at", "consumed_at", "revoked_at", "expired_at"),
    "sessions": ("id", "user_id", "stage_grant_id", "active", "finished_at", "score_percent"),
    "multi_apartment_evaluations": ("id", "user_id", "stage_grant_id", "percentage", "correct_count", "wrong_count", "total_correct_answers"),
    "multi_functional_evaluations": ("id", "user_id", "stage_grant_id", "percentage", "correct_count", "wrong_count", "total_correct_answers"),
    "certificates": ("id", "user_id", "level", "status", "issue_date", "valid_until", "is_transitional", "size_bytes"),
    "exam_schedules": ("id", "user_id", "exam_date", "period"),
}
CATEGORIES = {"users": "registration", "user_sessions": "auth", "statements": "statement", "planning_letters": "letter", "user_exam_stage_grants": "grant", "sessions": "exam", "multi_apartment_evaluations": "exam", "multi_functional_evaluations": "exam", "certificates": "certificate", "exam_schedules": "grant"}
CATEGORY_LABELS = {"registration": "რეგისტრაცია", "auth": "ავტორიზაცია", "statement": "განცხადება", "letter": "წერილი", "grant": "დაშვება / განრიგი", "exam": "გამოცდა", "certificate": "სერტიფიკატი", "system": "სისტემა"}
TABLE_LABELS = {"users": "მომხმარებელი", "user_sessions": "ავტორიზაციის სესია", "statements": "განცხადება", "planning_letters": "ოფიციალური წერილი", "user_exam_stage_grants": "საგამოცდო დაშვება", "sessions": "თეორიული გამოცდა", "multi_apartment_evaluations": "ეტაპი 2-ის შედეგი", "multi_functional_evaluations": "ეტაპი 3-ის შედეგი", "certificates": "სერტიფიკატი", "exam_schedules": "გამოცდის განრიგი"}
ACTION_LABELS = {f"{table}.{operation}": f"{label} — {suffix}" for table, label in TABLE_LABELS.items() for operation, suffix in (("created", "დამატება"), ("updated", "ცვლილება"), ("deleted", "წაშლა"))}
ACTION_LABELS.update({"journal.started": "მუდმივი ჟურნალის დაწყება", "auth.logout": "სისტემიდან გასვლა", "auth.login": "სისტემაში შესვლა", "user_sessions.created": "სისტემაში შესვლა", "user_sessions.deleted": "ავტორიზაციის სესიის გაუქმება", "letter.sent": "წერილის წარმატებით გაგზავნა", "letter.failed": "წერილის გაგზავნის შეცდომა", "letter.simulated": "წერილის შენახვა / სატესტო გაგზავნა", "letter.uncertain": "წერილის გაგზავნის შედეგი დაუდასტურებელია", "letter.sending": "წერილის გაგზავნის მცდელობა", "grant.started": "საგამოცდო ეტაპის დაწყება", "grant.consumed": "საგამოცდო დაშვების გამოყენება", "grant.revoked": "საგამოცდო დაშვების გაუქმება", "grant.expired": "დაუწყებელი დაშვების ვადის გასვლა", "exam.finished": "თეორიული გამოცდის დასრულება"})
ACTION_LABELS["registration.notice_accepted"] = "რეგისტრაციის პირობებზე თანხმობა"
ACTION_LABELS.update({
    "auth.admin_mfa.setup_started": "Google Authenticator-ის მიბმის დაწყება",
    "auth.admin_mfa.enabled": "Google Authenticator-ის მიბმა / განახლება",
    "auth.admin_mfa.verified": "ადმინისტრატორის ორფაქტორიანი დადასტურება",
    "auth.admin_mfa.failed": "ადმინისტრატორის დამატებითი დადასტურების წარუმატებელი მცდელობა",
    "auth.admin_mfa.recovery_regenerated": "სარეზერვო ავტორიზაციის კოდების განახლება",
    "auth.admin_mfa.locked": "ადმინისტრატორის დადასტურებული სესიის ჩაკეტვა",
})
COVERAGE_NOTE = "მუდმივი ჟურნალი ინახავს ამ განახლების შემდეგ აღრიცხულ მოქმედებებს. მანამდე არსებული სრული ისტორია არ აღდგენილა."
_HOOKS_LOCK = Lock()
_HOOKS_INSTALLED = False


def set_audit_actor(db, user, *, admin=False):
    if user is not None and user.id is not None:
        db.info["audit_actor"] = {"id": int(user.id), "label": ("ადმინისტრატორი" if admin or user.is_admin else "მომხმარებელი") + f" #{user.id}"}


def _scalar(value):
    if isinstance(value, datetime):
        if value.tzinfo:
            value = value.astimezone(timezone.utc).replace(tzinfo=None)
        return value.isoformat() + "Z"
    if isinstance(value, date):
        return value.isoformat()
    return value


def _columns(table):
    return [table.c[name] for name in FIELDS[table.name] if name in table.c]


def _snapshot(table, row):
    return {col.name: _scalar(row.get(col.name)) for col in _columns(table)}


def _record(db, table, before, after, operation):
    current = after if after is not None else before
    if current is None:
        return None
    changed = {key: {"before": (before or {}).get(key), "after": (after or {}).get(key)} for key in FIELDS[table.name] if (before or {}).get(key) != (after or {}).get(key)}
    if operation == "updated" and not changed:
        return None
    action, category = f"{table.name}.{operation}", CATEGORIES[table.name]
    if operation != "deleted":
        if table.name == "planning_letters" and "status" in changed:
            if current.get("status") in {"sent", "failed", "simulated", "sending", "uncertain"}:
                action = f"letter.{current['status']}"
        elif table.name == "user_exam_stage_grants":
            for field, name in (("revoked_at", "revoked"), ("expired_at", "expired"), ("consumed_at", "consumed"), ("started_at", "started")):
                if field in changed and current.get(field):
                    action = f"grant.{name}"
                    if name == "started":
                        category = "exam"
                    break
        elif table.name == "sessions" and "finished_at" in changed and current.get("finished_at"):
            action = "exam.finished"
    if table.name == "user_sessions" and operation == "deleted" and db.info.get("audit_logout_session_id") == current.get("id"):
        action = "auth.logout"
    actor = db.info.get("audit_actor")
    if not actor and operation == "created" and table.name in {"users", "user_sessions"}:
        uid = current.get("user_id") if table.name == "user_sessions" else current.get("id")
        actor = {"id": uid, "label": f"მომხმარებელი #{uid}"}
    actor = actor or {"id": None, "label": "სისტემა / ავტორი არ დაფიქსირებულა"}
    uid = current.get("user_id")
    details = json.dumps(changed, ensure_ascii=False, separators=(",", ":"))
    return dict(occurred_at=datetime.utcnow(), category=category, action=action, actor_id=actor["id"], actor_label=actor["label"], target_type=table.name, target_id=current.get("id"), target_label=f"{TABLE_LABELS[table.name]} #{current.get('id')}" + (f" · მომხმარებელი #{uid}" if uid is not None else ""), details=details)


def _write(db, records):
    from ..models import AuditEvent
    records = [record for record in records if record]
    if records:
        db.connection().execute(AuditEvent.__table__.insert(), records)


def record_reused_login(db, session):
    if db.info.get("audit_enabled"):
        snap = _snapshot(session.__table__, {col.name: getattr(session, col.name, None) for col in _columns(session.__table__)})
        record = _record(db, session.__table__, None, snap, "created")
        record["action"] = "auth.login"
        _write(db, [record])


def _lock_snapshot_reads(connection, table):
    # SQLite ignores SELECT FOR UPDATE. Acquire the same transaction's writer
    # lock before reading "before", otherwise a concurrent successful writer
    # could be attributed to this request. No rows or onupdate defaults change.
    # Table names come exclusively from the fixed allowlist above.
    if connection.dialect.name == "sqlite":
        connection.exec_driver_sql(f'UPDATE "{table.name}" SET id=id WHERE 0')


def _assigned_columns(statement, parameters):
    values = getattr(statement, "_values", None)
    ordered = getattr(statement, "_ordered_values", None)
    if values is not None:
        keys = values.keys()
    elif ordered is not None:
        keys = [key for key, _value in ordered]
    elif isinstance(parameters, dict) and parameters:
        keys = parameters.keys()
    else:
        return None  # Unknown shape: retain the guarded audit path.
    return {key if isinstance(key, str) else getattr(key, "key", None) for key in keys}


def _before_flush(db, _context, _instances):
    if not db.info.get("audit_enabled"):
        return
    pending = []
    connection = None
    for operation, objects in (("created", db.new), ("updated", db.dirty), ("deleted", db.deleted)):
        for obj in objects:
            state = inspect(obj)
            table = state.mapper.local_table
            if table.name not in FIELDS:
                continue
            if operation == "updated" and not any(state.attrs[name].history.has_changes() for name in FIELDS[table.name] if name in table.c):
                continue
            before = None
            if operation != "created":
                if connection is None:
                    connection = db.connection()
                    _lock_snapshot_reads(connection, table)
                row = connection.execute(select(*_columns(table)).where(table.c.id == obj.id).with_for_update()).mappings().first()
                before = _snapshot(table, row) if row else None
            pending.append((obj, table, before, operation))
    db.info["audit_pending_flush"] = pending


def _after_flush(db, _context):
    records = []
    for obj, table, before, operation in db.info.pop("audit_pending_flush", []):
        if operation == "updated":
            # Unmodified ORM attributes may be stale after another operator's
            # earlier commit. Audit what this transaction actually persisted,
            # not a cached value that was never part of its UPDATE statement.
            row = db.connection().execute(select(*_columns(table)).where(table.c.id == obj.id)).mappings().first()
            after = _snapshot(table, row) if row else None
        else:
            after = None if operation == "deleted" else _snapshot(table, {col.name: getattr(obj, col.name, None) for col in _columns(table)})
        records.append(_record(db, table, before, after, operation))
    _write(db, records)


def _bulk_write(state):
    if not state.session.info.get("audit_enabled") or not (state.is_update or state.is_delete):
        return None
    table = getattr(state.statement, "table", None)
    if table is None or table.name not in FIELDS:
        return None
    db = state.session
    params = state.parameters or {}
    if state.is_update:
        assigned = _assigned_columns(state.statement, params)
        if assigned is not None and not assigned.intersection(FIELDS[table.name]):
            # Heartbeats and the application's existing no-op transition locks
            # must not trigger snapshot queries or an earlier ORM flush.
            return None
    if isinstance(params, list):
        # Existing application mutations use one explicit WHERE clause. Never
        # infer a WHERE-less multi-row write as a full-table audit operation.
        raise ValueError("Audited executemany requires explicit per-row audit handling")
    conn = db.connection()
    _lock_snapshot_reads(conn, table)
    db.flush()
    rows = list(conn.execute(select(*_columns(table)).where(*state.statement._where_criteria).with_for_update(), params).mappings())
    result = state.invoke_statement()
    after_by_id = {}
    if state.is_update:
        ids = [row["id"] for row in rows]
        for offset in range(0, len(ids), 500):
            for row in conn.execute(select(*_columns(table)).where(table.c.id.in_(ids[offset:offset + 500]))).mappings():
                after_by_id[row["id"]] = _snapshot(table, row)
    _write(db, [_record(db, table, _snapshot(table, row), after_by_id.get(row["id"]), "deleted" if state.is_delete else "updated") for row in rows])
    return result


def _clear_pending(db, *_args):
    db.info.pop("audit_pending_flush", None)
    db.info.pop("audit_logout_session_id", None)


def protect_audit_table(connection):
    if connection.dialect.name == "sqlite":
        for operation in ("UPDATE", "DELETE"):
            connection.exec_driver_sql(f"CREATE TRIGGER IF NOT EXISTS audit_events_no_{operation.lower()} BEFORE {operation} ON audit_events BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END")


def enable_audit(db):
    global _HOOKS_INSTALLED
    if not _HOOKS_INSTALLED:
        with _HOOKS_LOCK:
            if not _HOOKS_INSTALLED:
                for name, callback in (("before_flush", _before_flush), ("after_flush", _after_flush), ("do_orm_execute", _bulk_write), ("after_rollback", _clear_pending), ("after_commit", _clear_pending)):
                    if not event.contains(Session, name, callback):
                        event.listen(Session, name, callback)
                _HOOKS_INSTALLED = True
    db.info["audit_enabled"] = True
