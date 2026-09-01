#!/usr/bin/env python3
"""Validate a frozen due-diligence DOCX, its PDF, and optional page renders."""

from __future__ import annotations

import argparse
from difflib import SequenceMatcher
import json
from pathlib import Path
import re
import sys
import unicodedata
import zipfile
from xml.etree import ElementTree as ET

sys.dont_write_bytecode = True

from runtime_bootstrap import ensure_runtime


W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W}
Q = lambda name: f"{{{W}}}{name}"
RECOMMENDATION_REPORT_STAGE = "investment-recommendation"
FINAL_REPORT_STAGE = "final-investment-decision"


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", value))


def page_number(path: Path) -> int:
    match = re.search(r"page-(\d+)\.png$", path.name)
    return int(match.group(1)) if match else 10**9


def docx_payload(docx: Path, errors: list[str]) -> tuple[str, list[str]]:
    text = ""
    orientations: list[str] = []
    try:
        with zipfile.ZipFile(docx) as archive:
            bad_part = archive.testzip()
            if bad_part:
                errors.append(f"DOCX ZIP部件损坏：{bad_part}")
                return text, orientations
            if "word/document.xml" not in archive.namelist():
                errors.append("DOCX缺少word/document.xml")
                return text, orientations
            document = ET.fromstring(archive.read("word/document.xml"))
    except (OSError, zipfile.BadZipFile, ET.ParseError) as exc:
        errors.append(f"DOCX不可读：{exc}")
        return text, orientations

    body = document.find("w:body", NS)
    if body is None:
        errors.append("DOCX正文为空")
        return text, orientations
    text = "".join(
        "".join(node.text or "" for node in child.findall(".//w:t", NS))
        for child in body
    )

    sections: list[ET.Element] = []
    for child in body:
        if child.tag == Q("p"):
            section = child.find("./w:pPr/w:sectPr", NS)
            if section is not None:
                sections.append(section)
        elif child.tag == Q("sectPr"):
            sections.append(child)
    for section in sections:
        size = section.find("w:pgSz", NS)
        if size is None:
            continue
        width = int(size.get(Q("w"), "0"))
        height = int(size.get(Q("h"), "0"))
        orientations.append("landscape" if width > height else "portrait")
    return text, orientations


def embedded_font_metrics(reader: object) -> tuple[int, int]:
    embedded: dict[object, bool] = {}
    for page in reader.pages:
        resources = page.get("/Resources") or {}
        fonts = resources.get("/Font") or {}
        try:
            fonts = fonts.get_object()
        except Exception:
            pass
        for key, reference in fonts.items():
            try:
                font = reference.get_object()
            except Exception:
                font = reference
            identity = getattr(reference, "idnum", None) or (str(key), str(font.get("/BaseFont")))
            descriptor = font.get("/FontDescriptor")
            if descriptor is None and font.get("/Subtype") == "/Type0":
                descendants = font.get("/DescendantFonts")
                if descendants:
                    try:
                        descendant = descendants[0].get_object()
                    except Exception:
                        descendant = descendants[0]
                    descriptor = descendant.get("/FontDescriptor")
            is_embedded = False
            if descriptor is not None:
                try:
                    descriptor = descriptor.get_object()
                except Exception:
                    pass
                is_embedded = any(name in descriptor for name in ("/FontFile", "/FontFile2", "/FontFile3"))
            embedded[identity] = embedded.get(identity, False) or is_embedded
    return len(embedded), sum(embedded.values())


def ink_ratios(pages: list[Path]) -> list[float]:
    from PIL import Image

    ratios: list[float] = []
    for page in pages:
        image = Image.open(page).convert("L")
        histogram = image.histogram()
        ratios.append(sum(histogram[:245]) / max(sum(histogram), 1))
    return ratios


def compare_renders(current: list[Path], baseline: list[Path]) -> int:
    from PIL import Image, ImageChops

    identical = 0
    for current_page, baseline_page in zip(current, baseline):
        left = Image.open(current_page).convert("RGB")
        right = Image.open(baseline_page).convert("RGB")
        if left.size == right.size and ImageChops.difference(left, right).getbbox() is None:
            identical += 1
    return identical


def validate(args: argparse.Namespace) -> dict[str, object]:
    from pypdf import PdfReader

    docx = args.docx.resolve()
    pdf = args.pdf.resolve()
    errors: list[str] = []
    warnings: list[str] = []
    metrics: dict[str, object] = {}

    if not docx.is_file():
        errors.append(f"DOCX不存在：{docx}")
    elif docx.suffix.lower() != ".docx":
        errors.append(f"DOCX扩展名错误：{docx.name}")
    if not pdf.is_file():
        errors.append(f"PDF不存在：{pdf}")
    elif pdf.suffix.lower() != ".pdf":
        errors.append(f"PDF扩展名错误：{pdf.name}")
    if docx.stem != pdf.stem:
        errors.append(f"主文件名不一致：{docx.stem!r} != {pdf.stem!r}")
    if errors:
        return {"status": "fail", "errors": errors, "warnings": warnings, "metrics": metrics}

    docx_text, docx_orientations = docx_payload(docx, errors)
    metrics["docx_sections"] = len(docx_orientations)
    metrics["docx_section_orientations"] = docx_orientations

    try:
        reader = PdfReader(str(pdf))
        if reader.is_encrypted:
            errors.append("PDF已加密，无法验收")
        pdf_pages = len(reader.pages)
        page_texts = [page.extract_text() or "" for page in reader.pages]
    except Exception as exc:
        errors.append(f"PDF不可读：{type(exc).__name__}: {exc}")
        return {"status": "fail", "errors": errors, "warnings": warnings, "metrics": metrics}

    metrics["pdf_bytes"] = pdf.stat().st_size
    metrics["pdf_pages"] = pdf_pages
    if pdf_pages < 1:
        errors.append("PDF没有页面")
    if args.expected_pages is not None and pdf_pages != args.expected_pages:
        errors.append(f"PDF页数不符合预期：{pdf_pages} != {args.expected_pages}")

    portrait = sum(float(page.mediabox.width) <= float(page.mediabox.height) for page in reader.pages)
    landscape = pdf_pages - portrait
    metrics["pdf_portrait_pages"] = portrait
    metrics["pdf_landscape_pages"] = landscape
    if "portrait" in docx_orientations and portrait == 0:
        errors.append("DOCX含纵向节，但PDF没有纵向页面")
    if "landscape" in docx_orientations and landscape == 0:
        errors.append("DOCX含横向节，但PDF没有横向页面")

    pdf_text = "\n".join(page_texts)
    normalized_docx = normalize_text(docx_text)
    normalized_pdf = normalize_text(pdf_text)
    if not normalized_docx:
        errors.append("DOCX无可比对正文文本")
        coverage = 0.0
    else:
        matcher = SequenceMatcher(None, normalized_docx, normalized_pdf, autojunk=False)
        coverage = sum(block.size for block in matcher.get_matching_blocks()) / len(normalized_docx)
        if coverage < args.min_text_coverage:
            errors.append(
                f"PDF正文覆盖率过低：{coverage:.4f} < {args.min_text_coverage:.4f}；疑似缺字、漏页或错误字体环境"
            )
    metrics["docx_normalized_chars"] = len(normalized_docx)
    metrics["pdf_normalized_chars"] = len(normalized_pdf)
    metrics["docx_text_coverage_in_pdf"] = round(coverage, 6)

    replacement_count = pdf_text.count("\ufffd")
    metrics["replacement_character_count"] = replacement_count
    if replacement_count:
        errors.append(f"PDF含Unicode替换字符：{replacement_count}")
    for term in args.require_term:
        if normalize_text(term) not in normalized_pdf:
            errors.append(f"PDF缺少必需文本：{term}")
    for term in args.forbid_term:
        if term and normalize_text(term) in normalized_pdf:
            errors.append(f"PDF含禁止残留词：{term}")
    if args.conclusion_term and normalize_text(args.conclusion_term) not in normalized_pdf:
        errors.append(f"PDF缺少投资结论标题：{args.conclusion_term}")

    if args.header_term:
        normalized_header = normalize_text(args.header_term)
        header_pages = sum(normalized_header in normalize_text(text) for text in page_texts)
        metrics["header_pages"] = header_pages
        if header_pages != pdf_pages:
            errors.append(f"页眉声明未覆盖全部PDF页面：{header_pages}/{pdf_pages}")

    if args.end_marker:
        marker_count = pdf_text.count(args.end_marker)
        metrics["end_marker_count"] = marker_count
        if marker_count != 1:
            errors.append(f"报告结束标记数量应为1，实际为{marker_count}")
        if marker_count == 1 and args.conclusion_term:
            conclusion_index = pdf_text.rfind(args.conclusion_term)
            if conclusion_index >= pdf_text.rfind(args.end_marker):
                errors.append("投资结论未位于报告结束标记之前")

    font_count, embedded_count = embedded_font_metrics(reader)
    metrics["unique_font_resources"] = font_count
    metrics["embedded_font_resources"] = embedded_count
    if not args.allow_unembedded_fonts and (font_count == 0 or embedded_count != font_count):
        errors.append(f"PDF字体未全部嵌入：{embedded_count}/{font_count}")

    rendered: list[Path] = []
    if args.render_dir is not None:
        render_dir = args.render_dir.resolve()
        if not render_dir.is_dir():
            errors.append(f"PDF渲染目录不存在：{render_dir}")
        else:
            rendered = sorted(render_dir.glob("page-*.png"), key=page_number)
            metrics["rendered_png_pages"] = len(rendered)
            if len(rendered) != pdf_pages:
                errors.append(f"PDF页数与渲染图数量不一致：{pdf_pages}页 != {len(rendered)}张")
            try:
                ratios = ink_ratios(rendered)
                minimum = min(ratios) if ratios else 0.0
                metrics["minimum_ink_ratio"] = round(minimum, 6)
                if minimum <= args.min_ink_ratio:
                    errors.append(f"渲染页疑似空白：最小墨迹率{minimum:.5f} <= {args.min_ink_ratio:.5f}")
            except ImportError:
                warnings.append("Pillow不可用，跳过像素级空白页检查")

    if args.baseline_render_dir is not None:
        baseline_dir = args.baseline_render_dir.resolve()
        baseline = sorted(baseline_dir.glob("page-*.png"), key=page_number) if baseline_dir.is_dir() else []
        metrics["baseline_png_pages"] = len(baseline)
        if not rendered:
            errors.append("使用--baseline-render-dir时必须同时提供有效--render-dir")
        elif len(baseline) != len(rendered):
            errors.append(f"当前渲染与基准页数不一致：{len(rendered)} != {len(baseline)}")
        else:
            try:
                identical = compare_renders(rendered, baseline)
                metrics["pixel_identical_pages"] = identical
                if identical != len(rendered):
                    errors.append(f"独立重渲染与基准不完全一致：{identical}/{len(rendered)}页像素一致")
            except ImportError:
                errors.append("Pillow不可用，无法执行独立重渲染像素比对")

    return {
        "status": "pass" if not errors else "fail",
        "errors": errors,
        "warnings": warnings,
        "metrics": metrics,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("docx", type=Path)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--render-dir", type=Path)
    parser.add_argument("--baseline-render-dir", type=Path)
    parser.add_argument("--expected-pages", type=int)
    parser.add_argument("--min-text-coverage", type=float, default=0.95)
    parser.add_argument("--min-ink-ratio", type=float, default=0.005)
    parser.add_argument("--require-term", action="append", default=[])
    parser.add_argument("--forbid-term", action="append", default=[])
    parser.add_argument("--header-term")
    parser.add_argument("--end-marker")
    parser.add_argument(
        "--report-stage",
        choices=(RECOMMENDATION_REPORT_STAGE, FINAL_REPORT_STAGE),
        default=RECOMMENDATION_REPORT_STAGE,
    )
    parser.add_argument("--conclusion-term")
    parser.add_argument("--allow-unembedded-fonts", action="store_true")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if args.conclusion_term is None:
        args.conclusion_term = (
            "投资结论及建议"
            if args.report_stage == RECOMMENDATION_REPORT_STAGE
            else "投资结论"
        )
    ensure_runtime(("pypdf", "PIL"))
    result = validate(args)
    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    print(rendered)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(rendered, encoding="utf-8")
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
