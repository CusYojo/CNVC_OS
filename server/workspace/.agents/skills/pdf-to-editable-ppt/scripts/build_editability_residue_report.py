#!/usr/bin/env python3
"""Classify final-background OCR residue and emit an editability gate report."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


def parse_allowed_page(value: str) -> tuple[int, str]:
    page_text, separator, reason = value.partition(":")
    if not separator or not page_text.isdigit() or not reason.strip():
        raise argparse.ArgumentTypeError("expected PAGE:REASON")
    return int(page_text), reason.strip()


def page_number(path: Path) -> int:
    match = re.search(r"slide-(\d+)", path.name)
    if not match:
        raise ValueError(f"cannot infer page number from {path.name}")
    return int(match.group(1))


def classify_detection(
    number: int,
    item: dict,
    allowed: dict[int, str],
    noise_confidence_max: float,
) -> tuple[str, str]:
    confidence = float(item.get("confidence", 0))
    if number in allowed:
        return "allowedRaster", allowed[number]
    if confidence <= noise_confidence_max:
        return "noise", "low-confidence icon/decorative OCR false positive"
    return "validResidual", "unapproved high-confidence OCR residue"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ocr-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--allowed-page", action="append", default=[], type=parse_allowed_page)
    parser.add_argument("--noise-confidence-max", type=float, default=0.5)
    parser.add_argument("--required-object-count", type=int, default=0)
    parser.add_argument("--foreground-object-count", type=int, default=0)
    parser.add_argument("--unresolved-graphic-regions", type=int, default=0)
    args = parser.parse_args()

    allowed = dict(args.allowed_page)
    pages = []
    totals = {"noise": 0, "allowedRaster": 0, "validResidual": 0}
    for path in sorted(args.ocr_dir.glob("*.json")):
        number = page_number(path)
        items = json.loads(path.read_text(encoding="utf-8"))
        classified = []
        for item in items:
            category, reason = classify_detection(
                number,
                item,
                allowed,
                args.noise_confidence_max,
            )
            totals[category] += 1
            classified.append({**item, "category": category, "reason": reason})
        pages.append(
            {
                "page": number,
                "detections": classified,
                "counts": {
                    key: sum(1 for item in classified if item["category"] == key)
                    for key in totals
                },
            }
        )

    report = {
        "schemaVersion": "1.0",
        "ocrDirectory": str(args.ocr_dir),
        "noiseConfidenceMax": args.noise_confidence_max,
        "allowedRasterPages": [
            {"page": page, "reason": reason} for page, reason in sorted(allowed.items())
        ],
        "requiredObjectCount": args.required_object_count,
        "foregroundObjectCount": args.foreground_object_count,
        "residualTextCount": totals["validResidual"],
        "unresolvedGraphicRegions": args.unresolved_graphic_regions,
        "totals": totals,
        "pages": pages,
        "passed": (
            totals["validResidual"] == 0
            and args.foreground_object_count >= args.required_object_count
            and args.unresolved_graphic_regions == 0
        ),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        f"residue gate {'passed' if report['passed'] else 'failed'}: "
        f"{totals['validResidual']} valid residuals"
    )


if __name__ == "__main__":
    main()
