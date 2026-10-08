"""Offline config-scope regression tests: no server, application, or DB writes."""

import importlib.util
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("static_delivery", ROOT / "tools/prepare_static_delivery.py")
delivery = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(delivery)


def sample_config():
    aliases = "\n".join(
        f"    location = /{alias} {{ alias /var/www/gipc/frontend/pages/{alias.removesuffix('.html')}.html; }}"
        for alias in delivery.ALIASES
    )
    return (
        "server {\n    server_name gipc.org.ge www.gipc.org.ge;\n" + delivery.ROOT_LOCATION + "\n" + aliases
        + "\n    location /auth { proxy_pass http://127.0.0.1:8000; }"
        + "\n    location /exam { proxy_pass http://127.0.0.1:8000; }"
        + "\n    location /users { proxy_pass http://127.0.0.1:8000; }"
        + "\n    listen 443 ssl;\n    client_max_body_size 1G;\n}\n"
        + "server {\n    server_name gipc.org.ge www.gipc.org.ge;\n    listen 80;\n    return 404;\n}\n"
    )


class StaticDeliveryTests(unittest.TestCase):
    def test_existing_api_tls_and_redirect_sections_remain_unchanged(self):
        original = sample_config()
        candidate = delivery.prepare(original)
        for name in ("auth", "exam", "users"):
            route = f"    location /{name} {{ proxy_pass http://127.0.0.1:8000; }}"
            self.assertEqual(candidate.count(route), 1)
        self.assertEqual(candidate.count("proxy_pass"), original.count("proxy_pass"))
        self.assertIn("listen 443 ssl;", candidate)
        self.assertIn("client_max_body_size 1G;", candidate)
        self.assertEqual(candidate.split("\nserver {")[-1], original.split("\nserver {")[-1])

    def test_html_aliases_and_unversioned_assets_revalidate(self):
        candidate = delivery.prepare(sample_config())
        self.assertEqual(candidate.count("expires -1;"), 7)
        self.assertIn("default -1;", candidate)
        self.assertIn("1h;", candidate)
        self.assertNotIn("immutable", candidate.replace("# Unversioned scripts/styles and HTML must revalidate, never be immutable.", ""))
        self.assertNotIn("add_header", candidate)

    def test_compression_location_is_only_for_explicit_public_assets(self):
        snippet = (delivery.CONFIG / "static-assets.location.conf").read_text(encoding="utf-8")
        pattern = re.search(r"^location ~ (.+) \{$", snippet, re.M).group(1)
        for name in (
            "/styles/styles.css", "/scripts/admin/users.js", "/scripts/vendor/qrcode.js",
            "/assets/svg/logo.svg", "/assets/fonts/dejavu-sans.ttf", "/assets/fonts/dejavu-sans.woff2",
        ):
            self.assertRegex(name, pattern)
        for name in (
            "/auth/login", "/users/public", "/exam/start", "/public/file.svg",
            "/admin/export.js", "/uploads/document.svg", "/pages/admin.html",
            "/partials/header.html", "/assets/svg/private.txt", "/styles/secret.json",
        ):
            self.assertNotRegex(name, pattern)
        self.assertIn("try_files $uri =404;", snippet)
        self.assertIn("gzip_vary on;", snippet)
        self.assertNotIn("application/json", snippet)
        gzip_types = re.search(r"gzip_types ([^;]+);", snippet).group(1)
        self.assertNotIn("font/woff2", gzip_types)  # already Brotli compressed
        self.assertIn("font/woff2 woff2;", snippet)
        self.assertIn("text/css css;", snippet)
        self.assertIn("application/javascript js;", snippet)
        self.assertIn("image/svg+xml svg;", snippet)

    def test_prepare_rejects_drift_or_a_second_application(self):
        source = sample_config()
        for changed in (
            source.replace("pages/index.html;", "pages/different.html;", 1),
            source.replace("location /auth", "location ~ /auth", 1),
            source.replace("server {", 'server {\n add_header X-Test "value";', 1),
            delivery.prepare(source),
        ):
            with self.assertRaises(AssertionError):
                delivery.prepare(changed)


if __name__ == "__main__":
    unittest.main()
