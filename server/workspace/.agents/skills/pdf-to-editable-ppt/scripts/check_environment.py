#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import platform
import shutil
import subprocess
import tempfile
from pathlib import Path


LINUX_REQUIRED_FONTS = ("Noto Sans CJK SC", "Noto Serif CJK SC")


def module_available(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def executable(name: str) -> str | None:
    value = shutil.which(name)
    return str(Path(value).resolve()) if value else None


def command_probe(
    command: str | None,
    args: tuple[str, ...],
    timeout_seconds: int,
) -> dict:
    if not command:
        return {"passed": False, "error": "未找到命令"}
    try:
        result = subprocess.run(
            [command, *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired:
        return {"passed": False, "error": "命令检查超时"}
    output = (result.stdout or result.stderr).strip()
    return {
        "passed": result.returncode == 0,
        "exitCode": result.returncode,
        "output": output[:1000],
        "error": None if result.returncode == 0 else output[:1000],
    }


def tesseract_languages(path: str | None, timeout_seconds: int) -> dict:
    if not path:
        return {"available": [], "strict_ready": False, "error": "未找到 Tesseract"}
    try:
        result = subprocess.run(
            [path, "--list-langs"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired:
        return {"available": [], "strict_ready": False, "error": "检查语言包超时"}
    available = [
        line.strip()
        for line in result.stdout.splitlines()
        if line.strip() and "List of available languages" not in line
    ]
    required = {"chi_sim", "eng"}
    return {
        "available": available,
        "strict_ready": result.returncode == 0 and required.issubset(available),
        "missing_for_strict_qa": sorted(required.difference(available)),
        "error": None if result.returncode == 0 else result.stderr[-1000:],
    }


def font_matches() -> dict:
    if platform.system() != "Linux":
        return {"required": [], "matches": {}, "ready": True}
    fc_match = executable("fc-match")
    if not fc_match:
        return {
            "required": list(LINUX_REQUIRED_FONTS),
            "matches": {},
            "ready": False,
            "error": "未找到 fc-match",
        }
    matches: dict[str, str] = {}
    for family in LINUX_REQUIRED_FONTS:
        result = subprocess.run(
            [fc_match, "--format=%{family}", family],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
        )
        matches[family] = result.stdout.strip()
    return {
        "required": list(LINUX_REQUIRED_FONTS),
        "matches": matches,
        "ready": all(
            "Noto" in matches.get(family, "") and "CJK" in matches.get(family, "")
            for family in LINUX_REQUIRED_FONTS
        ),
    }


def writable_temp_check() -> dict:
    try:
        with tempfile.TemporaryDirectory(prefix="pdf-ppt-env-") as directory:
            probe = Path(directory) / "probe"
            probe.write_text("ok", encoding="utf-8")
            return {"passed": probe.read_text(encoding="utf-8") == "ok"}
    except OSError as exc:
        return {"passed": False, "error": str(exc)}


def public_runtime_smoke_test(
    node: str | None,
    libreoffice: str | None,
    pdftoppm: str | None,
    timeout_seconds: int,
) -> dict:
    if not node:
        return {"passed": False, "error": "未找到 Node.js"}
    if not libreoffice:
        return {"passed": False, "error": "未找到 LibreOffice"}
    if not pdftoppm:
        return {"passed": False, "error": "未找到 pdftoppm"}
    script = """
import PptxGenJS from "pptxgenjs";
const output = process.argv[1];
const pptx = new PptxGenJS();
pptx.layout = "LAYOUT_WIDE";
const slide = pptx.addSlide();
slide.addText("Linux public PPT runtime smoke", {
  x: 0.5, y: 0.5, w: 6, h: 0.5, fontFace: "Noto Sans CJK SC", fontSize: 24
});
slide.addNotes("[Sources]\\n- runtime smoke");
await pptx.writeFile({ fileName: output, compression: true });
"""
    environment = os.environ.copy()
    environment.pop("DISPLAY", None)
    environment.pop("WAYLAND_DISPLAY", None)
    try:
        with tempfile.TemporaryDirectory(prefix="public-ppt-smoke-") as directory:
            root = Path(directory)
            pptx = root / "smoke.pptx"
            profile = root / "lo-profile"
            profile.mkdir()
            result = subprocess.run(
                [node, "--input-type=module", "-e", script, str(pptx)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout_seconds,
                env=environment,
                cwd=Path.cwd(),
            )
            if result.returncode:
                return {
                    "passed": False,
                    "stage": "pptxgenjs",
                    "error": (result.stderr or result.stdout)[-3000:],
                }
            result = subprocess.run(
                [
                    libreoffice,
                    "--headless",
                    f"-env:UserInstallation={profile.as_uri()}",
                    "--convert-to",
                    "pdf",
                    "--outdir",
                    str(root),
                    str(pptx),
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout_seconds,
                env=environment,
            )
            if result.returncode or not (root / "smoke.pdf").exists():
                return {
                    "passed": False,
                    "stage": "libreoffice",
                    "error": (result.stderr or result.stdout)[-3000:],
                }
            result = subprocess.run(
                [pdftoppm, "-f", "1", "-singlefile", "-png", str(root / "smoke.pdf"), str(root / "smoke")],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout_seconds,
                env=environment,
            )
            png = root / "smoke.png"
            if result.returncode or not png.exists():
                return {
                    "passed": False,
                    "stage": "poppler",
                    "error": (result.stderr or result.stdout)[-3000:],
                }
            return {
                "passed": True,
                "stage": "complete",
                "pptxSize": pptx.stat().st_size,
                "pdfSize": (root / "smoke.pdf").stat().st_size,
                "pngSize": png.stat().st_size,
            }
    except subprocess.TimeoutExpired:
        return {"passed": False, "error": "公开 PPT 运行时冒烟测试超时"}


def build_report(node_override: str | None, timeout_seconds: int) -> dict:
    system = platform.system()
    commands = {
        "node": node_override or executable("node"),
        "pdftoppm": executable("pdftoppm"),
        "tesseract": executable("tesseract"),
        "libreoffice": executable("libreoffice") or executable("soffice"),
    }
    modules = {
        "PyMuPDF": module_available("fitz"),
        "Pillow": module_available("PIL"),
        "opencv-python-headless": module_available("cv2"),
    }
    tesseract = tesseract_languages(commands["tesseract"], timeout_seconds)
    fonts = font_matches()
    temporary = writable_temp_check()
    runtime = public_runtime_smoke_test(
        commands["node"],
        commands["libreoffice"],
        commands["pdftoppm"],
        timeout_seconds,
    )
    command_checks = {
        "pdftoppm": command_probe(commands["pdftoppm"], ("-v",), timeout_seconds),
        "libreoffice": command_probe(
            commands["libreoffice"], ("--version",), timeout_seconds
        ),
    }
    missing_core = [
        name
        for name, present in {
            "Node.js": commands["node"],
            "Poppler pdftoppm": command_checks["pdftoppm"]["passed"],
            "LibreOffice": command_checks["libreoffice"]["passed"],
            "PyMuPDF": modules["PyMuPDF"],
            "Pillow": modules["Pillow"],
            "OpenCV": modules["opencv-python-headless"],
            "PptxGenJS/OpenXML/LibreOffice 冒烟": runtime["passed"],
            "可写临时目录": temporary["passed"],
        }.items()
        if not present
    ]
    core_ready = not missing_core
    strict_watermark_qa_ready = bool(tesseract["strict_ready"])
    linux_visual_qa_ready = (
        system != "Linux"
        or (fonts["ready"] and command_checks["libreoffice"]["passed"])
    )
    return {
        "platform": {
            "system": system,
            "release": platform.release(),
            "machine": platform.machine(),
            "python": os.path.realpath(os.sys.executable),
            "python_version": platform.python_version(),
            "display": os.environ.get("DISPLAY"),
            "wayland_display": os.environ.get("WAYLAND_DISPLAY"),
        },
        "commands": commands,
        "command_checks": command_checks,
        "python_modules": modules,
        "pptx_runtime": {
            "name": "PptxGenJS + OpenXML stdlib + LibreOffice",
            "productionDeployable": True,
            "privatePackageRequired": False,
            "smoke_test": runtime,
        },
        "tesseract": tesseract,
        "fonts": fonts,
        "temporary_storage": temporary,
        "core_ready": core_ready,
        "missing_core": missing_core,
        "automatic_ocr": "tesseract" if commands["tesseract"] else None,
        "strict_watermark_qa_ready": strict_watermark_qa_ready,
        "linux_visual_qa_ready": linux_visual_qa_ready,
        "ocr_ready": bool(
            commands["tesseract"]
            and modules["opencv-python-headless"]
            and strict_watermark_qa_ready
        ),
        "ready_for_default_workflow": (
            core_ready and strict_watermark_qa_ready and linux_visual_qa_ready
        ),
        "powerpoint_native_validation_available": False,
        "linux_compatibility_smoke_available": runtime["passed"],
    }


def print_human(report: dict) -> None:
    current = report["platform"]
    print(f"系统：{current['system']} {current['release']} ({current['machine']})")
    print(f"Python：{current['python']}")
    for label, key in (
        ("Node.js", "node"),
        ("Poppler pdftoppm", "pdftoppm"),
        ("Tesseract", "tesseract"),
        ("LibreOffice", "libreoffice"),
    ):
        print(f"{label}：{report['commands'][key] or '未找到'}")
    for label, present in report["python_modules"].items():
        print(f"Python {label}：{'已安装' if present else '未安装'}")
    print(
        "公开 PPT 运行时："
        + ("通过" if report["pptx_runtime"]["smoke_test"]["passed"] else "失败")
    )
    print(
        "默认严格流程："
        + ("可用" if report["ready_for_default_workflow"] else "不可用")
    )
    if report["missing_core"]:
        print("缺少：" + "、".join(report["missing_core"]))


def main() -> None:
    parser = argparse.ArgumentParser(
        description="检查 PDF 转可编辑 PPT 的公开生产运行环境。"
    )
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--node")
    parser.add_argument("--smoke-timeout-seconds", type=int, default=120)
    args = parser.parse_args()
    report = build_report(args.node, args.smoke_timeout_seconds)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print_human(report)
    raise SystemExit(0 if report["ready_for_default_workflow"] else 1)


if __name__ == "__main__":
    main()
