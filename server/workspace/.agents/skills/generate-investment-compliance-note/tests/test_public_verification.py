import copy
import importlib.util
import unittest
from pathlib import Path


VALIDATOR = Path(__file__).resolve().parents[1] / "scripts" / "validate_public_verification.py"
SPEC = importlib.util.spec_from_file_location("public_verification_validator_tests", VALIDATOR)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def valid_record():
    categories = [
        "corporate_registration",
        "administrative_penalties",
        "credit_and_enforcement",
        "litigation",
        "intellectual_property",
        "licences_and_filings",
        "public_adverse_information",
    ]
    checks = []
    for index, category in enumerate(categories, start=1):
        claim_type = "fact_confirmed" if category in {
            "corporate_registration", "intellectual_property", "licences_and_filings"
        } else "no_adverse_found"
        conclusion = (
            "公开登记或备案事实与目标主体标识相符。"
            if claim_type == "fact_confirmed"
            else "截至2026年8月18日，在列明公开渠道未发现该类别的重大公开异常。"
        )
        checks.append(
            {
                "check_id": f"check-{index}",
                "category": category,
                "entity_id": "target",
                "status": "verified",
                "claim_type": claim_type,
                "conclusion": conclusion,
                "queries": [f"测试公司 {category}"],
                "sources": [
                    {
                        "source_id": f"PUB-{index}",
                        "title": f"官方来源{index}",
                        "publisher": "测试政府机关",
                        "source_type": "government",
                        "url": f"https://example.gov.cn/record/{index}",
                        "accessed_at": "2026-08-18",
                        "direct": True,
                        "matched_identifiers": ["企业全称", "统一社会信用代码"],
                        "evidence_summary": conclusion,
                    }
                ],
                "limitations": [],
            }
        )
    return {
        "schema_version": "1.0",
        "project": {
            "name": "测试公司",
            "unified_social_credit_code": "91330483MA00000000",
        },
        "as_of_date": "2026-08-18",
        "scope": {
            "mode": "online",
            "query_terms": ["测试公司", "91330483MA00000000"],
            "excluded_sensitive_topics": ["投资金额", "估值", "基金协议"],
            "sensitive_terms_excluded": True,
            "coverage_status": "complete",
        },
        "entities": [
            {
                "entity_id": "target",
                "name": "测试公司",
                "role": "primary_target",
                "entity_type": "company",
                "identifiers": {
                    "unified_social_credit_code": "91330483MA00000000"
                },
                "identity_status": "matched",
                "match_basis": ["企业全称一致", "统一社会信用代码一致"],
            }
        ],
        "checks": checks,
        "limitations": [],
        "conflicts": [],
        "summary": {
            "validation_status": "pass",
            "coverage_status": "complete",
            "unresolved_material_conflicts": 0,
            "decision_impact": "no_material_public_conflict_found",
        },
    }


class PublicVerificationTests(unittest.TestCase):
    def test_valid_record_passes(self):
        self.assertEqual(MODULE.validate_record(valid_record()), [])

    def test_absolute_no_risk_wording_is_rejected(self):
        record = valid_record()
        record["checks"][1]["conclusion"] = "该公司不存在行政处罚。"
        errors = MODULE.validate_record(record)
        self.assertTrue(any("absolute no-risk" in error for error in errors), errors)

    def test_confidential_transaction_query_is_rejected(self):
        record = valid_record()
        record["scope"]["query_terms"].append("测试公司 拟投资金额")
        errors = MODULE.validate_record(record)
        self.assertTrue(any("confidential transaction" in error for error in errors), errors)

    def test_confidential_per_check_query_is_rejected(self):
        record = valid_record()
        record["checks"][0]["queries"].append("测试公司 投后估值")
        errors = MODULE.validate_record(record)
        self.assertTrue(any("checks[0].queries" in error for error in errors), errors)

    def test_search_lead_cannot_support_verified_status(self):
        record = valid_record()
        source = record["checks"][0]["sources"][0]
        source["source_type"] = "search_lead"
        source["direct"] = False
        errors = MODULE.validate_record(record)
        self.assertTrue(any("requires a direct source" in error for error in errors), errors)

    def test_unresolved_material_conflict_blocks_delivery(self):
        record = copy.deepcopy(valid_record())
        record["conflicts"] = [
            {
                "conflict_id": "C-1",
                "topic": "主体状态",
                "internal_value": "存续",
                "public_value": "注销",
                "severity": "material",
                "status": "unresolved",
                "governing_basis": "待核实",
            }
        ]
        record["summary"]["unresolved_material_conflicts"] = 1
        errors = MODULE.validate_record(record)
        self.assertTrue(any("block delivery" in error for error in errors), errors)


if __name__ == "__main__":
    unittest.main()
