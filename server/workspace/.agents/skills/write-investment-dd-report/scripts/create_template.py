#!/usr/bin/env python3
"""Create the sanitized Deta V5-style DOCX template asset."""

from __future__ import annotations

import argparse
from pathlib import Path

from docx_builder_lib import create_sanitized_template


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    path = create_sanitized_template(Path(args.output))
    print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
