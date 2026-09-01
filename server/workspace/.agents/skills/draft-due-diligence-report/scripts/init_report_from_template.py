#!/usr/bin/env python3
"""Create a due-diligence report workfile from the authoritative template.

The command refuses to reuse an existing report so a prior deliverable cannot
silently become the formatting base for a new project.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
from zipfile import ZipFile
from xml.etree import ElementTree as ET


W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def inspect_template(path: Path) -> dict[str, int]:
    with ZipFile(path) as archive:
        document = ET.fromstring(archive.read("word/document.xml"))
    body = document.find("w:body", NS)
    sections = 0
    if body is not None:
        for child in body:
            if child.tag == f"{{{W}}}p" and child.find("./w:pPr/w:sectPr", NS) is not None:
                sections += 1
            elif child.tag == f"{{{W}}}sectPr":
                sections += 1
    return {
        "tables": len(document.findall(".//w:tbl", NS)),
        "sections": sections,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--manifest", type=Path)
    args = parser.parse_args()

    skill_root = Path(__file__).resolve().parents[1]
    template = skill_root / "assets" / "primary-dd-report-template.docx"
    output = args.output.resolve()
    manifest = args.manifest.resolve() if args.manifest else output.with_suffix(".template-lineage.json")

    if output.suffix.lower() != ".docx":
        raise SystemExit("output must use the .docx extension")
    if output.exists():
        raise SystemExit(f"refusing to overwrite or reuse an existing report: {output}")
    if manifest.exists():
        raise SystemExit(f"refusing to overwrite an existing lineage manifest: {manifest}")
    if not template.exists():
        raise SystemExit(f"authoritative template is missing: {template}")

    metrics = inspect_template(template)
    if metrics != {"tables": 27, "sections": 4}:
        raise SystemExit(f"authoritative template structure drifted: {metrics!r}")

    output.parent.mkdir(parents=True, exist_ok=True)
    manifest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(template, output)
    record = {
        "schema_version": 1,
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "template": str(template),
        "template_sha256": sha256(template),
        "workfile": str(output),
        "workfile_initial_sha256": sha256(output),
        "template_tables": metrics["tables"],
        "template_sections": metrics["sections"],
    }
    manifest.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(record, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
