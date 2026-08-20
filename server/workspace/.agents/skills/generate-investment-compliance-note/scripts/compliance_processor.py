#!/usr/bin/env python3
"""Prepare evidence, build a template-faithful DOCX, and verify the result."""

from __future__ import annotations

import argparse
import copy
import csv
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Iterable
from xml.etree import ElementTree as ET


W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W14_NS = "http://schemas.microsoft.com/office/word/2010/wordml"
NS = {"w": W_NS, "w14": W14_NS}
W = f"{{{W_NS}}}"
W14 = f"{{{W14_NS}}}"
SKILL_DIR = Path(__file__).resolve().parent.parent
DEFAULT_TEMPLATE = SKILL_DIR / "assets" / "reference.docx"
REQUIRED_SECTIONS = ["公司情况介绍", "投资理由", "投资计划", "投资情形分析"]
TEMPLATE_RESIDUE = [
    "德塔智能", "北京德塔源创", "马晓健", "刘航欣", "黄思远", "朱松纯",
    "24亿元", "2.7亿元", "26.7亿元", "0.56%", "2026年7月1日",
]
REASON_DEFENSIVE_PHRASES = ["但", "仍需", "取决于", "适宜设置为", "交割前应", "需进一步"]
DEFENSIVE_PHRASES = ["仍需", "交割前", "以最终", "以交割前", "不构成无条件", "不能据此作绝对结论"]
ITEM7_CHECKLIST_MARKERS = ["纳入交割前核验", "包括", "分别取得专项"]
PLAN_RESERVATION_MAX_CHARS = 72
VISIBLE_IDENTITY_TERMS = ["统一社会信用代码", "社会信用代码"]
USCC_PATTERN = re.compile(r"(?<![0-9A-Z])[0-9A-HJ-NPQRTUWXY]{18}(?![0-9A-Z])")
COMPANY_INTRO_CAPITAL_PATTERNS = {
    "注册资本": re.compile(r"注册资本"),
    "认缴资本": re.compile(r"认缴(?:注册)?资本"),
    "实缴资本": re.compile(r"实缴(?:注册)?资本"),
    "实收资本": re.compile(r"实收资本"),
    "实缴金额": re.compile(r"实缴\s*(?:人民币)?\s*[0-9][0-9,.]*\s*(?:万|亿)?元"),
}
TEXT_EXTENSIONS = {".txt", ".md", ".csv", ".tsv"}
OFFICE_EXTENSIONS = {".docx", ".xlsx", ".xls", ".doc"}
SUPPORTED_EXTENSIONS = TEXT_EXTENSIONS | OFFICE_EXTENSIONS | {".pdf"}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def read_text_flexible(path: Path) -> str:
    data = path.read_bytes()
    for enc in ("utf-8-sig", "utf-8", "gb18030", "gbk", "big5"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def decode_zip_name(info: zipfile.ZipInfo) -> str:
    name = info.filename
    if info.flag_bits & 0x800:
        return name
    try:
        raw = name.encode("cp437")
    except UnicodeEncodeError:
        return name
    candidates = [name]
    for enc in ("gb18030", "utf-8", "big5"):
        try:
            candidates.append(raw.decode(enc))
        except UnicodeDecodeError:
            pass

    def score(value: str) -> tuple[int, int, int]:
        cjk = sum("\u3400" <= ch <= "\u9fff" for ch in value)
        mojibake = sum(ch in "��������" for ch in value)
        controls = sum(ord(ch) < 32 and ch not in "\t\n\r" for ch in value)
        return (cjk - 4 * mojibake - 8 * controls, -mojibake, -controls)

    return max(candidates, key=score)


def safe_extract_zip(archive: Path, target: Path) -> list[str]:
    warnings: list[str] = []
    target.mkdir(parents=True, exist_ok=True)
    root = target.resolve()
    with zipfile.ZipFile(archive) as zf:
        for info in zf.infolist():
            decoded = decode_zip_name(info).replace("\\", "/")
            parts = [p for p in PurePosixPath(decoded).parts if p not in ("", ".")]
            if not parts or any(p == ".." for p in parts) or PurePosixPath(decoded).is_absolute():
                warnings.append(f"blocked unsafe path: {decoded}")
                continue
            out = target.joinpath(*parts)
            try:
                out.resolve().relative_to(root)
            except ValueError:
                warnings.append(f"blocked escaping path: {decoded}")
                continue
            unix_mode = (info.external_attr >> 16) & 0o170000
            if unix_mode == 0o120000:
                warnings.append(f"skipped symlink: {decoded}")
                continue
            if info.is_dir() or decoded.endswith("/"):
                out.mkdir(parents=True, exist_ok=True)
                continue
            out.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, out.open("wb") as dst:
                shutil.copyfileobj(src, dst)
    return warnings


def xml_paragraph_texts(xml_bytes: bytes) -> list[str]:
    root = ET.fromstring(xml_bytes)
    texts: list[str] = []
    for p in root.findall(".//w:p", NS):
        pieces: list[str] = []
        for node in p.iter():
            if node.tag == W + "t" and node.text:
                pieces.append(node.text)
            elif node.tag == W + "tab":
                pieces.append("\t")
            elif node.tag in (W + "br", W + "cr"):
                pieces.append("\n")
        text = "".join(pieces).strip()
        if text:
            texts.append(text)
    return texts


def extract_docx(path: Path) -> str:
    parts: list[str] = []
    with zipfile.ZipFile(path) as zf:
        names = ["word/document.xml"] + sorted(
            n for n in zf.namelist()
            if re.fullmatch(r"word/(header|footer)\d+\.xml", n)
        )
        for name in names:
            if name in zf.namelist():
                parts.extend(xml_paragraph_texts(zf.read(name)))
    return "\n".join(parts)


def run_text_command(command: list[str], timeout: int = 180) -> str:
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout, check=False)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.decode("utf-8", errors="replace").strip())
    for enc in ("utf-8", "gb18030"):
        try:
            return result.stdout.decode(enc)
        except UnicodeDecodeError:
            pass
    return result.stdout.decode("utf-8", errors="replace")


def extract_pdf(path: Path) -> str:
    tool = shutil.which("pdftotext")
    if not tool:
        raise RuntimeError("pdftotext unavailable")
    return run_text_command([tool, "-layout", str(path), "-"])


def extract_doc(path: Path) -> str:
    tool = shutil.which("textutil") or shutil.which("antiword")
    if not tool:
        raise RuntimeError("textutil/antiword unavailable")
    if Path(tool).name == "textutil":
        return run_text_command([tool, "-convert", "txt", "-stdout", str(path)])
    return run_text_command([tool, str(path)])


def extract_workbook(path: Path) -> str:
    suffix = path.suffix.lower()
    rows: list[str] = []
    if suffix == ".xlsx":
        from openpyxl import load_workbook
        book = load_workbook(path, read_only=True, data_only=True)
        try:
            for sheet in book.worksheets:
                rows.append(f"## Sheet: {sheet.title}")
                count = 0
                for row in sheet.iter_rows(values_only=True):
                    values = ["" if v is None else str(v).strip() for v in row]
                    if any(values):
                        rows.append("\t".join(values).rstrip())
                        count += len(values)
                    if count > 50000:
                        rows.append("[truncated after 50,000 cells]")
                        break
        finally:
            book.close()
    else:
        try:
            import xlrd
        except ImportError:
            xlrd = None
        if xlrd is not None:
            book = xlrd.open_workbook(path, on_demand=True)
            try:
                for sheet in book.sheets():
                    rows.append(f"## Sheet: {sheet.name}")
                    for r in range(min(sheet.nrows, 5000)):
                        values = [str(sheet.cell_value(r, c)).strip() for c in range(sheet.ncols)]
                        if any(values):
                            rows.append("\t".join(values).rstrip())
            finally:
                book.release_resources()
        else:
            soffice = shutil.which("soffice")
            mac_soffice = Path("/Applications/LibreOffice.app/Contents/MacOS/soffice")
            if not soffice and mac_soffice.exists():
                soffice = str(mac_soffice)
            if not soffice:
                raise RuntimeError("xlrd and LibreOffice are both unavailable for .xls extraction")
            with tempfile.TemporaryDirectory(prefix="compliance-xls-") as tmp:
                tmpdir = Path(tmp)
                profile = tmpdir / "lo-profile"
                command = [soffice, "--headless", f"-env:UserInstallation={profile.as_uri()}",
                           "--convert-to", "xlsx", "--outdir", str(tmpdir), str(path)]
                result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        timeout=180, check=False)
                converted = tmpdir / f"{path.stem}.xlsx"
                if result.returncode != 0 or not converted.exists():
                    detail = result.stderr.decode("utf-8", errors="replace").strip()
                    raise RuntimeError(f"LibreOffice .xls conversion failed: {detail}")
                return extract_workbook(converted)
    return "\n".join(rows)


def extract_text(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in TEXT_EXTENSIONS:
        return read_text_flexible(path)
    if suffix == ".docx":
        return extract_docx(path)
    if suffix == ".pdf":
        return extract_pdf(path)
    if suffix in (".xlsx", ".xls"):
        return extract_workbook(path)
    if suffix == ".doc":
        return extract_doc(path)
    raise RuntimeError(f"unsupported extension: {suffix}")


def classify_source(path: Path) -> tuple[str, str, int]:
    value = str(path).lower()
    rules = [
        (("增资协议", "股东协议", "股权转让协议", "投资协议"), "transaction", "A", 95),
        (("营业执照", "工商", "公司章程"), "corporate/legal", "A", 92),
        (("审计报告", "专审", "财务尽职"), "financial", "B", 90),
        (("法律尽调", "尽调报告"), "legal", "B", 88),
        (("股东名册", "captable"), "ownership", "B", 86),
        (("客户", "销售", "采购", "合同"), "commercial", "C", 80),
        (("利润表", "资产负债表", "现金流量表", "预算"), "financial", "C", 78),
        (("访谈", "会议纪要", "交流纪要"), "interview", "D", 70),
        (("产品", "技术", "商业计划", "战略"), "business/technology", "E", 65),
        (("员工", "花名册", "竞业", "保密", "财务制度"), "operations", "C", 60),
    ]
    for needles, category, grade, rank in rules:
        if any(n.lower() in value for n in needles):
            return category, grade, rank
    return "other", "E", 30


def make_snippet(text: str, limit: int = 1800) -> str:
    clean = re.sub(r"[ \t]+", " ", text)
    clean = re.sub(r"\n{3,}", "\n\n", clean).strip()
    keywords = ["投资", "估值", "股权", "返投", "关联", "收入", "团队", "技术", "客户"]
    positions = [clean.find(k) for k in keywords if clean.find(k) >= 0]
    start = max(0, min(positions) - 200) if positions else 0
    return clean[start:start + limit]


def prepare_command(args: argparse.Namespace) -> int:
    source = Path(args.input).expanduser().resolve()
    workdir = Path(args.workdir).expanduser().resolve()
    workdir.mkdir(parents=True, exist_ok=True)
    warnings: list[str] = []
    if source.is_file() and source.suffix.lower() == ".zip":
        expanded = workdir / "expanded"
        if expanded.exists() and any(expanded.iterdir()):
            raise SystemExit(f"Refusing to reuse non-empty extraction directory: {expanded}")
        warnings.extend(safe_extract_zip(source, expanded))
        root = expanded
        source_hash = sha256(source)
    elif source.is_dir():
        root = source
        source_hash = None
    else:
        raise SystemExit("INPUT must be a ZIP archive or directory")

    packets = workdir / "packets"
    packets.mkdir(exist_ok=True)
    manifest: list[dict[str, Any]] = []
    for index, path in enumerate(sorted(p for p in root.rglob("*") if p.is_file()), 1):
        rel = path.relative_to(root).as_posix()
        category, grade, rank = classify_source(path)
        entry: dict[str, Any] = {
            "source_id": f"S{index:04d}", "path": rel, "size": path.stat().st_size,
            "sha256": sha256(path), "extension": path.suffix.lower(),
            "category": category, "evidence_grade": grade, "rank": rank,
            "text_length": 0, "packet": None, "status": "inventoried",
        }
        if path.suffix.lower() in SUPPORTED_EXTENSIONS:
            try:
                text = extract_text(path)
                text = text.replace("\x00", "").strip()
                entry["text_length"] = len(text)
                if text:
                    packet_path = packets / f"{entry['source_id']}.txt"
                    packet_path.write_text(
                        f"SOURCE_ID: {entry['source_id']}\nPATH: {rel}\nCATEGORY: {category}\n"
                        f"EVIDENCE_GRADE: {grade}\n\n{text}\n", encoding="utf-8")
                    entry["packet"] = packet_path.relative_to(workdir).as_posix()
                    entry["status"] = "extracted"
                else:
                    entry["status"] = "empty_or_scan"
                    warnings.append(f"no extractable text: {rel}")
            except Exception as exc:
                entry["status"] = "extract_failed"
                entry["error"] = str(exc)
                warnings.append(f"extract failed: {rel}: {exc}")
        elif path.suffix.lower() in (".rar", ".7z", ".lnk"):
            entry["status"] = "nested_or_shortcut_not_expanded"
            warnings.append(f"manual review required: {rel}")
        manifest.append(entry)

    manifest.sort(key=lambda item: (-item["rank"], item["path"]))
    write_json(workdir / "source_manifest.json", {
        "created_at": dt.datetime.now().astimezone().isoformat(),
        "input": str(source), "input_sha256": source_hash,
        "root": str(root), "warnings": warnings, "sources": manifest,
    })

    pack_lines = ["# Evidence pack", "", f"Input: `{source}`", "", "## Extraction warnings", ""]
    pack_lines.extend(f"- {w}" for w in warnings[:80])
    if not warnings:
        pack_lines.append("- None")
    pack_lines.extend(["", "## Highest-priority sources", ""])
    for item in manifest[:24]:
        pack_lines.append(f"### {item['source_id']} — {item['path']}")
        pack_lines.append(f"Category: {item['category']} | Grade: {item['evidence_grade']} | Status: {item['status']}")
        if item.get("packet"):
            text = (workdir / item["packet"]).read_text(encoding="utf-8", errors="replace")
            pack_lines.extend(["", make_snippet(text), ""])
        else:
            pack_lines.extend(["", "[No extractable packet]", ""])
    (workdir / "evidence_pack.md").write_text("\n".join(pack_lines), encoding="utf-8")

    prompt = f"""# Agent drafting task

Create a Chinese investment-compliance note from the evidence in `{workdir}`.
Read `source_manifest.json` and relevant packet files, build a conflict-aware fact ledger, then author `content.json` using the skill's content schema.
Use the retained standard only for structure and fund facts explicitly identified as such; never carry over the template project facts.
Required sections: {'、'.join(REQUIRED_SECTIONS)}. The final compliance analysis must contain all seven standard checks and a conditional conclusion.
"""
    (workdir / "agent_prompt.md").write_text(prompt, encoding="utf-8")
    print(json.dumps({"workdir": str(workdir), "sources": len(manifest),
                      "warnings": len(warnings), "manifest": str(workdir / "source_manifest.json")},
                     ensure_ascii=False))
    return 0


def paragraph_text(p: ET.Element) -> str:
    return "".join(t.text or "" for t in p.findall(".//w:t", NS))


def find_paragraph(paragraphs: Iterable[ET.Element], exact: str | None = None,
                   startswith: str | None = None) -> ET.Element:
    for p in paragraphs:
        text = paragraph_text(p).strip()
        if exact is not None and text == exact:
            return p
        if startswith is not None and text.startswith(startswith):
            return p
    raise ValueError(f"template exemplar not found: {exact or startswith}")


def clone_rpr(p: ET.Element) -> ET.Element | None:
    first = p.find("w:r", NS)
    if first is None:
        return None
    rpr = first.find("w:rPr", NS)
    return copy.deepcopy(rpr) if rpr is not None else None


def set_bold(rpr: ET.Element | None, bold: bool) -> ET.Element:
    if rpr is None:
        rpr = ET.Element(W + "rPr")
    for name in ("b", "bCs"):
        node = rpr.find(f"w:{name}", NS)
        if bold and node is None:
            ET.SubElement(rpr, W + name)
        elif not bold and node is not None:
            rpr.remove(node)
    return rpr


def add_text_run(p: ET.Element, text: str, rpr: ET.Element | None = None,
                 bold: bool | None = None) -> None:
    r = ET.SubElement(p, W + "r")
    if rpr is not None:
        r.append(copy.deepcopy(rpr))
    if bold is not None:
        current = r.find("w:rPr", NS)
        if current is not None:
            r.remove(current)
        r.insert(0, set_bold(copy.deepcopy(rpr), bold))
    t = ET.SubElement(r, W + "t")
    if text[:1].isspace() or text[-1:].isspace():
        t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    t.text = text


def clone_with_text(exemplar: ET.Element, text: str,
                    label: str | None = None) -> ET.Element:
    p = copy.deepcopy(exemplar)
    p.attrib.pop(W14 + "paraId", None)
    p.attrib.pop(W14 + "textId", None)
    rpr = clone_rpr(p)
    for child in list(p):
        if child.tag != W + "pPr":
            p.remove(child)
    if label:
        add_text_run(p, label, rpr, bold=True)
        add_text_run(p, text, rpr, bold=False)
    else:
        add_text_run(p, text, rpr)
    return p


def visible_content_text(content: dict[str, Any]) -> str:
    return "\n".join(
        str(block.get("text", ""))
        for section in content.get("sections", [])
        if isinstance(section, dict)
        for block in section.get("blocks", [])
        if isinstance(block, dict)
    )


def company_intro_text(content: dict[str, Any]) -> str:
    section = next(
        (
            item
            for item in content.get("sections", [])
            if isinstance(item, dict) and item.get("heading") == "公司情况介绍"
        ),
        None,
    )
    if not section:
        return ""
    collecting = False
    parts: list[str] = []
    for block in section.get("blocks", []):
        if not isinstance(block, dict):
            continue
        if block.get("type") == "subheading":
            if collecting:
                break
            collecting = block.get("text", "").strip() == "公司简介"
            continue
        if collecting:
            parts.append(str(block.get("text", "")))
    return "\n".join(parts)


def visible_identity_hits(text: str) -> list[str]:
    hits = [term for term in VISIBLE_IDENTITY_TERMS if term in text]
    hits.extend(f"18位信用代码:{value}" for value in USCC_PATTERN.findall(text.upper()))
    return list(dict.fromkeys(hits))


def company_intro_capital_hits(text: str) -> list[str]:
    return [
        label
        for label, pattern in COMPANY_INTRO_CAPITAL_PATTERNS.items()
        if pattern.search(text)
    ]


def text_between_paragraphs(paragraphs: list[str], start: str, end: str) -> str:
    collecting = False
    parts: list[str] = []
    for text in paragraphs:
        stripped = text.strip()
        if stripped == start:
            collecting = True
            continue
        if collecting and stripped == end:
            break
        if collecting and stripped:
            parts.append(stripped)
    return "\n".join(parts)


def validate_content(content: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    sections = content.get("sections")
    if not isinstance(sections, list):
        return ["sections must be an array"]
    headings = [s.get("heading") for s in sections if isinstance(s, dict)]
    if headings != REQUIRED_SECTIONS:
        errors.append(f"section order must be exactly {REQUIRED_SECTIONS}; got {headings}")
    closing = content.get("closing", {})
    if not closing.get("company") or not closing.get("date"):
        errors.append("closing.company and closing.date are required")
    analysis = next((s for s in sections if s.get("heading") == "投资情形分析"), None)
    if analysis:
        item_count = sum(b.get("type") == "numbered" for b in analysis.get("blocks", []))
        if item_count < 7:
            errors.append(f"投资情形分析 requires at least 7 numbered checks; got {item_count}")
    identity_hits = visible_identity_hits(visible_content_text(content))
    if identity_hits:
        errors.append(f"visible report contains prohibited registration identifiers: {identity_hits}")
    capital_hits = company_intro_capital_hits(company_intro_text(content))
    if capital_hits:
        errors.append(f"公司简介 contains prohibited capital-registration fields: {capital_hits}")
    return errors


def build_command(args: argparse.Namespace) -> int:
    content_path = Path(args.content).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()
    template = Path(args.template).expanduser().resolve() if args.template else DEFAULT_TEMPLATE
    content = json.loads(content_path.read_text(encoding="utf-8"))
    errors = validate_content(content)
    if errors:
        raise SystemExit("Invalid content:\n- " + "\n- ".join(errors))
    if not template.exists():
        raise SystemExit(f"Template not found: {template}")

    with zipfile.ZipFile(template) as zin:
        document_xml = zin.read("word/document.xml")
        root = ET.fromstring(document_xml)
        body = root.find("w:body", NS)
        if body is None:
            raise SystemExit("Template document body not found")
        paragraphs = body.findall("w:p", NS)
        ex_title = find_paragraph(paragraphs, exact="关于德塔智能项目投资合规性的说明")
        ex_main = find_paragraph(paragraphs, exact="公司情况介绍")
        ex_sub = find_paragraph(paragraphs, exact="公司简介")
        ex_body = find_paragraph(paragraphs, startswith="北京德塔源创智能科技有限公司")
        ex_numbered = find_paragraph(paragraphs, startswith="2、")
        ex_closing_company = find_paragraph(paragraphs, exact="浙江赛智伯乐股权投资管理有限公司")
        ex_closing_date = find_paragraph(paragraphs, startswith="2026年")
        sectpr = body.find("w:sectPr", NS)
        if sectpr is None:
            raise SystemExit("Template section properties not found")
        for child in list(body):
            if child is not sectpr:
                body.remove(child)

        body.insert(len(body) - 1, clone_with_text(ex_title, content["title"]))
        for section in content["sections"]:
            body.insert(len(body) - 1, clone_with_text(ex_main, section["heading"]))
            for block in section.get("blocks", []):
                kind = block.get("type", "paragraph")
                if kind == "subheading":
                    p = clone_with_text(ex_sub, block["text"])
                elif kind == "numbered":
                    label = block.get("label") or ""
                    if label and not re.search(r"[、.)）]\s*$", label):
                        label += "、"
                    p = clone_with_text(ex_numbered, block["text"], label=label)
                else:
                    p = clone_with_text(ex_body, block["text"])
                body.insert(len(body) - 1, p)
        body.insert(len(body) - 1, clone_with_text(ex_closing_company, content["closing"]["company"]))
        body.insert(len(body) - 1, clone_with_text(ex_closing_date, content["closing"]["date"]))

        ET.register_namespace("w", W_NS)
        ET.register_namespace("w14", W14_NS)
        new_document_xml = ET.tostring(root, encoding="utf-8", xml_declaration=True)
        output.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(output, "w") as zout:
            for info in zin.infolist():
                data = new_document_xml if info.filename == "word/document.xml" else zin.read(info.filename)
                zout.writestr(info, data)
    print(json.dumps({"output": str(output), "sha256": sha256(output),
                      "template": str(template), "template_sha256": sha256(template)}, ensure_ascii=False))
    return 0


def package_hashes(path: Path) -> dict[str, str]:
    with zipfile.ZipFile(path) as zf:
        return {name: hashlib.sha256(zf.read(name)).hexdigest() for name in zf.namelist()}


def direct_run_properties(docx: Path) -> list[dict[str, Any]]:
    with zipfile.ZipFile(docx) as zf:
        root = ET.fromstring(zf.read("word/document.xml"))
    rows: list[dict[str, Any]] = []
    for p_index, p in enumerate(root.findall(".//w:body/w:p", NS)):
        p_text = paragraph_text(p).strip()
        if not p_text:
            continue
        for r in p.findall("w:r", NS):
            text = "".join(t.text or "" for t in r.findall(".//w:t", NS)).strip()
            if not text:
                continue
            rpr = r.find("w:rPr", NS)
            fonts = rpr.find("w:rFonts", NS) if rpr is not None else None
            size = rpr.find("w:sz", NS) if rpr is not None else None
            underline = rpr.find("w:u", NS) if rpr is not None else None
            rows.append({
                "paragraph": p_index, "paragraph_text": p_text, "text": text,
                "east_asia_font": fonts.get(W + "eastAsia") if fonts is not None else None,
                "ascii_font": fonts.get(W + "ascii") if fonts is not None else None,
                "hansi_font": fonts.get(W + "hAnsi") if fonts is not None else None,
                "half_points": int(size.get(W + "val")) if size is not None and size.get(W + "val") else None,
                "bold": rpr is not None and rpr.find("w:b", NS) is not None,
                "italic": rpr is not None and rpr.find("w:i", NS) is not None,
                "underlined": underline is not None and underline.get(W + "val", "single") not in ("0", "false", "none"),
            })
    return rows


def direct_paragraph_properties(docx: Path) -> list[dict[str, Any]]:
    with zipfile.ZipFile(docx) as zf:
        root = ET.fromstring(zf.read("word/document.xml"))
    rows: list[dict[str, Any]] = []
    for p_index, p in enumerate(root.findall(".//w:body/w:p", NS)):
        text = paragraph_text(p).strip()
        if not text:
            rows.append({"paragraph": p_index, "text": "", "blank": True})
            continue
        ppr = p.find("w:pPr", NS)
        spacing = ppr.find("w:spacing", NS) if ppr is not None else None
        ind = ppr.find("w:ind", NS) if ppr is not None else None
        jc = ppr.find("w:jc", NS) if ppr is not None else None
        rows.append({
            "paragraph": p_index,
            "text": text,
            "blank": False,
            "align": jc.get(W + "val") if jc is not None else None,
            "before": spacing.get(W + "before") if spacing is not None else None,
            "after": spacing.get(W + "after") if spacing is not None else None,
            "line": spacing.get(W + "line") if spacing is not None else None,
            "line_rule": spacing.get(W + "lineRule") if spacing is not None else None,
            "first_line": ind.get(W + "firstLine") if ind is not None else None,
            "keep_next": ppr is not None and ppr.find("w:keepNext", NS) is not None,
        })
    return rows


def verify_command(args: argparse.Namespace) -> int:
    content_path = Path(args.content).expanduser().resolve()
    docx = Path(args.docx).expanduser().resolve()
    out = Path(args.out).expanduser().resolve()
    template = Path(args.template).expanduser().resolve() if args.template else DEFAULT_TEMPLATE
    content = json.loads(content_path.read_text(encoding="utf-8"))
    errors = validate_content(content)
    warnings: list[str] = []
    metrics: dict[str, Any] = {}

    with zipfile.ZipFile(docx) as zf:
        root = ET.fromstring(zf.read("word/document.xml"))
        visible_paragraphs = [paragraph_text(p) for p in root.findall(".//w:body/w:p", NS)]
        visible = "\n".join(visible_paragraphs)
        sect = root.find(".//w:sectPr", NS)
        if sect is None:
            errors.append("missing section properties")
        else:
            pgsz = sect.find("w:pgSz", NS)
            expected_size = {"w": "11906", "h": "16838"}
            actual_size = {k: pgsz.get(W + k) if pgsz is not None else None for k in expected_size}
            metrics["page_size_dxa"] = actual_size
            if actual_size != expected_size:
                errors.append(f"page size differs from A4 portrait: {actual_size}")
            pgmar = sect.find("w:pgMar", NS)
            expected = {"top": "1417", "bottom": "1417", "left": "1587", "right": "1587"}
            actual = {k: pgmar.get(W + k) if pgmar is not None else None for k in expected}
            metrics["margins_dxa"] = actual
            if actual != expected:
                errors.append(f"page margins differ from 2.5/2.8 cm contract: {actual}")

    doc_identity_hits = visible_identity_hits(visible)
    doc_intro_capital_hits = company_intro_capital_hits(
        text_between_paragraphs(visible_paragraphs, "公司简介", "核心团队")
    )
    metrics["visible_registration_identifier_hits"] = doc_identity_hits
    metrics["company_intro_capital_field_hits"] = doc_intro_capital_hits
    if doc_identity_hits and not any("prohibited registration identifiers" in error for error in errors):
        errors.append(f"visible DOCX contains prohibited registration identifiers: {doc_identity_hits}")
    if doc_intro_capital_hits and not any("prohibited capital-registration fields" in error for error in errors):
        errors.append(f"visible DOCX 公司简介 contains prohibited capital-registration fields: {doc_intro_capital_hits}")

    for section in REQUIRED_SECTIONS:
        if section not in visible:
            errors.append(f"missing visible section: {section}")
    declared_visible = visible_content_text(content)
    for residue in TEMPLATE_RESIDUE:
        # A retained-template marker is residue only when it was not supplied by
        # the current payload. This keeps real portfolio-peer references valid.
        if residue in visible and residue not in declared_visible:
            errors.append(f"template residue detected: {residue}")

    sections_by_heading = {s.get("heading"): s for s in content.get("sections", [])}
    reason_blocks = sections_by_heading.get("投资理由", {}).get("blocks", [])
    reason_hits: list[dict[str, Any]] = []
    for index, block in enumerate(reason_blocks, start=1):
        text = block.get("text", "")
        hits = [phrase for phrase in REASON_DEFENSIVE_PHRASES if phrase in text]
        if hits:
            reason_hits.append({"item": index, "phrases": hits})
    if reason_hits:
        errors.append(f"investment reasons contain defensive tails: {reason_hits}")

    defensive_counts = {phrase: visible.count(phrase) for phrase in DEFENSIVE_PHRASES}
    repeated_defensive = {phrase: count for phrase, count in defensive_counts.items() if count > 1}
    if repeated_defensive:
        warnings.append(f"repeated defensive phrases detected: {repeated_defensive}")

    plan_blocks = sections_by_heading.get("投资计划", {}).get("blocks", [])
    plan_reservation_text = plan_blocks[-1].get("text", "").strip() if plan_blocks else ""
    if not plan_reservation_text:
        errors.append("investment plan requires a final reservation sentence")
    else:
        if len(plan_reservation_text) > PLAN_RESERVATION_MAX_CHARS:
            warnings.append(
                f"investment-plan reservation exceeds {PLAN_RESERVATION_MAX_CHARS} characters: "
                f"{len(plan_reservation_text)}"
            )
        if "正式交易文件为准" not in plan_reservation_text:
            warnings.append("investment-plan reservation should end with definitive documents")

    analysis_blocks = sections_by_heading.get("投资情形分析", {}).get("blocks", [])
    numbered_analysis = [b for b in analysis_blocks if b.get("type") == "numbered"]
    item7_text = numbered_analysis[6].get("text", "") if len(numbered_analysis) >= 7 else ""
    item7_hits = [marker for marker in ITEM7_CHECKLIST_MARKERS if marker in item7_text]
    if item7_hits:
        errors.append(f"item 7 contains a closing checklist; move it to open_issues: {item7_hits}")
    conclusion_blocks = [b for b in analysis_blocks if b.get("type") == "conclusion"]
    if len(conclusion_blocks) != 1:
        errors.append(f"requires exactly one conclusion block; got {len(conclusion_blocks)}")
    elif conclusion_blocks:
        conclusion_text = conclusion_blocks[0].get("text", "").strip()
        sentence_count = len(re.findall(r"[。！？]", conclusion_text))
        if sentence_count != 1:
            errors.append(f"conclusion must be one sentence; got {sentence_count}")
        if len(conclusion_text) > 120:
            warnings.append(f"conclusion exceeds 120 characters: {len(conclusion_text)}")

    unsourced: list[str] = []
    pending = 0
    for section in content.get("sections", []):
        for block in section.get("blocks", []):
            if block.get("type") != "subheading" and not block.get("source_ids"):
                unsourced.append(block.get("label", "") + block.get("text", "")[:50])
            if block.get("status") == "pending":
                pending += 1
    if unsourced:
        warnings.append(f"{len(unsourced)} factual blocks lack source_ids")
    if pending:
        warnings.append(f"{pending} blocks are pending verification")
    if not content.get("open_issues"):
        warnings.append("open_issues is empty; confirm this is intentional")

    runs = direct_run_properties(docx)
    font_errors = []
    decoration_errors = []
    bold_role_errors = []
    subheading_texts = {
        block.get("text", "")
        for section in content.get("sections", [])
        for block in section.get("blocks", [])
        if block.get("type") == "subheading"
    }
    for row in runs:
        is_title = row["paragraph"] == 0
        expected_font = "黑体" if is_title else "宋体"
        expected_size = 28 if is_title else 24
        if (
            row["east_asia_font"] != expected_font
            or row["ascii_font"] != "Times New Roman"
            or row["hansi_font"] != "Times New Roman"
            or row["half_points"] != expected_size
        ):
            font_errors.append(row)
        if row["italic"] or row["underlined"]:
            decoration_errors.append(row)
        paragraph_text_value = row["paragraph_text"]
        if is_title and row["bold"]:
            bold_role_errors.append(row)
        elif paragraph_text_value in REQUIRED_SECTIONS and not row["bold"]:
            bold_role_errors.append(row)
        elif paragraph_text_value in subheading_texts and row["bold"]:
            bold_role_errors.append(row)
        elif paragraph_text_value[:1].isdigit() and "、" in paragraph_text_value[:3]:
            is_number_label = row["text"].strip().endswith("、")
            if row["bold"] != is_number_label:
                bold_role_errors.append(row)
    if font_errors:
        errors.append(f"{len(font_errors)} runs differ from required font/size/western-font contract")
    if decoration_errors:
        errors.append(f"{len(decoration_errors)} runs use forbidden italic or underline formatting")
    if bold_role_errors:
        errors.append(f"{len(bold_role_errors)} runs differ from required bold roles")
    metrics["visible_runs"] = len(runs)
    metrics["font_size_exceptions"] = len(font_errors)
    metrics["decoration_exceptions"] = len(decoration_errors)
    metrics["bold_role_exceptions"] = len(bold_role_errors)

    paragraphs = direct_paragraph_properties(docx)
    paragraph_errors: list[dict[str, Any]] = []
    blank_paragraphs = [row for row in paragraphs if row["blank"]]
    company_text = content.get("closing", {}).get("company", "")
    date_text = content.get("closing", {}).get("date", "")
    for row in paragraphs:
        if row["blank"]:
            continue
        text_value = row["text"]
        if row["paragraph"] == 0:
            expected_p = {"align": "center", "before": "0", "after": "0", "first_line": None, "keep_next": False}
        elif text_value in REQUIRED_SECTIONS:
            expected_p = {"align": "left", "before": "240", "after": "0", "first_line": None, "keep_next": True}
        elif text_value in subheading_texts:
            expected_p = {"align": "left", "before": "0", "after": "0", "first_line": "480", "keep_next": True}
        elif text_value == company_text:
            expected_p = {"align": "right", "before": "600", "after": "0", "first_line": None, "keep_next": False}
        elif text_value == date_text:
            expected_p = {"align": "right", "before": "0", "after": "0", "first_line": None, "keep_next": False}
        elif text_value[:1].isdigit() and "、" in text_value[:3]:
            expected_p = {"align": "both", "before": "120", "after": "0", "first_line": "0", "keep_next": False}
        else:
            expected_p = {"align": "both", "before": "0", "after": "0", "first_line": "480", "keep_next": False}
        actual_p = {key: row[key] for key in expected_p}
        if actual_p != expected_p or row["line"] != "360" or row["line_rule"] != "auto":
            paragraph_errors.append({
                "paragraph": row["paragraph"],
                "text": text_value[:60],
                "expected": expected_p | {"line": "360", "line_rule": "auto"},
                "actual": actual_p | {"line": row["line"], "line_rule": row["line_rule"]},
            })
    if blank_paragraphs:
        errors.append(f"{len(blank_paragraphs)} blank spacer paragraphs detected")
    if paragraph_errors:
        errors.append(f"{len(paragraph_errors)} paragraphs differ from alignment/spacing/indent contract")
    metrics["blank_paragraph_count"] = len(blank_paragraphs)
    metrics["paragraph_format_exceptions"] = len(paragraph_errors)

    final_hashes = package_hashes(docx)
    template_hashes = package_hashes(template)
    changed_parts = sorted(
        name for name, digest in template_hashes.items()
        if name != "word/document.xml" and final_hashes.get(name) != digest
    )
    missing_parts = sorted(name for name in template_hashes if name not in final_hashes)
    if changed_parts:
        errors.append(f"preserve-only package parts changed: {changed_parts}")
    if missing_parts:
        errors.append(f"template package parts missing: {missing_parts}")
    metrics["preserve_only_parts_changed"] = changed_parts
    metrics["template_parts_missing"] = missing_parts
    metrics["docx_sha256"] = sha256(docx)
    metrics["template_sha256"] = sha256(template)
    metrics["open_issue_count"] = len(content.get("open_issues", []))
    metrics["pending_block_count"] = pending
    metrics["reason_defensive_hits"] = reason_hits
    metrics["defensive_phrase_counts"] = defensive_counts
    metrics["conclusion_character_count"] = len(conclusion_blocks[0].get("text", "")) if conclusion_blocks else 0
    metrics["plan_reservation_character_count"] = len(plan_reservation_text)
    metrics["item7_checklist_hits"] = item7_hits
    qa = {
        "pass": not errors,
        "created_at": dt.datetime.now().astimezone().isoformat(),
        "errors": errors, "warnings": warnings, "metrics": metrics,
        "visual_qa": "required_separately_by_documents_skill",
    }
    write_json(out, qa)
    print(json.dumps({"pass": qa["pass"], "errors": len(errors),
                      "warnings": len(warnings), "qa": str(out)}, ensure_ascii=False))
    return 0 if qa["pass"] else 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    prepare = sub.add_parser("prepare", help="extract and index a ZIP/directory")
    prepare.add_argument("input")
    prepare.add_argument("--workdir", required=True)
    prepare.set_defaults(func=prepare_command)

    build = sub.add_parser("build", help="build DOCX from content JSON")
    build.add_argument("--content", required=True)
    build.add_argument("--output", required=True)
    build.add_argument("--template")
    build.set_defaults(func=build_command)

    verify = sub.add_parser("verify", help="structurally verify content and DOCX")
    verify.add_argument("--content", required=True)
    verify.add_argument("--docx", required=True)
    verify.add_argument("--out", required=True)
    verify.add_argument("--template")
    verify.set_defaults(func=verify_command)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
