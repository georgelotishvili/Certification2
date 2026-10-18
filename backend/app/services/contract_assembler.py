from __future__ import annotations

import html
import io
import re
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

TBILISI_TZ = ZoneInfo("Asia/Tbilisi")
W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"
ET.register_namespace("w", W_NS)

GEORGIAN_LETTERS = (
    "ა", "ბ", "გ", "დ", "ე", "ვ", "ზ", "თ", "ი", "კ",
    "ლ", "მ", "ნ", "ო", "პ", "ჟ", "რ", "ს", "ტ", "უ",
    "ფ", "ქ", "ღ", "ყ", "შ", "ჩ", "ც", "ძ", "წ", "ჭ",
    "ხ", "ჯ", "ჰ",
)

CONTRACT_SLOTS: dict[str, dict[str, str]] = {
    "exam": {
        "key": "exam",
        "code": "GIPC-CON-004",
        "short_title": "საგამოცდო ხელშეკრულება",
        "default_title": "საგამოცდო ხელშეკრულება (GIPC-CON-004)",
        "category": "EXAM",
        "order_index": 1,
        "source_md": "10_საგამოცდო_ხელშეკრულება_არგონ.md",
        "source_docx": "10_საგამოცდო_ხელშეკრულება.docx",
    },
    "cert_a": {
        "key": "cert_a",
        "code": "GIPC-CON-001",
        "short_title": "სასერტიფიკაციო ხელშეკრულება — კატეგორია A (არქიტექტორი)",
        "default_title": "სერტიფიცირების ხელშეკრულება — კატეგორია A: შენობა-ნაგებობის არქიტექტორი (GIPC-CON-001)",
        "category": "A",
        "order_index": 2,
        "source_md": "08_სასერტიფიკაციო_ხელშეკრულება_არქიტექტორი_არგონ.md",
        "source_docx": "08_სასერტიფიკაციო_ხელშეკრულება_არქიტექტორი.docx",
    },
    "cert_b": {
        "key": "cert_b",
        "code": "GIPC-CON-002",
        "short_title": "სასერტიფიკაციო ხელშეკრულება — კატეგორია B (სპეციალისტი)",
        "default_title": "სერტიფიცირების ხელშეკრულება — კატეგორია B: არქიტექტურული პროექტის შემსწავლელი სპეციალისტი (GIPC-CON-002)",
        "category": "B",
        "order_index": 3,
        "source_md": "09a_სასერტიფიკაციო_ხელშეკრულება_სპეციალისტი_არგონ.md",
        "source_docx": "09a_სასერტიფიკაციო_ხელშეკრულება_სპეციალისტი.docx",
    },
    "cert_c": {
        "key": "cert_c",
        "code": "GIPC-CON-003",
        "short_title": "სასერტიფიკაციო ხელშეკრულება — კატეგორია C (ექსპერტი)",
        "default_title": "სერტიფიცირების ხელშეკრულება — კატეგორია C: არქიტექტურული პროექტის ექსპერტი (GIPC-CON-003)",
        "category": "C",
        "order_index": 4,
        "source_md": "09_სასერტიფიკაციო_ხელშეკრულება_ექსპერტი_არგონ.md",
        "source_docx": "09_სასერტიფიკაციო_ხელშეკრულება_ექსპერტი.docx",
    },
}


def current_tbilisi_date_str() -> str:
    return datetime.now(TBILISI_TZ).strftime("%d.%m.%Y")


def extract_user_fields(user: Any, date_str: str | None = None) -> dict[str, str]:
    if user is None:
        return {}
    if isinstance(user, dict):
        first = str(user.get("first_name") or user.get("firstName") or "").strip()
        last = str(user.get("last_name") or user.get("lastName") or "").strip()
        personal_id = str(user.get("personal_id") or user.get("personalId") or "").strip()
        phone = str(user.get("phone") or "").strip()
        email = str(user.get("email") or "").strip()
    else:
        first = str(getattr(user, "first_name", "") or "").strip()
        last = str(getattr(user, "last_name", "") or "").strip()
        personal_id = str(getattr(user, "personal_id", "") or "").strip()
        phone = str(getattr(user, "phone", "") or "").strip()
        email = str(getattr(user, "email", "") or "").strip()

    full_name = f"{first} {last}".strip()
    return {
        "full_name": full_name,
        "personal_id": personal_id,
        "phone": phone,
        "email": email,
        "date": (date_str or current_tbilisi_date_str()).strip(),
    }


_HTML_FIELD_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    (
        "full_name",
        re.compile(
            r"(სახელი\s*,\s*გვარი\s*:(?:\s|&nbsp;|&#160;|</?(?:strong|b|span|em|i)[^>]*>)*)_{3,}",
            re.IGNORECASE,
        ),
    ),
    (
        "personal_id",
        re.compile(
            r"(პირადი\s+ნომერი\s*:(?:\s|&nbsp;|&#160;|</?(?:strong|b|span|em|i)[^>]*>)*)_{3,}",
            re.IGNORECASE,
        ),
    ),
    (
        "phone",
        re.compile(
            r"(ტელეფონი\s*:(?:\s|&nbsp;|&#160;|</?(?:strong|b|span|em|i)[^>]*>)*)_{3,}",
            re.IGNORECASE,
        ),
    ),
    (
        "email",
        re.compile(
            r"(ელ\.?\s*ფოსტა\s*:(?:\s|&nbsp;|&#160;|</?(?:strong|b|span|em|i)[^>]*>)*)_{3,}",
            re.IGNORECASE,
        ),
    ),
    (
        "date",
        re.compile(
            r"(თარიღი\s*:(?:\s|&nbsp;|&#160;|</?(?:strong|b|span|em|i)[^>]*>)*)_{3,}",
            re.IGNORECASE,
        ),
    ),
]


def populate_contract_html(content: str, user: Any, date_str: str | None = None) -> str:
    """Replace blank underscore lines in contract HTML with the user's data and date."""
    if not content or not user:
        return content or ""

    fields = extract_user_fields(user, date_str=date_str)
    if not fields.get("full_name") and not fields.get("personal_id") and not fields.get("email"):
        return content

    result = content
    for key, pattern in _HTML_FIELD_PATTERNS:
        val = fields.get(key, "")
        if not val:
            continue
        safe_val = html.escape(val)
        result = pattern.sub(lambda m, v=safe_val: f"{m.group(1)}<strong>{v}</strong>", result)

    return result


_DOCX_FIELD_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("full_name", re.compile(r"(სახელი\s*,\s*გვარი\s*:[\s\u00a0]*)_{3,}")),
    ("personal_id", re.compile(r"(პირადი\s+ნომერი\s*:[\s\u00a0]*)_{3,}")),
    ("phone", re.compile(r"(ტელეფონი\s*:[\s\u00a0]*)_{3,}")),
    ("email", re.compile(r"(ელ\.?\s*ფოსტა\s*:[\s\u00a0]*)_{3,}")),
    ("date", re.compile(r"(თარიღი\s*:[\s\u00a0]*)_{3,}")),
]


def populate_contract_docx_bytes(
    docx_source: Path | bytes,
    user: Any,
    date_str: str | None = None,
) -> bytes:
    """Return a copy of the .docx file with user's personal fields and date populated."""
    raw_bytes = docx_source.read_bytes() if isinstance(docx_source, Path) else docx_source
    if not user:
        return raw_bytes

    fields = extract_user_fields(user, date_str=date_str)
    if not fields.get("full_name") and not fields.get("personal_id") and not fields.get("email"):
        return raw_bytes

    try:
        in_mem = io.BytesIO(raw_bytes)
        out_mem = io.BytesIO()
        with zipfile.ZipFile(in_mem, "r") as zin:
            if "word/document.xml" not in zin.namelist():
                return raw_bytes
            xml_bytes = zin.read("word/document.xml")
            root = ET.fromstring(xml_bytes)

            w_p = f"{{{W_NS}}}p"
            w_t = f"{{{W_NS}}}t"

            for p in root.iter(w_p):
                t_nodes = list(p.iter(w_t))
                if not t_nodes:
                    continue
                full_text = "".join(t.text or "" for t in t_nodes)
                if "___" not in full_text:
                    continue

                new_text = full_text
                replaced = False
                for key, pattern in _DOCX_FIELD_PATTERNS:
                    val = fields.get(key, "")
                    if not val:
                        continue
                    updated, count = pattern.subn(lambda m, v=val: f"{m.group(1)}{v}", new_text)
                    if count > 0:
                        new_text = updated
                        replaced = True

                if replaced and new_text != full_text:
                    t_nodes[0].text = new_text
                    t_nodes[0].set(XML_SPACE, "preserve")
                    for extra_t in t_nodes[1:]:
                        extra_t.text = ""

            updated_xml = ET.tostring(root, encoding="utf-8", xml_declaration=True)

            with zipfile.ZipFile(out_mem, "w", compression=zipfile.ZIP_DEFLATED) as zout:
                for item in zin.infolist():
                    if item.filename == "word/document.xml":
                        zout.writestr(item, updated_xml)
                    else:
                        zout.writestr(item, zin.read(item.filename))

        return out_mem.getvalue()
    except Exception:
        return raw_bytes


def _inline_md_to_html(text: str) -> str:
    escaped = html.escape(text)
    escaped = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", escaped)
    escaped = re.sub(r"(?<!\*)\*([^*]+?)\*(?!\*)", r"<em>\1</em>", escaped)
    escaped = re.sub(r"`([^`]+?)`", r"<strong>\1</strong>", escaped)
    return escaped


_META_LINE_RE = re.compile(r"^\*\*(დოკუმენტის კოდი|ვერსია|თარიღი|კონფიდენციალურობა):\*\*\s*(.+)$")


def markdown_to_html(md_text: str) -> str:
    """Convert contract Markdown (.md) into clean semantic HTML matching the Word layout."""
    lines = (md_text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    out: list[str] = []
    i = 0
    n = len(lines)
    seen_h1 = False

    while i < n:
        raw_line = lines[i]
        stripped = raw_line.strip()

        if not stripped:
            i += 1
            continue

        if stripped == "---":
            i += 1
            continue

        # Metadata block (**დოკუმენტის კოდი:** ...)
        meta_match = _META_LINE_RE.match(stripped)
        if meta_match:
            meta_rows: list[tuple[str, str]] = []
            while i < n:
                m = _META_LINE_RE.match(lines[i].strip())
                if not m:
                    break
                meta_rows.append((m.group(1).strip(), m.group(2).strip()))
                i += 1
            out.append('<table>')
            for label, val in meta_rows:
                out.append(
                    f"<tr><th>{_inline_md_to_html(label)}</th>"
                    f"<td>{_inline_md_to_html(val)}</td></tr>"
                )
            out.append("</table>")
            continue

        # Headings
        if stripped.startswith("# "):
            seen_h1 = True
            out.append(
                f'<h1 style="text-align:center;">{_inline_md_to_html(stripped[2:].strip())}</h1>'
            )
            i += 1
            continue

        if stripped.startswith("## "):
            heading_text = stripped[3:].strip()
            # Subtitle right after H1 (before metadata table)
            if seen_h1 and len(out) == 1:
                out.append(
                    f'<h2 style="text-align:center;">{_inline_md_to_html(heading_text)}</h2>'
                )
            else:
                out.append(f"<h2>{_inline_md_to_html(heading_text)}</h2>")
            i += 1
            continue

        if stripped.startswith("### "):
            out.append(f"<h3>{_inline_md_to_html(stripped[4:].strip())}</h3>")
            i += 1
            continue

        # Consecutive "- " items -> Georgian lettered items (ა), ბ), გ)...) matching Word
        if stripped.startswith("- "):
            bullet_idx = 0
            while i < n and lines[i].strip().startswith("- "):
                item_text = lines[i].strip()[2:].strip()
                letter = GEORGIAN_LETTERS[bullet_idx] if bullet_idx < len(GEORGIAN_LETTERS) else "•"
                out.append(f"<p>{letter}) {_inline_md_to_html(item_text)}</p>")
                bullet_idx += 1
                i += 1
            continue

        # Markdown Table
        if stripped.startswith("|") and stripped.endswith("|"):
            table_rows: list[list[str]] = []
            while i < n and lines[i].strip().startswith("|") and lines[i].strip().endswith("|"):
                row_str = lines[i].strip()[1:-1]
                cells = [c.strip() for c in row_str.split("|")]
                if not all(re.fullmatch(r"[:\-]+", c or "-") for c in cells):
                    table_rows.append(cells)
                i += 1
            if table_rows:
                out.append("<table>")
                for r_idx, row in enumerate(table_rows):
                    tag = "th" if r_idx == 0 else "td"
                    cells_html = "".join(f"<{tag}>{_inline_md_to_html(c)}</{tag}>" for c in row)
                    out.append(f"<tr>{cells_html}</tr>")
                out.append("</table>")
            continue

        out.append(f"<p>{_inline_md_to_html(stripped)}</p>")
        i += 1

    return "\n".join(out)


# ----------------- Markdown -> OpenXML (.docx) builder -----------------

_INLINE_TOKEN_RE = re.compile(r"(\*\*.+?\*\*|`[^`]+?`|(?<!\*)\*[^*]+?\*(?!\*))")


def _w_el(tag: str, attrib: dict[str, str] | None = None) -> ET.Element:
    el = ET.Element(f"{{{W_NS}}}{tag}")
    if attrib:
        for k, v in attrib.items():
            if k.startswith("{"):
                el.set(k, v)
            else:
                el.set(f"{{{W_NS}}}{k}", v)
    return el


def _append_run(p: ET.Element, text: str, *, bold: bool = False, italic: bool = False, sz: str = "21") -> None:
    if not text:
        return
    r = _w_el("r")
    rPr = _w_el("rPr")
    rPr.append(_w_el("rFonts", {"ascii": "Sylfaen", "hAnsi": "Sylfaen", "cs": "Sylfaen", "eastAsia": "Sylfaen"}))
    if bold:
        rPr.append(_w_el("b"))
    else:
        rPr.append(_w_el("b", {"val": "0"}))
    if italic:
        rPr.append(_w_el("i"))
    else:
        rPr.append(_w_el("i", {"val": "0"}))
    rPr.append(_w_el("color", {"val": "000000"}))
    rPr.append(_w_el("sz", {"val": sz}))
    r.append(rPr)
    t = _w_el("t")
    if text.startswith(" ") or text.endswith(" ") or "  " in text:
        t.set(XML_SPACE, "preserve")
    t.text = text
    r.append(t)
    p.append(r)


def _append_inline_runs(p: ET.Element, md_inline: str, *, default_bold: bool = False, sz: str = "21") -> None:
    # Keep non-breaking space before blank underscore lines like Word template
    normalized = re.sub(r":\s+(_{3,})", ":\u00a0\\1", md_inline)
    parts = _INLINE_TOKEN_RE.split(normalized)
    for part in parts:
        if not part:
            continue
        if part.startswith("**") and part.endswith("**") and len(part) > 4:
            _append_run(p, part[2:-2], bold=True, italic=False, sz=sz)
        elif part.startswith("`") and part.endswith("`") and len(part) > 2:
            _append_run(p, part[1:-1], bold=True, italic=False, sz=sz)
        elif part.startswith("*") and part.endswith("*") and len(part) > 2:
            _append_run(p, part[1:-1], bold=default_bold, italic=True, sz=sz)
        else:
            _append_run(p, part, bold=default_bold, italic=False, sz=sz)


def _make_paragraph(
    md_inline: str,
    *,
    jc: str = "both",
    sz: str = "21",
    bold: bool = False,
    before: str = "0",
    after: str = "60",
    line: str | None = "276",
    keep_next: bool = False,
    bottom_border: bool = False,
    hanging_indent: bool = False,
) -> ET.Element:
    p = _w_el("p")
    pPr = _w_el("pPr")
    if keep_next:
        pPr.append(_w_el("keepNext"))
    spacing_attrs = {"before": before, "after": after}
    if line:
        spacing_attrs["line"] = line
        spacing_attrs["lineRule"] = "auto"
    pPr.append(_w_el("spacing", spacing_attrs))
    if hanging_indent:
        pPr.append(_w_el("ind", {"left": "312", "hanging": "312"}))
    pPr.append(_w_el("jc", {"val": jc}))
    if bottom_border:
        pBdr = _w_el("pBdr")
        pBdr.append(_w_el("bottom", {"val": "single", "sz": "4", "space": "2", "color": "000000"}))
        pPr.append(pBdr)
    p.append(pPr)
    if md_inline:
        _append_inline_runs(p, md_inline, default_bold=bold, sz=sz)
    return p


def _make_table(rows: list[list[str]], col_widths: list[int], *, is_meta_table: bool = False) -> ET.Element:
    tbl = _w_el("tbl")
    tblPr = _w_el("tblPr")
    tblPr.append(
        _w_el(
            "tblLook",
            {
                "firstColumn": "1",
                "firstRow": "1",
                "lastColumn": "0",
                "lastRow": "0",
                "noHBand": "0",
                "noVBand": "1",
                "val": "04A0",
            },
        )
    )
    tblPr.append(_w_el("tblW", {"w": str(sum(col_widths)), "type": "dxa"}))
    tblPr.append(_w_el("jc", {"val": "center"}))
    tblPr.append(_w_el("tblLayout", {"type": "fixed"}))
    borders = _w_el("tblBorders")
    for side in ("top", "left", "bottom", "right", "insideH", "insideV"):
        borders.append(_w_el(side, {"val": "single", "sz": "4", "space": "0", "color": "000000"}))
    tblPr.append(borders)
    cell_mar = _w_el("tblCellMar")
    for side, w_val in (("top", "55"), ("left", "90"), ("bottom", "55"), ("right", "90")):
        cell_mar.append(_w_el(side, {"w": w_val, "type": "dxa"}))
    tblPr.append(cell_mar)
    tbl.append(tblPr)

    grid = _w_el("tblGrid")
    for w_val in col_widths:
        grid.append(_w_el("gridCol", {"w": str(w_val)}))
    tbl.append(grid)

    for r_idx, row in enumerate(rows):
        tr = _w_el("tr")
        trPr = _w_el("trPr")
        trPr.append(_w_el("cantSplit"))
        if not is_meta_table and r_idx == 0:
            trPr.append(_w_el("tblHeader"))
        tr.append(trPr)

        for c_idx, cell_text in enumerate(row):
            width = col_widths[c_idx] if c_idx < len(col_widths) else col_widths[-1]
            tc = _w_el("tc")
            tcPr = _w_el("tcPr")
            tcPr.append(_w_el("tcW", {"type": "dxa", "w": str(width)}))
            shade = (is_meta_table and c_idx == 0) or (not is_meta_table and r_idx == 0)
            if shade:
                tcPr.append(_w_el("shd", {"val": "clear", "color": "auto", "fill": "F2F2F2"}))
            tcPr.append(_w_el("vAlign", {"val": "center"}))
            tc.append(tcPr)

            cell_bold = shade
            p = _make_paragraph(
                cell_text,
                jc="left",
                sz="20",
                bold=cell_bold,
                before="20",
                after="20",
                line="264",
            )
            tc.append(p)
            tr.append(tc)

        tbl.append(tr)

    return tbl


def build_docx_elements_from_md(md_text: str) -> list[ET.Element]:
    """Build OpenXML body elements (<w:p>, <w:tbl>) from contract Markdown."""
    lines = (md_text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    elements: list[ET.Element] = []
    i = 0
    n = len(lines)
    seen_h1 = False
    in_signature_section = False

    while i < n:
        stripped = lines[i].strip()
        if not stripped:
            i += 1
            continue

        if stripped == "---":
            # In signature section, --- between candidate and institute is a horizontal rule
            if in_signature_section:
                p = _w_el("p")
                pPr = _w_el("pPr")
                pPr.append(_w_el("keepNext"))
                pPr.append(_w_el("spacing", {"before": "120", "after": "120"}))
                pBdr = _w_el("pBdr")
                pBdr.append(_w_el("bottom", {"val": "single", "sz": "4", "space": "1", "color": "000000"}))
                pPr.append(pBdr)
                p.append(pPr)
                elements.append(p)
            i += 1
            continue

        # Metadata table (**დოკუმენტის კოდი:** ...)
        meta_match = _META_LINE_RE.match(stripped)
        if meta_match:
            meta_rows: list[list[str]] = []
            while i < n:
                m = _META_LINE_RE.match(lines[i].strip())
                if not m:
                    break
                meta_rows.append([m.group(1).strip(), m.group(2).strip()])
                i += 1
            elements.append(_make_table(meta_rows, [2698, 6941], is_meta_table=True))
            spacer = _make_paragraph("", jc="left", sz="4", before="0", after="80", line=None)
            elements.append(spacer)
            continue

        if stripped.startswith("# "):
            seen_h1 = True
            elements.append(
                _make_paragraph(
                    stripped[2:].strip(),
                    jc="center",
                    sz="28",
                    bold=True,
                    before="0",
                    after="60",
                    line=None,
                    keep_next=True,
                )
            )
            i += 1
            continue

        if stripped.startswith("## "):
            heading_text = stripped[3:].strip()
            if seen_h1 and len(elements) == 1:
                elements.append(
                    _make_paragraph(
                        heading_text,
                        jc="center",
                        sz="23",
                        bold=True,
                        before="0",
                        after="160",
                        line=None,
                        keep_next=True,
                    )
                )
            else:
                if "ხელმოწერები" in heading_text:
                    in_signature_section = True
                elements.append(
                    _make_paragraph(
                        heading_text,
                        jc="left",
                        sz="24",
                        bold=True,
                        before="240",
                        after="80",
                        line=None,
                        keep_next=True,
                        bottom_border=True,
                    )
                )
            i += 1
            continue

        if stripped.startswith("### "):
            elements.append(
                _make_paragraph(
                    stripped[4:].strip(),
                    jc="left",
                    sz="22",
                    bold=True,
                    before="160",
                    after="60",
                    line=None,
                    keep_next=True,
                )
            )
            i += 1
            continue

        if stripped.startswith("- "):
            bullet_idx = 0
            while i < n and lines[i].strip().startswith("- "):
                item_text = lines[i].strip()[2:].strip()
                letter = GEORGIAN_LETTERS[bullet_idx] if bullet_idx < len(GEORGIAN_LETTERS) else "•"
                elements.append(
                    _make_paragraph(
                        f"{letter}) {item_text}",
                        jc="both",
                        sz="21",
                        bold=False,
                        before="0",
                        after="50",
                        line="276",
                        hanging_indent=True,
                    )
                )
                bullet_idx += 1
                i += 1
            continue

        if stripped.startswith("|") and stripped.endswith("|"):
            table_rows: list[list[str]] = []
            while i < n and lines[i].strip().startswith("|") and lines[i].strip().endswith("|"):
                row_str = lines[i].strip()[1:-1]
                cells = [c.strip() for c in row_str.split("|")]
                if not all(re.fullmatch(r"[:\-]+", c or "-") for c in cells):
                    table_rows.append(cells)
                i += 1
            if table_rows:
                num_cols = max(len(r) for r in table_rows)
                total_w = 9639
                if num_cols == 3:
                    widths = [2266, 4901, 2472]
                elif num_cols == 2:
                    widths = [3500, 6139]
                else:
                    w_each = total_w // max(num_cols, 1)
                    widths = [w_each] * num_cols
                elements.append(_make_table(table_rows, widths, is_meta_table=False))
            continue

        jc_val = "left" if "___" in stripped else "both"
        elements.append(
            _make_paragraph(
                stripped,
                jc=jc_val,
                sz="21",
                bold=False,
                before="0",
                after="60",
                line="276",
            )
        )
        i += 1

    return elements


def _minimal_docx_From_elements(elements: list[ET.Element]) -> bytes:
    """Create a standalone valid .docx zip archive when no template .docx is provided."""
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        "</Types>"
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="word/document.xml"/>'
        "</Relationships>"
    )
    doc = _w_el("document")
    body = _w_el("body")
    for el in elements:
        body.append(el)
    sectPr = _w_el("sectPr")
    sectPr.append(_w_el("pgSz", {"w": "11906", "h": "16838"}))
    sectPr.append(
        _w_el(
            "pgMar",
            {
                "top": "1134",
                "right": "1020",
                "bottom": "1134",
                "left": "1247",
                "header": "720",
                "footer": "720",
                "gutter": "0",
            },
        )
    )
    body.append(sectPr)
    doc.append(body)
    doc_xml = ET.tostring(doc, encoding="utf-8", xml_declaration=True)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("word/document.xml", doc_xml)
    return buf.getvalue()


def markdown_to_docx_bytes(md_text: str, template_docx: Path | bytes | None = None) -> bytes:
    """Convert contract Markdown (.md) into a styled Word (.docx) binary."""
    elements = build_docx_elements_from_md(md_text)
    if template_docx is not None:
        try:
            raw_tpl = template_docx.read_bytes() if isinstance(template_docx, Path) else template_docx
            in_mem = io.BytesIO(raw_tpl)
            out_mem = io.BytesIO()
            with zipfile.ZipFile(in_mem, "r") as zin:
                root = ET.fromstring(zin.read("word/document.xml"))
                body = root.find(f"{{{W_NS}}}body")
                if body is not None:
                    sect_pr = body.find(f"{{{W_NS}}}sectPr")
                    body.clear()
                    for el in elements:
                        body.append(el)
                    if sect_pr is not None:
                        body.append(sect_pr)
                    updated_xml = ET.tostring(root, encoding="utf-8", xml_declaration=True)
                    with zipfile.ZipFile(out_mem, "w", compression=zipfile.ZIP_DEFLATED) as zout:
                        for item in zin.infolist():
                            if item.filename == "word/document.xml":
                                zout.writestr(item, updated_xml)
                            else:
                                zout.writestr(item, zin.read(item.filename))
                    return out_mem.getvalue()
        except Exception:
            pass
    return _minimal_docx_From_elements(elements)


def docx_bytes_to_html(docx_bytes: bytes) -> str:
    """Fallback converter from .docx bytes to clean HTML when frontend HTML is not provided."""
    try:
        with zipfile.ZipFile(io.BytesIO(docx_bytes), "r") as z:
            root = ET.fromstring(z.read("word/document.xml"))
        body = root.find(f"{{{W_NS}}}body")
        if body is None:
            return ""
        out: list[str] = []
        for child in body:
            tag = child.tag.split("}")[-1]
            if tag == "p":
                text = "".join(child.itertext()).strip()
                if not text:
                    continue
                out.append(f"<p>{html.escape(text)}</p>")
            elif tag == "tbl":
                out.append("<table>")
                for r_idx, tr in enumerate(child.findall(f".//{{{W_NS}}}tr")):
                    cells = []
                    cell_tag = "th" if r_idx == 0 else "td"
                    for tc in tr.findall(f"./{{{W_NS}}}tc"):
                        c_text = " ".join(
                            "".join(p.itertext()).strip()
                            for p in tc.findall(f".//{{{W_NS}}}p")
                            if "".join(p.itertext()).strip()
                        )
                        cells.append(f"<{cell_tag}>{html.escape(c_text)}</{cell_tag}>")
                    if cells:
                        out.append(f"<tr>{''.join(cells)}</tr>")
                out.append("</table>")
        return "\n".join(out)
    except Exception:
        return ""
