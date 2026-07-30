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


SCRIPT_DIR = Path(__file__).resolve().parent
LINUX_REQUIRED_FONTS = ("Noto Sans CJK SC", "Noto Serif CJK SC")
# Minimal valid PPTX for LibreOffice headless smoke test
_MINIMAL_PPTX_BYTES = bytes.fromhex(
    "504b030414000600080000002100e98c03a24b010000"  # PK signature
    + "0000000013000800"  # ... etc.
)


def module_available(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def executable(name: str) -> str | None:
    value = shutil.which(name)
    return str(Path(value).resolve()) if value else None


def powerpoint_location() -> str | None:
    system = platform.system()
    if system == "Darwin":
        candidate = Path("/Applications/Microsoft PowerPoint.app")
        return str(candidate) if candidate.exists() else None
    if system == "Windows":
        roots = [
            os.environ.get("ProgramFiles"),
            os.environ.get("ProgramFiles(x86)"),
        ]
        patterns = (
            "Microsoft Office/root/Office*/POWERPNT.EXE",
            "Microsoft Office/Office*/POWERPNT.EXE",
        )
        for root in filter(None, roots):
            for pattern in patterns:
                matches = sorted(Path(root).glob(pattern))
                if matches:
                    return str(matches[-1])
    return None


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
        return {
            "available": [],
            "strict_ready": False,
            "error": f"Tesseract 语言检查超过 {timeout_seconds} 秒",
        }
    languages = sorted(
        value.strip()
        for value in result.stdout.splitlines()
        if value.strip() and not value.lower().startswith("list of available")
    )
    missing = sorted({"chi_sim", "eng"} - set(languages))
    return {
        "available": languages,
        "strict_ready": result.returncode == 0 and not missing,
        "missing_for_strict_qa": missing,
        "error": None if result.returncode == 0 else (result.stderr or "").strip(),
    }


def command_probe(
    path: str | None,
    arguments: tuple[str, ...],
    timeout_seconds: int,
) -> dict:
    if not path:
        return {"passed": False, "error": "未找到命令"}
    try:
        result = subprocess.run(
            [path, *arguments],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired:
        return {"passed": False, "error": f"命令检查超过 {timeout_seconds} 秒"}
    output = (result.stdout or result.stderr).strip()
    return {
        "passed": result.returncode == 0,
        "exitCode": result.returncode,
        "output": output[:1000],
        "error": None if result.returncode == 0 else output[:1000],
    }


def pptx_builder_runtime_probe(
    node: str | None,
    timeout_seconds: int,
) -> dict:
    if not node:
        return {"passed": False, "error": "未找到 Node.js"}
    runtime_uri = (
        SCRIPT_DIR / "public_pptx_runtime.mjs"
    ).resolve().as_uri()
    program = (
        f"const runtime = await import({json.dumps(runtime_uri)});"
        "const built = runtime.createPresentation(960, 540);"
        "if (!built?.pptx || built.slideWidth <= 0) process.exit(2);"
        "console.log(built.pptx.constructor.name);"
    )
    try:
        result = subprocess.run(
            [node, "--input-type=module", "--eval", program],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
            env=os.environ.copy(),
            cwd=os.getcwd(),
        )
    except subprocess.TimeoutExpired:
        return {
            "passed": False,
            "error": f"PptxGenJS 运行时检查超过 {timeout_seconds} 秒",
        }
    output = (result.stdout or result.stderr).strip()
    return {
        "passed": result.returncode == 0,
        "exitCode": result.returncode,
        "output": output[:1000],
        "error": None if result.returncode == 0 else output[:1000],
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
        try:
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
        except subprocess.TimeoutExpired:
            matches[family] = ""
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


def libreoffice_smoke_test(
    libreoffice: str | None,
    pdftoppm: str | None,
    timeout_seconds: int,
) -> dict:
    """Create a minimal PPTX, convert to PDF via LibreOffice, render with pdftoppm."""
    if not libreoffice:
        return {"passed": False, "error": "未找到 LibreOffice"}
    if not pdftoppm:
        return {"passed": False, "error": "未找到 pdftoppm"}

    environment = os.environ.copy()
    environment.pop("DISPLAY", None)
    environment.pop("WAYLAND_DISPLAY", None)

    try:
        with tempfile.TemporaryDirectory(prefix="lo-smoke-") as directory:
            work = Path(directory)

            # Create a minimal PPTX with python zipfile
            import zipfile
            pptx_path = work / "smoke.pptx"
            _write_minimal_pptx(pptx_path)

            # Convert PPTX → PDF via LibreOffice headless
            lo_result = subprocess.run(
                [
                    libreoffice,
                    "--headless",
                    "--convert-to", "pdf",
                    "--outdir", str(work),
                    str(pptx_path),
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout_seconds,
                env=environment,
                cwd=str(work),
            )
            pdf_path = work / "smoke.pdf"
            if not pdf_path.exists():
                return {
                    "passed": False,
                    "error": (
                        f"LibreOffice PDF 导出失败（退出码 {lo_result.returncode}）："
                        f"{(lo_result.stderr or lo_result.stdout).strip()[-500:]}"
                    ),
                }

            # Render PDF → PNG via pdftoppm
            ppm_result = subprocess.run(
                [
                    pdftoppm,
                    "-png", "-r", "72",
                    "-singlefile",
                    str(pdf_path),
                    str(work / "slide"),
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout_seconds,
                env=environment,
            )
            png_path = work / "slide.png"
            if not png_path.exists():
                return {
                    "passed": False,
                    "error": (
                        f"pdftoppm 渲染失败（退出码 {ppm_result.returncode}）："
                        f"{(ppm_result.stderr or ppm_result.stdout).strip()[-500:]}"
                    ),
                }

            png_size = png_path.stat().st_size
            pdf_size = pdf_path.stat().st_size
            if png_size < 100 or pdf_size < 500:
                return {
                    "passed": False,
                    "error": f"渲染产物异常小：PNG={png_size} 字节，PDF={pdf_size} 字节",
                }

            return {
                "passed": True,
                "error": None,
                "pdfSize": pdf_size,
                "pngSize": png_size,
            }

    except subprocess.TimeoutExpired:
        return {
            "passed": False,
            "error": f"LibreOffice 无头冒烟测试超过 {timeout_seconds} 秒",
        }
    except Exception as exc:
        return {"passed": False, "error": str(exc)}


def _write_minimal_pptx(output_path: Path) -> None:
    """Write a minimal valid PPTX with a single text slide using zipfile + Open XML."""
    import zipfile

    # Minimal Open XML content types, relationships, and slide content
    content_types_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
        '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
        '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
        '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
        "</Types>"
    )

    rels_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>'
        "</Relationships>"
    )

    ppt_rels_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>'
        "</Relationships>"
    )

    presentation_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
        ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
        ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
        '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
        '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>'
        '<p:sldSz cx="9144000" cy="6858000" type="screen4x3"/>'
        "</p:presentation>"
    )

    slide_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
        ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
        ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
        '<p:cSld>'
        '<p:spTree>'
        '<p:sp>'
        '<p:nvSpPr><p:cNvPr id="1" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/>'
        "</p:nvSpPr>"
        '<p:spPr><a:xfrm><a:off x="914400" y="2743200"/><a:ext cx="7315200" cy="1371600"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
        '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="2400"/>'
        "<a:t>Linux OpenXML 环境冒烟测试</a:t></a:r></a:p></p:txBody>"
        "</p:sp>"
        "</p:spTree>"
        "</p:cSld>"
        '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>'
        "</p:sld>"
    )

    # Minimal slide master and layout
    slide_master = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
        ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
        ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<p:cSld><p:bg><p:bgRef idx="1001"><a:srgbClr val="FFFFFF"/></p:bgRef></p:bg>'
        '<p:spTree/></p:cSld>'
        '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
        "</p:sldMaster>"
    )

    slide_master_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout"'
        ' Target="../slideLayouts/slideLayout1.xml"/>'
        "</Relationships>"
    )

    slide_layout = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
        ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
        '<p:cSld name="Blank"><p:spTree/></p:cSld>'
        "</p:sldLayout>"
    )

    slide_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout"'
        ' Target="../slideLayouts/slideLayout1.xml"/>'
        "</Relationships>"
    )

    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", content_types_xml)
        zf.writestr("_rels/.rels", rels_xml)
        zf.writestr("ppt/_rels/presentation.xml.rels", ppt_rels_xml)
        zf.writestr("ppt/presentation.xml", presentation_xml)
        zf.writestr("ppt/slides/slide1.xml", slide_xml)
        zf.writestr("ppt/slides/_rels/slide1.xml.rels", slide_rels)
        zf.writestr("ppt/slideMasters/slideMaster1.xml", slide_master)
        zf.writestr("ppt/slideMasters/_rels/slideMaster1.xml.rels", slide_master_rels)
        zf.writestr("ppt/slideLayouts/slideLayout1.xml", slide_layout)


def build_report(
    libreoffice_override: str | None,
    pdftoppm_override: str | None,
    smoke_timeout_seconds: int,
) -> dict:
    system = platform.system()
    libreoffice = libreoffice_override or executable("libreoffice") or executable("soffice")
    commands = {
        "node": executable("node"),
        "pdftoppm": pdftoppm_override or executable("pdftoppm"),
        "tesseract": executable("tesseract"),
        "swiftc": executable("swiftc") if system == "Darwin" else None,
        "libreoffice": libreoffice,
        "powershell": (
            executable("powershell") or executable("pwsh")
            if system == "Windows"
            else None
        ),
        "powerpoint": powerpoint_location(),
    }
    modules = {
        "PyMuPDF": module_available("fitz"),
        "Pillow": module_available("PIL"),
        "opencv-python-headless": module_available("cv2"),
    }
    tesseract = tesseract_languages(commands["tesseract"], smoke_timeout_seconds)
    command_checks = {
        "pptx_builder": pptx_builder_runtime_probe(
            commands["node"], smoke_timeout_seconds
        ),
        "pdftoppm": command_probe(
            commands["pdftoppm"], ("-v",), smoke_timeout_seconds
        ),
        "libreoffice": command_probe(
            commands["libreoffice"], ("--version",), smoke_timeout_seconds
        ),
    }
    libreoffice_smoke = libreoffice_smoke_test(
        commands["libreoffice"],
        commands["pdftoppm"],
        smoke_timeout_seconds,
    )
    fonts = font_matches()
    temporary_storage = writable_temp_check()
    if system == "Darwin" and commands["swiftc"]:
        automatic_ocr = "apple-vision"
        strict_watermark_qa_ready = True
    elif commands["tesseract"]:
        automatic_ocr = "tesseract"
        strict_watermark_qa_ready = bool(tesseract["strict_ready"])
    else:
        automatic_ocr = None
        strict_watermark_qa_ready = False
    missing_core = [
        name
        for name, present in {
            "LibreOffice": commands["libreoffice"] is not None,
            "Poppler pdftoppm": command_checks["pdftoppm"]["passed"],
            "PptxGenJS 构建运行时": command_checks["pptx_builder"]["passed"],
            "PyMuPDF": modules["PyMuPDF"],
            "Pillow": modules["Pillow"],
            "LibreOffice + pdftoppm 渲染冒烟": libreoffice_smoke["passed"],
            "可写临时目录": temporary_storage["passed"],
        }.items()
        if not present
    ]
    core_ready = not missing_core
    linux_visual_qa_ready = (
        system != "Linux"
        or (fonts["ready"] and command_checks["libreoffice"]["passed"] and libreoffice_smoke["passed"])
    )
    ready_for_default_workflow = (
        core_ready
        and strict_watermark_qa_ready
        and linux_visual_qa_ready
    )
    return {
        "platform": {
            "system": system,
            "release": platform.release(),
            "machine": platform.machine(),
            "python": os.path.realpath(os.sys.executable),
            "python_version": platform.python_version(),
            "libc": list(platform.libc_ver()),
            "display": os.environ.get("DISPLAY"),
            "wayland_display": os.environ.get("WAYLAND_DISPLAY"),
        },
        "commands": commands,
        "command_checks": command_checks,
        "python_modules": modules,
        "libreoffice_smoke": libreoffice_smoke,
        "tesseract": tesseract,
        "fonts": fonts,
        "temporary_storage": temporary_storage,
        "core_ready": core_ready,
        "missing_core": missing_core,
        "automatic_ocr": automatic_ocr,
        "strict_watermark_qa_ready": strict_watermark_qa_ready,
        "linux_visual_qa_ready": linux_visual_qa_ready,
        "ocr_ready": bool(
            automatic_ocr
            and modules["opencv-python-headless"]
            and strict_watermark_qa_ready
        ),
        "ready_for_default_workflow": ready_for_default_workflow,
        "powerpoint_native_validation_available": bool(commands["powerpoint"]),
        "linux_compatibility_smoke_available": bool(
            command_checks["libreoffice"]["passed"] and libreoffice_smoke["passed"]
        ),
    }


def print_human(report: dict) -> None:
    current = report["platform"]
    print(f"系统：{current['system']} {current['release']} ({current['machine']})")
    print(f"Python：{current['python']}")
    for label, key in (
        ("Node.js", "node"),
        ("Poppler pdftoppm", "pdftoppm"),
        ("Tesseract", "tesseract"),
        ("Swift 编译器", "swiftc"),
        ("LibreOffice", "libreoffice"),
        ("Microsoft PowerPoint", "powerpoint"),
    ):
        print(f"{label}：{report['commands'][key] or '未找到'}")
    builder = report["command_checks"]["pptx_builder"]
    print(f"PptxGenJS 构建运行时：{'通过' if builder['passed'] else '失败'}")
    if builder.get("error"):
        print("  " + str(builder["error"]).replace("\n", "\n  "))
    for label, present in report["python_modules"].items():
        print(f"Python {label}：{'已安装' if present else '未安装'}")
    smoke = report["libreoffice_smoke"]
    print(f"LibreOffice + pdftoppm 渲染冒烟：{'通过' if smoke['passed'] else '失败'}")
    if smoke.get("error"):
        print("  " + str(smoke["error"]).replace("\n", "\n  "))
    if report["commands"]["tesseract"]:
        languages = ", ".join(report["tesseract"]["available"]) or "无"
        print(f"Tesseract 语言：{languages}")
    if report["platform"]["system"] == "Linux":
        print(
            "Linux CJK 字体："
            + ("可用" if report["fonts"]["ready"] else "缺失或发生回退")
        )
        print(
            "Linux 替代视觉 QA："
            + ("可用" if report["linux_visual_qa_ready"] else "不可用")
        )
    print(
        "核心转换环境："
        + ("可用" if report["core_ready"] else "缺少 " + "、".join(report["missing_core"]))
    )
    print(
        "严格水印验收："
        + ("可用" if report["strict_watermark_qa_ready"] else "不可用")
    )
    print(
        "默认严格流程："
        + ("可用" if report["ready_for_default_workflow"] else "不可用")
    )
    if not report["powerpoint_native_validation_available"]:
        print("原生 PowerPoint 验证：不可用，交付时必须披露替代验证")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="检查 PDF 转可编辑 PPT Skill 的无头与跨平台运行环境。"
    )
    parser.add_argument("--json", action="store_true", help="输出 JSON 报告")
    parser.add_argument("--libreoffice", help="LibreOffice 可执行文件路径")
    parser.add_argument("--pdftoppm", help="pdftoppm 可执行文件路径")
    parser.add_argument(
        "--smoke-timeout-seconds",
        type=int,
        default=120,
        help="无头渲染和 OCR 语言检查的超时秒数，默认 120。",
    )
    args = parser.parse_args()
    if args.smoke_timeout_seconds <= 0:
        raise ValueError("--smoke-timeout-seconds 必须大于 0")
    report = build_report(
        args.libreoffice,
        args.pdftoppm,
        args.smoke_timeout_seconds,
    )
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print_human(report)
    raise SystemExit(0 if report["ready_for_default_workflow"] else 1)


if __name__ == "__main__":
    main()
