# 输出 JSON 契约 V2

内部输出由 Decision Manifest 和 17 节 sections 组成；Manifest 不进入最终 DOCX。

## Section

```json
{
  "id": "Blueprint节点ID",
  "title": "固定标题",
  "findings": [
    {"text": "完整自然段", "status": "资料记载", "source_indexes": [0]}
  ],
  "tables": [
    {
      "slot": "transaction",
      "title": "投资方案",
      "unit": "人民币万元",
      "style": "grid",
      "caption_policy": "natural",
      "columns": [
        {"name": "金额", "role": "numeric", "width_weight": 0.8}
      ],
      "rows": [["3000"]],
      "status": "资料记载",
      "source_indexes": [0]
    }
  ],
  "calculation_indexes": [0]
}
```

## 状态

- `资料记载`：一手或已确认来源直接支持。
- `分析判断`：基于引用事实形成的条件性判断。
- `待核验`：有线索但主体、口径、时点或真实性未确认。
- `资料缺口`：仅用于内部 finding；正文转写为具体缺失事实、影响、动作和交易响应。
- `派生计算`：输入来自证据，公式可重算。
- `情景假设`：输入是明确假设，不得写成公司事实或管理层预测。

## 计算

每个 calculation 包含 `name`、`kind`、`formula`、`inputs`、`result`、`unit`、`source_indexes`。情景计算还必须包含 `scenario` 和 `assumption_labels`。不得只输出结果而省略公式和输入。

## 表格

- 2–8 列，行列一致，原生可编辑。
- columns 必须包含 `name`、`role`、`width_weight`。
- `role` 为 label、date、numeric、percent、narrative 或 status。
- `style` 为 grid 或 three-line。
- `caption_policy` 为 natural、numbered 或 none；默认 natural。
- 数字必须来自 Evidence 或 Calculation Ledger，不得把无法对齐的口径放在同一行。
- 缺少结构化证据时删除数据表；在对应 coverage gap 中写明影响、动作和交易响应。

## Findings

每个 finding 是不含手动换行的完整自然段。不得使用底稿标签、Markdown、来源路径、证据状态标签、网页导航、转录口语或固定 AI 套话。每个事实和计算只能在最相关章节完整出现一次。

## 交付

最终只交付一份 DOCX。Manifest、JSON、计算账本、审阅报告、PDF 和渲染图均为内部临时产物。
