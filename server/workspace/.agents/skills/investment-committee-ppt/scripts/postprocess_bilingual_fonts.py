#!/usr/bin/env python3
"""Patch explicit PPTX text-run fonts and optionally normalize 11.x pt to 12 pt."""

from __future__ import annotations

import argparse
import re
import shutil
import tempfile
import zipfile
from pathlib import Path


SIZE_PATTERN = re.compile(r'((?:<a:(?:rPr|defRPr|endParaRPr)\b[^>]*?)\bsz=")(\d+)(")')


def replace_typeface(xml: str, tag: str, typeface: str) -> str:
    pattern = re.compile(rf'(<a:{tag}\b[^>]*\btypeface=")[^"]*(")')
    return pattern.sub(rf'\g<1>{typeface}\g<2>', xml)


def patch_run_blocks(xml: str, latin: str, east_asian: str, complex_font: str) -> str:
    for tag, font in (("latin", latin), ("ea", east_asian), ("cs", complex_font)):
        xml = replace_typeface(xml, tag, font)
    return xml


def normalize_sizes(xml: str) -> str:
    def replace(match: re.Match[str]) -> str:
        size = int(match.group(2))
        if 1100 <= size < 1200:
            size = 1200
        return f"{match.group(1)}{size}{match.group(3)}"

    return SIZE_PATTERN.sub(replace, xml)


def patch_pptx(source: Path, output: Path, latin: str, east_asian: str, normalize_11: bool) -> dict:
    if not source.exists():
        raise FileNotFoundError(source)
    output.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(dir=output.parent) as temp_dir:
        staged = Path(temp_dir) / output.name
        with zipfile.ZipFile(source, "r") as zin, zipfile.ZipFile(staged, "w", zipfile.ZIP_DEFLATED) as zout:
            for info in zin.infolist():
                data = zin.read(info.filename)
                if info.filename.endswith(".xml"):
                    xml = data.decode("utf-8", errors="strict")
                    xml = patch_run_blocks(xml, latin, east_asian, latin)
                    if normalize_11:
                        xml = normalize_sizes(xml)
                    data = xml.encode("utf-8")
                zout.writestr(info, data)
        with zipfile.ZipFile(staged) as check:
            bad = check.testzip()
            if bad:
                raise RuntimeError(f"PPTX ZIP validation failed at {bad}")
        shutil.copy2(staged, output)

    counts = {"latin": 0, "east_asian": 0, "complex": 0, "11_x_sizes": 0}
    with zipfile.ZipFile(output) as package:
        for name in package.namelist():
            if not name.endswith(".xml"):
                continue
            xml = package.read(name).decode("utf-8", errors="ignore")
            counts["latin"] += xml.count(f'<a:latin typeface="{latin}"')
            counts["east_asian"] += xml.count(f'<a:ea typeface="{east_asian}"')
            counts["complex"] += xml.count(f'<a:cs typeface="{latin}"')
            counts["11_x_sizes"] += sum(1 for size in SIZE_PATTERN.findall(xml) if 1100 <= int(size[1]) < 1200)
    return counts


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("pptx", type=Path)
    parser.add_argument("--output", type=Path, help="Omit to patch in place; keep a source copy for material decks")
    parser.add_argument("--east-asian", default="KaiTi")
    parser.add_argument("--latin", default="Times New Roman")
    parser.add_argument("--normalize-11-to-12", action="store_true")
    args = parser.parse_args()

    source = args.pptx.resolve()
    output = args.output.resolve() if args.output else source
    counts = patch_pptx(source, output, args.latin, args.east_asian, args.normalize_11_to_12)
    print({"output": str(output), **counts})


if __name__ == "__main__":
    main()
