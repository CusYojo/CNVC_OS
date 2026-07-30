#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from PIL import Image


SCRIPT_DIR = Path(__file__).resolve().parent
COMMON_TERMS = (
    "保密资料",
    "请勿外传",
    "仅供参考",
    "仅供项目评审使用",
    "仅供投资人参考",
    "仅供基金投资人参考",
    "内部资料",
    "未经授权",
    "未经许可",
    "机密",
    "样稿",
    "水印",
    "confidential",
    "draft",
    "watermark",
)
ROTATION_ANGLES = (0, -45, 45, -30, 30)


def normalize(value: str) -> str:
    return re.sub(r"[\W_]+", "", str(value or "").lower(), flags=re.UNICODE)


def unique_terms(values: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        normalized = normalize(value)
        if len(normalized) < 2 or normalized in seen:
            continue
        seen.add(normalized)
        result.append(str(value).strip())
    return result


def read_watermark_report(path: Path) -> tuple[dict, list[str]]:
    if not path.exists():
        return {}, []
    report = json.loads(path.read_text(encoding="utf-8"))
    entries = report.get("entries") or []
    terms = [
        str(item.get("text", "")).strip()
        for item in entries
        if isinstance(item, dict) and str(item.get("text", "")).strip()
    ]
    terms.extend(str(value) for value in report.get("custom_terms") or [])
    return report, terms


def package_text_by_part(pptx: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    with zipfile.ZipFile(pptx) as archive:
        for name in archive.namelist():
            lowered = name.lower()
            if not (
                lowered.endswith(".xml")
                or lowered.endswith(".svg")
                or lowered.endswith(".txt")
            ):
                continue
            data = archive.read(name)
            try:
                if lowered.endswith((".xml", ".svg")):
                    root = ET.fromstring(data)
                    text = " ".join(
                        value.strip()
                        for value in root.itertext()
                        if value and value.strip()
                    )
                else:
                    text = data.decode("utf-8", errors="ignore")
            except ET.ParseError:
                text = data.decode("utf-8", errors="ignore")
            if text:
                result[name] = text
    return result


def find_term_matches(texts: dict[str, str], terms: list[str]) -> list[dict]:
    matches: list[dict] = []
    normalized_terms = [(term, normalize(term)) for term in terms]
    for part, text in texts.items():
        normalized_text = normalize(text)
        for term, normalized_term in normalized_terms:
            if normalized_term and normalized_term in normalized_text:
                matches.append({"part": part, "term": term})
    return matches


def resolve_tesseract(value: str | None) -> str | None:
    candidate = value or shutil.which("tesseract")
    if not candidate:
        return None
    path = Path(candidate).expanduser()
    if path.is_absolute():
        return str(path.resolve()) if path.exists() else None
    resolved = shutil.which(str(path))
    return str(Path(resolved).resolve()) if resolved else None


def resolve_ocr_engine(
    requested: str,
    tesseract: str | None,
    timeout_seconds: int,
) -> str | None:
    if requested == "apple-vision":
        return "apple-vision" if shutil.which("swiftc") and sys_platform() == "darwin" else None
    if requested == "tesseract":
        return (
            "tesseract"
            if tesseract_chinese_ready(tesseract, timeout_seconds)
            else None
        )
    if sys_platform() == "darwin" and shutil.which("swiftc"):
        return "apple-vision"
    if tesseract_chinese_ready(tesseract, timeout_seconds):
        return "tesseract"
    return None


def sys_platform() -> str:
    if os.name == "nt":
        return "windows"
    return os.uname().sysname.lower() if hasattr(os, "uname") else os.name


def tesseract_chinese_ready(
    executable: str | None,
    timeout_seconds: int,
) -> bool:
    if not executable:
        return False
    try:
        result = subprocess.run(
            [executable, "--list-langs"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired:
        return False
    languages = set(result.stdout.split())
    return result.returncode == 0 and {"chi_sim", "eng"} <= languages


def compile_vision(binary: Path, timeout_seconds: int) -> None:
    subprocess.run(
        [
            shutil.which("swiftc") or "swiftc",
            str(SCRIPT_DIR / "vision_ocr.swift"),
            "-o",
            str(binary),
        ],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout_seconds,
    )


def ocr_with_vision(
    binary: Path,
    image: Path,
    output: Path,
    timeout_seconds: int,
) -> str:
    subprocess.run(
        [str(binary), str(image), str(output), "zh-Hans,en-US"],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout_seconds,
    )
    rows = json.loads(output.read_text(encoding="utf-8"))
    return "\n".join(
        str(row.get("text", ""))
        for row in rows
        if float(row.get("confidence", 0)) >= 0.25
    )


def ocr_with_tesseract(
    image: Path,
    executable: str,
    timeout_seconds: int,
) -> str:
    command = [
        executable,
        str(image),
        "stdout",
        "--psm",
        "11",
    ]
    try:
        attempt = subprocess.run(
            [*command, "-l", "chi_sim+eng"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"Tesseract OCR 超过 {timeout_seconds} 秒：{image.name}"
        ) from exc
    if attempt.returncode == 0:
        return attempt.stdout
    raise RuntimeError("Tesseract OCR 运行失败或缺少 chi_sim/eng 语言包")


def rotated_image(source: Path, angle: int, output: Path) -> Path:
    if angle == 0:
        return source
    with Image.open(source) as image:
        fill = "white" if image.mode in {"RGB", "L"} else (255, 255, 255, 0)
        rotated = image.rotate(angle, expand=True, fillcolor=fill)
        rotated.save(output)
    return output


def gray_watermark_mask(source: Path, output: Path) -> Path:
    with Image.open(source) as image:
        rgb = image.convert("RGB")
        mask = Image.new("L", rgb.size, 255)
        source_pixels = rgb.load()
        target_pixels = mask.load()
        width, height = rgb.size
        for y in range(height):
            for x in range(width):
                red, green, blue = source_pixels[x, y]
                average = (red + green + blue) / 3
                channel_range = max(red, green, blue) - min(red, green, blue)
                if channel_range <= 26 and 105 <= average <= 232:
                    target_pixels[x, y] = 0
        mask.save(output)
    return output


def scan_renders(
    render_dir: Path,
    terms: list[str],
    requested_engine: str,
    work_dir: Path,
    tesseract: str | None,
    timeout_seconds: int,
) -> tuple[str | None, list[dict], int]:
    images = sorted(
        [
            path
            for path in render_dir.glob("*")
            if path.suffix.lower() in {".png", ".jpg", ".jpeg"}
        ]
    )
    tesseract = resolve_tesseract(tesseract)
    engine = resolve_ocr_engine(
        requested_engine,
        tesseract,
        timeout_seconds,
    )
    if not images or not engine:
        return engine, [], len(images)
    binary = work_dir / "vision-ocr"
    if engine == "apple-vision":
        compile_vision(binary, timeout_seconds)
    normalized_terms = [(term, normalize(term)) for term in terms]
    matches: list[dict] = []
    for page_index, image_path in enumerate(images, 1):
        mask_path = gray_watermark_mask(
            image_path, work_dir / f"{image_path.stem}-gray-mask.png"
        )
        found_on_page = False
        for variant_name, variant_path in (
            ("original", image_path),
            ("gray-mask", mask_path),
        ):
            for angle in ROTATION_ANGLES:
                rotated = rotated_image(
                    variant_path,
                    angle,
                    work_dir
                    / f"{image_path.stem}-{variant_name}-rot{angle:+d}.png",
                )
                if engine == "apple-vision":
                    text = ocr_with_vision(
                        binary,
                        rotated,
                        work_dir
                        / f"{image_path.stem}-{variant_name}-rot{angle:+d}.json",
                        timeout_seconds,
                    )
                else:
                    text = ocr_with_tesseract(
                        rotated,
                        tesseract or "tesseract",
                        timeout_seconds,
                    )
                normalized_text = normalize(text)
                found = [
                    term
                    for term, normalized_term in normalized_terms
                    if normalized_term and normalized_term in normalized_text
                ]
                if found:
                    matches.append(
                        {
                            "page": page_index,
                            "image": str(image_path),
                            "variant": variant_name,
                            "rotation": angle,
                            "terms": found,
                        }
                    )
                    found_on_page = True
                    break
            if found_on_page:
                break
    return engine, matches, len(images)


def validate(
    pptx: Path,
    render_dir: Path,
    watermark_report_path: Path,
    mode: str,
    custom_terms: list[str],
    ocr_engine: str,
    tesseract: str | None,
    ocr_timeout_seconds: int,
) -> dict:
    watermark_report, report_terms = read_watermark_report(watermark_report_path)
    terms = unique_terms([*COMMON_TERMS, *report_terms, *custom_terms])
    errors: list[str] = []
    warnings: list[str] = []
    package_matches = find_term_matches(package_text_by_part(pptx), terms)
    if package_matches:
        errors.append("PPTX 包内仍包含目标水印文字")
    if watermark_report.get("mode") == "keep" and mode != "off":
        errors.append("转换过程使用了 keep 模式，不能作为无水印底稿交接")

    with tempfile.TemporaryDirectory(prefix="watermark-qa-") as temporary:
        engine, visual_matches, render_count = scan_renders(
            render_dir,
            terms,
            ocr_engine,
            Path(temporary),
            tesseract,
            ocr_timeout_seconds,
        )
    if mode == "strict":
        if render_count == 0:
            errors.append("严格水印验收未找到任何最终渲染图")
        if not engine:
            errors.append("严格水印验收缺少 Apple Vision 或 Tesseract OCR")
        if visual_matches:
            errors.append("最终渲染图中仍识别到目标水印")
    elif mode == "xml-only":
        if render_count == 0:
            warnings.append("未提供最终渲染图，只完成 PPTX 包内文字扫描")
        elif not engine:
            warnings.append("视觉 OCR 不可用，只完成 PPTX 包内文字扫描")
    elif mode == "off":
        warnings.append("水印交接验收已关闭，结果不得标记为无水印底稿")

    return {
        "passed": not errors and mode != "off",
        "mode": mode,
        "pptx": str(pptx),
        "renderDir": str(render_dir),
        "watermarkReport": str(watermark_report_path),
        "terms": terms,
        "packageMatches": package_matches,
        "visualOcrEngine": engine,
        "tesseract": resolve_tesseract(tesseract),
        "ocrTimeoutSeconds": ocr_timeout_seconds,
        "visualMatches": visual_matches,
        "renderCount": render_count,
        "errors": errors,
        "warnings": warnings,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="验证可编辑 PPTX 是否可作为无水印底稿交接。")
    parser.add_argument("--pptx", required=True, type=Path)
    parser.add_argument("--render-dir", required=True, type=Path)
    parser.add_argument("--watermark-report", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--mode",
        choices=("strict", "xml-only", "off"),
        default="strict",
    )
    parser.add_argument(
        "--ocr-engine",
        choices=("auto", "apple-vision", "tesseract"),
        default="auto",
    )
    parser.add_argument(
        "--tesseract",
        help="Tesseract 可执行文件路径；未设置时从 PATH 查找。",
    )
    parser.add_argument(
        "--ocr-timeout-seconds",
        type=int,
        default=120,
        help="每次 OCR 调用的超时秒数，默认 120。",
    )
    parser.add_argument("--watermark-text", action="append", default=[])
    args = parser.parse_args()

    pptx = args.pptx.expanduser().resolve()
    render_dir = args.render_dir.expanduser().resolve()
    watermark_report = args.watermark_report.expanduser().resolve()
    if not pptx.exists():
        raise FileNotFoundError(pptx)
    if not render_dir.exists():
        raise FileNotFoundError(render_dir)
    if args.ocr_timeout_seconds <= 0:
        raise ValueError("--ocr-timeout-seconds 必须大于 0")
    report = validate(
        pptx,
        render_dir,
        watermark_report,
        args.mode,
        args.watermark_text,
        args.ocr_engine,
        args.tesseract,
        args.ocr_timeout_seconds,
    )
    output = args.output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    if not report["passed"]:
        print("水印交接验收失败：")
        for error in report["errors"]:
            print("-", error)
        print(f"报告：{output}")
        raise SystemExit(1)
    print(
        f"水印交接验收通过：扫描 {report['renderCount']} 页，"
        f"OCR={report['visualOcrEngine']}"
    )
    for warning in report["warnings"]:
        print("警告：", warning)
    print(f"报告：{output}")


if __name__ == "__main__":
    main()
