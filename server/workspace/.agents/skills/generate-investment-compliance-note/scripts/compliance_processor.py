#!/usr/bin/env python3
"""Render Agent-approved compliance content into the Skill-owned DOCX layout."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path
from typing import Any, Iterable
from xml.etree import ElementTree as ET


W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W14_NS = "http://schemas.microsoft.com/office/word/2010/wordml"
NS = {"w": W_NS, "w14": W14_NS}
W = f"{{{W_NS}}}"
W14 = f"{{{W14_NS}}}"
SKILL_DIR = Path(__file__).resolve().parent.parent
DEFAULT_TEMPLATE = SKILL_DIR / "assets" / "compliance-layout-authority.docx"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def paragraph_text(paragraph: ET.Element) -> str:
    return "".join(node.text or "" for node in paragraph.findall(".//w:t", NS))


def find_paragraph(
    paragraphs: Iterable[ET.Element],
    *,
    exact: str | None = None,
    pattern: str | None = None,
) -> ET.Element:
    for paragraph in paragraphs:
        text = paragraph_text(paragraph).strip()
        if exact is not None and text == exact:
            return paragraph
        if pattern is not None and re.search(pattern, text):
            return paragraph
    raise ValueError(f"layout exemplar not found: {exact or pattern}")


def clone_run_properties(paragraph: ET.Element) -> ET.Element | None:
    first_run = paragraph.find("w:r", NS)
    if first_run is None:
        return None
    properties = first_run.find("w:rPr", NS)
    return copy.deepcopy(properties) if properties is not None else None


def set_bold(properties: ET.Element | None, bold: bool) -> ET.Element:
    result = properties if properties is not None else ET.Element(W + "rPr")
    for name in ("b", "bCs"):
        node = result.find(f"w:{name}", NS)
        if bold and node is None:
            ET.SubElement(result, W + name)
        elif not bold and node is not None:
            result.remove(node)
    return result


def add_text_run(
    paragraph: ET.Element,
    text: str,
    properties: ET.Element | None = None,
    *,
    bold: bool | None = None,
) -> None:
    run = ET.SubElement(paragraph, W + "r")
    run_properties = copy.deepcopy(properties)
    if bold is not None:
        run_properties = set_bold(run_properties, bold)
    if run_properties is not None:
        run.append(run_properties)
    text_node = ET.SubElement(run, W + "t")
    if text[:1].isspace() or text[-1:].isspace():
        text_node.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    text_node.text = text


def clone_with_text(
    exemplar: ET.Element,
    text: str,
    *,
    label: str | None = None,
) -> ET.Element:
    paragraph = copy.deepcopy(exemplar)
    paragraph.attrib.pop(W14 + "paraId", None)
    paragraph.attrib.pop(W14 + "textId", None)
    run_properties = clone_run_properties(paragraph)
    for child in list(paragraph):
        if child.tag != W + "pPr":
            paragraph.remove(child)
    if label:
        add_text_run(paragraph, label, run_properties, bold=True)
        add_text_run(paragraph, text, run_properties, bold=False)
    else:
        add_text_run(paragraph, text, run_properties)
    return paragraph


def layout_exemplars(paragraphs: list[ET.Element]) -> dict[str, ET.Element]:
    visible = [paragraph for paragraph in paragraphs if paragraph_text(paragraph).strip()]
    if not visible:
        raise ValueError("Skill layout authority has no visible paragraphs")
    main = find_paragraph(visible, exact="公司情况介绍")
    subheading = find_paragraph(visible, exact="公司简介")
    subheading_index = visible.index(subheading)
    body = next(
        paragraph for paragraph in visible[subheading_index + 1:]
        if paragraph_text(paragraph).strip()
        not in {"核心团队", "产品及技术", "投资理由", "投资计划", "投资情形分析"}
    )
    numbered = find_paragraph(visible, pattern=r"^\d+[、.．]")
    date = find_paragraph(reversed(visible), pattern=r"^\d{4}\s*年.*月.*日$")
    date_index = visible.index(date)
    company = next(
        paragraph for paragraph in reversed(visible[:date_index])
        if paragraph_text(paragraph).strip().endswith(("公司", "合伙企业"))
    )
    return {
        "title": visible[0],
        "main": main,
        "subheading": subheading,
        "body": body,
        "numbered": numbered,
        "company": company,
        "date": date,
    }


def build_command(args: argparse.Namespace) -> int:
    content_path = Path(args.content).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    template_path = (
        Path(args.template).expanduser().resolve()
        if args.template else DEFAULT_TEMPLATE
    )
    content: dict[str, Any] = json.loads(content_path.read_text(encoding="utf-8"))
    if not template_path.is_file():
        raise SystemExit(f"Skill layout authority is missing: {template_path}")

    with zipfile.ZipFile(template_path) as source:
        root = ET.fromstring(source.read("word/document.xml"))
        body = root.find("w:body", NS)
        if body is None:
            raise SystemExit("Skill layout authority has no document body")
        section_properties = body.find("w:sectPr", NS)
        if section_properties is None:
            raise SystemExit("Skill layout authority has no section properties")
        exemplars = layout_exemplars(body.findall("w:p", NS))
        for child in list(body):
            if child is not section_properties:
                body.remove(child)

        def append(paragraph: ET.Element) -> None:
            body.insert(len(body) - 1, paragraph)

        append(clone_with_text(exemplars["title"], str(content.get("title", ""))))
        for section in content.get("sections", []):
            append(clone_with_text(exemplars["main"], str(section.get("heading", ""))))
            for block in section.get("blocks", []):
                kind = block.get("type", "paragraph")
                text = str(block.get("text", ""))
                if kind == "subheading":
                    paragraph = clone_with_text(exemplars["subheading"], text)
                elif kind == "numbered":
                    label = str(block.get("label", ""))
                    if label and not re.search(r"[、.)）]\s*$", label):
                        label += "、"
                    paragraph = clone_with_text(exemplars["numbered"], text, label=label)
                else:
                    paragraph = clone_with_text(exemplars["body"], text)
                append(paragraph)

        closing = content.get("closing", {})
        append(clone_with_text(exemplars["company"], str(closing.get("company", ""))))
        append(clone_with_text(exemplars["date"], str(closing.get("date", ""))))

        ET.register_namespace("w", W_NS)
        ET.register_namespace("w14", W14_NS)
        document_xml = ET.tostring(root, encoding="utf-8", xml_declaration=True)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(output_path, "w") as target:
            for info in source.infolist():
                payload = document_xml if info.filename == "word/document.xml" else source.read(info.filename)
                target.writestr(info, payload)

    print(json.dumps({
        "output": str(output_path),
        "sha256": sha256(output_path),
        "template": str(template_path),
        "template_sha256": sha256(template_path),
        "acceptance_authority": "agent-and-current-skill",
        "programmatic_business_acceptance": False,
    }, ensure_ascii=False))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    build = subparsers.add_parser("build", help="render Agent-approved content as DOCX")
    build.add_argument("--content", required=True)
    build.add_argument("--output", required=True)
    build.add_argument("--template")
    build.set_defaults(func=build_command)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
