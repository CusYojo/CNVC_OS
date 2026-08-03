from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image
from pypdf import PdfReader


SCRIPT = Path(__file__).parents[1] / "scripts" / "package_slides_as_pdf.py"
SPEC = importlib.util.spec_from_file_location("package_slides_as_pdf", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class PackageSlidesAsPdfTest(unittest.TestCase):
    def test_packages_uniform_slides_and_writes_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            slides = root / "slides"
            slides.mkdir()
            Image.new("RGB", (1600, 900), "#123456").save(slides / "slide-01.png")
            Image.new("RGB", (1600, 900), "#abcdef").save(slides / "slide-02.png")
            output = root / "deck.pdf"
            manifest = root / "bridge.json"

            args = MODULE.build_parser().parse_args(
                [
                    "--slides-dir",
                    str(slides),
                    "--output",
                    str(output),
                    "--manifest",
                    str(manifest),
                ]
            )
            result = MODULE.package(args)

            self.assertTrue(output.is_file())
            self.assertEqual(result["page_count"], 2)
            self.assertTrue(result["flattened"])
            payload = json.loads(manifest.read_text(encoding="utf-8"))
            self.assertEqual(len(payload["slides"]), 2)
            reader = PdfReader(str(output))
            self.assertEqual(len(reader.pages), 2)
            self.assertAlmostEqual(float(reader.pages[0].mediabox.width), 960.0, places=1)
            self.assertAlmostEqual(float(reader.pages[0].mediabox.height), 540.0, places=1)
            self.assertFalse((reader.pages[0].extract_text() or "").strip())

    def test_rejects_mixed_aspect_ratios(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            slides = root / "slides"
            slides.mkdir()
            Image.new("RGB", (1600, 900), "white").save(slides / "slide-01.png")
            Image.new("RGB", (1200, 900), "black").save(slides / "slide-02.png")
            args = MODULE.build_parser().parse_args(
                ["--slides-dir", str(slides), "--output", str(root / "deck.pdf")]
            )
            with self.assertRaisesRegex(ValueError, "宽高比"):
                MODULE.package(args)


if __name__ == "__main__":
    unittest.main()
