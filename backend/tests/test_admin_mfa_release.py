"""MFA provisioning source/transport checks. Never runs SSH or provisioning."""
import ast
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[2]


def release_module():
    spec = importlib.util.spec_from_file_location("test_mfa_release", ROOT / ".deploy/deploy_admin_mfa_20261105.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AdminMfaReleaseTests(unittest.TestCase):
    def test_remote_sources_parse_and_secret_never_leaves_host(self):
        module = release_module()
        tree = ast.parse("if True:\n" + module.PROVISION)
        values = {node.targets[0].id: ast.literal_eval(node.value)
                  for node in ast.walk(tree)
                  if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)
                  and isinstance(node.value, ast.Constant)}
        content = values["content"]
        self.assertEqual(content.splitlines(), [b"[Service]", b'Environment="ADMIN_MFA_KEY_FILE=/var/lib/gipc/secrets/admin-mfa.key"'])
        self.assertNotIn(b"ENCRYPTION_KEY=", content)
        key_tree = ast.parse(values["key_setup"])
        self.assertFalse(any(isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
                             and n.func.id == "print" for n in ast.walk(key_tree)))
        self.assertIn("Fernet.generate_key()", values["key_setup"])
        self.assertIn("os.O_EXCL | os.O_NOFOLLOW", values["key_setup"])
        self.assertIn("0o640", values["key_setup"])
        self.assertIn("key_path.read_bytes().strip()", values["key_setup"])

    def test_provisioning_injected_only_after_exam_guard_and_stop(self):
        module = release_module()
        remote = Mock(return_value={"ok": True})
        wrapper = module.provisioned_transport(remote)
        source = '''try:
    db.execute("BEGIN IMMEDIATE")
    subprocess.run(["systemctl", "stop", "gipc.service"])
    ref_stat = (root / "backend/app/main.py").stat()
except Exception:
    raise
'''
        self.assertEqual(wrapper(source, {"files": {"synthetic.py": {}}}), {"ok": True})
        sent = remote.call_args.args[0]
        ast.parse(sent)
        self.assertLess(sent.index('"stop"'), sent.index('"pip"'))
        self.assertLess(sent.index('"daemon-reload"'), sent.index("ref_stat ="))
        self.assertEqual(wrapper("readonly", {"rels": []}), {"ok": True})
        self.assertEqual(remote.call_args.args[0], "readonly")

    def test_unknown_transport_or_missing_guard_is_rejected(self):
        module = release_module()
        remote = Mock()
        with self.assertRaises((AssertionError, ValueError)):
            module.provisioned_transport(remote)("missing marker", {"files": {}})
        remote.assert_not_called()


if __name__ == "__main__":
    unittest.main()
