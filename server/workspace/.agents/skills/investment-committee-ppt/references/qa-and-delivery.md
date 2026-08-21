# QA 与交付规范

## 四层 QA

### 第一层：内容覆盖

- 基准 Word/逐页框架中的重要事实有明确去向。
- 行业、产品、技术、团队、客户、商业、财务、交易、治理、验证事项均覆盖或说明缺口。
- 页面顺序形成连续研究叙事。
- 每页行动标题与证据一致。

### 第二层：数据与证据

- 指标保留脚本无意外缺失。
- 金额、百分比、年份、单位、实际/预测一致。
- 财务公式、融资前后估值、持股比例交叉校验。
- 意向/订单/收入/回款不混用。
- 来源等级和日期可追溯。

### 第三层：PPTX 结构

- 文件 ZIP 结构完整，可用 PowerPoint 打开。
- 页数正确，无 `TODO/TBD/占位符/lorem ipsum`。
- 重要对象未超出画布。
- 文本、形状、图表保持可编辑。
- 中英文字体字段正确，正文未出现 11.x pt。
- PDF 页数与 PPTX 一致。

### 第四层：视觉渲染

逐页检查原生 PDF 或 160–200 dpi PNG：

- 标题、Logo、页脚、署名不裁切。
- 文本无溢出、孤立标点、单字尾行。
- 线条/箭头不穿字、不贴字、不越层。
- 表格分隔线没有多伸出或错位。
- 数字、单位、年份、图例和坐标清楚。
- 主次明确，3 秒能看出核心结论，10 秒能读懂主证据。
- 页面密集但不拥挤，不出现失衡大空白。
- 同一图片不过度复用，低清图片未被放大。

## 标准执行顺序

```powershell
python scripts/audit_pptx.py deck.pptx --expected-slides 24 --report qa-report.json
python scripts/audit_metric_retention.py deck.pptx --required metrics.txt --report metric-report.json
powershell -ExecutionPolicy Bypass -File scripts/render_powerpoint.ps1 -InputPptx deck.pptx -OutputPdf deck.pdf
python scripts/render_pdf_pages.py deck.pdf --output-dir D:\company_deck_qa --dpi 160
python scripts/make_contact_sheets.py --input-dir D:\company_deck_qa --output-dir D:\company_deck_qa\contact --columns 4
```

大文件、PDF 和截图优先输出到 `D:\`。接触表用于全稿节奏，重点页必须查看单页原尺寸。

## 修复优先级

1. 裁切、溢出、错误数字、图形语义错误。
2. 文字与线条重叠、丢标签、不可读图表。
3. 核心结论不清、页面结构杂乱。
4. 密度和字体尺度不协调。
5. 颜色、细线、图片重复等风格问题。

修复高优先级问题时不得引入缩字、内容遗漏或新的对齐错误。

## 回归检查

每次全局字体、主题或布局函数修改后，至少回归：封面、最长标题页、最密正文页、流程页、表格页、财务图表页、交易结构页、最后一页。字体放大后重点检查换行、标签遮挡和箭头端点。

## 交付清单

- `[公司名]投资建议书.pptx`
- `[公司名]投资建议书.pdf`
- 可选：`source-ledger.csv`、`qa-report.json`、`metric-report.json`
- 可选：`素材来源.md`、`待核验问题.md`

交付消息说明：采用的内容基准、主要结构变化、数据是否有待核验项、文件位置。不要声称“完全无问题”，除非已完成原生渲染与逐页复查。
