#!/usr/bin/env python3
"""Resolve and validate the three local skills used by the orchestration skill."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def _unique(paths: list[Path]) -> list[Path]:
    seen: set[str] = set()
    result: list[Path] = []
    for path in paths:
        key = str(path.expanduser().resolve(strict=False))
        if key not in seen:
            seen.add(key)
            result.append(Path(key))
    return result


def _workspace_candidates(skill_name: str) -> list[Path]:
    candidates: list[Path] = []
    for root in [Path.cwd(), *Path.cwd().parents]:
        candidates.extend(
            [
                root / skill_name,
                root / "GordenSuperPPTSkills" / skill_name,
                root / "project-discovery" / "GordenSuperPPTSkills" / skill_name,
            ]
        )
    return candidates


def _resolve_dir(
    label: str,
    explicit: str | None,
    env_name: str,
    skill_name: str,
    required_files: list[str],
    extra_candidates: list[Path] | None = None,
    required: bool = True,
) -> tuple[Path | None, list[str]]:
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit))
    if os.getenv(env_name):
        candidates.append(Path(os.environ[env_name]))
    candidates.append(Path.home() / ".codex" / "skills" / skill_name)
    candidates.extend(extra_candidates or [])
    candidates.extend(_workspace_candidates(skill_name))

    checked: list[str] = []
    for candidate in _unique(candidates):
        checked.append(str(candidate))
        if candidate.is_dir() and all((candidate / item).is_file() for item in required_files):
            return candidate.resolve(), checked

    if required:
        missing = ", ".join(required_files)
        raise FileNotFoundError(
            f"无法解析 {label}。需要目录包含: {missing}；已检查: {checked}"
        )
    return None, checked


def resolve(args: argparse.Namespace) -> dict:
    pdf_dir, pdf_checked = _resolve_dir(
        "pdf-to-editable-ppt",
        args.pdf_skill_dir,
        "PDF_TO_EDITABLE_PPT_SKILL_DIR",
        "pdf-to-editable-ppt",
        ["SKILL.md", "scripts/convert_pdf.py", "scripts/check_environment.py"],
    )

    super_dir, super_checked = _resolve_dir(
        "GordenSuperPPTSkill",
        args.gorden_super_dir,
        "GORDEN_SUPER_PPT_SKILL_DIR",
        "GordenSuperPPTSkill",
        ["SKILL.md", "scripts/ingest_reference_template.py"],
        required=args.require_template_adapter,
    )

    image_extra = [super_dir.parent / "GordenImagePPTGen"] if super_dir else []
    image_dir, image_checked = _resolve_dir(
        "GordenImagePPTGen",
        args.gorden_image_dir,
        "GORDEN_IMAGE_PPT_GEN_DIR",
        "GordenImagePPTGen",
        [
            "SKILL.md",
            "scripts/generate_gateway_slide_image.py",
            "scripts/compose_pptx.py",
        ],
        extra_candidates=image_extra,
    )

    assert pdf_dir is not None
    assert image_dir is not None
    return {
        "schema_version": "1.0",
        "resolved": True,
        "gorden_image_ppt_gen_dir": str(image_dir),
        "gorden_image_generate_script": str(
            image_dir / "scripts/generate_gateway_slide_image.py"
        ),
        "gorden_image_compose_script": str(image_dir / "scripts/compose_pptx.py"),
        "gorden_super_ppt_skill_dir": str(super_dir) if super_dir else None,
        "template_adapter_script": (
            str(super_dir / "scripts/ingest_reference_template.py") if super_dir else None
        ),
        "template_adapter_available": bool(super_dir),
        "pdf_to_editable_ppt_skill_dir": str(pdf_dir),
        "pdf_convert_script": str(pdf_dir / "scripts/convert_pdf.py"),
        "pdf_environment_check_script": str(pdf_dir / "scripts/check_environment.py"),
        "checked": {
            "gorden_image": image_checked,
            "gorden_super": super_checked,
            "pdf_to_editable_ppt": pdf_checked,
        },
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gorden-image-dir")
    parser.add_argument("--gorden-super-dir")
    parser.add_argument("--pdf-skill-dir")
    parser.add_argument("--require-template-adapter", action="store_true")
    parser.add_argument("--json", action="store_true", help="只输出 JSON")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = resolve(args)
    except Exception as exc:  # CLI boundary
        payload = {"resolved": False, "error": str(exc)}
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 1

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print("依赖解析成功")
        print(f"GordenImagePPTGen: {result['gorden_image_ppt_gen_dir']}")
        print(f"GordenSuperPPTSkill: {result['gorden_super_ppt_skill_dir']}")
        print(f"pdf-to-editable-ppt: {result['pdf_to_editable_ppt_skill_dir']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
