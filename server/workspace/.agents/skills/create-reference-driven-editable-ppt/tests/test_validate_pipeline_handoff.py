from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "validate_pipeline_handoff.py"
SPEC = importlib.util.spec_from_file_location("validate_pipeline_handoff", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


class ValidatePipelineHandoffTest(unittest.TestCase):
    def build_fixture(self, root: Path) -> tuple[Path, Path, Path, Path]:
        slides = root / "slides"
        slides.mkdir()
        image_records = []
        bridge_records = []
        for index in range(1, 3):
            image = slides / f"slide-{index:02d}.png"
            image.write_bytes(f"image-{index}".encode())
            metadata = slides / f"slide-{index:02d}.json"
            write_json(metadata, {"task_id": f"task-{index}"})
            image_records.append(
                {"task_id": f"task-{index}", "metadata_json": str(metadata), "copied_to": str(image)}
            )
            bridge_records.append(
                {"page": index, "path": str(image), "sha256": MODULE.sha256(image)}
            )

        image_manifest = root / "imagegen.json"
        write_json(image_manifest, {"slides": image_records})
        bridge_pdf = root / "bridge.pdf"
        bridge_pdf.write_bytes(b"synthetic-pdf")
        bridge_manifest = root / "bridge.json"
        write_json(
            bridge_manifest,
            {
                "flattened": True,
                "slides": bridge_records,
                "output_pdf": str(bridge_pdf),
                "output_pdf_sha256": MODULE.sha256(bridge_pdf),
            },
        )

        pptx = root / "editable.pptx"
        pptx.write_bytes(b"synthetic-pptx")
        reports = {}
        for path_field, hash_field in MODULE.REPORT_FIELDS:
            report = root / f"{path_field}.json"
            write_json(report, {"passed": True})
            reports[path_field] = str(report)
            reports[hash_field] = MODULE.sha256(report)

        handoff = root / "conversion-handoff.json"
        write_json(
            handoff,
            {
                "schemaVersion": "1.2",
                "producerSkill": "pdf-to-editable-ppt",
                "templatePptx": str(pptx),
                "templateSha256": MODULE.sha256(pptx),
                "pathBinding": "absolute",
                "sourcePdf": str(bridge_pdf),
                "route": "flattened",
                "editableScope": "all",
                "watermarkQaPassed": True,
                "editabilityReviewPassed": True,
                "semanticBuildPassed": True,
                "editableSurfacePassed": True,
                "layoutCalibrationPassed": True,
                "unresolvedEditablePages": [],
                "readyForContentReplacement": True,
                **reports,
            },
        )
        return image_manifest, bridge_manifest, handoff, root / "report.json"

    def test_accepts_complete_handoff(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            paths = self.build_fixture(Path(temp_dir))
            args = MODULE.build_parser().parse_args(
                [
                    "--imagegen-manifest",
                    str(paths[0]),
                    "--bridge-manifest",
                    str(paths[1]),
                    "--conversion-handoff",
                    str(paths[2]),
                    "--output-report",
                    str(paths[3]),
                ]
            )
            result = MODULE.validate(args)
            self.assertTrue(result["passed"], result["errors"])
            self.assertEqual(result["page_count"], 2)

    def test_rejects_unresolved_pages(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            paths = self.build_fixture(Path(temp_dir))
            handoff = json.loads(paths[2].read_text(encoding="utf-8"))
            handoff["unresolvedEditablePages"] = [2]
            handoff["readyForContentReplacement"] = False
            write_json(paths[2], handoff)
            args = MODULE.build_parser().parse_args(
                [
                    "--imagegen-manifest",
                    str(paths[0]),
                    "--bridge-manifest",
                    str(paths[1]),
                    "--conversion-handoff",
                    str(paths[2]),
                    "--output-report",
                    str(paths[3]),
                ]
            )
            result = MODULE.validate(args)
            self.assertFalse(result["passed"])
            self.assertTrue(any("unresolvedEditablePages" in error for error in result["errors"]))


if __name__ == "__main__":
    unittest.main()
