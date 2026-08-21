#!/usr/bin/env python3
"""Resolve a saved Design DNA profile plus an optional adapter into one active snapshot."""

from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
from typing import Any


DEFAULT_PROFILE = "investment-editorial-research"
DEFAULT_ADAPTER = "dense-investment-committee"


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def deep_merge(target: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            deep_merge(target[key], value)
        else:
            target[key] = copy.deepcopy(value)
    return target


def set_dotted_path(document: dict[str, Any], dotted_path: str, value: Any) -> None:
    parts = dotted_path.split(".")
    cursor: dict[str, Any] = document
    for part in parts[:-1]:
        child = cursor.get(part)
        if not isinstance(child, dict):
            child = {}
            cursor[part] = child
        cursor = child
    cursor[parts[-1]] = copy.deepcopy(value)


def resolve(
    library: Path,
    profile_id: str = DEFAULT_PROFILE,
    adapter_id: str | None = DEFAULT_ADAPTER,
) -> dict[str, Any]:
    library = library.resolve()
    index = load_json(library / "profile-index.json")
    index_entry = next((p for p in index.get("profiles", []) if p.get("profile_id") == profile_id), None)
    if not index_entry:
        raise KeyError(f"Profile not found in index: {profile_id}")

    profile_dir = library / profile_id
    profile = load_json(profile_dir / "profile.json")
    version_id = profile["current_version"]
    active = load_json(profile_dir / "versions" / f"{version_id}.json")
    active = copy.deepcopy(active)

    if adapter_id:
        adapter_dir = profile_dir / "adapters" / adapter_id
        adapter = load_json(adapter_dir / "adapter.json")
        adapter_version_id = adapter["current_adapter_version"]
        adapter_version = load_json(adapter_dir / "versions" / f"{adapter_version_id}.json")

        for change in adapter_version.get("parameter_changes", []):
            set_dotted_path(active, change["path"], change["to"])
        deep_merge(active.setdefault("execution_dna", {}), adapter_version.get("execution_overrides", {}))
        deep_merge(active.setdefault("tokens", {}), adapter_version.get("token_overrides", {}))
        active.setdefault("negative_constraints", []).extend(
            item
            for item in adapter_version.get("negative_constraints_additions", [])
            if item not in active["negative_constraints"]
        )
        deep_merge(active.setdefault("quality_constraints", {}), adapter_version.get("quality_targets", {}))
        active["persistence_state"] = "saved_adapter"
        active["active_adapter"] = {
            "adapter_id": adapter_id,
            "adapter_name": adapter_version["adapter_name"],
            "adapter_version": adapter_version_id,
            "base_profile_id": profile_id,
            "base_version_id": version_id,
            "scenario": adapter_version["scenario"],
            "selected_strategy": adapter_version["selected_strategy"],
            "contract_overrides": adapter_version.get("contract_overrides", {}),
        }

    active["resolution"] = {
        "profile_id": profile_id,
        "profile_version": version_id,
        "adapter_id": adapter_id,
        "source_library": "bundled_design_profiles",
    }
    return active


def main() -> None:
    skill_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument("--library", type=Path, default=skill_root / "assets" / "design-profiles")
    parser.add_argument("--profile", default=DEFAULT_PROFILE)
    parser.add_argument("--adapter", default=DEFAULT_ADAPTER)
    parser.add_argument("--no-adapter", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    active = resolve(args.library, args.profile, None if args.no_adapter else args.adapter)
    rendered = json.dumps(active, ensure_ascii=False, indent=2)
    if args.output:
        output = args.output.resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered + "\n", encoding="utf-8")
        print(output)
    else:
        print(rendered)


if __name__ == "__main__":
    main()
