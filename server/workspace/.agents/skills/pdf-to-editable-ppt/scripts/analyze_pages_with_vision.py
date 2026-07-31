#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path


REGION_TYPES = {
    "flowchart",
    "table",
    "chart",
    "matrix",
    "icon-group",
    "photo",
    "screenshot",
    "illustration",
    "decoration",
    "watermark",
    "text-block",
    "unknown",
}
ACTIONS = {
    "semantic-rebuild",
    "ocr-text",
    "keep-raster",
    "review",
    "ignore",
}


def parse_pages(value: str | None) -> set[int] | None:
    if not value:
        return None
    pages: set[int] = set()
    for item in value.split(","):
        item = item.strip()
        if not item:
            continue
        if "-" in item:
            start, end = item.split("-", 1)
            pages.update(range(int(start), int(end) + 1))
        else:
            pages.add(int(item))
    return pages


def ordered_renders(render_dir: Path) -> dict[int, Path]:
    result: dict[int, Path] = {}
    for path in render_dir.glob("slide-*.png"):
        match = re.search(r"(\d+)$", path.stem)
        if match:
            result[int(match.group(1))] = path
    return result


def normalize_bbox(value) -> list[float] | None:
    if not isinstance(value, list) or len(value) != 4:
        return None
    try:
        x, y, width, height = [float(item) for item in value]
    except (TypeError, ValueError):
        return None
    x = max(0.0, min(1.0, x))
    y = max(0.0, min(1.0, y))
    width = max(0.0, min(1.0 - x, width))
    height = max(0.0, min(1.0 - y, height))
    if width <= 0 or height <= 0:
        return None
    return [round(x, 6), round(y, 6), round(width, 6), round(height, 6)]


def normalize_confidence(value) -> float:
    try:
        return round(max(0.0, min(1.0, float(value))), 4)
    except (TypeError, ValueError):
        return 0.0


def normalize_region(region: dict, page_number: int, index: int) -> dict | None:
    bbox = normalize_bbox(region.get("bbox"))
    if bbox is None:
        return None
    region_type = str(region.get("type") or "unknown").strip().lower()
    if region_type not in REGION_TYPES:
        region_type = "unknown"
    action = str(region.get("recommendedAction") or "review").strip().lower()
    if action not in ACTIONS:
        action = "review"
    result = {
        "id": str(region.get("id") or f"p{page_number:02d}-r{index:03d}"),
        "type": region_type,
        "bbox": bbox,
        "recommendedAction": action,
        "confidence": normalize_confidence(region.get("confidence")),
        "reconstructionComplete": bool(region.get("reconstructionComplete")),
        "objects": region.get("objects") if isinstance(region.get("objects"), list) else [],
    }
    for key in ("summary", "coverFill", "sourceImageElementIndex", "notes"):
        if key in region:
            result[key] = region[key]
    return result


def normalize_analysis(payload: dict, page_number: int) -> dict:
    if isinstance(payload.get("analysis"), dict):
        payload = payload["analysis"]
    regions = []
    for index, region in enumerate(payload.get("regions") or [], 1):
        if isinstance(region, dict):
            normalized = normalize_region(region, page_number, index)
            if normalized:
                regions.append(normalized)
    return {
        "page": page_number,
        "pageType": str(payload.get("pageType") or "unknown"),
        "coordinateSpace": "normalized-top-left",
        "confidence": normalize_confidence(payload.get("confidence")),
        "regions": regions,
    }


def page_facts(page: dict) -> dict:
    elements = []
    for index, element in enumerate(page.get("elements") or []):
        item = {
            "id": f"p{int(page['number']):02d}-e{index:04d}",
            "index": index,
            "kind": element.get("kind"),
            "bbox": element.get("bbox"),
        }
        if element.get("kind") == "text":
            item["text"] = str(element.get("text") or "")[:500]
            item["fontSize"] = element.get("font_size")
        elif element.get("kind") == "image":
            item["assetName"] = Path(str(element.get("asset") or "")).name
        elements.append(item)
    return {
        "page": page["number"],
        "width": page["width"],
        "height": page["height"],
        "elements": elements,
    }


def target_pages(route_report: dict, explicit: set[int] | None) -> list[int]:
    if explicit is not None:
        return sorted(explicit)
    selected = []
    for page in route_report.get("pages") or []:
        if page.get("flattened") or page.get("embedded_image_candidates"):
            selected.append(int(page["page"]))
    return sorted(set(selected))


def http_analysis(
    endpoint: str,
    image_path: Path,
    facts: dict,
    timeout_seconds: int,
    api_key_env: str,
) -> dict:
    payload = {
        "schemaVersion": "1.0",
        "task": "analyze-pdf-slide-for-editable-reconstruction",
        "instructions": (
            "Return JSON only. Identify semantic regions and optional reconstruction "
            "objects. Do not rewrite source text, invent numbers, or claim precise "
            "coordinates. Use normalized top-left [x,y,width,height] coordinates. "
            "Use unknown/review when uncertain."
        ),
        "allowedRegionTypes": sorted(REGION_TYPES),
        "allowedActions": sorted(ACTIONS),
        "pdfFacts": facts,
        "image": {
            "mimeType": "image/png",
            "base64": base64.b64encode(image_path.read_bytes()).decode("ascii"),
        },
    }
    headers = {"Content-Type": "application/json"}
    api_key = os.environ.get(api_key_env)
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:2000]
        raise RuntimeError(f"视觉服务返回 HTTP {exc.code}：{detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"无法连接视觉服务：{exc}") from exc


def json_analysis(json_dir: Path, page_number: int) -> dict:
    candidates = [
        json_dir / f"page-{page_number:02d}.json",
        json_dir / f"slide-{page_number:02d}.json",
    ]
    for path in candidates:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    raise FileNotFoundError(
        f"缺少第 {page_number} 页视觉 JSON；已检查："
        + "、".join(str(path) for path in candidates)
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="通过可替换视觉服务分析 PDF 页面语义。")
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--route-report", required=True, type=Path)
    parser.add_argument("--render-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--mode", choices=("off", "audit", "assist", "required"), default="off")
    parser.add_argument("--provider", choices=("http", "json"), default="http")
    parser.add_argument("--endpoint")
    parser.add_argument("--json-dir", type=Path)
    parser.add_argument("--pages", help="页码列表，例如 1,3-5")
    parser.add_argument("--timeout-seconds", type=int, default=180)
    parser.add_argument("--api-key-env", default="PDF_PPT_VISION_API_KEY")
    args = parser.parse_args()

    model_path = args.model.expanduser().resolve()
    route_path = args.route_report.expanduser().resolve()
    render_dir = args.render_dir.expanduser().resolve()
    output = args.output.expanduser().resolve()
    model = json.loads(model_path.read_text(encoding="utf-8"))
    route_report = json.loads(route_path.read_text(encoding="utf-8"))
    renders = ordered_renders(render_dir)
    pages_by_number = {int(page["number"]): page for page in model.get("pages") or []}
    selected = target_pages(route_report, parse_pages(args.pages))

    report = {
        "schemaVersion": "1.0",
        "mode": args.mode,
        "provider": None if args.mode == "off" else args.provider,
        "coordinateSpace": "normalized-top-left",
        "selectedPages": selected,
        "pages": [],
        "errors": [],
    }
    if args.mode == "off":
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"视觉分析已关闭；写入 {output}")
        return
    if args.provider == "http" and not args.endpoint:
        raise ValueError("HTTP 视觉提供方需要 --endpoint")
    if args.provider == "json" and not args.json_dir:
        raise ValueError("JSON 视觉提供方需要 --json-dir")

    for page_number in selected:
        page = pages_by_number.get(page_number)
        image_path = renders.get(page_number)
        if page is None or image_path is None:
            message = f"第 {page_number} 页缺少 PDF 模型或渲染图"
            if args.mode == "required":
                raise RuntimeError(message)
            report["errors"].append(message)
            continue
        try:
            if args.provider == "http":
                raw = http_analysis(
                    args.endpoint,
                    image_path,
                    page_facts(page),
                    args.timeout_seconds,
                    args.api_key_env,
                )
            else:
                raw = json_analysis(args.json_dir.expanduser().resolve(), page_number)
            report["pages"].append(normalize_analysis(raw, page_number))
        except Exception as exc:
            if args.mode == "required":
                raise
            report["errors"].append(f"第 {page_number} 页视觉分析失败：{exc}")

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"视觉分析完成：{len(report['pages'])}/{len(selected)} 页；写入 {output}")


if __name__ == "__main__":
    main()
