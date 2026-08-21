# 工具与实现路径

## 输入读取

- DOCX：pandoc、python-docx、OOXML；同时使用 Word 文档技能的渲染流程检查版面。
- PDF：pdftotext/pdfplumber 用于内容，Poppler `pdftoppm` 用于逐页图像；扫描版 OCR。`render_pdf_pages.py` 会先查 PATH，再查 Codex bundled runtime。
- PPTX：python-pptx/OOXML 抽取文本、字号、对象位置和备注；PowerPoint COM 做最终渲染。
- XLSX/CSV：openpyxl/pandas 用于审计；保留公式、单位和原始值。

## 公开资料与视觉调研

业务事实使用搜索/浏览工具访问权威一手来源。视觉调研可搜索公开年报、投资者关系材料、编辑设计、公司 pitch deck 和 GitHub PPT 工具，但只借鉴信息语法。

本项目曾参考的公开方向包括：Pentagram 的年报设计、Behance 企业 pitch deck、公开 investor presentation 样例，以及 `addsumtech/slides_maker`、`CacinieP/ppt-skills`、`vedraut/slidesage` 等仓库。它们用于发现方法，不构成数据来源，也不应照搬资产。

## PPT 生成

优先选择能产出原生可编辑对象的工具：

- PptxGenJS：适合程序化形状、文本、图表和布局帮助函数。
- python-pptx：适合结构审计、后处理和简单生成。
- artifact-tool / Presentation 工具：适合组合式生成与转换。
- PPT-Design-DNA：适合先形成设计合同、母型和风格迁移思路。

无论使用哪个库，生成代码只是中间产物。最终输出需要在 Microsoft PowerPoint 中打开并导出 PDF。

## 字体后处理

PowerPoint 中中英混排可能因为 `a:latin`、`a:ea`、`a:cs` 字段不一致而替换字体。`postprocess_bilingual_fonts.py` 直接处理 PPTX OOXML：中文设为楷体，英文/数字设为 Times New Roman，并可把 11.x pt 提升至 12 pt。运行前保留源文件副本。

## 原生导出

Windows 上使用 `render_powerpoint.ps1` 调用 PowerPoint COM。它比 LibreOffice 或第三方渲染更接近用户实际打开效果。导出失败时检查：PowerPoint 是否安装、文件是否被占用、路径是否存在、COM 进程是否残留。

## 自动审计

- `audit_pptx.py`：页数、占位符、对象越界、字体/字号风险、ZIP 完整性。
- `audit_metric_retention.py`：逐项检查基准指标是否仍出现在 PPT 文本中。
- `make_contact_sheets.py`：将全页 PNG 拼成接触表，用于观察节奏和重复母型。
- `render_pdf_pages.py`：调用 Poppler 将原生 PDF 渲染为逐页 PNG。
- `resolve_design_profile.py`：将正式 Profile v001 与高密度投委会 Adapter a001 合并为项目级 `active-design-dna.json`。
- `install_design_profile.py`：在用户明确需要由通用 `$PPT-Design-DNA` 发现该风格时，把捆绑 Profile 安装到当前项目的 `design-profiles/`；已有同名 Profile 时默认拒绝覆盖。

自动脚本不能可靠判断：线条是否视觉贴字、页面是否太空、数字是否突兀、阅读路径是否清晰、图片是否与论证相关。因此必须人工看图。

## 版本与文件

源代码、蓝图、设计合同和 QA 记录存项目工作区；最终 PPTX 放用户指定位置；PDF、逐页 PNG、接触表等大文件放 `D:\`。不覆盖用户原始文件，使用新版本名并在确认后复制为正式文件。

## 可编辑性检查

抽查每类页面：标题可编辑、图表数据或形状可编辑、流程节点和连线可编辑、表格是真实表格或独立文本/线条、图片不是包含整页文字的截图。若使用图像生成，只用于照片/插画/纹理，不用来生成含关键文字的整页幻灯片。
