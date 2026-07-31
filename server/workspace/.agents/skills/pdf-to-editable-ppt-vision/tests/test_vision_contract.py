from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
FIXTURES = ROOT / "tests" / "fixtures"
sys.path.insert(0, str(SCRIPTS))

from analyze_pages_with_vision import normalize_analysis  # noqa: E402
from audit_editable_surface import covered_by_semantic_region  # noqa: E402
from build_editability_residue_report import classify_detection  # noqa: E402
from fuse_vision_evidence import object_to_override  # noqa: E402
from review_renders_with_vision import normalized_result  # noqa: E402
from vision_schema import validate_analysis_payload, validate_qa_payload  # noqa: E402


class VisionContractTests(unittest.TestCase):
    def test_fixture_contracts_are_valid(self):
        vision = FIXTURES / "vision"
        validate_analysis_payload(
            json.loads((vision / "page-01.json").read_text(encoding="utf-8"))
        )
        validate_qa_payload(
            json.loads((vision / "qa-page-01.json").read_text(encoding="utf-8"))
        )

    def test_unknown_analysis_field_is_rejected(self):
        payload = {
            "pageType": "hybrid",
            "confidence": 0.9,
            "regions": [],
            "unexpected": True,
        }
        with self.assertRaisesRegex(ValueError, "未声明字段"):
            validate_analysis_payload(payload)

    def test_normalization_preserves_typography_and_expected_count(self):
        payload = {
            "pageType": "hybrid",
            "confidence": 0.9,
            "typography": {
                "sourceFontVerified": True,
                "styles": [
                    {
                        "styleId": "body",
                        "fontSizePt": 16,
                        "bold": False,
                    }
                ],
            },
            "regions": [
                {
                    "id": "r1",
                    "type": "flowchart",
                    "bbox": [0.1, 0.1, 0.5, 0.5],
                    "recommendedAction": "semantic-rebuild",
                    "confidence": 0.95,
                    "reconstructionComplete": True,
                    "expectedObjectCount": 3,
                    "objects": [],
                }
            ],
        }
        validate_analysis_payload(payload)
        normalized = normalize_analysis(payload, 1)
        self.assertEqual(normalized["typography"]["styles"][0]["styleId"], "body")
        self.assertEqual(normalized["regions"][0]["expectedObjectCount"], 3)

    def test_connector_arrow_contract_survives_fusion(self):
        page = json.loads((FIXTURES / "model.json").read_text(encoding="utf-8"))[
            "pages"
        ][0]
        key, value, warnings = object_to_override(
            {
                "id": "c1",
                "type": "connector",
                "bbox": [0.1, 0.1, 0.2, 0.02],
                "from": "a",
                "to": "b",
                "head": {"type": "triangle"},
                "tail": {"type": "oval"},
                "cap": "round",
                "join": "round",
            },
            page,
            {},
            False,
        )
        self.assertEqual(key, "connectors")
        self.assertEqual(value["head"]["type"], "triangle")
        self.assertEqual(value["tail"]["type"], "oval")
        self.assertEqual(value["cap"], "round")
        self.assertEqual(value["join"], "round")
        self.assertEqual(warnings, [])

    def test_foreground_qa_must_be_explicit(self):
        raw = {
            "passed": True,
            "confidence": 0.9,
            "issues": [],
            "summary": "visual match",
        }
        result = normalized_result(raw, 1, True)
        self.assertFalse(result["passed"])
        self.assertTrue(result["issues"])

    def test_single_high_confidence_cjk_glyph_is_not_noise(self):
        category, _reason = classify_detection(
            1,
            {"text": "增", "confidence": 0.99},
            {},
            0.5,
        )
        self.assertEqual(category, "validResidual")

    def test_semantic_region_can_cover_source_raster(self):
        frame = {"x": 100, "y": 100, "cx": 400, "cy": 200}
        self.assertTrue(
            covered_by_semantic_region(
                frame,
                (1000, 500),
                [[0.09, 0.19, 0.42, 0.42]],
            )
        )


if __name__ == "__main__":
    unittest.main()
