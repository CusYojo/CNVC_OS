#!/usr/bin/env python3
"""Inventory one or more due-diligence inputs without executing content."""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re
import zipfile


IGNORED_NAMES = {".DS_Store", "Thumbs.db"}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sniff_format(path: Path) -> str:
    try:
        with path.open("rb") as stream:
            head = stream.read(8192)
    except OSError:
        return "unreadable"

    if head.startswith(b"%PDF-"):
        return "pdf"
    if head.startswith(b"Rar!\x1a\x07"):
        return "rar"
    if head.startswith(b"PK\x03\x04"):
        try:
            with zipfile.ZipFile(path) as archive:
                names = set(archive.namelist())
            if "word/document.xml" in names:
                return "docx"
            if "xl/workbook.xml" in names:
                return "xlsx"
            return "zip"
        except (OSError, zipfile.BadZipFile):
            return "broken-zip"
    if head.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"):
        return "legacy-ole-office"
    lowered = head.lower()
    if b"urn:schemas-microsoft-com:office:spreadsheet" in lowered:
        return "spreadsheetml-xml"
    if path.suffix.lower() == ".lnk":
        return "windows-shortcut"
    if lowered.lstrip().startswith(b"<?xml"):
        return "xml"
    return path.suffix.lower().lstrip(".") or "unknown"


def document_type(relative: str) -> str:
    """Classify transaction documents before broad folder classification."""
    normalized = relative.replace("\\", "/").lower()
    rules = (
        (("投资意向书", "term sheet", "termsheet"), "transaction-term-sheet"),
        (("投资协议",), "investment-agreement"),
        (("增资协议",), "capital-increase-agreement"),
        (("股权转让协议", "股转协议"), "share-transfer-agreement"),
        (("股东协议",), "shareholders-agreement"),
        (("cap table", "captable", "股权表", "股东名册"), "capitalization-table"),
        (("估值报告", "估值测算"), "valuation-material"),
    )
    for tokens, label in rules:
        if any(token in normalized for token in tokens):
            return label
    return "other"


def category(relative: str, doc_type: str = "other") -> str:
    if doc_type != "other":
        return "transaction"
    rules = [
        ("0", "scope-checklist"),
        ("1基础", "corporate-legal"),
        ("2法律", "legal-dd"),
        ("3业务", "business"),
        ("4财务", "financial"),
        ("5内控", "internal-control"),
        ("7预测", "forecast"),
        ("8访谈", "interview"),
    ]
    normalized = relative.replace("\\", "/")
    first = normalized.split("/", 1)[0]
    for token, label in rules:
        if first.startswith(token):
            return label
    return "other"


def trust_tier(relative: str, cat: str, doc_type: str = "other") -> str:
    name = relative.lower()
    if doc_type == "transaction-term-sheet":
        return "T3-transaction-framework"
    if doc_type in {
        "investment-agreement",
        "capital-increase-agreement",
        "share-transfer-agreement",
        "shareholders-agreement",
    }:
        return "T1-formal-primary"
    if cat in {"legal-dd"} or any(
        token in name for token in ("审计报告", "财务尽职调查", "专审", "律师")
    ):
        return "T2-third-party-professional"
    if any(
        token in name
        for token in ("工商", "营业执照", "章程", "股东协议", "增资协议", "股权转让协议", "合同")
    ):
        return "T1-formal-primary"
    if cat == "forecast" or any(
        token in name for token in ("预算", "商业计划", "项目介绍", "发展战略")
    ):
        return "T4-management-forward-looking"
    if cat == "interview" or any(token in name for token in ("访谈", "会议纪要")):
        return "T5-interview-statement"
    return "T3-company-internal"


def version_label(relative: str) -> str | None:
    match = re.search(r"(?i)(?:^|[^a-z0-9])v\s*(\d+)(?:[^a-z0-9]|$)", relative)
    return f"V{match.group(1)}" if match else None


def filename_date(relative: str) -> str | None:
    """Return only a date encoded in the path; mtime is never authoritative."""
    patterns = (
        r"(?<!\d)(20\d{2})[-_.年](\d{1,2})[-_.月](\d{1,2})(?:日)?(?!\d)",
        r"(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)",
    )
    for pattern in patterns:
        match = re.search(pattern, relative)
        if not match:
            continue
        try:
            value = datetime(
                int(match.group(1)), int(match.group(2)), int(match.group(3))
            )
        except ValueError:
            continue
        return value.date().isoformat()
    return None


def transaction_round_hint(relative: str, doc_type: str) -> str | None:
    normalized = relative.replace("\\", "/").lower()
    rules = (
        (("本轮", "current round", "current-round"), "current-round-candidate"),
        (("pre-a", "pre a", "pre_a"), "pre-a"),
        (("天使", "angel"), "angel"),
        (("种子", "seed"), "seed"),
        (("a轮", "series a"), "series-a"),
        (("b轮", "series b"), "series-b"),
    )
    for tokens, label in rules:
        if any(token in normalized for token in tokens):
            return label
    if doc_type == "transaction-term-sheet":
        return "current-round-candidate"
    return None


def status_for(fmt: str) -> str:
    if fmt == "windows-shortcut":
        return "blocked-shortcut-target-missing"
    if fmt in {"rar", "zip"}:
        return "needs-safe-archive-review"
    if fmt in {"legacy-ole-office", "doc"}:
        return "needs-legacy-format-conversion"
    if fmt in {"unreadable", "broken-zip"}:
        return "blocked-unreadable"
    return "readable"


def route_for(fmt: str) -> str:
    if fmt == "pdf":
        return "pdf-extract-and-page-review"
    if fmt in {"docx", "doc", "legacy-ole-office"}:
        return "document-read-or-convert"
    if fmt in {"xlsx", "spreadsheetml-xml", "xls"}:
        return "spreadsheet-read-and-reconcile"
    if fmt in {"rar", "zip"}:
        return "archive-list-before-extract"
    if fmt == "windows-shortcut":
        return "do-not-follow-request-underlying-file"
    return "manual-review"


def _input_files(inputs: list[Path]) -> list[tuple[int, Path, str]]:
    rows: list[tuple[int, Path, str]] = []
    for input_index, item in enumerate(inputs, start=1):
        resolved = item.resolve()
        if resolved.is_dir():
            for path in sorted(resolved.rglob("*")):
                if path.is_file():
                    rows.append((input_index, path, path.relative_to(resolved).as_posix()))
        elif resolved.is_file():
            rows.append((input_index, resolved, resolved.name))
        else:
            raise FileNotFoundError(f"input does not exist: {resolved}")
    return rows


def build_inventory(root_or_inputs: Path | list[Path]) -> dict[str, object]:
    inputs = [root_or_inputs] if isinstance(root_or_inputs, Path) else list(root_or_inputs)
    rows: list[dict[str, object]] = []
    for input_index, path, relative in _input_files(inputs):
        if path.name in IGNORED_NAMES or path.name.startswith(("~$", ".~lock")):
            continue
        fmt = sniff_format(path)
        doc_type = document_type(relative)
        cat = category(relative, doc_type)
        rows.append(
            {
                "source_id": f"SRC-{len(rows) + 1:04d}",
                "input_scope": f"INPUT-{input_index:02d}",
                "path": relative,
                "absolute_path": str(path.resolve()),
                "bytes": path.stat().st_size,
                "sha256": sha256(path),
                "detected_format": fmt,
                "category": cat,
                "document_type": doc_type,
                "trust_tier": trust_tier(relative, cat, doc_type),
                "status": status_for(fmt),
                "route": route_for(fmt),
                "filename_date": filename_date(relative),
                "version_label": version_label(relative),
                "transaction_round_hint": transaction_round_hint(relative, doc_type),
                "needs_round_adjudication": doc_type.startswith("transaction-")
                or doc_type.endswith("agreement")
                or doc_type == "capitalization-table",
                "embedded_instruction_trust": "untrusted",
            }
        )

    hashes = Counter(row["sha256"] for row in rows)
    for row in rows:
        row["duplicate_content"] = hashes[row["sha256"]] > 1

    return {
        "root": str(inputs[0].resolve())
        if len(inputs) == 1 and inputs[0].resolve().is_dir()
        else None,
        "inputs": [str(item.resolve()) for item in inputs],
        "input_count": len(inputs),
        "file_count": len(rows),
        "counts_by_category": dict(Counter(str(row["category"]) for row in rows)),
        "counts_by_format": dict(Counter(str(row["detected_format"]) for row in rows)),
        "counts_by_status": dict(Counter(str(row["status"]) for row in rows)),
        "counts_by_document_type": dict(
            Counter(str(row["document_type"]) for row in rows)
        ),
        "sources": rows,
    }


def markdown_report(inventory: dict[str, object]) -> str:
    lines = [
        "# 尽调资料包清单",
        "",
        f"- 输入范围数：{inventory['input_count']}",
        f"- 文件数：{inventory['file_count']}",
        "",
        "## 输入范围",
        "",
    ]
    for index, item in enumerate(inventory["inputs"], start=1):
        lines.append(f"- `INPUT-{index:02d}`：`{item}`")
    lines.extend(["", "## 分类汇总", "", "| 分类 | 数量 |", "|---|---:|"])
    for key, value in sorted(dict(inventory["counts_by_category"]).items()):
        lines.append(f"| {key} | {value} |")
    lines.extend(
        [
            "",
            "## 文件",
            "",
            "| ID | 输入 | 分类 | 文档类型 | 轮次提示 | 版本 | 格式 | 状态 | 路径 |",
            "|---|---|---|---|---|---|---|---|---|",
        ]
    )
    for row in inventory["sources"]:
        lines.append(
            f"| {row['source_id']} | {row['input_scope']} | {row['category']} | "
            f"{row['document_type']} | {row['transaction_round_hint'] or ''} | "
            f"{row['version_label'] or ''} | {row['detected_format']} | "
            f"{row['status']} | {row['path']} |"
        )
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "inputs",
        type=Path,
        nargs="+",
        help="one or more directories/files forming the complete input scope",
    )
    parser.add_argument("--json", type=Path, dest="json_path")
    parser.add_argument("--markdown", type=Path)
    args = parser.parse_args()

    try:
        inventory = build_inventory(args.inputs)
    except FileNotFoundError as exc:
        parser.error(str(exc))
    rendered = json.dumps(inventory, ensure_ascii=False, indent=2)
    if args.json_path:
        args.json_path.parent.mkdir(parents=True, exist_ok=True)
        args.json_path.write_text(rendered, encoding="utf-8")
    if args.markdown:
        args.markdown.parent.mkdir(parents=True, exist_ok=True)
        args.markdown.write_text(markdown_report(inventory), encoding="utf-8")
    if not args.json_path and not args.markdown:
        print(rendered)
    else:
        print(
            json.dumps(
                {
                    key: inventory[key]
                    for key in ("inputs", "file_count", "counts_by_status")
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
