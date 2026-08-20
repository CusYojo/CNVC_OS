#!/usr/bin/env python3
"""Regression tests for the dual-use narrative and evidence gates."""

from __future__ import annotations

import copy
import importlib.util
import json
import re
import sys
from pathlib import Path
from typing import Any, Callable


PROCESSOR = Path(__file__).with_name("qa_report_processor.py")
spec = importlib.util.spec_from_file_location("qa_report_processor", PROCESSOR)
if spec is None or spec.loader is None:
    raise SystemExit(f"无法加载 {PROCESSOR}")
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def build_fixture(root: Path) -> dict[str, Any]:
    names = (
        "facts", "rulings", "qa_plan", "qa_content",
        "quality_scorecard", "revision_log",
    )
    data = {name: read_json(root / f"{name}.json") for name in names}
    fact_ids = [str(fact["id"]) for fact in data["facts"]]
    for question in data["qa_plan"]["questions"]:
        question["evidence_focus"] = [question.get("angle", question["id"])]
    data["qa_plan"]["profile"] = {
        "narrative_mode": "dual_use",
        "sector_map": [
            {
                "category": "pure_world_model",
                "position": "通用模型能力导向",
                "project_difference": "项目已有付费任务证据",
                "fact_ids": [fact_ids[0]],
            },
            {
                "category": "embodiment_oem_internal",
                "position": "整机与基础能力导向",
                "project_difference": "项目提供跨本体数据与工具",
                "fact_ids": [fact_ids[1]],
            },
            {
                "category": "outsourced_data_service",
                "position": "人力交付导向",
                "project_difference": "项目正验证工具和硬件复用",
                "fact_ids": [fact_ids[2]],
            },
        ],
        "project_position": "以真实异构数据建立现金流，以合成数据和触觉硬件验证产品化。",
        "project_position_fact_ids": fact_ids[:3],
        "coverage": {},
    }
    for module in qa.MANDATORY_DUAL_USE_MODULES:
        data["qa_plan"]["profile"]["coverage"][module] = [
            question["id"] for question in data["qa_plan"]["questions"]
            if question["module"] == module
        ]
    data["qa_content"]["meta"]["narrative_mode"] = "dual_use"
    data["qa_content"]["overview"] = {
        "market_question": "项目收入能否沉淀为跨客户资产，是行业的核心争议。",
        "players": [
            "纯通用世界模型厂商以通用能力扩展为主。",
            "本体厂自研团队聚焦整机和基础控制。",
            "纯外包数据服务商主要依赖人员与单项目交付。",
        ],
        "project_position": "项目已形成真实数据收入，并开始验证合成数据和硬件复用。",
        "used_fact_ids": fact_ids[:3],
    }
    for item_index, item in enumerate(data["qa_content"]["items"]):
        paragraphs = [
            str(value)
            .replace("反向解释", "目前还需要确认的是")
            .replace("另一种解释", "另一种可能是")
            .replace("阶段约束与价值释放条件", "目前还需要确认的是")
            .replace("阶段约束", "目前还需要确认的是")
            .replace("价值释放条件", "付款条件")
            .replace("资本上限", "行业参照")
            .replace("平台飞轮", "可重复使用的产品能力")
            .replace("治理资产", "治理安排")
            .replace("对称资本处理", "交易安排")
            for value in item["answer_paragraphs"]
        ]
        item["answer_paragraphs"] = paragraphs
        item["claim_support"] = copy.deepcopy(
            next(
                (source.get("claim_support") or [] for source in data["qa_content"]["items"] if source.get("id") == item.get("id")),
                [],
            )
        )
    data["quality_scorecard"] = {
        "dimensions": {
            name: {"score": maximum, "max": maximum, "reason": "回归测试"}
            for name, maximum in qa.EXTERNAL_SCORE_DIMENSIONS.items()
        },
        "total": 100,
        "hard_failures": [],
        "revision_routes": [],
    }
    return data


def audit(data: dict[str, Any]) -> dict[str, Any]:
    qa.load_artifacts = lambda _: data
    return qa.audit_artifacts(Path("."))


def expect_pass(label: str, data: dict[str, Any]) -> None:
    report = audit(data)
    if report["status"] != "pass":
        raise AssertionError(f"{label} 本应通过：{report['issues'][:5]}")


def expect_failure(
    label: str,
    base: dict[str, Any],
    mutate: Callable[[dict[str, Any]], None],
    expected_text: str,
) -> None:
    data = copy.deepcopy(base)
    mutate(data)
    report = audit(data)
    messages = [issue["message"] for issue in report["issues"]]
    if report["status"] != "fail" or not any(expected_text in value for value in messages):
        raise AssertionError(f"{label} 未命中预期门禁：{messages[:5]}")


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("用法：test_dual_use_gates.py <已完成的旧版阶段文件目录>")
    base = build_fixture(Path(sys.argv[1]).resolve())
    expect_pass("dual_use 正常样例", base)
    expect_failure(
        "缺少商业化组织模块",
        base,
        lambda data: [
            question.update(module="policy_transaction")
            for question in data["qa_plan"]["questions"]
            if question["module"] == "commercialization_organization"
        ],
        "缺少必要模块",
    )
    expect_failure(
        "无证据联合研发",
        base,
        lambda data: data["qa_content"]["items"][0]["answer_paragraphs"].__setitem__(
            1, data["qa_content"]["items"][0]["answer_paragraphs"][1] + "双方已形成联合研发关系。"
        ),
        "joint_development 缺少 claim_support",
    )
    expect_failure(
        "防御性开头",
        base,
        lambda data: data["qa_content"]["items"][0]["answer_paragraphs"].__setitem__(
            0, "尚不足以支撑当前估值。" + data["qa_content"]["items"][0]["answer_paragraphs"][0]
        ),
        "以防御性否定开头",
    )
    expect_failure(
        "绝对不可替代断言",
        base,
        lambda data: data["qa_content"]["items"][3]["answer_paragraphs"].__setitem__(
            1, data["qa_content"]["items"][3]["answer_paragraphs"][1] + "该产品长期不会被替代。"
        ),
        "长期不会被替代",
    )
    expect_failure(
        "海外估值直接套用",
        base,
        lambda data: data["qa_content"]["items"][0]["answer_paragraphs"].__setitem__(
            1,
            data["qa_content"]["items"][0]["answer_paragraphs"][1]
            + "Physical Intelligence估值达数十亿美元，因此当前估值处于合理区间。",
        ),
        "用赛道上限直接证明",
    )
    expect_failure(
        "重复商业化组织专题",
        base,
        lambda data: data["qa_plan"]["profile"]["coverage"].__setitem__(
            "commercialization_organization", ["Q8", "Q9"]
        ),
        "必须且只能由 1 个问题承载",
    )
    expect_failure(
        "内部术语暴露",
        base,
        lambda data: data["qa_content"]["items"][1]["answer_paragraphs"].__setitem__(
            1, "阶段约束：" + data["qa_content"]["items"][1]["answer_paragraphs"][1]
        ),
        "阶段约束",
    )
    expect_failure(
        "段首小标题",
        base,
        lambda data: data["qa_content"]["items"][2]["answer_paragraphs"].__setitem__(
            1, "风险提示：" + data["qa_content"]["items"][2]["answer_paragraphs"][1]
        ),
        "小标题+冒号",
    )
    expect_failure(
        "顾问式继续尽调",
        base,
        lambda data: data["qa_content"]["items"][1]["answer_paragraphs"].__setitem__(
            1, data["qa_content"]["items"][1]["answer_paragraphs"][1] + "公司需要再补充三个客户案例。"
        ),
        "公司需要",
    )
    expect_failure(
        "提前声称双方已谈妥",
        base,
        lambda data: data["qa_content"]["items"][0]["answer_paragraphs"].__setitem__(
            1, data["qa_content"]["items"][0]["answer_paragraphs"][1] + "双方已约定按该口径交割。"
        ),
        "误写为双方已约定",
    )
    expect_failure(
        "保留投后过程语言",
        base,
        lambda data: data["qa_content"]["items"][6]["answer_paragraphs"].__setitem__(
            1, data["qa_content"]["items"][6]["answer_paragraphs"][1] + "该事项已纳入投后管理。"
        ),
        "投后管理",
    )
    expect_failure(
        "对外答疑出现内部叙述者",
        base,
        lambda data: data["qa_content"]["items"][0]["answer_paragraphs"].__setitem__(
            0, "经项目组核查，" + data["qa_content"]["items"][0]["answer_paragraphs"][0]
        ),
        "对外答疑出现内部口径",
    )
    expect_failure(
        "对外答疑混入交易操作",
        base,
        lambda data: data["qa_content"]["items"][0]["answer_paragraphs"].__setitem__(
            1, data["qa_content"]["items"][0]["answer_paragraphs"][1] + "相关款项采用专项预留。"
        ),
        "对外答疑出现内部口径",
    )
    expect_failure(
        "对外答疑使用资料转述口吻",
        base,
        lambda data: data["qa_content"]["items"][0]["answer_paragraphs"].__setitem__(
            0, "据公司披露，" + data["qa_content"]["items"][0]["answer_paragraphs"][0]
        ),
        "对外答疑出现内部口径",
    )
    expect_failure(
        "对外答疑展示推导过程",
        base,
        lambda data: data["qa_content"]["items"][0]["answer_paragraphs"].__setitem__(
            1, data["qa_content"]["items"][0]["answer_paragraphs"][1] + "这说明公司已经形成商业闭环。"
        ),
        "对外答疑出现内部口径",
    )
    expect_failure(
        "对外答疑使用单字模板开场",
        base,
        lambda data: data["qa_content"]["items"][0]["answer_paragraphs"].__setitem__(
            0, "合理。" + data["qa_content"]["items"][0]["answer_paragraphs"][0]
        ),
        "使用单字模板开场",
    )
    expect_failure(
        "问题原型过少",
        base,
        lambda data: [
            question.__setitem__("question_archetype", "positioning")
            for question in data["qa_plan"]["questions"]
        ],
        "问题原型少于",
    )
    expect_failure(
        "问题过度依赖数字",
        base,
        lambda data: [
            (
                question.__setitem__("question", "2025年" + question["question"]),
                data["qa_content"]["items"][index].__setitem__(
                    "question", question["question"]
                ),
            )
            for index, question in enumerate(data["qa_plan"]["questions"][:4])
        ],
        "问题设计过于材料化",
    )
    expect_failure(
        "分点规划过多",
        base,
        lambda data: [
            question.__setitem__("answer_structure", "numbered")
            for question in data["qa_plan"]["questions"][:5]
        ],
        "报告模板化",
    )
    expect_failure(
        "证据组合重复",
        base,
        lambda data: [
            question.__setitem__("evidence_focus", ["客户甲", "客户乙"])
            for question in data["qa_plan"]["questions"]
        ],
        "重复使用同一证据组合",
    )
    def overuse_one_fact(data: dict[str, Any]) -> None:
        fact_id = data["qa_content"]["items"][0]["used_fact_ids"][0]
        for item in data["qa_content"]["items"]:
            if fact_id not in item["used_fact_ids"]:
                item["used_fact_ids"].append(fact_id)

    expect_failure(
        "同一事实缺少主要归属",
        base,
        overuse_one_fact,
        "缺少主要归属",
    )
    reference = copy.deepcopy(base)
    reference["qa_plan"]["profile"]["narrative_mode"] = "reference_faithful"
    reference["qa_content"]["meta"]["narrative_mode"] = "reference_faithful"
    reference.pop("overview", None)
    expect_pass("reference_faithful 无总览正常样例", reference)
    expect_failure(
        "reference_faithful 缺少德塔格式配置",
        reference,
        lambda data: data["qa_content"]["meta"].pop("format_profile", None),
        "format_profile=deta_qa_pdf",
    )
    print("PASS: dual-use/reference-faithful fixtures and anti-template negative gates")


if __name__ == "__main__":
    main()
