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

from vision_schema import validate_qa_payload


def renders_by_page(directory: Path) -> dict[int, Path]:
    result = {}
    for path in directory.glob("slide-*.png"):
        match = re.search(r"(\d+)$", path.stem)
        if match:
            result[int(match.group(1))] = path
    return result


def normalized_result(payload: dict, page: int, require_foreground: bool) -> dict:
    validate_qa_payload(payload)
    if isinstance(payload.get("review"), dict):
        payload = payload["review"]
    issues = payload.get("issues") if isinstance(payload.get("issues"), list) else []
    foreground_passed = payload.get("foregroundPassed")
    if require_foreground and foreground_passed is not True:
        issues = [
            *issues,
            {
                "type": "foreground-editability",
                "severity": "blocking",
                "description": "未确认可编辑前景不存在重复原文或遗漏的必需对象",
            },
        ]
    return {
        "page": page,
        "passed": (
            bool(payload.get("passed"))
            and not issues
            and (not require_foreground or foreground_passed is True)
        ),
        "foregroundPassed": (
            foreground_passed
            if isinstance(foreground_passed, bool)
            else None
        ),
        "confidence": max(0.0, min(1.0, float(payload.get("confidence") or 0))),
        "issues": issues,
        "summary": str(payload.get("summary") or ""),
    }


def request_review(
    endpoint: str,
    source: Path,
    rendered: Path,
    foreground: Path | None,
    timeout_seconds: int,
    api_key_env: str,
) -> dict:
    payload = {
        "schemaVersion": "1.0",
        "task": "compare-pdf-source-and-ppt-render",
        "instructions": (
            "Return JSON only with passed, confidence, issues, and summary. "
            "Report missing or extra elements, changed text, incorrect connector "
            "direction, damaged background repairs, severe alignment differences, "
            "or chart/table structure changes. If foregroundRender is present, also "
            "set foregroundPassed and fail it when editable foreground contains "
            "duplicate source text, flattened source content, or misses a required "
            "semantic object. Ignore minor antialiasing differences."
        ),
        "sourceImage": {
            "mimeType": "image/png",
            "base64": base64.b64encode(source.read_bytes()).decode("ascii"),
        },
        "pptRender": {
            "mimeType": "image/png",
            "base64": base64.b64encode(rendered.read_bytes()).decode("ascii"),
        },
    }
    if foreground is not None:
        payload["foregroundRender"] = {
            "mimeType": "image/png",
            "base64": base64.b64encode(foreground.read_bytes()).decode("ascii"),
        }
    headers = {"Content-Type": "application/json"}
    api_key = os.environ.get(api_key_env)
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:2000]
        raise RuntimeError(f"视觉 QA 服务返回 HTTP {exc.code}：{detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"无法连接视觉 QA 服务：{exc}") from exc


def json_review(directory: Path, page: int) -> dict:
    candidates = [
        directory / f"qa-page-{page:02d}.json",
        directory / f"review-page-{page:02d}.json",
    ]
    for path in candidates:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    raise FileNotFoundError(
        "缺少视觉 QA JSON；已检查：" + "、".join(str(path) for path in candidates)
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="使用可替换视觉服务复核源 PDF 与最终 PPT 渲染。")
    parser.add_argument("--source-render-dir", required=True, type=Path)
    parser.add_argument("--artifact-render-dir", required=True, type=Path)
    parser.add_argument("--foreground-render-dir", type=Path)
    parser.add_argument("--require-foreground", action="store_true")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--mode", choices=("off", "audit", "required"), default="audit")
    parser.add_argument("--provider", choices=("http", "json"), default="http")
    parser.add_argument("--endpoint")
    parser.add_argument("--json-dir", type=Path)
    parser.add_argument("--timeout-seconds", type=int, default=180)
    parser.add_argument("--api-key-env", default="PDF_PPT_VISION_API_KEY")
    args = parser.parse_args()

    source_renders = renders_by_page(args.source_render_dir.expanduser().resolve())
    artifact_renders = renders_by_page(args.artifact_render_dir.expanduser().resolve())
    foreground_renders = (
        renders_by_page(args.foreground_render_dir.expanduser().resolve())
        if args.foreground_render_dir
        else {}
    )
    output = args.output.expanduser().resolve()
    report = {
        "schemaVersion": "1.0",
        "mode": args.mode,
        "provider": None if args.mode == "off" else args.provider,
        "foregroundRequired": args.require_foreground,
        "passed": args.mode == "off",
        "pages": [],
        "errors": [],
    }
    if args.mode == "off":
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"视觉 QA 已关闭；写入 {output}")
        return
    if args.provider == "http" and not args.endpoint:
        raise ValueError("HTTP 视觉 QA 需要 --endpoint")
    if args.provider == "json" and not args.json_dir:
        raise ValueError("JSON 视觉 QA 需要 --json-dir")

    pages = sorted(set(source_renders) | set(artifact_renders))
    for page in pages:
        source = source_renders.get(page)
        rendered = artifact_renders.get(page)
        foreground = foreground_renders.get(page)
        if not source or not rendered:
            message = f"第 {page} 页缺少源渲染或最终渲染"
            if args.mode == "required":
                raise RuntimeError(message)
            report["errors"].append(message)
            continue
        if args.require_foreground and not foreground:
            message = f"第 {page} 页缺少可编辑前景渲染"
            if args.mode == "required":
                raise RuntimeError(message)
            report["errors"].append(message)
            continue
        try:
            if args.provider == "http":
                raw = request_review(
                    args.endpoint,
                    source,
                    rendered,
                    foreground,
                    args.timeout_seconds,
                    args.api_key_env,
                )
            else:
                raw = json_review(args.json_dir.expanduser().resolve(), page)
            report["pages"].append(
                normalized_result(raw, page, args.require_foreground)
            )
        except Exception as exc:
            if args.mode == "required":
                raise
            report["errors"].append(f"第 {page} 页视觉 QA 未完成：{exc}")

    report["passed"] = (
        len(report["pages"]) == len(pages)
        and not report["errors"]
        and all(page["passed"] for page in report["pages"])
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.mode == "required" and not report["passed"]:
        raise RuntimeError("视觉 QA 未通过")
    print(
        f"视觉 QA：{sum(page['passed'] for page in report['pages'])}/"
        f"{len(pages)} 页通过；写入 {output}"
    )


if __name__ == "__main__":
    main()
