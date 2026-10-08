"""Build lossless WOFF2 copies; keep the original TTFs used by PDF generation.

Run in an isolated tooling environment (not the production backend):
    python -m pip install -r tools/requirements-webfonts.txt
    python tools/build_webfonts.py
    python tools/build_webfonts.py --check

No subsetting, font replacement, or application dependency is involved.
Reference: https://fonttools.readthedocs.io/en/latest/ttLib/woff2.html
"""

import argparse
import hashlib
import io
import json
from pathlib import Path

from fontTools.pens.recordingPen import RecordingPen
from fontTools.ttLib import TTFont


ROOT = Path(__file__).resolve().parents[1]
FONTS = ROOT / "frontend/assets/fonts"
SOURCES = {
    "dejavu-sans.ttf": "7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954",
    "bpg_nino_mtavruli_bold.ttf": "daaf598286ceebe8ed7719e66b8f4ae4582f1cb8a4b7dd85dbeca38267f99284",
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verify_font(source, candidate):
    """Check every glyph, mapping, hint, metric, and non-container table."""
    original = TTFont(io.BytesIO(source), recalcTimestamp=False)
    compressed = TTFont(io.BytesIO(candidate), recalcTimestamp=False)
    assert compressed.flavor == "woff2", "Expected a WOFF2 font"
    names = original.getGlyphOrder()
    assert names == compressed.getGlyphOrder(), "Glyph order or count changed"
    assert original.getBestCmap() == compressed.getBestCmap(), "Unicode mappings changed"
    assert set(original.keys()) == set(compressed.keys()), "Font tables changed"
    for tag in original.keys():
        if tag not in {"GlyphOrder", "head", "glyf", "loca"}:
            assert original.getTableData(tag) == compressed.getTableData(tag), f"Table changed: {tag}"
    # Container checksums/loca encoding may change; typography must not.
    for name, value in vars(original["head"]).items():
        if name == "flags":
            # WOFF2 sets bit 11 to mark lossless font transformation.
            assert value | (1 << 11) == compressed["head"].flags, "Head flags changed"
        elif name not in {"checkSumAdjustment", "indexToLocFormat"}:
            assert value == getattr(compressed["head"], name), f"Head metric changed: {name}"
    before_glyphs, after_glyphs = original.getGlyphSet(), compressed.getGlyphSet()
    for name in names:
        before, after = RecordingPen(), RecordingPen()
        before_glyphs[name].draw(before)
        after_glyphs[name].draw(after)
        assert before.value == after.value, f"Glyph outline changed: {name}"
        for table in ("glyf",):
            old, new = original[table][name], compressed[table][name]
            assert old.numberOfContours == new.numberOfContours, f"Contours changed: {name}"
            old_program = old.program.getBytecode() if hasattr(old, "program") else b""
            new_program = new.program.getBytecode() if hasattr(new, "program") else b""
            assert old_program == new_program, f"Hinting changed: {name}"
    result = {
        "glyphs": len(names),
        "unicode_mappings": len(original.getBestCmap()),
        "original_bytes": len(source),
        "woff2_bytes": len(candidate),
        "saved_bytes": len(source) - len(candidate),
        "saved_percent": round((1 - len(candidate) / len(source)) * 100, 2),
        "original_sha256": digest(source),
        "woff2_sha256": digest(candidate),
        "all_glyphs_outlines_metrics_hinting_preserved": True,
    }
    original.close()
    compressed.close()
    return result


def build(check_only=False):
    report = {}
    for filename, expected in SOURCES.items():
        source_path = FONTS / filename
        target_path = source_path.with_suffix(".woff2")
        source = source_path.read_bytes()
        if expected:
            assert digest(source) == expected, f"Original TTF unexpectedly changed: {filename}"
        if check_only:
            result = verify_font(source, target_path.read_bytes())
        else:
            font = TTFont(io.BytesIO(source), recalcTimestamp=False)
            font.flavor = "woff2"
            output = io.BytesIO()
            font.save(output, reorderTables=False)
            font.close()
            candidate = output.getvalue()
            result = verify_font(source, candidate)
            assert len(candidate) < len(source), f"WOFF2 is not smaller: {filename}"
            target_path.write_bytes(candidate)
            assert target_path.read_bytes() == candidate
        assert source_path.read_bytes() == source, "Original TTF must not be modified"
        report[filename] = result
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Verify checked-in webfonts without writing")
    args = parser.parse_args()
    print(json.dumps(build(check_only=args.check), indent=2))
