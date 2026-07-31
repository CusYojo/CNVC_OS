# 段落级文字聚类

## 目标

将属于同一段落的多行 PDF 文字写入一个 PowerPoint 文本框，同时阻止跨栏目、
表格单元格、图表标签、按钮和独立数字的误合并。

## 模式

- `line`：保持旧行为；一条视觉行对应一个文本框。
- `hybrid`：默认；仅合并字体、字号、颜色、方向、行距和对齐关系均兼容的
  连续视觉行。
- `paragraph`：放宽字体家族、粗体和斜体限制，适合结构简单的正文页；仍阻止
  独立数字与项目符号之间的合并。

换行策略：

- `preserve`：在同一文本框内保留原始视觉换行。
- `smart`：左对齐、行宽接近且未以终止标点结束时视为软换行，其余保留。
- `reflow`：尽量移除行间换行，让 PowerPoint 按文本框宽度重新排版。

本 Skill 的 1:1 默认是 `preserve`。用户只要求“多行一起编辑”但强调 1:1 时，优先使用
`hybrid + preserve`；用户还希望修改文本框宽度后自动重排时使用
`hybrid + smart`。

OCR 默认增加 `order_mode=spatial`：先用字号、样式、垂直距离和对齐关系建立
局部段落链，再执行顺序合并。这样双栏、卡片和 OCR 检测器乱序不会把同一段落
拆开，也不会用全局 y/x 排序交叉合并两栏。

## 数据结构

段落对象仍使用 `kind: text`，并增加：

```json
{
  "text_grouping": "paragraph",
  "source_line_count": 3,
  "source_lines": [],
  "line_breaks": ["soft", "hard"],
  "runs": [
    {
      "text": "正文",
      "font": "Microsoft YaHei",
      "font_size": 16,
      "bold": false,
      "color": "#222222"
    }
  ]
}
```

构建器必须对整个段落只调用一次 `addText()`。不同样式通过 `runs` 保留；不要
把各行创建为多个文本框后再执行组合。

## 防误合并

同时满足以下条件才合并：

- 两个对象在显示顺序中连续，且均为水平文字；
- 行距落在字号约束范围内；
- 左对齐、居中或右对齐关系稳定，并具有足够水平重叠；
- 字号和颜色兼容；`hybrid` 还要求字体、粗体和斜体一致；
- 下一行不是新的项目符号；
- 两行不是独立短标签或数字；
- 合并后的源行数不超过模式上限。

视觉模型可提出文本容器和阅读顺序，但不得单独改写文字或精确坐标。复杂
双栏、表格、图表或卡片页出现误合并时，先切换 `hybrid + preserve`；仍不安全
时对该文档使用 `line`，再通过语义覆盖重建指定段落。

## QA

必须运行 `validate_text_grouping.py` 并检查：

- 聚类前后去空白文字摘要一致；
- 段落 `runs` 拼接结果与 `text` 一致；
- `source_line_count` 与 `source_lines` 数量一致；
- bbox 有效且没有空文本框；
- 记录 `groupedParagraphCount`、`groupedSourceLineCount` 和
  `textObjectReduction`。
- 用户明确要求整段一起编辑时启用 `--require-paragraph-coverage`，并要求
  `unmergedParagraphCandidateCount=0`。
- 相同 `style_id` 的字体和字号必须一致。

最终仍需逐页渲染，检查软换行造成的重排、字体回退、溢出和跨容器误合并。
