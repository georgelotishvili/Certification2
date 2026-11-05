"""Deployment inventory and local evidence paths; no SSH or real HTTP calls."""
from __future__ import annotations

import base64
import importlib.util
import io
import json
from pathlib import Path, PurePosixPath
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / ".deploy" / "deploy_admin_release_20261016.py"


def load_deployer():
    spec = importlib.util.spec_from_file_location("isolated_manifest_deployer", SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DeployManifestTests(unittest.TestCase):
    def setUp(self):
        # Fail closed even outside run_isolated_suite.py. Generated remote
        # scripts are never executed; only mocked transport is used below.
        process_patch = patch("subprocess.run", side_effect=AssertionError("Real SSH/process forbidden"))
        process_patch.start()
        self.addCleanup(process_patch.stop)
        network_patch = patch("urllib.request.urlopen", side_effect=AssertionError("Real HTTP forbidden"))
        network_patch.start()
        self.addCleanup(network_patch.stop)
        self.base = load_deployer()

    def test_reported_runtime_omissions_are_explicitly_listed(self):
        required = {
            "backend/app/rate_limiter.py",
            "backend/app/routers/regulations.py",
            "backend/app/routers/reviews.py",
            "backend/app/routers/taxonomy.py",
            "backend/app/services/bounded_upload.py",
            "backend/app/services/exam_stage.py",
            "backend/app/services/expert_certificate_cleanup.py",
            "backend/app/services/media_storage.py",
            "backend/app/services/user_codes.py",
            "frontend/scripts/config.js",
            "frontend/scripts/certificate-qr.js",
        }
        self.assertLessEqual(required, set(self.base.CANDIDATE_FILES))

    def test_python_and_javascript_runtime_inventory_cannot_silently_drift(self):
        runtime = []
        # Only actual source directories: exclude uploaded media, tests,
        # generated builds, desktop sources and historical release snapshots.
        for folder in ("backend/app", "backend/app/routers", "backend/app/services"):
            runtime.extend((ROOT / folder).glob("*.py"))
        for folder in ("frontend/scripts", "frontend/vendor"):
            runtime.extend((ROOT / folder).rglob("*.js"))
        missing = sorted(path.relative_to(ROOT).as_posix() for path in runtime
                         if path.relative_to(ROOT).as_posix() not in self.base.CANDIDATE_FILES)
        self.assertEqual(missing, [], "New runtime modules must be added to the explicit deployment list")

    def test_certificate_dependencies_and_active_site_assets_are_listed(self):
        required = {
            "frontend/scripts/vendor/qrcode-generator.LICENSE.txt",
            "frontend/scripts/vendor/qrcode-generator.SOURCE.txt",
            "frontend/assets/fonts/bpg_nino_mtavruli_bold.ttf",
            "frontend/assets/fonts/bpg_nino_mtavruli_bold.woff2",
            "frontend/assets/fonts/dejavu-sans.ttf",
            "frontend/assets/fonts/dejavu-sans-bold.ttf",
            "frontend/assets/fonts/dejavu-sans.woff2",
            "frontend/assets/photos/main backenground.jpg",
            "frontend/robots.txt", "frontend/sitemap.xml",
        }
        required.update(f"frontend/assets/svg/{name}.svg" for name in
                        ("E-mail", "facebook", "header", "location", "logo", "phone"))
        required.update(path.relative_to(ROOT).as_posix()
                        for path in (ROOT / "frontend/certificate").iterdir() if path.is_file())
        self.assertLessEqual(required, set(self.base.CANDIDATE_FILES))
        self.assertNotIn("frontend/assets/svg/world.svg", self.base.CANDIDATE_FILES,
                         "Unused artwork is not automatically promoted into the release")

    def test_manifest_is_unique_contained_and_excludes_sensitive_or_generated_data(self):
        names = self.base.CANDIDATE_FILES
        self.assertEqual(len(names), len(set(names)))
        forbidden_parts = {"tests", "__pycache__", "node_modules", "desktop_app", "media", ".git", ".deploy"}
        for name in names:
            with self.subTest(name=name):
                relative = PurePosixPath(name)
                self.assertFalse(relative.is_absolute())
                self.assertNotIn("..", relative.parts)
                self.assertNotIn("\\", name)
                self.assertFalse(forbidden_parts.intersection(relative.parts))
                self.assertNotIn(relative.suffix.lower(), {".db", ".sqlite", ".sqlite3", ".exe", ".pyc", ".pem", ".key"})
                self.assertFalse(relative.name.startswith(".env"))
                self.assertTrue((ROOT / name).resolve().is_relative_to(ROOT))
                self.assertTrue((ROOT / name).is_file())

    def test_import_and_check_are_read_only_and_default_paths_are_unique(self):
        with patch.object(Path, "mkdir", side_effect=AssertionError("Import/check must not create release state")):
            first, second = load_deployer(), load_deployer()
            for module in (first, second):
                self.assertEqual(module.DEPLOY_DIR.parent, ROOT / ".deploy" / "releases")
                self.assertRegex(module.DEPLOY_DIR.name, r"^\d{8}T\d{6}Z-[0-9a-f]{32}$")
                self.assertEqual(module.BEFORE_DIR, module.DEPLOY_DIR / "before")
                self.assertEqual(module.AFTER_DIR, module.DEPLOY_DIR / "after")
                self.assertFalse(module.DEPLOY_DIR.exists())
                rel = "backend/app/rate_limiter.py"
                response = {"remote_hashes": {rel: module.sha256_bytes((ROOT / rel).read_bytes())}, "exam_counts": {}}
                with patch.object(module, "CANDIDATE_FILES", [rel]), \
                        patch.object(module, "run_remote_python", return_value=response) as transport:
                    self.assertEqual(module.check_diff()["changed"], [])
                    self.assertEqual(transport.call_args.args[1], {"rels": [rel]})
                self.assertFalse(module.DEPLOY_DIR.exists())
            self.assertNotEqual(first.DEPLOY_DIR, second.DEPLOY_DIR)

    def test_explicit_wrapper_paths_are_preserved_and_asset_urls_encode_spaces(self):
        with tempfile.TemporaryDirectory(prefix="gipc-manifest-test-") as directory:
            root = Path(directory)
            rel = "frontend/certificate/synthetic background.svg"
            local = root / "local" / rel
            local.parent.mkdir(parents=True)
            local.write_bytes(b"synthetic new SVG")
            old = b"synthetic old SVG"
            old_hash = self.base.sha256_bytes(old)
            new_hash = self.base.sha256_bytes(local.read_bytes())
            calls = []

            def transport(script, payload):
                calls.append(payload)
                if "rels" in payload:
                    return {rel: {"exists": True, "sha256": old_hash,
                                  "b64": base64.b64encode(old).decode("ascii")}}
                return {"ok": True, "verified_files": {rel: True}}

            class Response(io.BytesIO):
                status = 200

            state, before, after = root / "state", root / "custom-before", root / "custom-after"
            with patch.object(self.base, "ROOT", root / "local"), \
                    patch.object(self.base, "DEPLOY_DIR", state), \
                    patch.object(self.base, "BEFORE_DIR", before), \
                    patch.object(self.base, "AFTER_DIR", after), \
                    patch.object(self.base, "run_remote_python", side_effect=transport), \
                    patch.object(self.base.urllib.request, "urlopen", return_value=Response(local.read_bytes())) as http:
                receipt = self.base.deploy([{"path": rel, "local_sha256": new_hash, "remote_sha256": old_hash}])
            self.assertEqual(http.call_args.args[0].full_url,
                             "https://gipc.org.ge/certificate/synthetic%20background.svg")
            self.assertEqual(calls[0], {"rels": [rel]})
            self.assertEqual(set(calls[1]["files"]), {rel})
            self.assertEqual((before / rel).read_bytes(), old)
            self.assertEqual((after / rel).read_bytes(), local.read_bytes())
            self.assertEqual(receipt["release"], "state")
            self.assertEqual(json.loads((state / "receipt.json").read_text())["release"], "state")


if __name__ == "__main__":
    unittest.main()
