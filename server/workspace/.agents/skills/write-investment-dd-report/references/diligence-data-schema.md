# 投资尽调字段数据规范

## 目的

在撰写正文前建立 `diligence-data.json`，把投委会需要的事实、底表和交易结论从自由文本中分离出来。章节齐全不能替代字段齐全；没有通过字段完整性审计，不得生成德塔 V5 上会版报告。

## 顶层结构

```json
{
  "project": {
    "name": "项目名称",
    "legal_entity": "准确法律主体",
    "cutoff_date": "2026-08-05",
    "currency": "CNY",
    "report_mode": "pre_ic"
  },
  "fields": [
    {
      "id": "ownership.current_cap_table",
      "status": "supported",
      "source_grade": "primary_document",
      "period": "2026-08-05",
      "unit": "% / CNY 10k",
      "evidence_ids": ["F001"],
      "data": {
        "rows": [
          {
            "shareholder": "股东名称",
            "subscribed_capital": 100,
            "ownership_pct": 55.0,
            "beneficial_owner": "最终持有人"
          }
        ]
      }
    }
  ]
}
```

`report_mode` 只能为：

- `screening_public`：以公开信息为主的项目初筛；
- `business_dd`：业务专项尽调；
- `financial_dd`：财务专项尽调；
- `legal_dd`：法律专项尽调；
- `technical_dd`：技术专项尽调；
- `pre_ic`：已有管理层材料、部分财务和交易信息的投委会预审；
- `comprehensive_ic`：具备股权、合同、财务、法务、知识产权和交易底稿的完整上会尽调。

封面标题在三种模式下均保持“尽职调查报告”。报告模式只写入后台元数据和一次性范围说明。

## 字段状态与来源等级

`status`：

- `supported`：字段有足以支持当前报告模式的证据；
- `conflicted`：可靠来源冲突，必须记录冲突和交易影响；
- `absent`：没有取得；
- `not_applicable`：确实不适用，必须写明原因。

`source_grade`：

- `primary_document`：合同、财务报表、银行记录、股东协议、权属证书等原始文件；
- `management_record`：管理账、业务系统、董事会材料或正式书面回复；
- `third_party_primary`：客户、供应商、合作方或主管机关直接出具的信息；
- `public_authoritative`：官方登记、监管、司法、知识产权、招投标等权威公开来源；
- `public_secondary`：媒体、数据库和研究机构二手资料；
- `analyst_model`：基于已列示假设的分析师测算；
- `not_applicable`：不适用。

公开来源可以支持主体、工商、知识产权、司法、招投标、公开客户案例和市场竞争等外部事实，不能替代未公开合同、客户台账、银行流水、管理账和本轮条款。

## P0 字段

### `pre_ic` 和 `comprehensive_ic` 必须支持

| 字段 ID | 最低数据内容 | 最低来源等级 |
|---|---|---|
| `entity.basic_registry` | 法律名称、统一社会信用代码、成立日期、注册资本、法定代表人、注册地址、经营范围 | `public_authoritative` 或更高 |
| `ownership.current_cap_table` | 股东、认缴资本、持股比例、最终持有人 | `public_authoritative` 或 `primary_document` |
| `ownership.financing_history` | 日期、轮次、投资方、融资金额、增资或转让变化 | `primary_document`；公开轮次可由权威来源辅助 |
| `ownership.control` | 实际控制人、控制路径、表决权和持股平台关系 | `primary_document` 或 `public_authoritative` |
| `team.core_people` | 姓名、职务、履历、全职状态、劳动关系、职务成果安排 | `management_record` 或更高 |
| `team.organization_headcount` | 总人数、全职人数、部门及人数 | `management_record` 或更高 |
| `product.product_matrix` | 产品、购买方、收费、交付方式、成熟度和已验证证据 | 与各事实匹配 |
| `product.technology_architecture` | 技术栈、自研部分、第三方依赖、性能或成本指标 | `management_record` 或更高 |
| `product.ip_schedule` | 类型、名称、权利人、状态、取得方式、授权边界 | `primary_document` 或 `public_authoritative` |
| `business.customer_closed_loop` | 客户、合同、金额、交付、验收、收入、开票、回款、复购 | `primary_document`、`management_record` 或 `third_party_primary` |
| `business.revenue_breakdown` | 按法人、产品、客户和期间拆分的收入 | `management_record` 或 `primary_document` |
| `finance.historical_financials` | 明确期间的历史损益、资产负债和现金流实际数 | `primary_document` 或 `management_record` |
| `finance.cash_runway` | 现金余额、月度净消耗、受限资金、可用月数 | `primary_document` 或 `management_record` |
| `finance.forecast_and_funding` | 驱动、基准/下行/上行情景、资金用途和下一里程碑资金需求 | `management_record` 与 `analyst_model` |
| `market.competitor_matrix` | 至少三家直接或替代竞争者，包含产品、客户、定价、优势和弱点 | 权威公开来源或一手访谈 |
| `legal.compliance_schedule` | 公司法、劳动、税务、诉讼、许可、数据和业务专项结论 | 与事项匹配 |
| `legal.related_party_transactions` | 关联方、关系、交易内容、金额、余额和定价依据 | `primary_document` 或 `management_record` |
| `transaction.round_terms` | 投资金额、投前/投后估值、方式、预计持股和本轮规模 | `primary_document` 或 `management_record` |
| `transaction.pro_forma_cap_table` | 交割后股东及完全摊薄持股比例 | `primary_document` 或 `analyst_model` |
| `valuation.valuation_result` | 方法、可比口径、估值区间、建议价格及关键折价 | `analyst_model` |
| `risk.risk_register` | 事实、触发、概率、影响、责任人、期限、证据、救济和剩余风险 | 与事项匹配 |
| `decision.recommendation` | 投资、附条件投资、暂缓或否决；金额/价格原则、条件和退出触发 | `analyst_model` |

`comprehensive_ic` 还必须支持：

- `business.cost_and_suppliers`；
- `finance.working_capital`；
- `valuation.return_scenarios`；
- `legal.material_contracts`。

## `screening_public` 最低字段

公开初筛不得伪装为完整上会报告。至少支持：

- `entity.basic_registry`；
- `ownership.public_ownership`；
- `team.core_people`；
- `product.product_matrix`；
- `business.public_customer_cases`；
- `market.competitor_matrix`；
- `legal.public_compliance`；
- `decision.recommendation`。

`screening_public` 和专项模式不得与 `deta_v5_up_to_ic` 同时使用。需要德塔完整上会结构时，先取得足以升级到 `pre_ic` 的P0证据。

## 专项报告最低字段

- `business_dd`：主体、产品矩阵、客户闭环、收入拆分、竞争矩阵和专项结论；
- `financial_dd`：主体、收入拆分、历史财务、现金消耗、营运资金、预测与资金需求和专项结论；
- `legal_dd`：主体、当前股权、控制权、知识产权、合规、关联交易、重大合同和专项结论；
- `technical_dd`：主体、核心团队、产品矩阵、技术架构、知识产权和专项结论。

专项报告只对本专业范围执行P0门禁，不得包装成综合上会尽调。

## 正文映射

`report.json` 的事实表、分析表和结论块必须增加 `semantic_role`。常用角色：

```text
company_key_facts
transaction_summary
cap_table
financing_history
control_structure
team
organization_headcount
product_matrix
technology_architecture
ip_schedule
customer_closed_loop
revenue_breakdown
historical_financials
cash_runway
forecast_and_funding
competitor_matrix
legal_compliance
related_party_transactions
valuation
return_scenarios
risk_register
decision
```

不得用“经营质量评价框架”“建议的经营里程碑”“建议的估值处理”等方法论表格代替对应事实角色。

## 审计命令

```bash
"$DD_PYTHON" "$DD_SKILL_ROOT/scripts/audit_ic_completeness.py" \
  diligence-data.json --report report.json --evidence evidence.json
```

任何P0字段缺失、来源等级不足、必需子字段为空、正文语义角色缺失或模式与模板冲突，均为交付阻断错误。
