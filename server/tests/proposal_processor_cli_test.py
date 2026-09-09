import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1] / "workspace/.agents/skills/draft-investment-proposal"
SCRIPT = SKILL / "scripts/proposal_processor.py"


class ProposalCliTest(unittest.TestCase):
    def run_cli(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *map(str, args)],
                              capture_output=True, text=True, encoding="utf-8")

    def test_help_describes_real_arguments(self):
        result = self.run_cli("--help")
        self.assertEqual(result.returncode, 0)
        self.assertIn("--proposal-path", result.stdout)

    def test_no_arguments_and_invented_arguments_fail(self):
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertNotEqual(self.run_cli("--project-name", "test").returncode, 0)

    def test_render_and_invalid_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "proposal.json"
            output = Path(directory) / "proposal.docx"
            source.write_text(json.dumps({
                "meta": {"title_lines": ["测试提案"]},
                "sections": [{"title": "一、测试", "paragraphs": ["这是离线测试，不是业务成品。"]}],
            }), encoding="utf-8")
            args = ["--proposal-path", source, "--output-path", output,
                    "--template-path", SKILL / "assets/primary-layout-authority.docx"]
            result = self.run_cli(*args)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(zipfile.is_zipfile(output))
            self.assertGreater(output.stat().st_size, 1000)
            source.write_text("{}", encoding="utf-8")
            self.assertNotEqual(self.run_cli(*args).returncode, 0)


if __name__ == "__main__":
    unittest.main()
