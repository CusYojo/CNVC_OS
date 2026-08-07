#!/usr/bin/env python3
"""Generate pdf-to-editable-ppt compatible OCR JSON using macOS Vision via PyObjC."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import Vision
from Foundation import NSURL


def natural_key(path: Path) -> list[object]:
    return [int(part) if part.isdigit() else part for part in re.split(r"(\d+)", path.name)]


def recognize(path: Path, languages: list[str]) -> list[dict]:
    request = Vision.VNRecognizeTextRequest.alloc().init()
    request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    request.setRecognitionLanguages_(languages)
    request.setUsesLanguageCorrection_(True)
    handler = Vision.VNImageRequestHandler.alloc().initWithURL_options_(NSURL.fileURLWithPath_(str(path)), {})
    ok, error = handler.performRequests_error_([request], None)
    if not ok:
        raise RuntimeError(str(error))
    rows = []
    for observation in request.results() or []:
        candidates = observation.topCandidates_(1)
        if not candidates:
            continue
        candidate = candidates[0]
        box = observation.boundingBox()
        rows.append({
            "text": str(candidate.string()),
            "confidence": float(candidate.confidence()),
            "x": float(box.origin.x),
            "y": float(box.origin.y),
            "width": float(box.size.width),
            "height": float(box.size.height),
            "orientation": "horizontal",
        })
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--languages", default="zh-Hans,en-US")
    args = parser.parse_args()
    input_dir = Path(args.input_dir).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    images = sorted(input_dir.glob("slide-*.png"), key=natural_key)
    for image in images:
        rows = recognize(image, [value.strip() for value in args.languages.split(",") if value.strip()])
        target = output_dir / f"{image.stem}.json"
        target.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"{image.name}: {len(rows)} rows -> {target}")


if __name__ == "__main__":
    main()
