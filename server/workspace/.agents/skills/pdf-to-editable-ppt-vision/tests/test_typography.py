from __future__ import annotations

import sys
from pathlib import Path
import unittest


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from typography import normalize_deck_typography


class TypographyTests(unittest.TestCase):
    def test_same_style_noise_normalizes_to_one_size(self):
        pages = [
            {
                "number": 1,
                "height": 720,
                "text": [
                    {
                        "text": "这是一段正文的第一行内容",
                        "top": 200,
                        "raw_font_size": 15.1,
                        "font_size": 15.1,
                        "font": "Noto Sans CJK SC",
                        "bold": False,
                        "color": "#333333",
                    },
                    {
                        "text": "这是一段正文的第二行内容",
                        "top": 224,
                        "raw_font_size": 15.8,
                        "font_size": 15.8,
                        "font": "Noto Sans CJK SC",
                        "bold": False,
                        "color": "#303030",
                    },
                ],
            }
        ]
        report = normalize_deck_typography(pages, mode="normalized")
        first, second = pages[0]["text"]
        self.assertTrue(report["passed"])
        self.assertEqual(first["style_id"], second["style_id"])
        self.assertEqual(first["font_size_pt"], second["font_size_pt"])
        self.assertEqual(first["font"], second["font"])

    def test_profile_controls_font_and_role_size(self):
        pages = [
            {
                "number": 1,
                "height": 720,
                "text": [
                    {
                        "text": "项目标题",
                        "top": 40,
                        "raw_font_size": 31,
                        "font_size": 31,
                        "font": "Fallback",
                        "bold": True,
                        "color": "#111111",
                    }
                ],
            }
        ]
        normalize_deck_typography(
            pages,
            profile={
                "sourceFontVerified": True,
                "fonts": {"title": "Microsoft YaHei"},
                "roleSizes": {"cover-title": 28},
            },
            mode="strict",
        )
        item = pages[0]["text"][0]
        self.assertEqual(item["font"], "Microsoft YaHei")
        self.assertEqual(item["font_size_pt"], 28)


if __name__ == "__main__":
    unittest.main()
