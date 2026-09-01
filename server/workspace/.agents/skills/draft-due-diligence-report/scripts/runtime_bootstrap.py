#!/usr/bin/env python3
"""Re-run a skill script with an existing Codex Python runtime when dependencies are absent."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import subprocess
import sys
from typing import Iterable


BOOTSTRAP_MARKER = "DD_SKILL_RUNTIME_BOOTSTRAPPED"


def modules_available(modules: Iterable[str]) -> bool:
    return all(importlib.util.find_spec(name) is not None for name in modules)


def runtime_candidates() -> list[Path]:
    candidates: list[Path] = []
    explicit = os.environ.get("DD_SKILL_PYTHON")
    if explicit:
        candidates.append(Path(explicit).expanduser())
    runtime_root = Path.home() / ".cache/codex-runtimes"
    candidates.extend(runtime_root.glob("*/dependencies/python/bin/python3"))
    unique: dict[Path, None] = {}
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
        except OSError:
            continue
        if resolved.is_file() and resolved != Path(sys.executable).resolve():
            unique[resolved] = None
    return sorted(unique, key=lambda path: path.stat().st_mtime, reverse=True)


def candidate_supports(python: Path, modules: tuple[str, ...]) -> bool:
    statement = ";".join(f"import {name}" for name in modules)
    try:
        completed = subprocess.run(
            [str(python), "-c", statement],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return completed.returncode == 0


def ensure_runtime(modules: tuple[str, ...]) -> None:
    """Return when modules exist; otherwise re-run the current script under a valid runtime."""

    if modules_available(modules):
        return
    missing = [name for name in modules if importlib.util.find_spec(name) is None]
    if os.environ.get(BOOTSTRAP_MARKER) == "1":
        raise RuntimeError(f"Codex运行时自举后仍缺少依赖：{', '.join(missing)}")
    for python in runtime_candidates():
        if not candidate_supports(python, modules):
            continue
        script = Path(sys.argv[0]).resolve()
        env = os.environ.copy()
        env[BOOTSTRAP_MARKER] = "1"
        env["DD_SKILL_BOOTSTRAP_FROM"] = str(Path(sys.executable).resolve())
        print(
            f"RUNTIME_BOOTSTRAP={Path(sys.executable).resolve()} -> {python} "
            f"for {','.join(missing)}",
            file=sys.stderr,
            flush=True,
        )
        completed = subprocess.run([str(python), str(script), *sys.argv[1:]], env=env, check=False)
        raise SystemExit(completed.returncode)
    raise RuntimeError(
        "当前Python缺少依赖且未找到可用Codex工作区运行时："
        + ", ".join(missing)
        + "；可通过DD_SKILL_PYTHON指定已有依赖的python3"
    )
