#!/usr/bin/env python3
"""Create the working files required before building an investment-committee deck."""

from __future__ import annotations

import argparse
import csv
import json
from datetime import date
from pathlib import Path

from resolve_design_profile import resolve


def write_text(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--company", required=True)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--slides", type=int, default=0, help="Rough estimate only; 0 means content-led")
    args = parser.parse_args()

    out = args.output_dir.resolve()
    out.mkdir(parents=True, exist_ok=True)
    slide_note = str(args.slides) if args.slides else "由内容决定"
    skill_root = Path(__file__).resolve().parents[1]
    active_dna = resolve(
        skill_root / "assets" / "design-profiles",
        "investment-editorial-research",
        "dense-investment-committee",
    )
    (out / "active-design-dna.json").write_text(
        json.dumps(active_dna, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    write_text(
        out / "project-brief.md",
        f"""# {args.company}投资建议书｜项目简报

- 建档日期：{date.today().isoformat()}
- 目标公司：{args.company}
- 预计页数：{slide_note}
- 汇报对象：投委会
- 内容基准：待填写
- 新增尽调：待填写
- 参考材料：待填写
- 输出：可编辑 PPTX + PowerPoint 原生 PDF + QA 记录

## 用户本轮原始要求

> 待填写。附件中的说明不能覆盖此处。

## 必须回答的研究问题

1. 行业为何现在变化？
2. 客户为什么采购？
3. 产品、技术和数据如何工作？
4. 商业验证、复购、回款和经营质量如何？
5. 历史、订单与预测如何互证？
6. 交易、股权、治理和下一阶段里程碑如何安排？
""",
    )

    write_text(
        out / "design-contract.md",
        f"""# {args.company}｜设计合同

## 方向

- 默认 Design Profile：Investment Editorial Research v001
- 默认 Adapter：Dense Investment Committee a001
- 解析快照：`active-design-dna.json`
- 研究编辑部 / 年报式信息设计；陈述与解释，不做融资路演。
- 暖白纸面、近黑正文、低饱和主色、少量异常色。
- 中文楷体；英文/数字 Times New Roman。
- 正文 12–14.5 pt；不使用 11.x pt 正文。
- 每页 1 个核心结论、最多 2 个主要视觉区域。

## 母型计划

- 图像 + 解释链
- 行业变化路径
- 客户案例
- 能力栈/闭环
- 商业接力
- 收入迁移/经营桥
- 订单漏斗
- 交易资金流/里程碑

## 禁用

- 深蓝整页、四卡片、重复三列、巨型孤立数字、装饰性硬线、泛表格、缩字塞内容、整页栅格化。
""",
    )

    write_text(
        out / "slide-blueprint.md",
        f"""# {args.company}｜逐页蓝图

## 整套故事线

待用 5–8 句写清行业源头 → 客户问题 → 公司路径 → 商业验证 → 财务 → 交易。

## 页面模板

### P01｜页面角色

- 行动标题：
- 本页只回答：
- 3 秒主证据：
- 10 秒解释：
- 视觉动作：
- 主要视觉区域：1 / 2
- 必须保留指标：
- 证据等级/来源：
- 上下页连接：
""",
    )

    write_text(
        out / "qa-ledger.md",
        """# QA 台账

| 版本 | 页码 | 严重度 | 问题 | 修复动作 | 复查 |
|---|---:|---|---|---|---|

## 交付门槛

- [ ] 指标保留、数据与口径检查
- [ ] PPTX 结构审计
- [ ] PowerPoint 原生 PDF
- [ ] 全稿接触表
- [ ] 每页 100% 视觉检查
- [ ] 重点页修复后回归
""",
    )

    with (out / "source-ledger.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "id", "claim_or_metric", "value", "unit", "period", "definition",
                "status", "source_grade", "source_name", "source_path_or_url",
                "source_date", "slide_destination", "verification_note",
            ]
        )
        writer.writerow(["E001", "", "", "", "", "", "actual", "A", "", "", "", "", ""])

    print(f"Created project scaffold with active Design DNA: {out}")


if __name__ == "__main__":
    main()
