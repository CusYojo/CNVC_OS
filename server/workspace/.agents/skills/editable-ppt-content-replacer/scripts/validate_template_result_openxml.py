#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

from openxml_runtime import analyze_pptx, read_json, write_json


def main() -> None:
    parser = argparse.ArgumentParser(
        description="使用公开 OpenXML 运行时验证模板原位替换保真度。"
    )
    parser.add_argument("--template", required=True, type=Path)
    parser.add_argument("--result", required=True, type=Path)
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    before = analyze_pptx(args.template.expanduser().resolve())
    after = analyze_pptx(args.result.expanduser().resolve())
    plan = read_json(args.plan.expanduser().resolve())
    errors: list[str] = []
    authorized_text: dict[tuple[int, int], str] = {}
    authorized_media: dict[tuple[int, int], str] = {}
    authorized_additions: dict[tuple[int, int], dict] = {}
    for operation in plan.get("operations") or []:
        if operation.get("action") == "add_disclaimer_textbox":
            authorized_additions[
                (int(operation["slide"]), int(operation["shapeId"]))
            ] = operation
            continue
        action = operation.get("action")
        slide = int(operation["slide"])
        if action == "replace_text_group":
            identifiers = [int(value) for value in operation.get("shapeIds") or []]
            primary = int(operation.get("primaryShapeId", identifiers[0]))
            for shape_id in identifiers:
                authorized_text[(slide, shape_id)] = (
                    str(operation.get("text", ""))
                    if shape_id == primary
                    else ""
                )
        elif action == "replace_text":
            authorized_text[(slide, int(operation["shapeId"]))] = str(
                operation.get("text", "")
            )
        elif action == "replace_image":
            asset = Path(str(operation.get("asset", ""))).expanduser().resolve()
            if not asset.is_file():
                errors.append(f"授权图片素材不存在：{asset}")
                continue
            actual_sha256 = hashlib.sha256(asset.read_bytes()).hexdigest()
            expected_sha256 = str(operation.get("assetSha256", ""))
            if expected_sha256 and actual_sha256 != expected_sha256:
                errors.append(f"授权图片素材 SHA-256 不一致：{asset}")
            authorized_media[(slide, int(operation["shapeId"]))] = actual_sha256

    for key, label in (
        ("slideCount", "页面数量"),
        ("layoutCount", "版式数量"),
        ("masterCount", "母版数量"),
    ):
        if before[key] != after[key]:
            errors.append(f"{label}变化：{before[key]} -> {after[key]}")
    for source_slide in before["slides"]:
        page = source_slide["number"]
        if page > len(after["slides"]):
            continue
        result_slide = after["slides"][page - 1]
        for key, label in (
            ("widthEmu", "画布宽度"),
            ("heightEmu", "画布高度"),
            ("layoutId", "版式引用"),
        ):
            if source_slide[key] != result_slide[key]:
                errors.append(f"第 {page} 页{label}发生变化")
        additions_on_slide = sum(
            page == key[0] for key in authorized_additions
        )
        expected_object_count = len(source_slide["objects"]) + additions_on_slide
        if expected_object_count != len(result_slide["objects"]):
            errors.append(
                f"第 {page} 页对象数量变化："
                f"期望 {expected_object_count}，实际 {len(result_slide['objects'])}"
            )
        targets = {
            item["shapeId"]: item for item in result_slide["objects"]
        }
        for source_object in source_slide["objects"]:
            shape_id = source_object["shapeId"]
            target = targets.get(shape_id)
            if target is None:
                errors.append(f"第 {page} 页 shapeId={shape_id} 丢失")
                continue
            for key, label in (
                ("kind", "类型"),
                ("bbox", "坐标尺寸"),
                ("textStyle", "文字样式"),
            ):
                if source_object[key] != target[key]:
                    errors.append(
                        f"第 {page} 页 shapeId={shape_id} {label}变化"
                    )
            media_key = (page, shape_id)
            expected_media = authorized_media.get(media_key)
            if expected_media is not None:
                if target.get("media") != expected_media:
                    errors.append(
                        f"第 {page} 页 shapeId={shape_id} 未写入授权图片"
                    )
            elif source_object["media"] != target["media"]:
                errors.append(
                    f"第 {page} 页 shapeId={shape_id} 发生未授权媒体修改"
                )
            expected = authorized_text.get((page, shape_id))
            if expected is not None:
                if target["text"] != expected:
                    errors.append(
                        f"第 {page} 页 shapeId={shape_id} 未写入计划文字"
                    )
            elif source_object["text"] != target["text"]:
                errors.append(
                    f"第 {page} 页 shapeId={shape_id} 发生未授权文字修改"
                )
        for key, operation in authorized_additions.items():
            if key[0] != page:
                continue
            target = targets.get(key[1])
            if target is None:
                errors.append(
                    f"第 {page} 页受控责任声明 shapeId={key[1]} 未生成"
                )
                continue
            if target.get("name") != operation.get("name"):
                errors.append(
                    f"第 {page} 页受控责任声明 shapeId={key[1]} 名称不符"
                )
            if target.get("kind") != "shape:textbox":
                errors.append(
                    f"第 {page} 页受控责任声明 shapeId={key[1]} 不是可编辑文本框"
                )
            if target.get("text") != operation.get("text"):
                errors.append(
                    f"第 {page} 页受控责任声明 shapeId={key[1]} 文字不符"
                )
            if target.get("bbox") != [
                round(float(value), 2) for value in operation.get("bbox", [])
            ]:
                errors.append(
                    f"第 {page} 页受控责任声明 shapeId={key[1]} 坐标尺寸不符"
                )

    object_count_before = sum(
        len(slide["objects"]) for slide in before["slides"]
    )
    object_count_after = sum(
        len(slide["objects"]) for slide in after["slides"]
    )
    report = {
        "passed": not errors,
        "runtime": "openxml-stdlib",
        "template": str(args.template.expanduser().resolve()),
        "result": str(args.result.expanduser().resolve()),
        "authorizedTargetCount": len(authorized_text) + len(authorized_media),
        "authorizedTextTargetCount": len(authorized_text),
        "authorizedImageTargetCount": len(authorized_media),
        "authorizedAddedDisclaimerTextBoxCount": len(authorized_additions),
        "slideCountPreserved": before["slideCount"] == after["slideCount"],
        "layoutCountPreserved": before["layoutCount"] == after["layoutCount"],
        "masterCountPreserved": before["masterCount"] == after["masterCount"],
        "mediaChangesLimitedToAuthorizedTargets": not any(
            "未授权媒体修改" in error for error in errors
        ),
        "errors": errors,
        "before": {
            "slideCount": before["slideCount"],
            "layoutCount": before["layoutCount"],
            "masterCount": before["masterCount"],
            "mediaCount": len(before["mediaIds"]),
            "objectCount": object_count_before,
        },
        "after": {
            "slideCount": after["slideCount"],
            "layoutCount": after["layoutCount"],
            "masterCount": after["masterCount"],
            "mediaCount": len(after["mediaIds"]),
            "objectCount": object_count_after,
        },
    }
    write_json(args.output.expanduser().resolve(), report)
    if errors:
        for error in errors[:50]:
            print("-", error)
        raise SystemExit(f"模板保真校验失败，共 {len(errors)} 项差异")
    print(
        "模板保真校验通过："
        f"{before['slideCount']} 页、{object_count_before} 个模板对象、"
        f"{len(authorized_additions)} 个受控责任声明文本框、"
        f"{len(authorized_media)} 个授权图片槽完成替换"
    )


if __name__ == "__main__":
    main()
