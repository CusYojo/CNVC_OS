#!/usr/bin/env python3
"""Project Discovery Radar 单次 Job 入口。

运行时不启动 FastAPI/uvicorn。每次只执行一个明确动作，将唯一 JSON 结果写到 stdout，
由主 Node 服务负责调度、超时、取消和日志归属。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections import Counter
from pathlib import Path

import app as radar


def emit(payload: object) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))


def candidates(args: argparse.Namespace) -> dict:
    q_folded = args.q.casefold().strip()
    rows = []
    for item in radar.read_candidates():
        if args.source and item.get("source") != args.source:
            continue
        if args.group and item.get("source_group") != args.group:
            continue
        if args.attention_only and not item.get("worth_attention"):
            continue
        if item.get("attention_score", 0) < args.min_score:
            continue
        if q_folded:
            haystack = "\n".join([
                item.get("title", ""), item.get("summary", ""),
                item.get("article_text", ""), " ".join(item.get("authors", [])),
                item.get("school", ""), item.get("account_name", ""),
                item.get("wx_name", ""), item.get("source_name", ""),
                item.get("source_group", ""),
            ]).casefold()
            if q_folded not in haystack:
                continue
        rows.append(item)
    total = len(rows)
    rows = sorted(rows, key=radar.candidate_cursor_key, reverse=True)
    if args.cursor:
        cursor_key = radar.decode_candidate_cursor(args.cursor)
        rows = [item for item in rows if radar.candidate_cursor_key(item) < cursor_key]
    page = rows[:args.limit]
    has_more = len(rows) > args.limit
    next_cursor = (
        radar.encode_candidate_cursor(radar.candidate_cursor_key(page[-1]))
        if has_more and page else ""
    )
    return {
        "items": page,
        "total": total,
        "sort": "collected",
        "has_more": has_more,
        "next_cursor": next_cursor,
    }


def health() -> dict:
    rows = radar.read_candidates()
    return {
        "status": "ok",
        "name": "project-discovery-radar-job",
        "mode": "single-shot",
        "data_dir": str(radar.DATA_DIR),
        "accounts_file": str(radar.WECHAT_ACCOUNTS_XLSX),
        "gsdata_configured": radar.gsdata_credentials_configured(),
        "candidate_total": len(rows),
        "sources": dict(Counter(row.get("source", "unknown") for row in rows)),
        "state_files": {
            "auto": radar.AUTO_STATUS_FILE.exists(),
            "wechat_daily": radar.WECHAT_DAILY_STATUS_FILE.exists(),
            "wechat_sources": radar.WECHAT_SOURCE_STATUS_FILE.exists(),
        },
    }


def snapshot() -> dict:
    """导出可迁移的状态与来源清单；不包含 GSData 凭据。"""
    return {
        "states": {
            "auto": {
                "source_path": str(radar.AUTO_STATUS_FILE),
                "value": radar.read_auto_status(),
            },
            "wechat_daily": {
                "source_path": str(radar.WECHAT_DAILY_STATUS_FILE),
                "value": radar.read_wechat_daily_status(),
            },
            "wechat_sources": {
                "source_path": str(radar.WECHAT_SOURCE_STATUS_FILE),
                "value": radar.read_wechat_source_status(),
            },
        },
        "source_registry": radar.load_wechat_sources(),
        "accounts": radar.load_wechat_api_accounts(),
        "public_sources": radar.load_public_sources(),
        "candidate_files": [
            str(radar.ARXIV_FILE),
            str(radar.WECHAT_FILE),
            str(radar.WECHAT_API_FILE),
            str(radar.WECHAT_CHAT_CANDIDATES_FILE),
            str(radar.INVESTMENT_FILE),
        ],
        "accounts_file": str(radar.WECHAT_ACCOUNTS_XLSX),
    }


async def run_action(action: str) -> object:
    if action == "auto":
        return await radar.run_auto_crawl_once()
    if action == "wechat-daily":
        return await radar.run_wechat_daily_once()
    if action == "wechat-retry":
        return await radar.run_wechat_retry_once()
    if action == "wechat-institution":
        return await radar.run_wechat_institution_once()
    raise ValueError(f"unsupported action: {action}")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="Radar single-shot job adapter")
    sub = root.add_subparsers(dest="command", required=True)
    sub.add_parser("health")
    sub.add_parser("snapshot")
    page = sub.add_parser("candidates")
    page.add_argument("--limit", type=int, default=200, choices=range(1, 501), metavar="1..500")
    page.add_argument("--cursor", default="")
    page.add_argument("--source", default="")
    page.add_argument("--group", default="")
    page.add_argument("--q", default="")
    page.add_argument("--min-score", type=int, default=0)
    page.add_argument("--attention-only", action="store_true")
    for action in ("auto", "wechat-daily", "wechat-retry", "wechat-institution"):
        sub.add_parser(action)
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        if args.command == "health":
            emit(health())
        elif args.command == "snapshot":
            emit(snapshot())
        elif args.command == "candidates":
            emit(candidates(args))
        else:
            emit(asyncio.run(run_action(args.command)))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
