#!/usr/bin/env python3
"""Install the bundled Design DNA profile into a project's design-profiles library."""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from resolve_design_profile import DEFAULT_PROFILE


def main() -> None:
    skill_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", required=True, type=Path)
    parser.add_argument("--profile", default=DEFAULT_PROFILE)
    parser.add_argument("--replace", action="store_true", help="Replace the same profile id; never use silently")
    args = parser.parse_args()

    source_library = skill_root / "assets" / "design-profiles"
    source_index = json.loads((source_library / "profile-index.json").read_text(encoding="utf-8"))
    source_entry = next((p for p in source_index["profiles"] if p["profile_id"] == args.profile), None)
    if not source_entry:
        raise KeyError(f"Bundled profile not found: {args.profile}")

    destination_library = args.workspace.resolve() / "design-profiles"
    destination_library.mkdir(parents=True, exist_ok=True)
    destination_profile = destination_library / args.profile
    if destination_profile.exists():
        if not args.replace:
            raise FileExistsError(
                f"Profile already exists: {destination_profile}. Use --replace only after explicit approval."
            )
        shutil.rmtree(destination_profile)
    shutil.copytree(source_library / args.profile, destination_profile)

    destination_index_path = destination_library / "profile-index.json"
    if destination_index_path.exists():
        destination_index = json.loads(destination_index_path.read_text(encoding="utf-8"))
    else:
        destination_index = {"schema_version": "3.0", "profiles": []}
    destination_index["profiles"] = [
        p for p in destination_index.get("profiles", []) if p.get("profile_id") != args.profile
    ]
    destination_index["profiles"].append(source_entry)
    destination_index_path.write_text(
        json.dumps(destination_index, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(destination_profile)


if __name__ == "__main__":
    main()
