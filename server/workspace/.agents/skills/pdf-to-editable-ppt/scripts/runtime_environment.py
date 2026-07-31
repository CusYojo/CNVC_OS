#!/usr/bin/env python3
"""Build a stable headless rendering environment for bundled LibreOffice."""

from __future__ import annotations

import os
from pathlib import Path


def bundled_fontconfig_file(executable: str | Path | None) -> Path | None:
    if not executable:
        return None
    path = Path(executable).expanduser().resolve()
    for root in (path.parent, *path.parents):
        for candidate in (
            root / "Resources" / "fontconfig" / "fonts.conf",
            root
            / "native"
            / "libreoffice-headless"
            / "libreoffice"
            / "LibreOfficeDev.app"
            / "Contents"
            / "Resources"
            / "fontconfig"
            / "fonts.conf",
        ):
            if candidate.is_file():
                return candidate
    return None


def fontconfig_environment(
    executable: str | Path | None,
    cache_directory: str | Path,
    base: dict[str, str] | None = None,
) -> dict[str, str]:
    environment = dict(base or os.environ)
    cache = Path(cache_directory).expanduser().resolve()
    cache.mkdir(parents=True, exist_ok=True)
    environment["XDG_CACHE_HOME"] = str(cache)
    fontconfig_file = bundled_fontconfig_file(executable)
    if fontconfig_file:
        environment["FONTCONFIG_FILE"] = str(fontconfig_file)
        environment["FONTCONFIG_PATH"] = str(fontconfig_file.parent)
    return environment
