#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(
        description="验证 PDF 文字段落聚类没有丢字、空框或无效富文本结构。"
    )
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--grouping-report", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--require-paragraph-coverage",
        action="store_true",
        help="存在可合并段落候选却仍未合并时令验证失败。",
    )
    args = parser.parse_args()

    model_path = args.model.expanduser().resolve()
    grouping_report_path = args.grouping_report.expanduser().resolve()
    output_path = args.output.expanduser().resolve()
    model = json.loads(model_path.read_text(encoding="utf-8"))
    grouping_report = json.loads(
        grouping_report_path.read_text(encoding="utf-8")
    )

    errors = []
    grouped_objects = 0
    grouped_source_lines = 0
    style_values = {}
    for page in model.get("pages") or []:
        elements = page.get("elements")
        flattened = elements is None
        if flattened:
            elements = page.get("text") or []
        for index, element in enumerate(elements or []):
            if not flattened and element.get("kind") != "text":
                continue
            text = str(element.get("text") or "")
            if not text:
                errors.append(
                    f"第 {page.get('number')} 页文字对象 {index} 为空"
                )
            bbox = element.get("bbox") or [
                element.get("left"),
                element.get("top"),
                float(element.get("left") or 0)
                + float(element.get("width") or 0),
                float(element.get("top") or 0)
                + float(element.get("height") or 0),
            ]
            if (
                len(bbox) != 4
                or float(bbox[2]) <= float(bbox[0])
                or float(bbox[3]) <= float(bbox[1])
            ):
                errors.append(
                    f"第 {page.get('number')} 页文字对象 {index} bbox 无效"
                )
            source_line_count = int(
                element.get("source_line_count") or 1
            )
            style_id = element.get("style_id")
            if style_id:
                style_values.setdefault(style_id, set()).add(
                    (
                        str(element.get("font") or ""),
                        round(
                            float(
                                element.get("font_size_pt")
                                or element.get("font_size")
                                or 0
                            ),
                            2,
                        ),
                    )
                )
            if source_line_count <= 1:
                continue
            grouped_objects += 1
            grouped_source_lines += source_line_count
            source_lines = element.get("source_lines") or []
            if len(source_lines) != source_line_count:
                errors.append(
                    f"第 {page.get('number')} 页段落 {index} 的源行数量不一致"
                )
            runs = element.get("runs") or []
            if not runs:
                errors.append(
                    f"第 {page.get('number')} 页段落 {index} 缺少富文本 runs"
                )
            elif "".join(str(run.get("text") or "") for run in runs) != text:
                errors.append(
                    f"第 {page.get('number')} 页段落 {index} 的 runs 与文字不一致"
                )

    if not grouping_report.get("passed"):
        errors.append("提取阶段文字完整性校验未通过")
    if grouped_objects != int(
        grouping_report.get("groupedParagraphCount") or 0
    ):
        errors.append("模型中的段落数量与聚类报告不一致")
    if grouped_source_lines != int(
        grouping_report.get("groupedSourceLineCount") or 0
    ):
        errors.append("模型中的段落源行数量与聚类报告不一致")
    inconsistent_styles = {
        style_id: sorted(values)
        for style_id, values in style_values.items()
        if len(values) > 1
    }
    if inconsistent_styles:
        errors.append(
            "相同 style_id 出现不同字体或字号："
            + "、".join(sorted(inconsistent_styles)[:5])
        )
    unmerged_candidates = int(
        grouping_report.get("unmergedParagraphCandidateCount") or 0
    )
    if args.require_paragraph_coverage and unmerged_candidates:
        errors.append(
            f"仍有 {unmerged_candidates} 个多行段落候选未合并"
        )

    result = {
        "schemaVersion": "1.0",
        "passed": not errors,
        "mode": grouping_report.get("mode"),
        "lineBreakMode": grouping_report.get("lineBreakMode"),
        "inputTextObjectCount": grouping_report.get(
            "inputTextObjectCount", 0
        ),
        "outputTextObjectCount": grouping_report.get(
            "outputTextObjectCount", 0
        ),
        "textObjectReduction": grouping_report.get(
            "textObjectReduction", 0
        ),
        "groupedParagraphCount": grouped_objects,
        "groupedSourceLineCount": grouped_source_lines,
        "paragraphCandidateCount": grouping_report.get(
            "paragraphCandidateCount", 0
        ),
        "unmergedParagraphCandidateCount": unmerged_candidates,
        "typographyStyleCount": len(style_values),
        "inconsistentTypographyStyles": inconsistent_styles,
        "errors": errors,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(result, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    if errors:
        raise RuntimeError(
            f"文字段落聚类验证失败：{'; '.join(errors[:5])}"
        )
    print(
        "文字段落聚类验证通过："
        f"{grouped_source_lines} 行合并为 {grouped_objects} 个段落文本框，"
        f"文字对象减少 {result['textObjectReduction']} 个"
    )


if __name__ == "__main__":
    main()
