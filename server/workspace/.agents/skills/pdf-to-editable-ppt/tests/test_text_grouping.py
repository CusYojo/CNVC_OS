from __future__ import annotations

import sys
from pathlib import Path
import unittest


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from text_grouping import group_text_elements


def text_line(
    seqno,
    y,
    text,
    *,
    width=100,
    font_size=20,
    bold=False,
    x=10,
):
    return {
        "kind": "text",
        "seqno": seqno,
        "bbox": [x, y, x + width, y + font_size],
        "origin": [x, y + font_size * 0.9],
        "text": text,
        "font": "Arial",
        "bold": bold,
        "italic": False,
        "font_size": font_size,
        "color": "#222222",
        "opacity": 1,
        "direction": [1, 0],
        "ascender": 1,
        "descender": -0.25,
    }


class TextGroupingTests(unittest.TestCase):
    def test_smart_reflows_wrapped_chinese_paragraph(self):
        elements = [
            text_line(1, 10, "公司专注于具身智能机器人"),
            text_line(2, 34, "核心零部件的研发和生产", width=80),
        ]
        output, report = group_text_elements(
            elements,
            mode="hybrid",
            line_break_mode="smart",
            page_number=1,
        )
        self.assertEqual(len(output), 1)
        self.assertEqual(
            output[0]["text"],
            "公司专注于具身智能机器人核心零部件的研发和生产",
        )
        self.assertEqual(output[0]["source_line_count"], 2)
        self.assertEqual(
            [line["text"] for line in output[0]["source_lines"]],
            ["公司专注于具身智能机器人", "核心零部件的研发和生产"],
        )
        self.assertTrue(report["contentPreserved"])

    def test_preserve_uses_one_multiline_text_box(self):
        elements = [
            text_line(1, 10, "这是需要保留的第一行正文"),
            text_line(2, 34, "这是需要保留的第二行正文", width=80),
        ]
        output, _ = group_text_elements(
            elements,
            mode="hybrid",
            line_break_mode="preserve",
        )
        self.assertEqual(len(output), 1)
        self.assertEqual(
            output[0]["text"],
            "这是需要保留的第一行正文\n这是需要保留的第二行正文",
        )

    def test_numeric_labels_remain_separate(self):
        elements = [
            text_line(1, 10, "2133", width=35),
            text_line(2, 34, "2771", width=35),
        ]
        output, _ = group_text_elements(
            elements,
            mode="hybrid",
            line_break_mode="smart",
        )
        self.assertEqual(len(output), 2)

    def test_line_mode_preserves_legacy_object_count(self):
        elements = [
            text_line(1, 10, "第一行"),
            text_line(2, 34, "第二行"),
        ]
        output, report = group_text_elements(
            elements,
            mode="line",
            line_break_mode="smart",
        )
        self.assertEqual(len(output), 2)
        self.assertEqual(report["textObjectReduction"], 0)

    def test_spatial_order_keeps_two_columns_as_two_paragraphs(self):
        elements = [
            text_line(1, 10, "左栏第一行正文", x=10, width=120),
            text_line(2, 10, "右栏第一行正文", x=220, width=120),
            text_line(3, 34, "左栏第二行正文", x=10, width=100),
            text_line(4, 34, "右栏第二行正文", x=220, width=100),
        ]
        output, report = group_text_elements(
            elements,
            mode="hybrid",
            line_break_mode="preserve",
            order_mode="spatial",
        )
        self.assertEqual(len(output), 2)
        self.assertEqual(
            output[0]["text"],
            "左栏第一行正文\n左栏第二行正文",
        )
        self.assertEqual(
            output[1]["text"],
            "右栏第一行正文\n右栏第二行正文",
        )
        self.assertEqual(report["groupedParagraphCount"], 2)
        self.assertEqual(report["orderMode"], "spatial")


if __name__ == "__main__":
    unittest.main()
