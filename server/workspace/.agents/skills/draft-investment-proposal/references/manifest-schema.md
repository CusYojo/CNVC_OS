# Decision Manifest Schema

Manifest 是内部决策账本，不进入 DOCX。

## 顶层字段

- `schema_version`: 固定为 2。
- `project`: `target_company`、`source_cutoff_date`，可增加投资主体和币种。
- `decision`: `recommendation`、`authorization_boundary`、至少三项 `kill_conditions`。
- `investment_case`: why_now、why_company、why_price、value_creation、downside。
- `coverage`: 八个固定主题。
- `calculations`: 派生或情景计算数组。
- `table_plans`: 所有最终数据表的规划数组。

## Coverage

八个键固定为 commercialization、financials、technology、market_competition、cap_table、transaction、returns、team。

- supported/partial：提供 `evidence_points` 和 source indexes。
- gap：提供 `missing`、`impact`、`action`、`transaction_response`。

## Calculation Ledger

```json
{
  "name": "综合入股估值",
  "kind": "derived",
  "formula": "investment / ownership",
  "inputs": {"investment": 3000, "ownership": 0.075},
  "result": 40000,
  "unit": "人民币万元",
  "source_indexes": [1, 2]
}
```

`kind=scenario` 时增加 `scenario` 和 `assumption_labels`。公式只使用输入变量、数字、括号和 `+ - * / **`。

## Table plans

每个 plan 包含 slot、title、style、caption_policy、columns。columns 包含 name、role、width_weight。表格实际列顺序、角色、宽度和对齐必须与 plan 一致。

## 验证

运行 `python scripts/validate_manifest.py manifest.json`。错误为零才能开始章节生成。
