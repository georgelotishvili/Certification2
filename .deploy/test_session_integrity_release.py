"""Release safety gates, using temporary files/SQLite and mocked Linux transport.

Never imports application startup or opens SSH, HTTP, SMTP or production paths.
"""
import ast
import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import types
import unittest
from contextlib import ExitStack, redirect_stdout
from unittest.mock import patch

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("isolated_deploy_base", HERE / "deploy_admin_release_20261016.py")
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


class Captured(Exception):
    pass


class ReleaseSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="gipc-release-test-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.local = self.directory / "local"
        self.remote = self.directory / "remote"
        self.rel = "backend/app/main.py"
        self.old, self.new = b"# synthetic old\n", b"# synthetic new\n"
        for root, content in ((self.local, self.new), (self.remote, self.old)):
            path = root / self.rel
            path.parent.mkdir(parents=True)
            path.write_bytes(content)
        self.dbpath = self.directory / "synthetic.db"
        with sqlite3.connect(self.dbpath) as db:
            db.execute("CREATE TABLE sessions(active INTEGER, finished_at TEXT, ends_at TEXT)")
            db.execute("CREATE TABLE offline_exam_attempts(submitted_at TEXT, ends_at TEXT)")
        self.patches = ExitStack()
        self.addCleanup(self.patches.close)
        self.patches.enter_context(patch.object(base, "ROOT", self.local))
        self.patches.enter_context(patch.object(base, "DEPLOY_DIR", self.directory / "state"))
        self.patches.enter_context(patch.object(base, "BEFORE_DIR", self.directory / "before"))
        self.patches.enter_context(patch.object(base, "AFTER_DIR", self.directory / "after"))
        self.commands = []

    def capture(self, *, local_hash=None, remote_hash=None):
        before = {self.rel: dict(exists=True, sha256=digest(self.old),
                                 b64=base64.b64encode(self.old).decode(), uid=1, gid=1, mode="0o644")}
        changed = [dict(path=self.rel, local_sha256=local_hash or digest(self.new),
                        remote_sha256=remote_hash or digest(self.old))]
        captured = {}
        def transport(script, payload):
            if "rels" in payload:
                return before
            captured.update(script=script, payload=payload)
            raise Captured()
        with patch.object(base, "run_remote_python", transport):
            with self.assertRaises(Captured):
                base.deploy(changed)
        return captured

    def execute_remote(self, captured, *, stop_error=False, compile_error=False):
        source = captured["script"].replace("/var/www/gipc", self.remote.as_posix())
        source = source.replace("/var/lib/gipc/db/app.db", self.dbpath.as_posix())
        source = source.replace("/run/lock/gipc-release.lock", (self.directory / "release.lock").as_posix())
        namespace = {"PAYLOAD": captured["payload"]}
        self.lock_checks = []
        def run(command, **kwargs):
            self.commands.append(command)
            if command[:2] == ["systemctl", "stop"]:
                self.assertEqual((self.remote / self.rel).read_bytes(), self.old)
                with sqlite3.connect(self.dbpath, timeout=0) as writer:
                    with self.assertRaises(sqlite3.OperationalError):
                        writer.execute("BEGIN IMMEDIATE")
                self.lock_checks.append("held-during-stop")
                if stop_error:
                    raise RuntimeError("synthetic stop failed")
            elif command[:2] == ["systemctl", "restart"]:
                with sqlite3.connect(self.dbpath, timeout=0) as writer:
                    writer.execute("BEGIN IMMEDIATE"); writer.rollback()
                self.lock_checks.append("released-before-restart")
            elif "py_compile" in command and compile_error:
                raise RuntimeError("synthetic compile failed")
            return types.SimpleNamespace(returncode=0)
        class Response(io.BytesIO):
            status = 200
        output = io.StringIO()
        fcntl = types.SimpleNamespace(LOCK_EX=2, LOCK_NB=4, flock=lambda *_: None)
        try:
            with ExitStack() as stack:
                stack.enter_context(patch.dict(sys.modules, {"fcntl": fcntl}))
                stack.enter_context(patch("os.chown", create=True))
                stack.enter_context(patch("subprocess.run", run))
                stack.enter_context(patch("subprocess.check_output", return_value="active\n"))
                stack.enter_context(patch("urllib.request.urlopen", return_value=Response(b'{"paths":{"/admin/users":{},"/admin/planning-templates":{}}}')))
                stack.enter_context(redirect_stdout(output))
                exec(compile(source, "<isolated-generated-deploy>", "exec"), namespace)
        finally:
            if namespace.get("release_lock"):
                namespace["release_lock"].close()
        return json.loads(output.getvalue())

    def test_active_exam_aborts_before_any_service_stop_or_file_write(self):
        with sqlite3.connect(self.dbpath) as db:
            db.execute("INSERT INTO sessions VALUES (1,NULL,datetime('now','+1 hour'))")
        with self.assertRaisesRegex(RuntimeError, "Active exam"):
            self.execute_remote(self.capture())
        self.assertEqual(self.commands, [])
        self.assertEqual((self.remote / self.rel).read_bytes(), self.old)

    def test_future_preparation_and_offline_exam_also_block_deployment(self):
        for table in ("sessions", "offline_exam_attempts"):
            with self.subTest(table=table):
                with sqlite3.connect(self.dbpath) as db:
                    db.execute("DELETE FROM sessions"); db.execute("DELETE FROM offline_exam_attempts")
                    if table == "sessions":
                        db.execute("INSERT INTO sessions VALUES (0,NULL,datetime('now','+1 hour'))")
                    else:
                        db.execute("INSERT INTO offline_exam_attempts VALUES (NULL,datetime('now','+1 hour'))")
                with self.assertRaisesRegex(RuntimeError, "Active exam"):
                    self.execute_remote(self.capture())
                self.assertEqual(self.commands, [])
                self.assertEqual((self.remote / self.rel).read_bytes(), self.old)

    def test_idle_release_holds_writer_lock_until_stop_then_unlocks_for_restart(self):
        result = self.execute_remote(self.capture())
        self.assertEqual(self.lock_checks, ["held-during-stop", "released-before-restart"])
        self.assertEqual((self.remote / self.rel).read_bytes(), self.new)
        self.assertTrue(result["ok"])
        self.assertTrue(result["verified_files"][self.rel])

    def test_changed_remote_after_backup_aborts_before_stop_or_overwrite(self):
        captured = self.capture()
        concurrent = b"# synthetic concurrent change\n"
        (self.remote / self.rel).write_bytes(concurrent)
        with self.assertRaisesRegex(RuntimeError, "Remote file changed before apply"):
            self.execute_remote(captured)
        self.assertEqual(self.commands, [])
        self.assertEqual((self.remote / self.rel).read_bytes(), concurrent)

    def test_changed_local_after_inspection_is_not_uploaded(self):
        with self.assertRaisesRegex(RuntimeError, "Local file changed since inspection"):
            self.capture(local_hash=digest(b"different checked source"))

    def test_changed_remote_between_inspection_and_backup_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "Remote file changed since inspection"):
            self.capture(remote_hash=digest(b"different checked remote"))

    def test_invalid_payload_aborts_before_stop(self):
        captured = self.capture()
        captured["payload"]["files"][self.rel]["b64"] = base64.b64encode(b"corrupt").decode()
        with self.assertRaisesRegex(RuntimeError, "Payload hash mismatch"):
            self.execute_remote(captured)
        self.assertEqual(self.commands, [])

    def test_stop_and_compile_failures_restore_and_restart_after_unlock(self):
        for mode in ("stop_error", "compile_error"):
            with self.subTest(mode=mode):
                self.commands = []
                with self.assertRaisesRegex(RuntimeError, "synthetic"):
                    self.execute_remote(self.capture(), **{mode: True})
                self.assertEqual((self.remote / self.rel).read_bytes(), self.old)
                self.assertEqual(self.lock_checks[-1], "released-before-restart")
                self.assertIn(["systemctl", "restart", "gipc.service"], self.commands)

    def test_publisher_keeps_large_copy_outside_db_transaction_and_checks_slot(self):
        tree = ast.parse((HERE / "release_session_integrity_20261104.py").read_text(encoding="utf-8"))
        scripts = [node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and isinstance(node.value, str) and "UPDATE app_files" in node.value]
        self.assertEqual(len(scripts), 1)
        script = scripts[0]
        compile(script, "<publisher-remote>", "exec")
        self.assertLess(script.index("shutil.copyfile"), script.index("BEGIN IMMEDIATE"))
        self.assertIn("old==expected", script)
        self.assertIn("SELECT COUNT(*) FROM app_files", script)
        self.assertIn("WHERE id=2", script)
        self.assertIn("Backend changed before app publication", script)
        self.assertNotIn("previous.unlink", script)
        self.assertNotIn("DELETE FROM app_files", script)


if __name__ == "__main__":
    unittest.main()
