import importlib.util
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from PIL import Image


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "ingest_reference_template.py"
SPEC = importlib.util.spec_from_file_location("ingest_reference_template", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class IngestReferenceTemplateTests(unittest.TestCase):
    def test_image_directory_intake(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "pages"
            output = root / "bundle"
            source.mkdir()
            Image.new("RGB", (1600, 900), "#F5F7FB").save(source / "01.png")
            Image.new("RGB", (1600, 900), "#1F5ED8").save(source / "02.png")
            with redirect_stdout(io.StringIO()):
                result = MODULE.main([
                    str(source), "--out-dir", str(output), "--template-name", "demo-template"
                ])
            self.assertEqual(result, 0)
            profile = json.loads((output / "template-profile.json").read_text(encoding="utf-8"))
            manifest = json.loads((output / "template-intake-manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(profile["canvas"]["aspect_ratio"], "16:9")
            self.assertEqual(profile["reuse_level"], "structure-and-style")
            self.assertEqual(manifest["page_count"], 2)
            self.assertEqual(manifest["promotion_status"], "not-promoted")
            self.assertTrue((output / "contact-sheet.png").exists())
            self.assertTrue((output / "rendered" / "page-001.png").exists())
            self.assertTrue((output / "source" / "pages" / "01.png").exists())

    def test_persistent_candidate_still_awaits_approval(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "page.png"
            output = root / "bundle"
            Image.new("RGB", (1200, 800), "#202B4F").save(source)
            with redirect_stdout(io.StringIO()):
                result = MODULE.main([
                    str(source), "--out-dir", str(output), "--scope", "persistent-candidate",
                    "--reuse-level", "style-only",
                ])
            self.assertEqual(result, 0)
            profile = json.loads((output / "template-profile.json").read_text(encoding="utf-8"))
            manifest = json.loads((output / "template-intake-manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(profile["scope"], "persistent-candidate")
            self.assertEqual(profile["reuse_level"], "style-only")
            self.assertEqual(manifest["promotion_status"], "awaiting-explicit-approval")


if __name__ == "__main__":
    unittest.main()
