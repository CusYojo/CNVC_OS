---
name: pdf-to-editable-ppt
description: 在 macOS、Windows 或 Linux 上将演示型 PDF 高还原转换为 PowerPoint，默认移除跨页、斜向、低透明度水印，并通过PPTX包内扫描和逐页渲染OCR生成无水印交接证书；支持富对象重建、扁平化OCR元素化、内嵌流程图、产品矩阵、文字密集型栅格图、竖排文字、扇形、曲线路径、图标、连接线、图表和表格的可编辑语义重建。适用于将PDF、WPS/PowerPoint导出稿、投资建议书、商业计划书或报告转换为1:1可编辑PPTX，尤其适用于后续串联 editable-ppt-content-replacer 的模板制作流程。
---

# PDF 转元素级可编辑 PowerPoint

将 PDF 的每一页重建为 PowerPoint 对象，同时保留源 PDF，并输出新的
`.pptx` 文件。交付时必须准确说明哪些内容可编辑。

## 必须遵循

- 使用当前会话中的 PDF 与 Presentations 技能；执行前完整阅读它们的说明。
- 优先使用工作区内置依赖。
- 使用 Python `zipfile` + Open XML 直接操作 PPTX 包结构，不依赖外部
  Node.js 运行时或 `@oai/artifact-tool`。
- 将源 PDF 视为视觉标准，不得擅自改版、摘要或改写；用户明确要求去除的
  水印是允许且必须执行的例外。
- 用户要求去水印时，转换成功不等于任务完成。必须通过最终 PPTX 包内扫描
  和逐页渲染 OCR 双重验收，生成可供内容替换技能读取的交接证书。

## 跨平台准备

先运行环境检查：

```bash
python3 "$SKILL_DIR/scripts/check_environment.py" --json
```

环境检查必须实际通过 LibreOffice 无头 PDF 导出和 pdftoppm 渲染冒烟测试；
仅检查到 `node` 命令不算可用。Linux 严格水印验收还必须同时存在
Tesseract 的 `chi_sim` 和 `eng` 语言包。Presentations 技能不在默认插件缓存时设置
`PRESENTATIONS_SKILL_DIR`。

核心富对象与图片路线支持 macOS、Windows 和 Linux。需要安装 Python 3、
PyMuPDF、Pillow 和 Poppler。Linux 还需要 LibreOffice、pdftoppm、
fonts-noto-cjk 和 Tesseract。扁平化 OCR 模式还需要
`opencv-python-headless`，并通过 `--ocr-engine auto` 自动选择：

- macOS 且存在 `swiftc`：Apple Vision；
- Windows 或 Linux，或没有 `swiftc` 的 macOS：Tesseract；
- 使用 `--ocr-json-dir`：读取外部 OCR JSON。

PPTX 构建脚本需要项目依赖 `pptxgenjs`。当技能目录与项目目录分离部署时，
必须将 `AI_PDF_TO_PPT_NODE_PROJECT_ROOT` 指向包含 `node_modules` 的项目根目录；
转换服务会自动传递该变量，手工运行转换器时需继承或显式设置。

在非 macOS 系统运行、安装依赖或执行原生应用验证时，阅读
[references/cross-platform.md](references/cross-platform.md)。

## 检查源文件并选择路线

先运行一次转换器，或使用 PyMuPDF 检查文件。转换器会生成
`route-report.json` 和 `editability-report.json`。前者判断 PDF 路线，
后者列出可能封装流程图、表格或文字的大面积内嵌图片：

- **富对象型（object-rich）**：重建可选择的文字、矢量图形、独立图片和图标。
  仍须检查大面积图片中是否封装了流程图、表格或大量文字；“富对象型”不代表
  每一个可见元素都已经独立。
- **扁平化型（flattened）**：每页只有一张整页图片，没有可用对象。此时选择：
  - 以 1:1 还原为最高优先级时使用 `image`；
  - 用户明确要求文字可编辑时使用 `ocr`；
  - 图标、图表或表格也必须可编辑时，使用 `ocr` 并提供覆盖清单。
- **混合型（mixed）**：富对象页面按对象重建，扁平化页面使用栅格回退。
  如果扁平化页面也要求文字可编辑，应只对这些页面运行 OCR 准备流程，
  再有意识地合并结果。当前单一转换命令不会自动合并混合型 OCR；
  对混合型文件使用 `--flattened-mode ocr` 时必须失败并列出扁平化页码，
  不得静默把这些页面作为不可编辑图片交付。

处理扁平化源文件时，阅读
[references/flattened-pdf-workflow.md](references/flattened-pdf-workflow.md)。

## 富对象型或整页图片高保真流程

1. 在工作区中创建独立、可写的构建目录。
2. 确认当前运行环境已安装 `PyMuPDF` 和 `Pillow`；仅在缺失时安装。
3. 运行：

```bash
python3 "$SKILL_DIR/scripts/convert_pdf.py" \
  --input "/absolute/source.pdf" \
  --output "/absolute/final.pptx" \
  --work-dir "/absolute/work-dir" \
  --watermark-qa-mode strict
```

将 `SKILL_DIR` 设置为本技能的绝对路径。仅当 `pdftoppm` 不在 `PATH` 中时，才传入
`--pdftoppm`。服务器任务默认限制 300 页、单个外部命令 1800 秒；需要扩大时
有意识地使用 `--max-pages` 和 `--command-timeout-seconds`，不得无限制处理不可信文件。

转换器会自动识别源文件结构。扁平化文件默认使用 `image` 模式，
能够精确保留外观，但只能把整页图片作为一个对象编辑。

富对象型路线会：

- 使用 Poppler 渲染 PDF，作为视觉对照基准；
- 默认识别并移除跨页重复、斜向、低透明度或包含常见保密提示的文字水印；
- 按字符基线提取文字，保留 PDF 原有换行；
- 保留显示列表中的对象顺序；
- 创建可编辑的原生矩形、线条和多边形；
- 将曲线保留为 SVG 矢量对象；
- 分别提取并放置图片；
- 识别常见的软蒙版辅助图像，避免其变成不透明色块；
- 为每一页添加来源备注；
- 渲染所有生成的幻灯片并导出 PPTX。

如果用户要求“所有元素可编辑”“图中这些框也要能改”或指定图片内部区域，
不得在基础转换后停止。应运行内嵌图片可编辑性审计，并通过 `--overrides`
把流程图、信息图或表格区域语义重建。具体流程和清单格式见
[references/embedded-diagram-workflow.md](references/embedded-diagram-workflow.md)。

## 水印处理（默认去除）

标准转换命令默认使用 `--watermark-mode auto`。该模式会综合以下证据，
只移除高置信度文字水印：

- 同一短语出现在至少一半页面；
- 斜向旋转、低透明度、大字号或大面积覆盖；
- 包含“保密资料”“内部资料”“仅供参考”“请勿外传”
  “Confidential”“Draft”等常见水印短语。

转换器会在工作目录生成 `watermark-report.json`，记录移除文字、页码、
透明度、角度和识别理由。交付前必须复核该报告，并在 PPTX 文本 XML 与
逐页渲染图中检查是否仍有残留。

转换完成后会强制运行 `scripts/validate_watermark_handoff.py`：

- 扫描 PPTX 中的幻灯片 XML、SVG 和其他文本资源；
- 对最终逐页渲染图按原角度及 `±30°/±45°` 旋转后执行 OCR；
- 发现“保密资料”“请勿外传”等目标短语时立即失败；
- OCR 后端不可用或没有最终渲染图时，严格模式立即失败；
- 通过后生成 `watermark-handoff-report.json`。

验收失败时不得进入内容替换阶段。应根据报告使用
`--watermark-mode aggressive` 或准确的 `--watermark-text` 重新转换；
矢量路径、独立图片或烧录水印必须先完成对应对象删除或背景修补。

可选参数：

- `--watermark-mode auto`：默认安全识别；
- `--watermark-mode aggressive`：扩大对跨页重复水印的识别范围；
- `--watermark-text "指定短语"`：明确移除该文字，可重复传入；
- `--watermark-opacity-threshold 0.45`：调整低透明度阈值；
- `--watermark-mode keep` 或 `--keep-watermarks`：明确保留全部文字水印。
- `--watermark-qa-mode strict`：默认，包内扫描和渲染 OCR 均必须通过；
- `--watermark-qa-mode xml-only`：只在无法运行 OCR 且用户接受风险时使用；
- `--watermark-qa-mode off`：关闭验收；输出不得标记为无水印底稿，也不得
  直接交给 `editable-ppt-content-replacer`。
- `--watermark-qa-ocr-timeout-seconds 120`：限制每次水印 OCR 调用；
  超时必须失败，不得跳过对应页面。

示例：

```bash
python3 "$SKILL_DIR/scripts/convert_pdf.py" \
  --input "/absolute/source.pdf" \
  --output "/absolute/final.pptx" \
  --work-dir "/absolute/work-dir" \
  --watermark-mode auto \
  --watermark-text "仅供项目评审使用"
```

自动过滤针对 PDF 中仍为独立文字对象的水印。若水印是矢量路径、独立图片，
或已烧录进整页栅格图，不得声称已经自动移除。应先识别其类型，再使用局部
覆盖、背景修补或图像修复；复杂纹理和照片背景不得直接盖不匹配的白色块。
扁平化水印的处理要求见
[references/flattened-pdf-workflow.md](references/flattened-pdf-workflow.md)。

## 与内容替换技能的强制交接

当下一步使用 `editable-ppt-content-replacer` 时，转换目录必须包含
`conversion-handoff.json`。1.1 版证书记录：

- 输出 PPTX 的绝对路径和 SHA-256；
- `pathBinding: "sha256"`、构建目录内报告的相对路径和报告 SHA-256；
- 水印处理策略及 `watermarkQaPassed`；
- 大面积内嵌图片可编辑性复核结果；
- 尚未元素化的页面；
- `readyForContentReplacement`。

只有 `readyForContentReplacement=true` 才能进入内容替换。以下情况必须
停止：

- 水印 OCR 或 PPTX 包内扫描未通过；
- 使用了 `keep` 或关闭水印验收；
- 存在未复核的大面积内嵌图片；
- 1.0 版证书的输出路径不一致，或任意版本的 SHA-256 不一致。

同一交接目录整体迁移到另一台服务器时，内容替换技能可根据
`pathBinding: "sha256"`、模板 SHA-256 和目录内相对报告路径重新绑定。
只复制 PPTX、不复制交接证书及 QA 报告，或模板哈希发生变化时仍必须停止。
1.0 版旧证书继续执行绝对路径严格匹配。

不得绕过交接证书，直接把一个“看起来已经转换”的 PPTX 当作锁定模板。

## 扁平化 PDF 的 OCR 可编辑流程

如果当前 Python 环境缺少 `opencv-python-headless`，先安装它。
默认使用 `--ocr-engine auto`：macOS 优先 Apple Vision，Windows/Linux
自动使用 PATH 中的 Tesseract。

```bash
python3 "$SKILL_DIR/scripts/convert_pdf.py" \
  --input "/absolute/source.pdf" \
  --output "/absolute/editable-text.pptx" \
  --work-dir "/absolute/work-dir" \
  --flattened-mode ocr \
  --ocr-engine auto \
  --ocr-min-confidence 0.45
```

可选参数：

- `--ocr-engine`：选择 `auto`、`apple-vision`、`tesseract` 或 `json`；
- `--ocr-json-dir`：使用预先生成的 `slide-XX.json` OCR 文件；
- `--tesseract`：Tesseract 不在 PATH 时传入可执行文件路径；该路径同时
  用于扁平化 OCR 和最终严格水印验收；
- `--ocr-languages`：使用 BCP-47 语言列表，如 `zh-Hans,en-US`；
- `--ocr-body-font`、`--ocr-title-font`：覆盖系统默认 OCR 字体；
- `--ocr-corrections`：传入精确替换规则和归一化排除区域；
- `--overrides`：传入独立图标、原生图表、表格和形状的重建清单。

OCR 只是起点，不是成品。必须逐页检查并修正识别错误；如果对密集截图
执行 OCR 后的效果比源文件更差，应保留为栅格图片。

当图表或表格需要可编辑时：

1. 用外观匹配的原生形状覆盖扁平化图表或表格区域。
2. 通过 `--overrides` 添加原生图表或表格（使用 Python zipfile + Open XML 直接操作）。
3. 跳过重建区域内的 OCR 文字，避免内容重复。
4. 在 Microsoft PowerPoint 中复查；表格行高和图表标记的渲染结果
   可能与 LibreOffice 预览不同。Linux 上无法进行 PowerPoint 原生验证，
   在交付时披露替代验证。

## 图标独立编辑流程

当用户要求图标可以单独修改时，按以下优先级处理：

1. **PowerPoint 原生形状**：适合圆形、箭头、勾选、人物轮廓等简单图标；
   可直接修改填充、描边、尺寸和组成部件。
2. **独立 SVG**：适合复杂线性或品牌图标；可单独移动、缩放，
   并可在 PowerPoint 中“转换为形状”后编辑路径和颜色。
3. **独立栅格图片**：仅用于无法可靠矢量化的图标；只能移动、缩放、
   裁剪和替换，不能修改内部路径或颜色。

富对象 PDF 中已经独立存在的图片、SVG 和矢量路径应原样分离。
对于扁平化 PDF 或没有独立图标对象的页面，通过 `--overrides` 的 `icons`
数组重建图标，并使用 `cover` 遮盖原图标，防止移动新图标后露出旧图标。
复杂背景优先使用背景修补图作为 `cover.asset`，不要使用不匹配的纯色块。

图标覆盖清单的完整字段和示例见
[references/flattened-pdf-workflow.md](references/flattened-pdf-workflow.md)。
不得用字体字符冒充非字体图标，除非已经确认字体在 PowerPoint 中可稳定渲染。

## 内嵌流程图与信息图元素化

富对象 PDF 可能把一整张流程图作为栅格图片嵌入，同时把页面其他文字保留为
对象。若图片内部包含节点框、连接线、标签、表格或图例，而用户要求这些内容
可编辑，必须执行以下步骤：

1. 从 `pdf-model.json` 找到该图片的 `bbox` 和资源文件。
   优先检查 `editability-report.json` 中标记为 `review-required` 的页面。
2. 对照页面渲染，列出需要独立编辑的节点、连接线和文字。
3. 在覆盖清单中先用 `covers` 完整遮盖原图区域；复杂背景使用背景修补图。
4. 用 `shapes` 重建节点和容器，用 `connectors` 重建附着式连接线，
   用 `texts` 重建独立标签；图表和表格分别使用 `charts`、`tables`。
5. 用稳定、语义化的 `name` 命名每个对象，并通过 `--overrides` 生成 PPTX。
6. 检查最终 PPTX 的 inspect 结果，确认目标文字不再只存在于图片像素中。

不得只在原图上叠加可编辑文字或节点；移动新对象后露出旧图即为失败。
若只重建用户指定局部，也必须先完整清除该局部的旧像素内容。连接线应绑定
节点，而不是保留在图片中。

### 内嵌图片中的文字矩阵

若大面积图片内部主要是带底色的产品矩阵、工艺流程表、能力地图或密集标签，
不应把整图当作一个 OCR 区域。使用
`scripts/prepare_embedded_image_ocr.py`：

1. 以图片原始资源和其最终幻灯片坐标为输入；
2. 检测蓝、灰、黄等实心矩形单元格；
3. 对横排单元格逐格 OCR；对窄竖排中文先按字符行分割，再按原顺序组合；
4. 用单元格背景色清除旧文字，并输出完整的去字底图；
5. 通过 `imageReplacements` 在 PDF 原图片的显示列表位置原位替换底图，
   不得把底图统一置于页面最底层；
6. 用 `texts` 添加独立可编辑文本框；
7. 在校正 JSON 中使用 `cell_text` 和 `free_text` 精确修订重要短文本、
   产品名、英文缩写与竖排文字。

脚本会生成 `embedded-ocr-report.json`，其中必须达到检测单元格全覆盖，且
`recognized_cells` 中的文字已人工核对。OCR 结果即使置信度较高，也不得
直接视为最终文案。

## 扇形、曲线与裁剪填充

PDF 可能使用 `fill-shade` 绘制扇形或曲线区域。PyMuPDF 有时会同时把这类
填充暴露为一张矩形图片；如果直接放入 PowerPoint，扇形会变成“矩形底色＋
圆弧描边”。

遇到饼图、环形图、弧形色块或圆角裁剪填充时：

1. 对照 `get_bboxlog()`，区分 `fill-shade` 与真正的 `fill-image`；
2. 检查同一边界后续是否存在由贝塞尔曲线和中心连线组成的描边路径；
3. 若 shade 图片为单一纯色，将颜色融合进该曲线路径，并跳过矩形图片；
4. 保留曲线路径的闭合、填充规则、白色分隔描边、透明度和显示顺序；
5. 若 shade 为真实渐变或纹理，不得直接保留矩形；应应用原裁剪路径，
   或对该局部执行带透明边界的裁剪重建；
6. 逐个检查扇区是否以共同圆心闭合、外弧半径一致、分隔线没有缺口，
   标签仍位于对应扇区内。

转换日志中的“裁剪纯色填充已融合”数量应与源 PDF 中需要融合的对象一致。
曲线扇区默认保留为独立 SVG 矢量对象；可在 PowerPoint 中转换为形状后编辑
路径节点。需要直接修改数据时，应通过覆盖清单重建为原生饼图。

## 保真规则

- 必须精确匹配 PDF 页面宽高比。
- 根据 PDF 的实际页面宽度计算缩放比例。不得假设页面一定是
  `960 × 540 pt`；扁平化导出稿可能是 `1920 × 1080 pt` 或其他尺寸。
- 按字体家族名称保留原字体；即使构建预览发生字体替换，也优先保留源字体。
- 将文字、图标、图片和简单矢量形状保留为独立可编辑对象。
- 对用户指定的图片内部流程图、节点框、连接线和标签执行语义重建；不得把
  包含多个逻辑元素的一整张图片描述成“元素级可编辑”。
- 只有当复杂蒙版元素拆分后会出现明显损坏时，才对该局部使用栅格裁图。
- 保留源文件中的对象顺序。除非 PDF 显示列表本身如此，不得把所有矢量
  统一放到所有图片下方。
- 不得把 `fill-shade` 生成的矩形图片直接覆盖在扇形、圆角或曲线路径上。
- 不得把可搜索但被裁切隐藏的 WPS 水印文字暴露为可见的 PowerPoint 对象。
- 默认去除高置信度文字水印；不确定对象必须保留并记录，除非用户使用
  `--watermark-text` 明确指定或选择 `aggressive`。
- 不得把栅格化图表、照片或插画描述成原生可编辑对象。
- 不得把独立栅格图标描述成路径可编辑图标；SVG 也必须说明需要在
  PowerPoint 中转换为形状后才能编辑内部节点。
- 添加可编辑 OCR 文字前，必须移除或完整遮盖原有栅格文字，不能让旧文字
  留在新文字下方。
- 对界面截图、论文页面、代码块或密集技术表格中的低置信度 OCR，
  除非经过人工核对，否则应予以排除。

## 质检与交付

阅读 [references/fidelity-and-qa.md](references/fidelity-and-qa.md)，
执行其中要求的对比检查与故障排查。

交付前：

1. 渲染最终文件中的每一页幻灯片。
2. 以原始尺寸逐页检查信息密集页和图片较多的页面。
   纯终端服务器必须保留逐页 PNG，并将其交给具有视觉读取能力的审阅环境；
   仅生成图片、未实际审阅不算完成。
3. 如果可以使用 Microsoft PowerPoint，在其中打开 PPTX 并导出验证 PDF，
   再与源 PDF 对比；Linux 上用内置渲染器与 LibreOffice 做兼容性检查，
   并说明未经过 PowerPoint 原生验证。
4. 运行 Presentations 技能中的 `slides_test.py`。
5. 确认 PPTX 可以正常打开，且不存在画布溢出。
6. 检查 `watermark-report.json`，搜索 PPTX 解包后的幻灯片 XML，
   并逐页确认没有目标水印残留或误删正常正文。
7. 确认 `watermark-handoff-report.json` 的 `passed=true`，并且
   `conversion-handoff.json` 的 `readyForContentReplacement=true`；
8. 审计大面积图片：若图片内部存在流程图、表格、图例或明显文字，确认用户
   要求的节点、连接线和标签均出现在 inspect 结果中，并可分别选择。
9. 只交付最终 PPTX，并简要说明图标采用原生形状、SVG 还是栅格图片，
   以及哪些其他元素仍是 SVG 或栅格图片。

使用准确的交付表述：

- **图片高保真版**：每页是一张可移动、裁剪或替换的整页图片；
  页内文字和图表不能单独编辑。
- **OCR 可编辑版**：已核对的标题、正文和标签均为独立文本框；
  被排除的截图和复杂插画仍为栅格图片。
- **语义重建版**：明确列出哪些图标是原生形状、哪些是独立 SVG，
  哪些原生图表和表格可编辑数据，并指出仍保留为栅格图片的元素。
