# OCR 字体与字号校准

## 原则

OCR 框高包含行距、抗锯齿边缘和检测器误差，不能直接作为 PowerPoint 字号。
扁平化 PDF 也通常不保留字体元数据，因此“识别到某种字体”只是候选，除非有
原始 PDF 字体对象、模板规范或人工确认作为证据。

## 两阶段处理

1. 每条 OCR 行先记录 `raw_font_size`，不直接用于最终构建。
2. `typography.py` 按页面角色、粗细、颜色桶、方向和相邻字号带聚类。
3. 每个聚类生成稳定 `style_id`、`font_size_pt` 和字体家族。
4. 同一 `style_id` 的所有文本和 rich-text runs 必须使用相同字体与字号。
5. PPT 构建器对 `font_size_pt` 原样使用，不再追加逐对象缩放。

## Profile

```json
{
  "sourceFontVerified": true,
  "fonts": {
    "body": "Microsoft YaHei",
    "title": "Microsoft YaHei"
  },
  "roleSizes": {
    "page-title": 28,
    "body": 14,
    "footnote": 9
  },
  "fontSizePalette": [9, 10, 12, 14, 16, 18, 22, 28, 32]
}
```

只有字体文件、PDF 原生字体信息、模板设计规范或人工确认能够支持
`sourceFontVerified=true`。视觉模型给出的候选字体不能单独满足这一条件。

## 门禁

- `font-size-mode normalized`：统一样式字号并输出报告。
- `font-size-mode strict`：同时作为交付门禁。
- 相同 `style_id` 出现不同字体或字号时，`validate_text_grouping.py` 失败。
- `typography-calibration-report.json` 必须记录所有聚类、原始范围、最终字号和
  字体证据状态。
