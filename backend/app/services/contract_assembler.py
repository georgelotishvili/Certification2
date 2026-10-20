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

PUBLIC_DOCUMENTS: list[dict[str, Any]] = [
    {
        "key": "scheme",
        "code": "GIPC-SCH-001",
        "default_title": "სერტიფიცირების სქემა",
        "order_index": 1,
        "source_md": "01_სერტიფიკაციის_სქემა.md",
        "source_docx": "01_სერტიფიკაციის_სქემა.docx",
        "strip_annex_1": False,
    },
    {
        "key": "impartiality",
        "code": "GIPC-POL-001",
        "default_title": "მიუკერძოებლობის პოლიტიკა",
        "order_index": 2,
        "source_md": "03_მიუკერძოებლობის_პოლიტიკა.md",
        "source_docx": "03_მიუკერძოებლობის_პოლიტიკა.docx",
        "strip_annex_1": True,
    },
    {
        "key": "confidentiality",
        "code": "GIPC-POL-002",
        "default_title": "კონფიდენციალურობისა და პერსონალურ მონაცემთა დაცვის პოლიტიკა",
        "order_index": 3,
        "source_md": "04_კონფიდენციალურობის_პოლიტიკა.md",
        "source_docx": "04_კონფიდენციალურობის_პოლიტიკა.docx",
        "strip_annex_1": False,
    },
    {
        "key": "complaints_appeals",
        "code": "GIPC-PRO-003",
        "default_title": "საჩივრებისა და აპელაციების პროცედურა",
        "order_index": 4,
        "source_md": "07_საჩივრებისა_და_აპელაციების_პროცედურა.md",
        "source_docx": "07_საჩივრებისა_და_აპელაციების_პროცედურა.docx",
        "strip_annex_1": True,
    },
    {
        "key": "application_form",
        "code": "GIPC-FRM-001",
        "default_title": "სერტიფიცირების განაცხადის ფორმა",
        "order_index": 5,
        "source_md": "12_ფორმა_განაცხადი.md",
        "source_docx": "12_ფორმა_განაცხადი.docx",
        "strip_annex_1": False,
    },
]

CONTRACT_SLOTS: dict[str, dict[str, Any]] = {
    "exam": {
        "key": "exam",
        "code": "GIPC-CON-004",
        "short_title": "საგამოცდო ხელშეკრულება",
        "default_title": "საგამოცდო ხელშეკრულება",
        "category": "EXAM",
        "order_index": 6,
        "source_md": "10_საგამოცდო_ხელშეკრულება.md",
        "source_docx": "10_საგამოცდო_ხელშეკრულება.docx",
    },
    "cert_a": {
        "key": "cert_a",
        "code": "GIPC-CON-001",
        "short_title": "სასერტიფიკაციო ხელშეკრულება — კატეგორია A (არქიტექტორი)",
        "default_title": "სერტიფიცირების ხელშეკრულება — კატეგორია A: შენობა-ნაგებობის არქიტექტორი",
        "category": "A",
        "order_index": 7,
        "source_md": "08_სასერტიფიკაციო_ხელშეკრულება_არქიტექტორი.md",
        "source_docx": "08_სასერტიფიკაციო_ხელშეკრულება_არქიტექტორი.docx",
    },
    "cert_b": {
        "key": "cert_b",
        "code": "GIPC-CON-002",
        "short_title": "სასერტიფიკაციო ხელშეკრულება — კატეგორია B (სპეციალისტი)",
        "default_title": "სერტიფიცირების ხელშეკრულება — კატეგორია B: არქიტექტურული პროექტის შემსწავლელი სპეციალისტი",
        "category": "B",
        "order_index": 8,
        "source_md": "09a_სასერტიფიკაციო_ხელშეკრულება_სპეციალისტი.md",
        "source_docx": "09a_სასერტიფიკაციო_ხელშეკრულება_სპეციალისტი.docx",
    },
    "cert_c": {
        "key": "cert_c",
        "code": "GIPC-CON-003",
        "short_title": "სასერტიფიკაციო ხელშეკრულება — კატეგორია C (ექსპერტი)",
        "default_title": "სერტიფიცირების ხელშეკრულება — კატეგორია C: არქიტექტურული პროექტის ექსპერტი",
        "category": "C",
        "order_index": 9,
        "source_md": "09_სასერტიფიკაციო_ხელშეკრულება_ექსპერტი.md",
        "source_docx": "09_სასერტიფიკაციო_ხელშეკრულება_ექსპერტი.docx",
    },
}

_INTERNAL_ANNEX_RE = re.compile(
    r"(?:\n---\s*)?\n##\s+დანართი\s*№\s*1\b.*$",
    re.DOTALL,
)


def strip_internal_annexes(md_text: str, force: bool = False) -> str:
    """Strip internal Annex 1 (დანართი №1) from public documents (GIPC-POL-001, GIPC-PRO-003)."""
    if not md_text:
        return ""
    normalized = md_text.replace("\r\n", "\n").replace("\r", "\n")
    if (
        force
        or "GIPC-POL-001" in normalized
        or "GIPC-PRO-003" in normalized
        or "ვებგვერდზე არ ქვეყნდება" in normalized
    ):
        cleaned = _INTERNAL_ANNEX_RE.sub("", normalized)
        cleaned = re.sub(r"\s*\(დანართი\s*№\s*1\s*[—–-]\s*შიდა\s+მოხმარების\)", "", cleaned)
        return cleaned.rstrip() + "\n"
    return normalized


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
        code = str(user.get("code") or "").strip()
    else:
        first = str(getattr(user, "first_name", "") or "").strip()
        last = str(getattr(user, "last_name", "") or "").strip()
        personal_id = str(getattr(user, "personal_id", "") or "").strip()
        phone = str(getattr(user, "phone", "") or "").strip()
        email = str(getattr(user, "email", "") or "").strip()
        code = str(getattr(user, "code", "") or "").strip()

    full_name = f"{first} {last}".strip()
    return {
        "full_name": full_name,
        "personal_id": personal_id,
        "phone": phone,
        "email": email,
        "code": code,
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
    """Replace blank underscore lines or bracket placeholders in contract/form HTML with the user's data and date."""
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

    bracket_replacements = [
        (r"\[სახელი,\s*გვარი\]", fields.get("full_name", "")),
        (r"\[სახელი\s+გვარი\]", fields.get("full_name", "")),
        (r"\[პირადი\s*ნომერი\]", fields.get("personal_id", "")),
        (r"\[ტელეფონის\s*ნომერი\]", fields.get("phone", "")),
        (r"\[ტელეფონი\]", fields.get("phone", "")),
        (r"\[ელექტრონული\s*ფოსტა\]", fields.get("email", "")),
        (r"\[ელ\.?\s*ფოსტა\]", fields.get("email", "")),
        (r"\[უნიკალური\s*კოდი\]", fields.get("code", "")),
        (r"\[თარიღი\]", fields.get("date", "")),
    ]
    for pat_str, val in bracket_replacements:
        if val:
            safe_val = html.escape(val)
            result = re.sub(pat_str, f"<strong>{safe_val}</strong>", result)

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


_MD_LINK_ESCAPED_RE = re.compile(r"\[([^\]]+)\]\((https?://[^\s)]+)\)")
_MD_LINK_PLAIN_RE = re.compile(r"\[([^\]]+)\]\((https?://[^\s)]+)\)")


def _inline_md_to_html(text: str) -> str:
    placeholder = "\u0000AST\u0000"
    prepared = re.sub(r"[🟢🟡🔴]\s*", "", (text or "")).replace(r"\*", placeholder)
    escaped = html.escape(prepared)
    escaped = re.sub(r"&lt;br\s*/?&gt;", "<br>", escaped, flags=re.IGNORECASE)
    escaped = _MD_LINK_ESCAPED_RE.sub(
        r'<a href="\2" target="_blank" rel="noopener noreferrer">\1</a>',
        escaped,
    )
    escaped = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", escaped)
    escaped = re.sub(r"(?<!\*)\*([^*]+?)\*(?!\*)", r"<em>\1</em>", escaped)
    escaped = re.sub(r"`([^`]+?)`", r"<strong>\1</strong>", escaped)
    escaped = escaped.replace(placeholder, "*")
    return escaped


_META_LINE_RE = re.compile(
    r"^\*\*(დოკუმენტის კოდი|ფორმის კოდი|ვერსია|თარიღი|კონფიდენციალურობა|სქემის მფლობელი|სერტიფიცირების ორგანო|საიდენტიფიკაციო კოდი|იურიდიული მისამართი|ფაქტობრივი \(საოფისე და საგამოცდო\) მისამართი|ვებგვერდი):\*\*\s*(.+)$"
)
_MD_UL_ITEM_RE = re.compile(r"^[-*•–—]\s+(.+)$")
_MD_OL_ITEM_RE = re.compile(r"^\d+\.\s+(.+)$")


def markdown_to_html(md_text: str) -> str:
    """Convert official document or contract Markdown (.md) into clean semantic HTML matching the Word layout."""
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
            out.append("<table>")
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

        if (
            seen_h1
            and len(out) == 1
            and stripped.startswith("**")
            and stripped.endswith("**")
            and ":" not in stripped
        ):
            subtitle_text = stripped.strip("*").strip()
            out.append(f'<h2 style="text-align:center;">{_inline_md_to_html(subtitle_text)}</h2>')
            i += 1
            continue

        if stripped.startswith("## "):
            heading_text = stripped[3:].strip()
            # Subtitle right after H1 (before metadata table in official documents)
            is_doc_subtitle = (
                seen_h1
                and len(out) == 1
                and not re.match(r"^(?:\d+\.|[IVX]+\.)\s", heading_text)
                and any(
                    kw in heading_text
                    for kw in ("შპს", "ინსტიტუტი", "არქიტექტორთა სერტიფიცირება", "კატეგორია")
                )
            )
            if is_doc_subtitle:
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

        if stripped.startswith("#### "):
            out.append(f"<h4>{_inline_md_to_html(stripped[5:].strip())}</h4>")
            i += 1
            continue

        # Consecutive bullet items ("- " or "* ") -> semantic <ul><li> list
        ul_match = _MD_UL_ITEM_RE.match(stripped)
        if ul_match:
            out.append("<ul>")
            while i < n:
                cur_s = lines[i].strip()
                m_ul = _MD_UL_ITEM_RE.match(cur_s)
                m_ol_sub = _MD_OL_ITEM_RE.match(cur_s) if lines[i].startswith(("  ", "\t")) else None
                if m_ul:
                    out.append(f"<li>{_inline_md_to_html(m_ul.group(1).strip())}</li>")
                    i += 1
                elif m_ol_sub:
                    out.append(f"<li>{_inline_md_to_html(m_ol_sub.group(1).strip())}</li>")
                    i += 1
                elif lines[i].startswith(("  ", "\t")) and cur_s and not cur_s.startswith(("#", "|", "---")):
                    out[-1] = out[-1][:-5] + f"<br>{_inline_md_to_html(cur_s)}</li>"
                    i += 1
                else:
                    break
            out.append("</ul>")
            continue

        # Consecutive numbered items ("1. ", "2. ") -> semantic <ol><li> list
        ol_match = _MD_OL_ITEM_RE.match(stripped)
        if ol_match:
            out.append("<ol>")
            while i < n:
                cur_s = lines[i].strip()
                m_ol = _MD_OL_ITEM_RE.match(cur_s)
                if m_ol:
                    out.append(f"<li>{_inline_md_to_html(m_ol.group(1).strip())}</li>")
                    i += 1
                elif lines[i].startswith(("  ", "\t")) and cur_s and not cur_s.startswith(("#", "|", "---")):
                    out[-1] = out[-1][:-5] + f"<br>{_inline_md_to_html(cur_s)}</li>"
                    i += 1
                else:
                    break
            out.append("</ol>")
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

        if "___" in stripped:
            out.append(f'<p style="text-align:left;">{_inline_md_to_html(stripped)}</p>')
        else:
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
    normalized = _MD_LINK_PLAIN_RE.sub(r"\1", md_inline)
    normalized = re.sub(r":\s+(_{3,})", ":\u00a0\\1", normalized)
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
            cell_bold = (is_meta_table and c_idx == 0) or (not is_meta_table and r_idx == 0)
            tcPr.append(_w_el("vAlign", {"val": "center"}))
            tc.append(tcPr)

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
    """Build OpenXML body elements (<w:p>, <w:tbl>) from document or contract Markdown."""
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

        if stripped.startswith("#### "):
            elements.append(
                _make_paragraph(
                    stripped[5:].strip(),
                    jc="left",
                    sz="21",
                    bold=True,
                    before="120",
                    after="50",
                    line=None,
                    keep_next=True,
                )
            )
            i += 1
            continue

        if stripped.startswith("- "):
            while i < n and lines[i].strip().startswith("- "):
                item_text = lines[i].strip()[2:].strip()
                elements.append(
                    _make_paragraph(
                        f"– {item_text}",
                        jc="both",
                        sz="21",
                        bold=False,
                        before="0",
                        after="50",
                        line="276",
                        hanging_indent=False,
                    )
                )
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
                first_col_header = (table_rows[0][0] if table_rows[0] else "").strip()
                if num_cols == 4:
                    if first_col_header == "№":
                        widths = [480, 2645, 3273, 3241]
                    else:
                        widths = [2342, 2438, 2438, 2421]
                elif num_cols == 3:
                    if first_col_header == "ბლოკი":
                        widths = [1303, 5660, 2676]
                    elif first_col_header == "დონე":
                        widths = [1630, 2209, 5800]
                    elif first_col_header == "პარამეტრი":
                        widths = [1397, 3694, 4548]
                    else:
                        widths = [2266, 4901, 2472]
                elif num_cols == 2:
                    widths = [3100, 6539]
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


def _sanitize_docx_styles_xml(xml_bytes: bytes) -> bytes:
    try:
        text = xml_bytes.decode("utf-8")
        text = re.sub(r'\s+w:theme(?:Color|Shade|Tint|Fill|FillShade|FillTint)="[^"]*"', "", text)
        text = re.sub(r'w:color\s+w:val="(?!FFFFFF"[,\s/>])[^"]*"', 'w:color w:val="000000"', text)
        text = re.sub(r'w:color="(?!FFFFFF"|auto")[^"]*"', 'w:color="000000"', text)
        text = re.sub(r'w:fill="(?!FFFFFF"|auto")[^"]*"', 'w:fill="FFFFFF"', text)
        return text.encode("utf-8")
    except Exception:
        return xml_bytes


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
                            elif item.filename in ("word/styles.xml", "word/stylesWithEffects.xml"):
                                zout.writestr(item, _sanitize_docx_styles_xml(zin.read(item.filename)))
                            else:
                                zout.writestr(item, zin.read(item.filename))
                    return out_mem.getvalue()
        except Exception:
            pass
    return _minimal_docx_From_elements(elements)


_SECTION_H2_RE = re.compile(
    r"^(?:(?:ნაწილი|თავი|ეტაპი|ნაბიჯი|მუხლი|კატეგორია|დანართი)\s*[№#]?\s*[0-9IVX]+|[IVX]+\.|[0-9]{1,2}\.)\s+.+$",
    re.IGNORECASE,
)
_SECTION_H3_RE = re.compile(r"^[0-9]{1,2}\.[0-9]{1,2}(?:\.[0-9]{1,2})?\.?\s+.+$")
_BULLET_LINE_RE = re.compile(r"^(?:[-•*–—]|\([ა-ჰ0-9]+\)|[ა-ჰ]\))\s+(.+)$")
_LABEL_PREFIX_RE = re.compile(
    r"^((?:შენიშვნა|მნიშვნელოვანია|ყურადღება|გაითვალისწინეთ|სავალდებულოა|რეკომენდაცია|მაგალითი)\s*:)\s*(.+)$",
    re.IGNORECASE,
)


def _format_inline_with_labels(text: str) -> str:
    m = _LABEL_PREFIX_RE.match(text)
    if m:
        return f"<strong>{_inline_md_to_html(m.group(1))}</strong> {_inline_md_to_html(m.group(2))}"
    return _inline_md_to_html(text)


def structured_text_to_html(raw_text: str) -> str:
    """Convert plain text or Markdown into a symmetric, well-structured HTML document."""
    if not raw_text or not raw_text.strip():
        return ""
    trimmed = raw_text.strip()
    if re.search(r"<(?:h1|h2|h3|p|ul|ol|table|div|article)\b", trimmed, re.IGNORECASE):
        return trimmed

    # If the text already uses standard Markdown headings (# or ##), use markdown_to_html
    if re.search(r"(?m)^#{1,4}\s+\S", trimmed):
        return markdown_to_html(trimmed)

    lines = trimmed.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    out: list[str] = []
    i = 0
    n = len(lines)
    seen_h1 = False

    while i < n:
        stripped = lines[i].strip()
        if not stripped or stripped == "---":
            i += 1
            continue

        # Markdown table support
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

        # Bullet list items
        b_match = _BULLET_LINE_RE.match(stripped)
        if b_match:
            out.append("<ul>")
            while i < n:
                bm = _BULLET_LINE_RE.match(lines[i].strip())
                if not bm:
                    break
                out.append(f"<li>{_format_inline_with_labels(bm.group(1).strip())}</li>")
                i += 1
            out.append("</ul>")
            continue

        # First short non-sentence line becomes centered H1 title
        if not seen_h1 and len(out) == 0 and len(stripped) <= 115 and not stripped.endswith((".", ";", ",")):
            seen_h1 = True
            clean_t = stripped.strip("*").strip()
            out.append(f'<h1 style="text-align:center;">{_inline_md_to_html(clean_t)}</h1>')
            i += 1
            continue

        # Sub-numbered heading (1.1, 1.2, etc.) -> H3 if relatively short
        if _SECTION_H3_RE.match(stripped) and len(stripped) <= 120 and not stripped.endswith((".", ";", ",")):
            clean_h3 = stripped.strip("*").strip()
            out.append(f"<h3>{_inline_md_to_html(clean_h3)}</h3>")
            i += 1
            continue

        # Major numbered/titled section -> H2 if relatively short and not a long sentence
        if _SECTION_H2_RE.match(stripped) and len(stripped) <= 110 and not stripped.endswith((";", ",")):
            clean_h2 = stripped.strip("*").strip()
            out.append(f"<h2>{_inline_md_to_html(clean_h2)}</h2>")
            i += 1
            continue

        # Standalone bold or short heading line surrounded by blank lines
        prev_blank = (i == 0) or (not lines[i - 1].strip())
        next_blank = (i + 1 >= n) or (not lines[i + 1].strip())
        is_wrapped_bold = stripped.startswith("**") and stripped.endswith("**") and len(stripped) > 4
        if (
            (is_wrapped_bold or (prev_blank and next_blank and len(stripped) <= 85 and not stripped.endswith((".", ";", ","))))
            and len(stripped) <= 105
        ):
            clean_h = stripped.strip("*").strip()
            if not seen_h1 and len(out) == 0:
                seen_h1 = True
                out.append(f'<h1 style="text-align:center;">{_inline_md_to_html(clean_h)}</h1>')
            else:
                out.append(f"<h2>{_inline_md_to_html(clean_h)}</h2>")
            i += 1
            continue

        out.append(f"<p>{_format_inline_with_labels(stripped)}</p>")
        i += 1

    return "\n".join(out)


def _docx_runs_to_html(p_el: ET.Element, strip_bullet_prefix: bool = False) -> str:
    """Extract inline HTML from a <w:p> element preserving run-level bold and italic."""
    segments: list[tuple[str, bool, bool]] = []
    for r in p_el.findall(f".//{{{W_NS}}}r"):
        r_text = "".join(r.itertext())
        if not r_text:
            continue
        r_pr = r.find(f"./{{{W_NS}}}rPr")
        is_b = False
        is_i = False
        if r_pr is not None:
            b_el = r_pr.find(f"./{{{W_NS}}}b")
            if b_el is not None and (b_el.get(f"{{{W_NS}}}val") or "1") not in ("0", "false"):
                is_b = True
            i_el = r_pr.find(f"./{{{W_NS}}}i")
            if i_el is not None and (i_el.get(f"{{{W_NS}}}val") or "1") not in ("0", "false"):
                is_i = True
        if segments and segments[-1][1] == is_b and segments[-1][2] == is_i:
            segments[-1] = (segments[-1][0] + r_text, is_b, is_i)
        else:
            segments.append((r_text, is_b, is_i))

    if not segments:
        raw = "".join(p_el.itertext()).strip()
        return _format_inline_with_labels(raw) if raw else ""

    if strip_bullet_prefix:
        first_txt, first_b, first_i = segments[0]
        m = _BULLET_LINE_RE.match(first_txt.lstrip())
        if m:
            rem = m.group(1)
            if rem:
                segments[0] = (rem, first_b, first_i)
            else:
                segments.pop(0)
        else:
            # Handle case where bullet symbol is in first segment and space/rest in next
            full_joined = "".join(s[0] for s in segments).lstrip()
            m_full = _BULLET_LINE_RE.match(full_joined)
            if m_full:
                prefix_len = len(full_joined) - len(m_full.group(1))
                # Strip prefix_len chars from start of segments
                to_strip = len("".join(s[0] for s in segments)) - len(full_joined) + prefix_len
                while segments and to_strip > 0:
                    s_txt, s_b, s_i = segments[0]
                    if len(s_txt) <= to_strip:
                        to_strip -= len(s_txt)
                        segments.pop(0)
                    else:
                        segments[0] = (s_txt[to_strip:], s_b, s_i)
                        to_strip = 0

    # Clean stray markdown escape artifacts from converted docx (e.g. leading '\' before 'შენიშვნა:' and trailing '.*')
    if segments:
        s0_txt, s0_b, s0_i = segments[0]
        if s0_txt.startswith("\\"):
            s0_txt = s0_txt.lstrip("\\")
            if s0_txt:
                segments[0] = (s0_txt, s0_b, s0_i)
            else:
                segments.pop(0)
    if segments:
        sl_txt, sl_b, sl_i = segments[-1]
        if sl_txt.endswith(").*"):
            segments[-1] = (sl_txt[:-1], sl_b, sl_i)

    has_any_formatting = any(b or i for _, b, i in segments)
    if not has_any_formatting:
        plain = "".join(t for t, _, _ in segments).strip()
        return _format_inline_with_labels(plain)

    parts: list[str] = []
    for seg_txt, is_b, is_i in segments:
        esc = _inline_md_to_html(seg_txt)
        if is_b and is_i:
            parts.append(f"<strong><em>{esc}</em></strong>")
        elif is_b:
            parts.append(f"<strong>{esc}</strong>")
        elif is_i:
            parts.append(f"<em>{esc}</em>")
        else:
            parts.append(esc)
    return "".join(parts).strip()


def docx_bytes_to_html(docx_bytes: bytes) -> str:
    """Convert .docx bytes into clean, structured HTML preserving headings, lists, and tables."""
    try:
        with zipfile.ZipFile(io.BytesIO(docx_bytes), "r") as z:
            root = ET.fromstring(z.read("word/document.xml"))
        body = root.find(f"{{{W_NS}}}body")
        if body is None:
            return ""
        out: list[str] = []
        seen_h1 = False
        in_ul = False

        def close_ul() -> None:
            nonlocal in_ul
            if in_ul:
                out.append("</ul>")
                in_ul = False

        for child in body:
            tag = child.tag.split("}")[-1]
            if tag == "p":
                text = "".join(child.itertext()).strip()
                if not text:
                    continue

                p_pr = child.find(f"./{{{W_NS}}}pPr")
                style_val = ""
                jc_val = ""
                has_num_pr = False
                has_bottom_bdr = False
                if p_pr is not None:
                    p_style = p_pr.find(f"./{{{W_NS}}}pStyle")
                    if p_style is not None:
                        style_val = (p_style.get(f"{{{W_NS}}}val") or "").lower()
                    jc_el = p_pr.find(f"./{{{W_NS}}}jc")
                    if jc_el is not None:
                        jc_val = (jc_el.get(f"{{{W_NS}}}val") or "").lower()
                    if p_pr.find(f"./{{{W_NS}}}numPr") is not None:
                        has_num_pr = True
                    p_bdr = p_pr.find(f"./{{{W_NS}}}pBdr")
                    if p_bdr is not None and p_bdr.find(f"./{{{W_NS}}}bottom") is not None:
                        has_bottom_bdr = True

                runs = [r for r in child.findall(f".//{{{W_NS}}}r") if "".join(r.itertext()).strip()]
                all_bold = bool(runs) and all(
                    r.find(f"./{{{W_NS}}}rPr/{{{W_NS}}}b") is not None
                    and (r.find(f"./{{{W_NS}}}rPr/{{{W_NS}}}b").get(f"{{{W_NS}}}val") or "1") not in ("0", "false")
                    for r in runs
                )

                b_match = _BULLET_LINE_RE.match(text)
                if has_num_pr or b_match:
                    if not in_ul:
                        out.append("<ul>")
                        in_ul = True
                    out.append(f"<li>{_docx_runs_to_html(child, strip_bullet_prefix=True)}</li>")
                    continue

                close_ul()

                if "heading1" in style_val or "title" in style_val or (
                    not seen_h1 and len(out) == 0 and jc_val == "center" and len(text) <= 120
                ):
                    seen_h1 = True
                    out.append(f'<h1 style="text-align:center;">{html.escape(text)}</h1>')
                elif (
                    "heading2" in style_val
                    or has_bottom_bdr
                    or (all_bold and len(text) <= 115 and not text.endswith((":", ".", ";", ",")))
                ):
                    if seen_h1 and len(out) == 1 and jc_val == "center":
                        out.append(f'<h2 style="text-align:center;">{html.escape(text)}</h2>')
                    else:
                        out.append(f"<h2>{html.escape(text)}</h2>")
                elif "heading3" in style_val or (
                    all_bold and _SECTION_H3_RE.match(text) and len(text) <= 120 and not text.endswith((".", ";", ","))
                ):
                    out.append(f"<h3>{html.escape(text)}</h3>")
                else:
                    out.append(f"<p>{_docx_runs_to_html(child, strip_bullet_prefix=False)}</p>")
            elif tag == "tbl":
                close_ul()
                out.append("<table>")
                for r_idx, tr in enumerate(child.findall(f".//{{{W_NS}}}tr")):
                    cells = []
                    cell_tag = "th" if r_idx == 0 else "td"
                    for tc in tr.findall(f"./{{{W_NS}}}tc"):
                        c_parts = []
                        for p in tc.findall(f".//{{{W_NS}}}p"):
                            if "".join(p.itertext()).strip():
                                c_parts.append(
                                    html.escape("".join(p.itertext()).strip())
                                    if cell_tag == "th"
                                    else _docx_runs_to_html(p, strip_bullet_prefix=False)
                                )
                        cells.append(f"<{cell_tag}>{' '.join(c_parts)}</{cell_tag}>")
                    if cells:
                        out.append(f"<tr>{''.join(cells)}</tr>")
                out.append("</table>")

        close_ul()
        return "\n".join(out)
    except Exception:
        return ""

