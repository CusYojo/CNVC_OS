#!/usr/bin/env python3

from copy import deepcopy
import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from deta_ic_processor import audit_entity_binding


def valid_proposal() -> dict:
    return {
        "meta": {
            "title_lines": [
                "关于浙江赛智伯乐股权投资管理有限公司",
                "对大衍科技（桐乡）有限公司实施股权投资的提案",
            ],
            "intro_paragraphs": [
                "浙江赛智伯乐股权投资管理有限公司（以下简称“赛智伯乐”）拟对大衍科技（桐乡）有限公司实施股权投资。"
            ],
            "signature_entity": "浙江赛智伯乐股权投资管理有限公司",
            "entity_binding": {
                "investment_entity_full_name": "浙江赛智伯乐股权投资管理有限公司",
                "investment_entity_short_name": "赛智伯乐",
                "target_entity_full_name": "大衍科技（桐乡）有限公司",
                "forbidden_investment_entities": [
                    "宁波赛智具身股权投资合伙企业（有限合伙）",
                    "赛智具身基金",
                ],
            },
        },
        "sections": [],
    }


def main() -> None:
    failures: list[str] = []
    audit_entity_binding(valid_proposal(), failures)
    assert not failures, failures

    contaminated = deepcopy(valid_proposal())
    contaminated["sections"] = [{"paragraphs": ["赛智具身基金拟投资3,000万元。"]}]
    failures = []
    audit_entity_binding(contaminated, failures)
    assert any("已禁用" in failure for failure in failures), failures

    wrong_title = deepcopy(valid_proposal())
    wrong_title["meta"]["title_lines"][0] = "关于其他投资主体"
    failures = []
    audit_entity_binding(wrong_title, failures)
    assert any("报告标题" in failure for failure in failures), failures

    print("entity binding tests passed")


if __name__ == "__main__":
    main()
