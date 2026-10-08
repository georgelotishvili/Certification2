"""Read-only, offline size audit of public CSS/JS/SVG at the Nginx gzip level.

Reports transfer-size estimates, not page-load-time claims. No .gz files are
written or required: the scoped Nginx location compresses eligible responses.
Already-compressed WOFF2 files and all private/API data are excluded.
"""

import gzip
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
SAMPLE = (
    "styles/styles.css", "styles/header.css", "scripts/config.js",
    "scripts/header.js", "scripts/registry.mini.js", "scripts/script.js",
    "assets/svg/logo.svg",
)


def measure(names):
    files = []
    for name in names:
        location = (FRONTEND / name).resolve()
        assert location.is_relative_to(FRONTEND.resolve())
        assert location.suffix in {".css", ".js", ".svg"}
        raw = location.read_bytes()
        compressed = gzip.compress(raw, compresslevel=5, mtime=0)
        assert gzip.decompress(compressed) == raw, f"Round-trip failed: {name}"
        sent_size = len(compressed) if len(raw) >= 1024 else len(raw)
        files.append({"path": name, "raw_bytes": len(raw), "gzip_bytes": sent_size})
    raw_total = sum(item["raw_bytes"] for item in files)
    gzip_total = sum(item["gzip_bytes"] for item in files)
    return {"files": files, "raw_bytes": raw_total, "gzip_bytes": gzip_total,
            "saved_bytes": raw_total - gzip_total,
            "saved_percent": round((1 - gzip_total / raw_total) * 100, 2),
            "all_files_decompressed_identically": True}


if __name__ == "__main__":
    print(json.dumps(measure(SAMPLE), indent=2))
