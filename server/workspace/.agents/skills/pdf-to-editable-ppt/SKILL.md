---
name: pdf-to-editable-ppt
description: 在 Linux、macOS 或 Windows 上，将演示型、扫描型或混合型 PDF 高还原转换为可编辑 PowerPoint；通过段落级文字聚类避免多行正文被拆成逐行文本框，并可融合视觉大模型、专业 OCR、OpenCV 与 PyMuPDF 原生对象证据，识别内嵌流程图、表格、矩阵、图表和图标。用于 PDF 转 PPTX、全文字可编辑、正文多行整体编辑、扁平化文字元素化、图片内部结构识别、视觉辅助重建、严格去水印验收或后续内容替换模板交接。
---

# PDF 视觉融合可编辑 PowerPoint

保留 PDF 原生对象提取、OCR、图像回退和水印 QA，并增加可关闭的视觉分析与
证据融合。大模型负责语义，PDF/OCR/OpenCV 负责事实和几何；不得让视觉模型
单独决定正文、数字或精确坐标。

## 必须遵循

- 执行前完整阅读当前会话中的 PDF 与 Presentations 技能。
- 保留源 PDF；输出到新的 `.pptx`。
- 使用 PyMuPDF 原生文字、路径、图片和显示顺序作为首选事实来源。
- 只有通过 PDF 原生文字、OCR 或人工校正验证的文字才能自动写入 PPT。
- 默认使用 `hybrid + preserve + spatial` 将同一正文段落写入一个 PowerPoint 文本框；
  不得以 PowerPoint“组合”冒充段落级编辑。
- OCR 行框高度只能作为字号候选，禁止直接逐行写入 PPT。必须先执行 deck 级
  typography 校准：相同 `style_id` 的字体、字号、粗细必须完全一致。
- 扁平化 PDF 无法仅凭像素证明精确字体家族。用户要求与模板字体一致时，必须
  提供或生成 `typography-profile.json`，并在报告中区分“已验证字体”和“候选字体”。
- 金额、日期、百分比、数量和图表数据不得仅凭视觉模型生成。
- 视觉服务不可用时按模式失败或安全降级，不得伪造分析结果。
- 当执行本 Skill 的 Codex Agent 本身支持图片输入时，默认由当前 Agent 直接完成
  页面理解和渲染复核；不要为了调用同一模型再建立 HTTP 视觉服务。
- 低置信度或不完整区域保留为栅格，并在报告中披露。
- 用户要求所有文字、图标或流程元素可编辑时，切换到 `required` 语义重建，
  并设置 `--editable-targets`；
  不得把 OCR 文字覆盖版当作全元素可编辑版。
- 视觉识别出图标不等于图标已经可编辑。每个要求可编辑的图标必须具有稳定 ID、
  `type=icon` 重建对象和 `build-manifest.json` 发射记录；整页背景中的像素不计数。
- 对扁平化页完成首次去字后，必须重新 OCR 最终去字背景；任何未豁免的有效
  文字残留都必须清除并补建文本框。
- 全元素可编辑任务必须生成移除整页背景的前景版 QA PPTX；隐藏背景后，
  要求可编辑的文字、图标、线条、箭头和节点仍须完整可见。
- 去水印任务必须通过 PPTX 包扫描与最终渲染 OCR。
- Linux 交付必须说明未经过 Microsoft PowerPoint 原生验证。

## 环境

先运行：

```bash
python3 "$SKILL_DIR/scripts/check_environment.py" --json
```

Linux 必须具备：

- Python 3、PyMuPDF、Pillow、OpenCV Headless；
- Poppler `pdftoppm`；
- LibreOffice Headless；
- Tesseract，以及 `chi_sim`、`eng`；
- Noto CJK 字体；
- Node.js；
- Codex/Presentations 运行时中的 `@oai/artifact-tool`，或兼容部署使用的
  `pptxgenjs`。

在 Codex 中先调用 `load_workspace_dependencies`，将返回的 Node 依赖目录配置为：

```bash
export PDF_TO_PPT_ARTIFACT_TOOL_ROOT="/absolute/dependencies/node"
export AI_PDF_TO_PPT_BUILDER_BACKEND="artifact-tool"
```

独立服务暂未提供 `@oai/artifact-tool` 时，才使用兼容后端：

```bash
export AI_PDF_TO_PPT_BUILDER_BACKEND="pptxgenjs"
export AI_PDF_TO_PPT_NODE_PROJECT_ROOT="/absolute/project-with-node_modules"
```

完整 Linux 部署要求见
[references/cross-platform.md](references/cross-platform.md)。

## 视觉运行模式

- `off`：关闭视觉分析，保持确定性转换。
- `audit`：生成视觉分析和语义计划，但不自动应用模型重建。
- `assist`：应用置信度达到门槛且标记为完整的安全重建。
- `required`：视觉分析失败或仍有待解决的语义区域时停止。

生产上线顺序必须先 `audit`，验证后再切换 `assist`。只有用户明确要求所有
目标区域必须元素化时才使用 `required`。

## 默认视觉后端：当前 Agent

Linux 上的 Codex Agent 使用 `gpt-5.6-sol` 且运行面支持本地图片输入时，视觉
识别采用“两阶段 Agent 原生工作流”：

1. 脚本准备高分辨率页面图、PDF 原生事实和待分析页清单。
2. 当前 Agent 逐页查看图片，按 Schema 写入 `page-XX.json`。
3. 转换脚本以 `--vision-provider json` 读取结果并执行证据融合和 PPT 构建。
4. 当前 Agent 对比源页面图和 PPT 渲染图，写入 `qa-page-XX.json`。
5. 脚本汇总视觉复核并重新签发交接报告。

模型名称本身不等于具备视觉输入能力。若服务器运行面不能把本地 PNG/JPEG
交给当前 Agent，则必须改用支持图片输入的 Codex 运行面，或显式配置 HTTP
视觉服务；不得只把图片路径当文本发送给模型并声称完成了识别。

## 快速开始

### 无视觉增强

```bash
python3 "$SKILL_DIR/scripts/convert_pdf.py" \
  --input "/absolute/source.pdf" \
  --output "/absolute/final.pptx" \
  --work-dir "/absolute/build" \
  --vision-mode off \
  --watermark-qa-mode strict
```

默认文字与字号策略：

```text
--text-grouping hybrid --line-break-mode preserve
--paragraph-order spatial --font-size-mode normalized
```

需要最高视觉保真但接受逐行编辑时使用 `--text-grouping line`。页面结构简单且
希望扩大正文合并范围时使用 `--text-grouping paragraph`。用户明确要求“一句话
多行一起编辑”时增加 `--require-paragraph-coverage`。换行策略及误合并
防护见 [references/text-grouping.md](references/text-grouping.md)。

要求模板字体、字号一致时提供：

```bash
--typography-profile "/absolute/typography-profile.json" \
--font-size-mode strict
```

Profile、字号聚类和字体限制见
[references/typography-calibration.md](references/typography-calibration.md)。

### 当前 Agent 原生视觉识别

先准备页面和事实清单：

```bash
python3 "$SKILL_DIR/scripts/prepare_agent_vision.py" \
  --input "/absolute/source.pdf" \
  --work-dir "/absolute/build" \
  --agent-model "gpt-5.6-sol" \
  --editable-targets "text,icons"
```

读取 `/absolute/build/agent-vision-request.json`。对其中每个
`analysisPages[].image`，使用当前 Agent 的图片查看能力进行识别，并将结果写到该页的
`analysisOutput`。输出必须满足
`references/agent-vision-analysis.schema.json`，不能把视觉猜测写成 PDF
事实。

然后执行融合与构建：

```bash
python3 "$SKILL_DIR/scripts/convert_pdf.py" \
  --input "/absolute/source.pdf" \
  --output "/absolute/editable.pptx" \
  --work-dir "/absolute/build" \
  --vision-mode required \
  --vision-provider json \
  --vision-json-dir "/absolute/build/agent-vision" \
  --vision-qa-mode off \
  --vision-min-confidence 0.85 \
  --editable-targets "text,icons" \
  --require-paragraph-coverage \
  --font-size-mode strict
```

构建完成后，当前 Agent 按 `qaPages[]` 逐页对比 `sourceImage` 与
`artifactImage`，并检查 `foregroundImage` 中不存在重复源文字、源栅格或
缺失的必需语义对象。将复核结果写到对应 `qaOutput`，且必须满足
`references/agent-visual-qa.schema.json`。再运行：

```bash
python3 "$SKILL_DIR/scripts/review_renders_with_vision.py" \
  --source-render-dir "/absolute/build/source-renders" \
  --artifact-render-dir "/absolute/build/artifact-renders" \
  --foreground-render-dir "/absolute/build/foreground-renders" \
  --require-foreground \
  --output "/absolute/build/visual-qa-report.json" \
  --mode required \
  --provider json \
  --json-dir "/absolute/build/agent-vision"

python3 "$SKILL_DIR/scripts/finalize_agent_handoff.py" \
  --work-dir "/absolute/build"
```

当前 Agent 的结构化 JSON 是可审计的中间产物，因此在转换器内部仍表示为
`--vision-provider json`；这不代表使用了另一个模型。

### 可选：Linux 内网 HTTP 视觉服务审计

```bash
python3 "$SKILL_DIR/scripts/convert_pdf.py" \
  --input "/absolute/source.pdf" \
  --output "/absolute/audit.pptx" \
  --work-dir "/absolute/build" \
  --vision-mode audit \
  --vision-provider http \
  --vision-endpoint "http://vision-service:8000/analyze" \
  --vision-min-confidence 0.85
```

### 可选：HTTP 服务应用高置信度视觉重建

```bash
python3 "$SKILL_DIR/scripts/convert_pdf.py" \
  --input "/absolute/source.pdf" \
  --output "/absolute/editable.pptx" \
  --work-dir "/absolute/build" \
  --vision-mode assist \
  --vision-provider http \
  --vision-endpoint "http://vision-service:8000/analyze" \
  --vision-min-confidence 0.85 \
  --flattened-mode ocr \
  --ocr-engine tesseract
```

### 离线 JSON 回放

```bash
python3 "$SKILL_DIR/scripts/convert_pdf.py" \
  --input "/absolute/source.pdf" \
  --output "/absolute/editable.pptx" \
  --work-dir "/absolute/build" \
  --vision-mode assist \
  --vision-provider json \
  --vision-json-dir "/absolute/vision-json"
```

视觉 JSON 协议、对象 Schema 和 HTTP 请求格式见
[references/vision-integration.md](references/vision-integration.md)。

## 工作流

1. 以 96 DPI 渲染 PDF，供原生对象裁切和基准对照。
2. 视觉模式开启时，再按 `--vision-render-dpi` 渲染模型输入，默认 200 DPI。
3. 使用 `extract_pdf_model.py` 生成 `pdf-model.json`，并将字符、样式片段和
   视觉行按 `line`、`hybrid` 或 `paragraph` 策略组织为文本框。
4. 生成 `route-report.json`，识别原生、扁平化和大图候选页面。
5. 对扁平化页和大图候选页执行视觉分析。默认由当前 Agent 查看图片并写入
   分页 JSON；HTTP 后端仅为可选的自动化部署方式。转换器汇总生成
   `vision-analysis.json`。
6. 将视觉语义与 PDF 原生文字、对象位置融合，生成：
   - `semantic-plan.json`
   - `semantic-overrides.json`
7. 构建 PPTX，并同步生成 `build-manifest.json`。
8. 使用 `validate_semantic_build.py` 验证计划中的对象确实写入构建清单。
9. 使用 `validate_canvas_bounds.py` 检查所有对象未越出幻灯片画布。
10. 生成移除源背景、源图片、源矢量和已被重建源文字的前景版 QA PPTX。
11. 使用 LibreOffice 渲染成品与前景版的全部页面。
12. 执行规则检查与当前 Agent 视觉复核，生成 `visual-qa-report.json`。
13. 执行水印包扫描和多角度 OCR。
14. 对最终去字背景执行二次 OCR，并生成前景独立性审计。
15. 生成 `conversion-handoff.json`；当 Agent 复核尚未完成时必须保留
    `agentVisualQaPending=true`，不得提前签发可替换证书。
16. 用户指定对象类别时，执行 `validate_editable_coverage.py`；任何未清点或未
    发射的文字、图标、表格、图表、形状或连接线都会阻断交付。

## 证据裁决

文字优先级：

```text
PDF 原生文字 > 专业 OCR > 人工校正 > 视觉模型候选
```

坐标优先级：

```text
PDF 边界 > OpenCV 几何 > OCR 框 > 视觉模型近似框
```

语义关系由视觉模型提出，但必须通过对象、线条、OCR 或人工清单验证。

默认只自动应用同时满足以下条件的区域：

- `recommendedAction = semantic-rebuild`
- `reconstructionComplete = true`
- `confidence >= --vision-min-confidence`
- 构建对象具有稳定名称和有效 bbox
- 文字能够匹配 PDF 原生证据，或用户明确允许未验证视觉文字
- 表格、图表数据具有 `verifiedData = true`

不得在生产环境默认使用 `--allow-unverified-vision-text`。

## 构建对象

语义构建器支持：

- `covers`：纯色覆盖或背景修补图片；
- `imageReplacements`：原图片原位替换；
- `shapes`：原生矩形、圆角矩形、椭圆、菱形等；
- `connectors`：基于命名节点位置生成的可编辑直线或折线；
- `texts`：独立文本框；
- `icons`：原生复合形状、SVG 或栅格图标；
- `tables`：PowerPoint 表格；
- `charts`：数据已验证的原生图表。

连接线使用 `head=目标端`、`tail=来源端` 的统一契约。`artifact-tool` 后端
使用节点附着连接线；PptxGenJS 兼容后端只按节点位置计算端点，不保证随节点
移动，交付时不得把兼容后端结果声称为附着式连接线。

PDF 原生 drawing 默认仍以 SVG 保存；只有语义计划明确创建的简单形状才是
PowerPoint 原生形状。

## 页面策略

- 原生页：以 PyMuPDF 对象为主，只分析大面积内嵌图片。
- 扁平化页：以 OCR、OpenCV 和视觉分析为主，低置信度区域保留图片。
- 混合页：富对象区域按对象重建；扁平化区域按图片或手工覆盖处理。
- 照片、复杂插画、截图和无法验证的数据图表默认保留栅格。
- 大面积图片只有在当前 Agent 按候选图逐一确认属于照片、截图、复杂插画或
  装饰，并以高置信度输出 `keep-raster` 后，才能标记为
  `agent-reviewed-raster-accepted`；未逐一复核的候选仍必须进入人工检查。

当前单命令仍不自动合并混合型 PDF 的选择性整页 OCR；需要文字元素化时，
拆分对应页或使用局部语义覆盖，不得静默输出不可编辑文字。

## 输出报告

构建目录至少包含：

- `pdf-model.json`
- `text-grouping-report.json`
- `text-grouping-qa-report.json`
- `typography-calibration-report.json`
- `editable-coverage-report.json`
- `route-report.json`
- `editability-report.json`
- `vision-analysis.json`
- `semantic-plan.json`
- `semantic-overrides.json`（视觉模式启用时）
- `build-manifest.json`
- `semantic-build-report.json`
- `visual-qa-report.json`
- `watermark-report.json`
- `watermark-handoff-report.json`
- `conversion-handoff.json`
- `editability-residue-report.json`
- `editable-surface-audit.json`
- `foreground-only.pptx`（仅 QA，不交付）
- `foreground-renders/`（仅 QA，不交付）
- `canvas-overflow-report.json`

只有以下条件同时成立时，才能令 `readyForContentReplacement=true`：

- 水印 QA 通过；
- 文字段落聚类 QA 通过；
- typography 校准通过，且相同 `style_id` 不存在字体或字号漂移；
- 用户指定的可编辑对象覆盖率通过；
- 语义构建 QA 通过；
- 没有待解决的视觉语义区域；
- 没有未复核的大面积内嵌图片。
- 二次 OCR 没有未豁免的有效文字残留；
- 画布边界检查通过；
- 前景版 QA 中要求可编辑的业务信息仍然完整；
- 当前 Agent 最终视觉复核已完成，`agentVisualQaPending=false`；
- 成品文件 SHA-256 与交接证书记录一致。

## 质检

- 渲染最终 PPTX 的每一页。
- 必须运行本 Skill 的 `validate_canvas_bounds.py`；若当前 Presentations
  运行时提供 `slides_test.py`，再追加运行该检查器。
- 检查文字换行、字体回退、遮挡、画布溢出和连接线方向。
- 检查 `text-grouping-qa-report.json`，确认文字完整、富文本 runs 一致，
  并记录多行正文合并数量与文本框减少量。
- 检查 `typography-calibration-report.json`；相同样式的字号方差必须为零。
  使用候选字体时必须披露，不能写成“与原字体完全一致”。
- 当用户要求文字和图标全部可编辑时，必须使用
  `--editable-targets text,icons --vision-mode required`。图标清单为空、
  `keep-raster` 或构建清单缺少对应 `icons` 对象均为失败。
- 搜索 `build-manifest.json`，确认目标对象均 `emitted=true`。
- 检查 `semantic-plan.json` 中的 `unresolvedRegions`。
- 运行 `scripts/audit_editable_surface.py` 生成前景版 QA PPTX，并逐页检查
  隐藏整页背景后的业务信息是否完整。
- 对最终去字背景重新 OCR，再运行
  `scripts/build_editability_residue_report.py` 将识别结果逐项分类到
  `editability-residue-report.json`；未豁免的有效残留必须为零。
- `requiredObjectCount` 必须按本次用户明确要求的对象类别建立，例如“所有文字
  + 全部功能图标 + 指定连接线”。装饰底纹、卡片底板和照片不应被悄悄计入
  通过项，也不应在用户只要求文字和图标可编辑时误判为阻断项；若用户要求
  “全元素可编辑”，容器、节点、圆环和全部关系线也必须计入。
- 对重要数字执行 PDF/OCR 双重核对。
- 视觉模型 QA 只能用于发现差异，不能代替结构、水印和文字检查。
- 所有 Agent 分页 JSON 都必须通过 `vision_schema.py` 的严格运行时校验；
  未声明字段、不完整 JSON 和缺少 `foregroundPassed` 的必需复核均为失败。
- Linux 使用 LibreOffice 与内置渲染器验证，并披露未经过 PowerPoint 原生验证。

扁平化、内嵌流程图和保真细节分别见：

- [references/flattened-pdf-workflow.md](references/flattened-pdf-workflow.md)
- [references/embedded-diagram-workflow.md](references/embedded-diagram-workflow.md)
- [references/fidelity-and-qa.md](references/fidelity-and-qa.md)
- [references/editability-residue-gate.md](references/editability-residue-gate.md)
