from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "resolve_dependencies.py"
SPEC = importlib.util.spec_from_file_location("resolve_dependencies", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def touch_tree(root: Path, files: list[str]) -> None:
    for relative in files:
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("test\n", encoding="utf-8")


class ResolveDependenciesTest(unittest.TestCase):
    def test_resolves_explicit_valid_directories(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image = root / "GordenImagePPTGen"
            super_skill = root / "GordenSuperPPTSkill"
            pdf = root / "pdf-to-editable-ppt"
            touch_tree(
                image,
                ["SKILL.md", "scripts/generate_gateway_slide_image.py", "scripts/compose_pptx.py"],
            )
            touch_tree(super_skill, ["SKILL.md", "scripts/ingest_reference_template.py"])
            touch_tree(pdf, ["SKILL.md", "scripts/convert_pdf.py", "scripts/check_environment.py"])
            args = MODULE.build_parser().parse_args(
                [
                    "--gorden-image-dir",
                    str(image),
                    "--gorden-super-dir",
                    str(super_skill),
                    "--pdf-skill-dir",
                    str(pdf),
                    "--require-template-adapter",
                    "--json",
                ]
            )
            result = MODULE.resolve(args)
            self.assertTrue(result["resolved"])
            self.assertEqual(result["gorden_image_ppt_gen_dir"], str(image.resolve()))
            self.assertTrue(result["template_adapter_available"])


if __name__ == "__main__":
    unittest.main()
