#!/usr/bin/env python3
"""Regression tests for V22 transaction, table and source-semantic gates."""

from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import unittest
from zipfile import ZipFile
from xml.etree import ElementTree as ET


sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

from docx import Document

import inventory_sources
import table_writer
import validate_dd_report as validator


def synthetic_nodes(term: str) -> list[tuple[str, str, int | None, ET.Element]]:
    node = ET.Element("node")
    return [
        ("paragraph", "1.2 交易要点", 2, node),
        ("paragraph", term, None, node),
        ("paragraph", "1.3 行业概况", 2, node),
        ("paragraph", "7.2 公司估值与投资方式", 2, node),
        ("paragraph", term, None, node),
        ("paragraph", "8、风险识别与控制", 1, node),
        ("paragraph", "投资结论", 1, node),
        ("paragraph", term, None, node),
    ]


class V22SemanticRegressionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.skill_root = Path(__file__).resolve().parents[1]
        self.template = self.skill_root / "assets" / "primary-dd-report-template.docx"

    def test_inventory_accepts_multiple_inputs_and_classifies_current_term_sheet(self) -> None:
        with tempfile.TemporaryDirectory(prefix="dd-v22-inventory-") as tmp:
            root = Path(tmp)
            package = root / "package"
            package.mkdir()
            (package / "营业执照.txt").write_text("fact", encoding="utf-8")
            term_sheet = root / "目标公司本轮投资意向书V5-20260826.txt"
            term_sheet.write_text("draft material", encoding="utf-8")
            result = inventory_sources.build_inventory([package, term_sheet])
            self.assertEqual(result["input_count"], 2)
            transaction = next(
                item for item in result["sources"]
                if item["document_type"] == "transaction-term-sheet"
            )
            self.assertEqual(transaction["input_scope"], "INPUT-02")
            self.assertEqual(transaction["version_label"], "V5")
            self.assertEqual(transaction["transaction_round_hint"], "current-round-candidate")
            self.assertEqual(transaction["embedded_instruction_trust"], "untrusted")

    def test_table_writer_removes_unsupported_forecast_year_columns(self) -> None:
        document = Document(self.template)
        table = document.tables[21]
        rows = [
            ["人员类别", "2026E", "2027E"],
            ["人员数量", "25", "40"],
        ]
        table_writer.write_table(table, rows, table_number=22)
        self.assertEqual(len(table.rows), 2)
        self.assertTrue(all(len(row.cells) == 3 for row in table.rows))
        self.assertEqual([cell.text for cell in table.rows[0].cells], rows[0])

    def test_empty_forecast_columns_are_rejected(self) -> None:
        with ZipFile(self.template) as archive:
            root = ET.fromstring(archive.read("word/document.xml"))
        tables = root.findall(".//w:tbl", validator.NS)
        codes = {
            item["code"]
            for item in validator.content_density_contract(tables)[0]
        }
        self.assertIn("EMPTY_FORECAST_YEAR", codes)

    def test_grouped_financial_template_has_complete_classification(self) -> None:
        with ZipFile(self.template) as archive:
            root = ET.fromstring(archive.read("word/document.xml"))
        tables = root.findall(".//w:tbl", validator.NS)
        classification_errors = [
            item for item in validator.content_density_contract(tables)[0]
            if item["code"] == "FINANCIAL_CLASSIFICATION"
        ]
        self.assertEqual(classification_errors, [])

    def test_current_round_source_contract_passes_and_stale_or_unresolved_fails(self) -> None:
        current_term = "本轮投资金额为2000万元，投后估值为5亿元。"
        with tempfile.TemporaryDirectory(prefix="dd-v22-source-") as tmp:
            root = Path(tmp)
            register_path = root / "transaction-register.json"
            ledger_path = root / "evidence-ledger.json"
            register = {
                "schema_version": 1,
                "current_round_id": "ROUND-CURRENT",
                "report_stage": validator.FINAL_REPORT_STAGE,
                "documents": [{
                    "source_id": "SRC-0001",
                    "round_id": "ROUND-CURRENT",
                    "round_role": "current",
                    "document_type": "transaction-term-sheet",
                    "execution_status": "draft",
                    "contains_drafting_notes": False,
                    "drafting_notes_resolved": True,
                }],
                "report_assertions": [{
                    "claim_id": "CLAIM-TXN-001",
                    "label": "本轮金额",
                    "sections": ["1.2", "7.2", "conclusion"],
                    "patterns": ["本轮投资金额[^。；\\n]{0,20}2000万元"],
                    "minimum_matches": 1,
                }],
                "stale_term_rules": [{
                    "label": "上一轮估值",
                    "sections": ["1.2", "7.2", "conclusion"],
                    "patterns": ["上一轮估值"],
                }],
            }
            ledger_path.write_text(
                json.dumps({"claims": [{
                    "claim_id": "CLAIM-TXN-001",
                    "round_id": "ROUND-CURRENT",
                    "freshness_status": "current",
                    "source_id": "SRC-0001",
                    "drafting_note_status": "resolved",
                    "claim_status": "verified",
                }]}, ensure_ascii=False),
                encoding="utf-8",
            )
            register_path.write_text(json.dumps(register, ensure_ascii=False), encoding="utf-8")
            errors, _ = validator.source_contract_issues(
                synthetic_nodes(current_term),
                register_path,
                ledger_path,
                validator.FINAL_REPORT_STAGE,
                True,
            )
            self.assertEqual(errors, [])

            register["documents"][0]["contains_drafting_notes"] = True
            register["documents"][0]["drafting_notes_resolved"] = False
            register_path.write_text(json.dumps(register, ensure_ascii=False), encoding="utf-8")
            errors, _ = validator.source_contract_issues(
                synthetic_nodes(current_term + "上一轮估值为3亿元。"),
                register_path,
                ledger_path,
                validator.FINAL_REPORT_STAGE,
                True,
            )
            codes = {item["code"] for item in errors}
            self.assertIn("UNRESOLVED_TRANSACTION_DRAFT_NOTES", codes)
            self.assertIn("STALE_TRANSACTION_TERM", codes)

    def test_new_product_and_technology_headers_are_distinct(self) -> None:
        self.assertTrue(validator.strict_table_header_matches(
            13,
            ["核心产品", "产品定义/核心功能", "应用场景/目标客户", "商业化进展"],
            validator.STRICT_TABLE_HEADERS[12],
        ))
        self.assertTrue(validator.strict_table_header_matches(
            14,
            ["核心技术", "技术描述/原理", "技术来源/权属", "技术门槛/产品作用"],
            validator.STRICT_TABLE_HEADERS[13],
        ))

    def test_team_member_and_org_chart_semantic_coverage(self) -> None:
        node = ET.Element("node")
        nodes = [
            ("paragraph", "2.4 核心团队", 2, node),
            ("paragraph", "2.4.1 张三——创始人", 3, node),
            ("paragraph", "完整履历", None, node),
            ("paragraph", "2.4.2 李四——技术负责人", 3, node),
            ("paragraph", "完整履历", None, node),
            ("paragraph", "2.5 组织架构", 2, node),
        ]
        self.assertEqual(
            validator.team_member_coverage_issues(nodes, ["张三", "李四", "王五"]),
            ["王五"],
        )

        document = ET.Element(validator.Q("document"))
        body = ET.SubElement(document, validator.Q("body"))
        heading = ET.SubElement(body, validator.Q("p"))
        ppr = ET.SubElement(heading, validator.Q("pPr"))
        pstyle = ET.SubElement(ppr, validator.Q("pStyle"))
        pstyle.set(validator.Q("val"), "H2")
        run = ET.SubElement(heading, validator.Q("r"))
        text = ET.SubElement(run, validator.Q("t"))
        text.text = "2.5 组织架构"
        drawing_paragraph = ET.SubElement(body, validator.Q("p"))
        drawing = ET.SubElement(drawing_paragraph, validator.Q("drawing"))
        doc_pr = ET.SubElement(drawing, "docPr")
        doc_pr.set("descr", "总经理→技术中心；总经理→运营中心")
        end_heading = ET.SubElement(body, validator.Q("p"))
        end_ppr = ET.SubElement(end_heading, validator.Q("pPr"))
        end_style = ET.SubElement(end_ppr, validator.Q("pStyle"))
        end_style.set(validator.Q("val"), "H2")
        end_run = ET.SubElement(end_heading, validator.Q("r"))
        end_text = ET.SubElement(end_run, validator.Q("t"))
        end_text.text = "2.6 关联公司及关联交易"
        semantic = validator.document_section_semantic_text(
            document, {"H2": "Heading 2"}, r"^2\.5组织架构$"
        )
        self.assertIn("技术中心", semantic)
        self.assertNotIn("财务中心", semantic)

    def test_qualification_table_rejects_negative_legal_topics(self) -> None:
        self.assertEqual(
            validator.qualification_scope_spill_hits("高新技术企业；ISO9001认证"),
            [],
        )
        self.assertEqual(
            validator.qualification_scope_spill_hits("诉讼仲裁情况；房屋租赁；行政处罚"),
            ["仲裁", "房屋租赁", "行政处罚", "诉讼"],
        )


if __name__ == "__main__":
    unittest.main()
