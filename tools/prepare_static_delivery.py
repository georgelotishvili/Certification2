"""Prepare a local Nginx candidate from a saved copy of the actual GIPC config.

This tool never connects to a server, installs a config, or reloads Nginx.
Only public static-asset delivery changes; every existing API location is kept.

    python tools/prepare_static_delivery.py --input .deploy/gipc.nginx \
        --output .deploy/static-delivery-20261008/gipc.candidate.conf

Before a separately approved deployment: capture the live config, check for drift,
run nginx -t on the candidate, keep the old config locally, deploy atomically,
reload only Nginx, and verify both hostnames. Never restart the application or
change the database. Check gzip/non-gzip response bytes and 304 revalidation.

References:
https://nginx.org/en/docs/http/ngx_http_gzip_module.html
https://nginx.org/en/docs/http/ngx_http_headers_module.html
"""

import argparse
import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "deployment/nginx"
ROOT_LOCATION = """    location / {
        root /var/www/gipc/frontend;
        index pages/index.html;
        try_files $uri $uri/ /pages/index.html;
    }"""
ALIASES = ("admin", "admin.html", "my", "my.html", "registrations", "registrations.html")


def prepare(original):
    source = original.replace("\r\n", "\n")
    assert source.count("server_name gipc.org.ge www.gipc.org.ge;") == 2, "Unexpected virtual hosts"
    assert source.count(ROOT_LOCATION) == 1, "Root location changed: review before preparing"
    assert "$gipc_static_expires" not in source, "Static optimization already applied"
    assert "location ~" not in source, "New regex locations need a manual precedence review"
    assert "add_header" not in source, "Review security-header inheritance first"
    # Retain existing API routes, TLS settings, redirects, body limits and aliases.
    with_cache = source.replace(ROOT_LOCATION, ROOT_LOCATION.replace("        index", "        expires -1;\n        index"), 1)
    for alias in ALIASES:
        page = alias.removesuffix(".html")
        old = f"    location = /{alias} {{ alias /var/www/gipc/frontend/pages/{page}.html; }}"
        assert with_cache.count(old) == 1, f"Alias changed: {alias}"
        with_cache = with_cache.replace(old, old.replace("; }", "; expires -1; }"), 1)
    location = (CONFIG / "static-assets.location.conf").read_text(encoding="utf-8").rstrip()
    indented = "\n".join("    " + line if line else "" for line in location.splitlines())
    with_assets = with_cache.replace("    location / {", indented + "\n\n    location / {", 1)
    mapping = (CONFIG / "static-cache.map.conf").read_text(encoding="utf-8").rstrip()
    candidate = mapping + "\n\n" + with_assets
    # Reverse only the intended additions and demand an exact round trip.
    restored = candidate.removeprefix(mapping + "\n\n")
    restored = restored.replace(indented + "\n\n", "", 1)
    restored = restored.replace("        expires -1;\n", "", 1)
    for alias in ALIASES:
        page = alias.removesuffix(".html")
        line = f"    location = /{alias} {{ alias /var/www/gipc/frontend/pages/{page}.html; expires -1; }}"
        restored = restored.replace(line, line.replace(" expires -1;", ""), 1)
    assert restored == source, "A change outside static delivery was detected"
    return candidate


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True, help="Local saved production configuration")
    parser.add_argument("--output", type=Path, required=True, help="New local candidate file")
    args = parser.parse_args()
    destination = args.output.resolve()
    staging = (ROOT / ".deploy").resolve()
    assert destination.is_relative_to(staging), "Candidate must remain in local .deploy staging"
    assert not destination.exists(), "Never overwrite a prepared candidate or backup"
    original = args.input.read_text(encoding="utf-8-sig")
    candidate = prepare(original)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(candidate, encoding="utf-8", newline="\n")
    print(json.dumps({
        "input_sha256": hashlib.sha256(args.input.read_bytes()).hexdigest(),
        "candidate_sha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
        "candidate": str(destination),
        "server_changed": False,
        "api_locations_unchanged": True,
        "unversioned_assets_and_html_revalidate": True,
        "versioned_public_assets_max_age_seconds": 3600,
    }, indent=2))


if __name__ == "__main__":
    main()
