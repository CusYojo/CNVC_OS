#!/usr/bin/env python3
"""Unit tests for the investment-manager decision-layer language gates."""

from __future__ import annotations

from pathlib import Path
import sys
import unittest


sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

import validate_dd_report as validator


class DecisionLayerGateTests(unittest.TestCase):
    def test_open_due_diligence_language_is_detected(self) -> None:
        variants = [
            "相关收入仍需进一步核验。",
            "核心技术主张待验证。",
            "建议补充银行流水后再确认收入。",
            "本次投资方案尚未确定。",
            "现有资料不能据此推演规模收入。",
            "若里程碑未达标则降低估值。",
        ]
        for value in variants:
            with self.subTest(value=value):
                self.assertTrue(validator.open_dd_language_hits(value), value)

    def test_closed_adverse_fact_and_forecast_attributes_are_allowed(self) -> None:
        variants = [
            "公司主营业务所需资质齐备，非主营业务不构成本轮投资逻辑。",
            "管理层预计2027年营业收入为3,000万元。",
            "已签约并完成回款的项目构成现阶段商业验证基础。",
            "本轮分两期交割，第二期付款以量产验收完成为条件。",
        ]
        for value in variants:
            with self.subTest(value=value):
                self.assertEqual(validator.open_dd_language_hits(value), [], value)

    def test_source_and_verification_meta_language_is_detected(self) -> None:
        variants = [
            "根据公司提供的材料，公司共有12名员工。",
            "财务尽调确认2025年营业收入为900万元。",
            "投资团队据此判断公司具备投资价值。",
            "本报告仅以已回款项目作为分析基础。",
            "本次采用经调整收入作为估值口径。",
        ]
        for value in variants:
            with self.subTest(value=value):
                self.assertTrue(
                    validator.decision_layer_meta_language_hits(value),
                    value,
                )

    def test_exclusionary_decision_language_is_detected(self) -> None:
        variants = [
            "未验收项目不纳入基准收入。",
            "该产品不计入本轮估值。",
            "本次不使用管理层预测。",
            "本报告仅以回款收入为基础。",
        ]
        for value in variants:
            with self.subTest(value=value):
                self.assertRegex(
                    value,
                    validator.EXCLUSIONARY_DECISION_LANGUAGE_PATTERN,
                )

    def test_simulated_post_investment_and_risk_status_labels_are_detected(self) -> None:
        self.assertRegex(
            "模拟投后股东",
            validator.SIMULATED_POST_INVESTMENT_PATTERN,
        )
        self.assertRegex(
            "状态：已接受",
            validator.RISK_STATUS_META_PATTERN,
        )

    def test_product_technology_split_and_supported_forecast_years_pass(self) -> None:
        self.assertTrue(
            validator.strict_table_header_matches(
                13,
                ["核心产品", "产品定义/核心功能", "应用场景/目标客户", "商业化进展"],
                validator.STRICT_TABLE_HEADERS[12],
            )
        )
        self.assertTrue(
            validator.strict_table_header_matches(
                14,
                ["核心技术", "技术描述/原理", "技术来源/权属", "技术门槛/产品作用"],
                validator.STRICT_TABLE_HEADERS[13],
            )
        )
        self.assertFalse(
            validator.strict_table_header_matches(
                13,
                ["产品板块", "认证内容", "应用场景", "商业化进展"],
                validator.STRICT_TABLE_HEADERS[12],
            )
        )
        self.assertTrue(
            validator.strict_table_header_matches(
                22,
                ["人员类别", "2027E", "2028E"],
                validator.STRICT_TABLE_HEADERS[21],
            )
        )
        self.assertFalse(
            validator.strict_table_header_matches(
                22,
                ["全职（未考虑兼职人员和实习生）", "2027E"],
                validator.STRICT_TABLE_HEADERS[21],
            )
        )
        self.assertTrue(
            validator.strict_table_header_matches(
                18,
                ["业务板块", "主要产品/服务", "收入来源", "销售与交付方式"],
                validator.STRICT_TABLE_HEADERS[17],
            )
        )
        self.assertFalse(
            validator.strict_table_header_matches(
                18,
                ["业务阶段", "主要产品/服务", "收入来源", "商业验证"],
                validator.STRICT_TABLE_HEADERS[17],
            )
        )

    def test_transaction_terms_require_a_bound_numeric_value(self) -> None:
        self.assertTrue(
            validator.transaction_terms_are_concrete(
                "本轮投资金额为2,000万元，投前估值为1亿元。"
            )
        )
        self.assertFalse(
            validator.transaction_terms_are_concrete("投资金额和投前估值另行确定。")
        )

    def test_transaction_execution_uses_terms_not_analytic_basis_language(self) -> None:
        rejected = [
            "交易实施按签署文件、付款安排与工商变更口径执行。",
            "付款与工商变更按交割口径办理。",
        ]
        allowed = [
            "增资款与老股转让价款分别依交易文件支付，工商变更随交割办理。",
            "2025年度收入按审计调整后口径列示。",
        ]
        for value in rejected:
            with self.subTest(value=value):
                self.assertRegex(value, validator.TRANSACTION_EXECUTION_META_PATTERN)
        for value in allowed:
            with self.subTest(value=value):
                self.assertNotRegex(value, validator.TRANSACTION_EXECUTION_META_PATTERN)

    def test_decisive_conclusion_is_distinct_from_advisory_tone(self) -> None:
        decisive = (
            "本轮投资金额为2,000万元，投前估值为1亿元，投后持股16.67%。"
            "核心投资逻辑来自已回款业务、产品能力和客户复制基础，交易安排已落实保护条款。"
        )
        formulaic = "本项目投资结论为同意按照本报告所列交易方案实施投资。"
        advisory = "建议按照本报告所列交易方案推进本轮投资。"
        self.assertRegex(decisive, validator.DECISIVE_INVESTMENT_CONCLUSION_PATTERN)
        self.assertNotRegex(decisive, validator.ADVISORY_INVESTMENT_CONCLUSION_PATTERN)
        self.assertRegex(formulaic, validator.FORMULAIC_APPROVAL_CONCLUSION_PATTERN)
        self.assertRegex(advisory, validator.ADVISORY_INVESTMENT_CONCLUSION_PATTERN)

    def test_recommendation_conclusion_requires_all_transaction_terms(self) -> None:
        complete = (
            "建议由赛智伯乐股权投资基金作为投资主体，以2,000万元增资，"
            "按投前估值1亿元实施，投后持股比例为16.67%。"
        )
        incomplete = "建议以2,000万元投资目标公司。"
        self.assertTrue(validator.recommendation_terms_are_complete(complete))
        self.assertFalse(validator.recommendation_terms_are_complete(incomplete))

    def test_visible_reasoning_and_formulaic_summary_are_detected(self) -> None:
        for value in ("中心判断：公司具备投资价值。", "事实基础：已实现回款。"):
            with self.subTest(value=value):
                self.assertRegex(value, validator.VISIBLE_REASONING_LABEL_PATTERN)
        self.assertRegex(
            "核心逻辑由三项事实构成。",
            validator.FORMULAIC_AI_SUMMARY_PATTERN,
        )

    def test_related_party_risk_tail_is_detected(self) -> None:
        for value in ("已签署竞业协议，以避免利益冲突。", "未发现相关不利后果。"):
            with self.subTest(value=value):
                self.assertRegex(value, validator.ASSOCIATION_RISK_NARRATIVE_PATTERN)

    def test_summary_negative_metrics_are_detected(self) -> None:
        variants = [
            "2026年上半年净亏损269.16万元。",
            "标准化经营现金流约-453.78万元。",
        ]
        for value in variants:
            with self.subTest(value=value):
                self.assertRegex(value, validator.SUMMARY_NEGATIVE_METRIC_PATTERN)

    def test_immaterial_personal_amounts_are_detected(self) -> None:
        values = ["杨林报销50元。", "个人往来中张某垫付775元。"]
        for value in values:
            with self.subTest(value=value):
                match = validator.IMMATERIAL_PERSONAL_AMOUNT_PATTERN.search(value)
                self.assertIsNotNone(match)
                amount = match.group("amount") or match.group("amount_first")
                self.assertLess(float(amount), 10000)

    def test_screenshot_style_generic_disclaimer_is_rejected(self) -> None:
        value = (
            "公司所处赛道具有长期需求，但行业关注度、政策与同业融资"
            "不能直接证明公司份额和估值。"
        )
        self.assertRegex(value, validator.GENERIC_DEFENSIVE_JUDGMENT_PATTERN)
        self.assertRegex(value, validator.INVESTMENT_THESIS_DEFENSIVE_PATTERN)


if __name__ == "__main__":
    unittest.main()
