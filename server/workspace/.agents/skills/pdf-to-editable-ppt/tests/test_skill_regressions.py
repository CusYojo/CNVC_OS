from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

from PIL import Image


SKILL_DIR = Path(__file__).resolve().parents[1]
SCRIPTS = SKILL_DIR / "scripts"
NODE = Path(shutil.which("node") or "/nonexistent/node")
NODE_PROJECT_CANDIDATES = [
    Path(os.environ["AI_PDF_TO_PPT_NODE_PROJECT_ROOT"])
    if os.environ.get("AI_PDF_TO_PPT_NODE_PROJECT_ROOT")
    else None,
    (
        Path.home()
        / ".cache/codex-runtimes/codex-primary-runtime/dependencies/node"
    ),
    Path.cwd(),
]
NODE_MODULES = next(
    (
        candidate
        for candidate in NODE_PROJECT_CANDIDATES
        if candidate
        and (candidate / "node_modules" / "pptxgenjs").exists()
    ),
    Path("/nonexistent/node-project"),
)


def load_script(name: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


def load_server_script(name: str):
    script_path = SKILL_DIR.parents[3] / "scripts" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, script_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


class RasterSlotOverrideTests(unittest.TestCase):
    def test_raster_slot_names_are_stable_and_validator_safe(self):
        builder = load_server_script("build-pdf-raster-slot-overrides")
        self.assertEqual(
            builder.raster_slot_name(3, "page-03-image-007.png"),
            "raster-slot.page-03.page-03-image-007",
        )
        self.assertEqual(
            builder.raster_slot_name(12, "产品 矩阵@2x.png"),
            "raster-slot.page-12.2x",
        )

    def test_raster_slot_review_declares_all_semantic_counts(self):
        builder = load_server_script("build-pdf-raster-slot-overrides")
        review = builder.raster_slot_review(4)
        self.assertTrue(review["completed"])
        self.assertEqual(review["expectedCounts"]["imageReplacements"], 4)
        self.assertEqual(
            set(review["expectedCounts"]),
            {
                "covers",
                "shapes",
                "connectors",
                "texts",
                "icons",
                "charts",
                "tables",
                "imageReplacements",
            },
        )
        self.assertEqual(review["unresolvedRegions"], [])


class FontCalibrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ocr = load_script("prepare_flattened_ocr")
        cls.converter = load_script("convert_pdf")

    def test_short_labels_are_preserved_at_normal_confidence(self):
        self.assertTrue(
            self.ocr.useful_row(
                {"text": "优", "confidence": 0.90},
                0.45,
            )
        )

    def test_body_and_display_fonts_use_separate_calibration(self):
        body = self.ocr.calibrated_font_size(
            text="这是正文文字",
            item_width=180,
            item_height=20,
            font_basis=16.4,
            role="body",
            render_dpi=96,
            body_scale=0.75,
            title_scale=0.78,
            display_scale=0.98,
            minimum=5,
            maximum=96,
        )
        display = self.ocr.calibrated_font_size(
            text="100%",
            item_width=300,
            item_height=80,
            font_basis=65.6,
            role="display-number",
            render_dpi=96,
            body_scale=0.75,
            title_scale=0.78,
            display_scale=0.98,
            minimum=5,
            maximum=96,
        )
        self.assertAlmostEqual(body, 12.3, places=1)
        self.assertGreater(display, body * 3)
        self.assertLessEqual(body, 28)

    def test_all_scope_requires_completed_review_and_counts(self):
        route = {
            "pages": [
                {
                    "page": 1,
                    "flattened": True,
                    "embedded_image_candidates": [],
                }
            ]
        }
        with tempfile.TemporaryDirectory() as temporary:
            override_path = Path(temporary) / "overrides.json"
            override_path.write_text(
                json.dumps(
                    {
                        "slides": {
                            "1": {
                                "icons": [{"name": "icon-1"}],
                                "review": {
                                    "completed": True,
                                    "expectedCounts": {
                                        "covers": 0,
                                        "shapes": 0,
                                        "connectors": 0,
                                        "texts": 0,
                                        "icons": 1,
                                        "charts": 0,
                                        "tables": 0,
                                        "imageReplacements": 0,
                                    },
                                    "unresolvedRegions": [],
                                },
                            }
                        }
                    }
                ),
                encoding="utf-8",
            )
            report = self.converter.build_editability_report(
                route,
                override_path,
                "all",
                "ocr",
            )
        self.assertEqual(report["review_required_pages"], [])
        self.assertEqual(report["pages"][0]["status"], "semantic-review-complete")


class SemanticBuildTests(unittest.TestCase):
    def test_semantic_objects_and_calibrated_font_are_emitted(self):
        if not NODE.exists() or not NODE_MODULES.exists():
            self.skipTest("bundled Node runtime is unavailable")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            background = root / "background.png"
            model_path = root / "model.json"
            overrides_path = root / "overrides.json"
            pptx_path = root / "result.pptx"
            manifest_path = root / "manifest.json"
            semantic_report = root / "semantic-report.json"
            surface_report = root / "surface-report.json"
            foreground_pptx = root / "foreground.pptx"

            Image.new("RGB", (1280, 720), "white").save(background)
            model_path.write_text(
                json.dumps(
                    {
                        "source": "synthetic.pdf",
                        "page_width": 1280,
                        "page_height": 720,
                        "pages": [
                            {
                                "number": 1,
                                "width": 1280,
                                "height": 720,
                                "background": str(background),
                                "text": [
                                    {
                                        "text": "模板正文",
                                        "left": 100,
                                        "top": 100,
                                        "width": 160,
                                        "height": 24,
                                        "font_size": 16,
                                        "ppt_font_size": 12,
                                        "text_role": "body",
                                        "font": "Hiragino Sans GB",
                                        "color": "#172033",
                                    },
                                    {
                                        "text": "旧图标文字",
                                        "left": 600,
                                        "top": 300,
                                        "width": 100,
                                        "height": 24,
                                        "font_size": 16,
                                        "ppt_font_size": 12,
                                        "text_role": "body",
                                        "font": "Hiragino Sans GB",
                                        "color": "#172033",
                                    },
                                ],
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            overrides_path.write_text(
                json.dumps(
                    {
                        "coordinateWidth": 1280,
                        "slides": {
                            "1": {
                                "review": {
                                    "completed": True,
                                    "expectedCounts": {
                                        "covers": 1,
                                        "shapes": 2,
                                        "connectors": 1,
                                        "texts": 1,
                                        "icons": 1,
                                        "charts": 0,
                                        "tables": 0,
                                        "imageReplacements": 0,
                                    },
                                    "unresolvedRegions": [],
                                },
                                "skipTextRegions": [
                                    {
                                        "left": 580,
                                        "top": 280,
                                        "width": 160,
                                        "height": 80,
                                    }
                                ],
                                "covers": [
                                    {
                                        "name": "icon-area-cover",
                                        "position": {
                                            "left": 580,
                                            "top": 280,
                                            "width": 160,
                                            "height": 80,
                                        },
                                        "fill": "#FFFFFF",
                                        "line": "none",
                                    }
                                ],
                                "shapes": [
                                    {
                                        "name": "node-a",
                                        "geometry": "roundRect",
                                        "position": {
                                            "left": 400,
                                            "top": 280,
                                            "width": 100,
                                            "height": 50,
                                        },
                                        "fill": "#EAF3FF",
                                        "line": {"fill": "#1677FF", "width": 1},
                                    },
                                    {
                                        "name": "node-b",
                                        "geometry": "roundRect",
                                        "position": {
                                            "left": 520,
                                            "top": 280,
                                            "width": 100,
                                            "height": 50,
                                        },
                                        "fill": "#EAF3FF",
                                        "line": {"fill": "#1677FF", "width": 1},
                                    },
                                ],
                                "connectors": [
                                    {
                                        "name": "node-link",
                                        "from": "node-a",
                                        "to": "node-b",
                                        "line": {"fill": "#1677FF", "width": 1},
                                    }
                                ],
                                "texts": [
                                    {
                                        "name": "semantic-label",
                                        "text": "可编辑标签",
                                        "position": {
                                            "left": 650,
                                            "top": 290,
                                            "width": 120,
                                            "height": 30,
                                        },
                                        "textStyle": {
                                            "typeface": "Hiragino Sans GB",
                                            "fontSize": 12,
                                        },
                                    }
                                ],
                                "icons": [
                                    {
                                        "name": "editable-icon",
                                        "mode": "native",
                                        "position": {
                                            "left": 600,
                                            "top": 290,
                                            "width": 40,
                                            "height": 40,
                                        },
                                        "parts": [
                                            {
                                                "geometry": "ellipse",
                                                "position": {
                                                    "left": 0,
                                                    "top": 0,
                                                    "width": 40,
                                                    "height": 40,
                                                },
                                                "fill": "#1677FF",
                                                "line": "none",
                                            },
                                            {
                                                "geometry": "ellipse",
                                                "position": {
                                                    "left": 13,
                                                    "top": 13,
                                                    "width": 14,
                                                    "height": 14,
                                                },
                                                "fill": "#FFFFFF",
                                                "line": "none",
                                            },
                                        ],
                                    }
                                ],
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )

            environment = os.environ.copy()
            environment["AI_PDF_TO_PPT_NODE_PROJECT_ROOT"] = str(NODE_MODULES)
            subprocess.run(
                [
                    str(NODE),
                    str(SCRIPTS / "build_flattened_ocr_ppt.mjs"),
                    "--model",
                    str(model_path),
                    "--output",
                    str(pptx_path),
                    "--overrides",
                    str(overrides_path),
                    "--build-manifest",
                    str(manifest_path),
                ],
                check=True,
                env=environment,
                capture_output=True,
                text=True,
            )
            subprocess.run(
                [
                    os.sys.executable,
                    str(SCRIPTS / "validate_semantic_build.py"),
                    "--overrides",
                    str(overrides_path),
                    "--build-manifest",
                    str(manifest_path),
                    "--output",
                    str(semantic_report),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            subprocess.run(
                [
                    os.sys.executable,
                    str(SCRIPTS / "audit_editable_surface.py"),
                    "--pptx",
                    str(pptx_path),
                    "--output",
                    str(surface_report),
                    "--foreground-only-pptx",
                    str(foreground_pptx),
                ],
                check=True,
                capture_output=True,
                text=True,
            )

            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            emitted = {
                (item["semanticId"], item["type"])
                for item in manifest["objects"]
                if item["emitted"]
            }
            self.assertIn(("editable-icon", "icon"), emitted)
            self.assertIn(("node-link", "connector"), emitted)
            ocr_objects = [
                item
                for item in manifest["objects"]
                if item["type"] == "ocr-text" and item["emitted"]
            ]
            self.assertEqual(len(ocr_objects), 1)
            self.assertEqual(ocr_objects[0]["fontSize"], 12)
            self.assertTrue(
                json.loads(semantic_report.read_text(encoding="utf-8"))["passed"]
            )
            self.assertTrue(
                json.loads(surface_report.read_text(encoding="utf-8"))["passed"]
            )
            self.assertTrue(foreground_pptx.exists())
            with zipfile.ZipFile(pptx_path) as archive:
                slide_xml = archive.read("ppt/slides/slide1.xml").decode("utf-8")
            self.assertIn("editable-icon", slide_xml)
            self.assertIn("semantic-label", slide_xml)
            self.assertNotIn("旧图标文字", slide_xml)


if __name__ == "__main__":
    unittest.main()
