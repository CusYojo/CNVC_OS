# 端到端流水线

## 目录

- 依赖解析
- P0 输入与身份
- P1 模板适配
- P2 研究补全
- P3 逐页策划与语义源
- P4 图片稿生成
- P5 PDF 桥接
- P6 可编辑化
- P7 验收交付

## 依赖解析

运行 `scripts/resolve_dependencies.py --json`。用户提供模板时增加 `--require-template-adapter`。优先读取显式参数和环境变量：

- `GORDEN_IMAGE_PPT_GEN_DIR`
- `GORDEN_SUPER_PPT_SKILL_DIR`
- `PDF_TO_EDITABLE_PPT_SKILL_DIR`

其次检查个人技能目录及当前工作区的 `project-discovery/GordenSuperPPTSkills/`。不得假定固定用户名或仓库绝对路径。

## P0 输入与身份

创建唯一运行目录。锁定项目身份，禁止在同一次运行中混入多个同名或相似实体。`project-identity.json` 至少包含：

```json
{
  "legal_name": "",
  "display_name": "",
  "aliases": [],
  "jurisdiction": "",
  "website": "",
  "audience": "investment-committee",
  "purpose": "investment-recommendation",
  "language": "zh-CN",
  "editable_scope": "all"
}
```

如果法定实体无法区分，必须先澄清；不得联网搜集并混合错误公司的信息。

## P1 模板适配

用户提供模板时，运行解析出的 GordenSuperPPTSkill 中 `scripts/ingest_reference_template.py`：

```bash
python3 "$GORDEN_SUPER_PPT_SKILL_DIR/scripts/ingest_reference_template.py" \
  "/absolute/reference.pdf" \
  --out-dir "/absolute/run/reference-template" \
  --scope task-only \
  --reuse-level structure-and-style
```

完整检查总览图和代表页。脚本生成的角色、配色只是候选。逐页记录借鉴的结构和必须替换的模板元素。敏感模板不得未经授权传给外部图像模型；改用 `text-style-spec`。

## P2 研究补全

按 `input-and-research.md` 建立事实与来源。对 `slide-plan.json` 的每一页单独检查信息是否足够。若不足，立即形成检索问题并联网，不要等整套大纲完成后统一“补行业数据”。

只有事实库中的 `verified` 和经过限定的 `public-claim` 能进入页面正文。`assumption` 必须明确写为假设；`unknown` 只能进入尽调缺口。

## P3 逐页策划与语义源

建立 `slide-semantics.json`，让后续可编辑化拥有比 OCR 更可靠的真实文字和结构数据。每页至少包含：

- 页面角色、主结论和主参考页。
- 全部准确文字及来源键。
- KPI 的值、单位、币种和期间。
- 图表数据与轴定义。
- 表格的行列数据。
- 流程节点和连接关系。
- 计划独立编辑的图标、卡片和照片。

无法提供结构化数据的图表不得在交付时声称可编辑数据。

## P4 图片稿生成

完整执行解析出的 GordenImagePPTGen：

1. 写 `outline.json` 和自包含逐页提示词。
2. 每页通过网关脚本真实出图，保存到 `generation/slides/`。
3. 写 `imagegen-manifest.json`，每页必须包含 `task_id`、`metadata_json`、`copied_to`。
4. 错字、事实错误和模板残留只能通过重生成整页修复，禁止代码补字或遮挡。
5. 合成图片型 PPTX，并逐页渲染检查。

## P5 PDF 桥接

运行：

```bash
python3 scripts/package_slides_as_pdf.py \
  --slides-dir "/absolute/run/generation/slides" \
  --output "/absolute/run/bridge/image-deck.pdf" \
  --manifest "/absolute/run/bridge/pdf-bridge-manifest.json"
```

桥接脚本只允许整页缩放与 PDF 封装，不得修改图片像素、补字或重画页面。桥接 PDF 应被下游识别为 `flattened`。

## P6 可编辑化

完整读取并执行 `pdf-to-editable-ppt`。先运行其环境检查。默认命令骨架：

```bash
python3 "$PDF_TO_EDITABLE_PPT_SKILL_DIR/scripts/convert_pdf.py" \
  --input "/absolute/run/bridge/image-deck.pdf" \
  --output "/absolute/run/editable/final-editable.pptx" \
  --work-dir "/absolute/run/editable/work" \
  --flattened-mode ocr \
  --editable-scope all \
  --ocr-engine auto \
  --ocr-corrections "/absolute/run/editable/exact-text-corrections.json" \
  --overrides "/absolute/run/editable/semantic-overrides.json" \
  --watermark-qa-mode strict
```

实际参数和覆盖清单格式以该技能当前版本为准。`slide-semantics.json` 是文字与语义的事实源，OCR 仅负责坐标候选。所有覆盖区域必须先清除原像素内容，防止移动新对象后露出旧对象。

## P7 验收交付

1. 运行 `scripts/validate_pipeline_handoff.py`。
2. 逐页对比桥接 PDF、图片稿和最终 PPTX。
3. 确认 `route=flattened`、`editableScope=all`、所有 QA 布尔值通过、无未解决页。
4. 运行 Presentations 的 `slides_test.py`。
5. 交付图片型 PPTX、桥接 PDF、可编辑 PPTX和 `pipeline-handoff-report.json`。

若交接证书未通过，不得把 PPTX 标记为最终可编辑成品。
