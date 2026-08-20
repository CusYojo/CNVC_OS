# 报告 JSON 结构规范

## 顶层结构

```json
{
  "meta": {
    "project_name": "项目名称",
    "legal_entity": "准确法律主体",
    "report_title": "尽职调查报告",
    "report_date": "2026年8月",
    "author": "投资机构",
    "report_type": "comprehensive",
    "template_profile": "deta_v5_up_to_ic",
    "cutoff_date": "2026-08-05",
    "confidentiality": "内部资料，严禁外传"
  },
  "blocks": []
}
```

`report_title` 必须严格等于 `尽职调查报告`。无论 `report_type` 是否为 `screening`、`pre_ic` 或其他类型，均不得更换为“公开信息预尽职调查报告”等标题。

`report_type` 支持：`comprehensive`、`business`、`financial`、`legal`、`technical`、`screening`、`pre_ic`。

`template_profile` 可省略以使用通用版式；使用德塔 V5 语义与视觉规范时设为 `deta_v5_up_to_ic`。

`report.json` 只负责读者可见内容。投委会字段、来源等级和模式门禁必须先写入 `diligence-data.json`，并遵循 [diligence-data-schema.md](diligence-data-schema.md)。`screening` 和专项报告不得使用 `deta_v5_up_to_ic`。

## 内容块

### 标题

```json
{"type":"heading","level":1,"title":"投资概要与建议","numbered":true}
```

标题级别为 1—4，对应保留的标题样式。`numbered:true` 时，生成器按确定的中文层级自动编号。

### 段落

```json
{
  "type":"paragraph",
  "text":"截至报告日，公司已完成……",
  "nature":"fact",
  "evidence_ids":["F001","F002"]
}
```

`nature` 只能为 `fact`、`analysis`、`recommendation` 或 `gap`。除非正文明确标明未经核实，事实必须关联证据 ID；重大分析和建议必须关联其依据 ID。

### 项目符号与编号项

```json
{"type":"bullet","text":"核心客户集中度较高。","nature":"analysis","evidence_ids":["F010"]}
{"type":"numbered_item","text":"完成核心知识产权转让。","nature":"recommendation","evidence_ids":["F021"]}
```

### 提示框

```json
{"type":"callout","label":"投资建议","text":"满足交割条件后分期投资。","nature":"recommendation","evidence_ids":["F001","F020"]}
```

### 普通表格

```json
{
  "type":"table",
  "semantic_role":"transaction_summary",
  "data_field_ids":["transaction.round_terms"],
  "title":"核心交易参数",
  "headers":["项目","内容","判断"],
  "rows":[["投前估值","10亿元","需结合情景估值调整"]],
  "column_widths":[0.20,0.35,0.45],
  "alignments":["center","center","left"],
  "nature":"fact",
  "evidence_ids":["F030"]
}
```

`column_widths` 为列宽比例，合计应约等于 1。所有显示值使用字符串，以保留单位和格式。

专项、投前预审和综合上会报告的每张表必须设置 `semantic_role`，并通过 `data_field_ids` 绑定 `diligence-data.json` 中的字段。通用表格不能代替股权、客户闭环、财务、估值或风险底表。

### 键值摘要表

```json
{
  "type":"key_value_table",
  "semantic_role":"company_key_facts",
  "data_field_ids":["entity.basic_registry"],
  "title":"",
  "rows":[["公司名称","北京某某科技有限公司"],["核心判断","附条件推进"]],
  "column_widths":[0.29,0.71],
  "nature":"fact",
  "evidence_ids":["F001"]
}
```

仅用于德塔式投资概要、交易概要和公司概况。标签列使用灰底粗体，内容列保持精炼。

### 图片

```json
{
  "type":"image",
  "path":"/absolute/path/chart.png",
  "caption":"图1：客户验证进度",
  "width_cm":14.0,
  "nature":"fact",
  "evidence_ids":["F040"]
}
```

### 分页符

```json
{"type":"page_break"}
```

### 分节符与页面方向

```json
{"type":"section_break","orientation":"landscape"}
```

`orientation` 支持 `portrait` 和 `landscape`。六列及以上的财务表、股权表或情景测算表前使用横向分节，表格结束后立即使用纵向分节。各节页眉、页脚和页码必须连续链接。

## 德塔 V5 正文规则

当 `meta.template_profile` 为 `deta_v5_up_to_ic` 时，采用 [deta-v5-semantic-blueprint.md](deta-v5-semantic-blueprint.md) 中的章节与投资概要槽位。该配置只允许 `pre_ic` 或 `comprehensive`。正文表格只能呈现公司事实、可比记录、分析判断或交易含义；验证框架、资料请求、工作底稿要求及分析师完成标准必须放在证据台账或一个最终附录中。

完整上会报告至少包含以下 `semantic_role`：

```text
company_key_facts
transaction_summary
cap_table
team
product_matrix
customer_closed_loop
historical_financials
forecast_and_funding
competitor_matrix
valuation
risk_register
decision
```

综合尽调还应包含融资历史、控制权、组织人数、技术架构、知识产权、收入拆分、现金消耗、关联交易、退出回报等角色。具体门禁由 `audit_ic_completeness.py` 执行。

## 内部证据标记

证据 ID 默认不显示在面向读者的报告中，仅用于内部审计链。用户要求报告展示来源时，应增加来源附录或可见来源注释，不得插入原始工具令牌。
