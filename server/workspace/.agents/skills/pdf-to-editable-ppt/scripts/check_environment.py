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


MIN_ARTIFACT_TOOL_VERSION = (2, 7, 3)
LINUX_REQUIRED_FONTS = ("Noto Sans CJK SC", "Noto Serif CJK SC")


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


def parse_version(value: object) -> tuple[int, int, int]:
    parts = str(value or "0.0.0").split(".")
    result = []
    for part in parts[:3]:
        digits = "".join(character for character in part if character.isdigit())
        result.append(int(digits or 0))
    return tuple((result + [0, 0, 0])[:3])


def artifact_tool_candidates(explicit: Path | None) -> list[Path]:
    candidates: list[Path] = []
    configured = explicit or (
        Path(os.environ["ARTIFACT_TOOL_DIR"]).expanduser()
        if os.environ.get("ARTIFACT_TOOL_DIR")
        else None
    )
    if configured:
        candidates.append(configured.resolve())
    candidates.append(
        (
            Path.home()
            / ".cache"
            / "codex-runtimes"
            / "codex-primary-runtime"
            / "dependencies"
            / "node"
            / "node_modules"
            / "@oai"
            / "artifact-tool"
        ).resolve()
    )
    unique: list[Path] = []
    for candidate in candidates:
        if candidate not in unique:
            unique.append(candidate)
    return unique


def inspect_presentations_skill() -> dict:
    configured = os.environ.get("PRESENTATIONS_SKILL_DIR")
    candidates: list[Path] = []
    if configured:
        candidates.append(Path(configured).expanduser().resolve())
    root = (
        Path.home()
        / ".codex"
        / "plugins"
        / "cache"
        / "openai-primary-runtime"
        / "presentations"
    )
    candidates.extend(sorted(root.glob("*/skills/presentations"), reverse=True))
    for candidate in candidates:
        required = {
            "renderSlides": candidate / "container_tools" / "render_slides.py",
            "slidesTest": candidate / "container_tools" / "slides_test.py",
            "setupArtifactWorkspace": (
                candidate
                / "container_tools"
                / "setup_artifact_tool_workspace.mjs"
            ),
        }
        if candidate.exists():
            return {
                "path": str(candidate),
                "required": {
                    key: str(path) for key, path in required.items()
                },
                "ready": all(path.exists() for path in required.values()),
                "missing": [
                    key for key, path in required.items() if not path.exists()
                ],
            }
    return {
        "path": None,
        "required": {},
        "ready": False,
        "missing": ["Presentations skill"],
    }


def inspect_artifact_tool(explicit: Path | None) -> dict:
    checked: list[str] = []
    for candidate in artifact_tool_candidates(explicit):
        checked.append(str(candidate))
        package_json = candidate / "package.json"
        if not package_json.exists():
            continue
        try:
            metadata = json.loads(package_json.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if metadata.get("name") != "@oai/artifact-tool":
            continue
        entrypoint = next(
            (
                path
                for path in (
                    candidate / "dist" / "node" / "artifact_tool.mjs",
                    candidate / "dist" / "artifact_tool.mjs",
                )
                if path.exists()
            ),
            None,
        )
        version = parse_version(metadata.get("version"))
        return {
            "path": str(candidate),
            "entrypoint": str(entrypoint) if entrypoint else None,
            "version": str(metadata.get("version") or ""),
            "version_ready": version >= MIN_ARTIFACT_TOOL_VERSION,
            "checked": checked,
        }
    return {
        "path": None,
        "entrypoint": None,
        "version": None,
        "version_ready": False,
        "checked": checked,
    }


def artifact_smoke_test(
    node: str | None,
    artifact: dict,
    timeout_seconds: int,
) -> dict:
    if not node:
        return {"passed": False, "error": "未找到 Node.js"}
    entrypoint = artifact.get("entrypoint")
    if not entrypoint:
        return {"passed": False, "error": "未找到 Artifact Tool 入口文件"}
    if not artifact.get("version_ready"):
        return {
            "passed": False,
            "error": (
                "Artifact Tool 版本低于 "
                + ".".join(str(value) for value in MIN_ARTIFACT_TOOL_VERSION)
            ),
        }
    script = """
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
const modulePath = process.argv[1];
const outputPath = process.argv[2];
const tool = await import(pathToFileURL(modulePath).href);
const presentation = tool.Presentation.create({
  slideSize: { width: 320, height: 180 },
});
const slide = presentation.slides.add();
const shape = slide.shapes.add({
  geometry: "textbox",
  position: { left: 20, top: 20, width: 260, height: 60 },
  fill: "none",
  line: { fill: "none", width: 0 },
});
shape.text = "Linux headless smoke";
shape.text.style = { fontSize: 18, color: "#000000" };
const png = await presentation.export({ slide, format: "png", scale: 0.25 });
const pptx = await tool.PresentationFile.exportPptx(presentation);
const pngSize = (await png.arrayBuffer()).byteLength;
await pptx.save(outputPath);
const pptxSize = (await fs.stat(outputPath)).size;
if (pngSize < 100 || pptxSize < 1000) {
  throw new Error(`unexpected output sizes: png=${pngSize}, pptx=${pptxSize}`);
}
console.log(JSON.stringify({ pngSize, pptxSize }));
"""
    environment = os.environ.copy()
    environment.pop("DISPLAY", None)
    environment.pop("WAYLAND_DISPLAY", None)
    try:
        with tempfile.TemporaryDirectory(prefix="artifact-smoke-") as directory:
            result = subprocess.run(
                [
                    node,
                    "--input-type=module",
                    "-e",
                    script,
                    entrypoint,
                    str(Path(directory) / "smoke.pptx"),
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout_seconds,
                env=environment,
                cwd=directory,
            )
    except subprocess.TimeoutExpired:
        return {
            "passed": False,
            "error": f"Artifact Tool 无头冒烟测试超过 {timeout_seconds} 秒",
        }
    if result.returncode:
        detail = (result.stderr or result.stdout).strip()
        return {"passed": False, "error": detail[-3000:]}
    try:
        sizes = json.loads(result.stdout.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError):
        sizes = {}
    return {"passed": True, "error": None, **sizes}


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


def build_report(
    artifact_tool_dir: Path | None,
    node_override: str | None,
    smoke_timeout_seconds: int,
) -> dict:
    system = platform.system()
    commands = {
        "node": node_override or executable("node"),
        "pdftoppm": executable("pdftoppm"),
        "tesseract": executable("tesseract"),
        "swiftc": executable("swiftc") if system == "Darwin" else None,
        "libreoffice": executable("libreoffice") or executable("soffice"),
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
    artifact = inspect_artifact_tool(artifact_tool_dir)
    artifact["smoke_test"] = artifact_smoke_test(
        commands["node"], artifact, smoke_timeout_seconds
    )
    tesseract = tesseract_languages(commands["tesseract"], smoke_timeout_seconds)
    command_checks = {
        "pdftoppm": command_probe(
            commands["pdftoppm"], ("-v",), smoke_timeout_seconds
        ),
        "libreoffice": command_probe(
            commands["libreoffice"], ("--version",), smoke_timeout_seconds
        ),
    }
    fonts = font_matches()
    presentations = inspect_presentations_skill()
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
            "Node.js": commands["node"],
            "Poppler pdftoppm": command_checks["pdftoppm"]["passed"],
            "PyMuPDF": modules["PyMuPDF"],
            "Pillow": modules["Pillow"],
            "Artifact Tool 无头渲染": artifact["smoke_test"]["passed"],
            "Presentations 技能辅助脚本": presentations["ready"],
            "可写临时目录": temporary_storage["passed"],
        }.items()
        if not present
    ]
    core_ready = not missing_core
    linux_visual_qa_ready = (
        system != "Linux"
        or (fonts["ready"] and command_checks["libreoffice"]["passed"])
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
        "artifact_tool": artifact,
        "presentations_skill": presentations,
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
        "linux_compatibility_smoke_available": command_checks[
            "libreoffice"
        ]["passed"],
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
    for label, present in report["python_modules"].items():
        print(f"Python {label}：{'已安装' if present else '未安装'}")
    artifact = report["artifact_tool"]
    print(
        "Artifact Tool："
        + (
            f"{artifact['path']}（{artifact['version']}）"
            if artifact["path"]
            else "未找到"
        )
    )
    smoke = artifact["smoke_test"]
    print(f"无头生成/渲染冒烟：{'通过' if smoke['passed'] else '失败'}")
    if smoke.get("error"):
        print("  " + str(smoke["error"]).replace("\n", "\n  "))
    presentations = report["presentations_skill"]
    print(
        "Presentations 技能："
        + (
            str(presentations["path"])
            if presentations["ready"]
            else "缺失或不完整"
        )
    )
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
    parser.add_argument("--node", help="Node.js 可执行文件路径")
    parser.add_argument(
        "--artifact-tool-dir",
        type=Path,
        help="Artifact Tool 包目录；也可设置 ARTIFACT_TOOL_DIR。",
    )
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
        args.artifact_tool_dir,
        args.node,
        args.smoke_timeout_seconds,
    )
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print_human(report)
    raise SystemExit(0 if report["ready_for_default_workflow"] else 1)


if __name__ == "__main__":
    main()
