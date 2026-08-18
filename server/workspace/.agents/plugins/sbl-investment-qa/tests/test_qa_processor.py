#!/usr/bin/env python3

from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import sys
import tempfile


PROCESSOR_DIR = (
    Path(__file__).resolve().parents[1]
    / "skills/generate-investment-qa-report/scripts"
)
sys.path.insert(0, str(PROCESSOR_DIR))

from qa_report_processor import (  # noqa: E402
    SCORE_DIMENSIONS,
    audit_artifacts,
    read_json,
    render_docx,
    verify_docx,
    write_json,
)


TOPICS = [
    ("估值抬升", "产品从一次性交付走向订阅复购", "同轮估值包含尚未兑现的增长预期", "估值问题还要校准融资轮次、投前投后口径、优先权和稀释安排。若价格上涨只是融资叙事变化，而客户合同、产品成熟度和治理权利没有同步增强，就不能把账面估值变化视为企业价值提升。"),
    ("收入质量", "验收开票与回款节奏决定收入兑现", "合同额可能只是未履约管线", "收入质量要穿透到交付、验收、开票和应收账龄，不能用合同总额替代会计确认，也不能用开票替代现金回收。若验收周期延长或应收持续累积，新增订单反而会加大营运资金压力。"),
    ("客户集中", "标杆客户的流程复制决定获客效率", "集中度下降也可能来自原客户流失", "客户集中问题的关键是标杆流程能否在相邻客户复制，而不是简单追求客户数量。需要区分同一集团内部扩张与独立客户获取，并观察采购决策人、预算来源、交付环境和复购触发是否具有可复制性。"),
    ("技术指标", "盲测表现影响客户采购与提价意愿", "内部指标可能不能代表客户任务", "技术指标必须回到客户任务：测试集、基线、样本选择、盲测方式和失败样本都会改变指标含义。若指标提升不能减少客户标注、测试或部署成本，也没有带来采购升级，技术表现就难以转化为商业溢价。"),
    ("团队兼职", "核心人员投入强度影响研发交付速度", "顾问履历可能被当成全职能力", "团队风险需要落到职责、投入时间、代码与知识产权归属、关键客户响应和替代梯队。高水平顾问可以增强方向判断，但不能自动替代全职工程管理；交付瓶颈若集中在少数兼职人员，规模化会放大组织风险。"),
    ("政策依赖", "补贴只能降低阶段成本而不能替代付费", "收入增长可能由政策项目拉动", "政策资金应与商业收入分开评价。补贴可以延长研发跑道，却不能证明客户愿意持续付费；若项目选择、定价和回款节奏都由申报周期驱动，公司会面临预算切换、验收延迟和现金流波动。"),
]


def build_artifacts(root: Path) -> None:
    facts = []
    questions = []
    items = []
    for index, (topic, mechanism, alternative, unique_detail) in enumerate(TOPICS, 1):
        base = 1000 + index * 111
        ids = [f"F{index}A", f"F{index}B", f"F{index}C"]
        facts.extend([
            {
                "id": ids[0],
                "fact": f"2025年{topic}相关确认值为{base}万元，核验口径为已完成事项。",
                "category": topic,
                "status": "verified",
                "materiality": 3,
                "source_ids": [f"S{index:04d}"],
                "date_hint": "2025年",
            },
            {
                "id": ids[1],
                "fact": f"2026年相关目标为{base + 500}万元，属于管理层预测而非已实现收入。",
                "category": topic,
                "status": "management_stated",
                "materiality": 3,
                "source_ids": [f"S{index:04d}"],
                "date_hint": "2026年",
            },
            {
                "id": ids[2],
                "fact": f"截至2026年6月，相关合同转化金额为{base - 200}万元，回款为{base - 400}万元。",
                "category": topic,
                "status": "verified",
                "materiality": 3,
                "source_ids": [f"S{index:04d}"],
                "date_hint": "2026年6月",
            },
        ])
        question = (
            f"2025年{topic}确认值仅{base}万元，2026年目标却升至{base + 500}万元，"
            f"截至2026年6月合同转化只有{base - 200}万元、回款仅{base - 400}万元，"
            "这一差距是否说明当前投资定价透支了尚未兑现的经营改善？"
        )
        questions.append({
            "id": f"Q{index}",
            "question": question,
            "angle": topic,
            "question_archetype": ("positioning", "mechanism", "customer_case", "product_role", "valuation", "organization")[index - 1],
            "answer_structure": "natural",
            "evidence_focus": [topic],
            "queries": [topic, "合同转化", "回款"],
            "must_cover_fact_ids": ids,
            "mechanism_chain": f"{mechanism}，再传导到收入、毛利与现金流",
            "why_layer": f"客户只有在{mechanism}直接改善任务结果时才会持续采购" if index in {2, 3, 4} else "",
            "competing_explanation": alternative,
            "discriminator": "观察下一报告期合同、验收、回款和复购是否同时改善",
            "economic_bridge": "按客户采购、合同转化、验收、收入确认、毛利和回款建立桥梁",
            "valuation_treatment": "已兑现部分进入基准价值，未兑现部分进入成长或期权价值并分期付款",
            "boundary": "若下一报告期核心指标未改善，取消溢价并触发终止条件",
        })
        paragraphs = [
            (
                f"回答：对{topic}不能按管理层目标直接给满估值。2025年确认值为{base}万元，"
                f"2026年目标为{base + 500}万元，但截至2026年6月合同转化只有{base - 200}万元、"
                f"回款只有{base - 400}万元，目标、合同和现金之间仍有明显距离。最强的正向解释是"
                f"{mechanism}正在形成，最强的反向解释则是{alternative}；因此，目标数字只代表上行情景，"
                "不能等同于基准经营结果，当前判断必须同时承认兑现速度和现金质量的约束。"
            ),
            (
                f"该争议的核心不是把{topic}材料逐项列出，而是判断{mechanism}能否改变客户行为。"
                f"{unique_detail}"
                "只有客户从测试进入采购，采购进一步形成合同转化、交付验收和复购，公司才可能扩大收入；"
                "在交付效率改善且单位成本没有同步上升时，新增收入才能转化为毛利，并通过缩短应收周期形成现金流。"
                f"对本题而言，应把{base - 200}万元合同转化与{base - 400}万元回款分开观察，前者衡量销售兑现，"
                "后者衡量客户认可和资金占用，任何一个环节停滞都意味着增长并未形成完整经济闭环。"
            ),
            (
                f"另一种解释是{alternative}，这会使表面增长无法转化为可持续复购。下一报告期应同时观察"
                "新增客户采购、原客户复购、验收周期、毛利变化和回款周期：若合同增长但复购与回款仍未改善，"
                "则反向解释更成立；若客户采购、复购和现金回收同步改善，才支持正向机制。资本配置上，"
                f"2025年已确认的{base}万元只进入基准价值，2026年{base + 500}万元目标进入成长价值或期权价值；"
                "估值应对未兑现部分折价，投资额度采用分期付款，并把复购、毛利和现金流里程碑写入支付条件。"
                "如果下一报告期仍未形成客户行为与现金结果的同步改善，则取消相应溢价并触发终止安排。"
            ),
        ]
        items.append({
            "id": f"Q{index}",
            "question": question,
            "answer_paragraphs": paragraphs,
            "paragraph_roles": [
                "opening_position", "evidence_and_reasoning", "transaction_treatment",
            ],
            "used_fact_ids": ids,
            "claim_support": [],
        })

    write_json(root / "facts.json", facts)
    write_json(root / "rulings.json", {"rulings": [], "blacklist": []})
    write_json(root / "qa_plan.json", {
        "profile": {"company": "测试科技有限公司", "investor": "测试投资方"},
        "questions": questions,
    })
    write_json(root / "qa_content.json", {
        "meta": {"company": "测试科技有限公司", "title": "测试科技项目 Q&A", "investor": "测试投资方", "date": "2026年8月"},
        "items": items,
    })
    write_json(root / "quality_scorecard.json", {
        "dimensions": {
            name: {"score": maximum, "max": maximum, "reason": "测试文本已覆盖该维度"}
            for name, maximum in SCORE_DIMENSIONS.items()
        },
        "total": 100,
        "hard_failures": [],
        "revision_routes": [],
    })
    write_json(root / "revision_log.json", [])


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="qa-processor-test-") as temp:
        root = Path(temp)
        build_artifacts(root)

        audit = audit_artifacts(root)
        assert audit["status"] == "pass", audit

        output = root / "report.docx"
        render_docx(root, output)
        assert output.is_file() and output.stat().st_size > 5000

        verification = verify_docx(root, output)
        assert verification["status"] == "pass", verification
        assert verification["docx_package"]["question_count"] == 6
        assert verification["docx_package"]["section_count"] == 1

        content = deepcopy(read_json(root / "qa_content.json"))
        content["items"][0]["answer_paragraphs"] = ["回答：只有简单事实，没有经营和资本配置链条。"] * 3
        content["items"][0]["paragraph_roles"] = [
            "opening_position", "evidence_and_reasoning", "transaction_treatment",
        ]
        write_json(root / "qa_content.json", content)
        failed = audit_artifacts(root)
        assert failed["status"] == "fail"
        assert any(issue["gate"] == "content" for issue in failed["issues"])

    print("qa processor tests passed")


if __name__ == "__main__":
    main()
