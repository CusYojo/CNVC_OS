# 端到端运行手册（A → B 串联）

本技能 = 依次完整执行两个子技能。本文件是落地细节；每阶段的**完整**规范以子技能的 SKILL.md / references 为准。

平台“投资建议书（PPT）”快捷任务固定为 `gorden-native`：跳过阶段 T，不读取任何模板或模板目录，不向阶段 1 传模板参考图，阶段 2 四层还原通过后直接交付可编辑 PPTX。

## 阶段 T · 用户动态模板摄取（按需）

当用户提供 PDF、PPTX 或页面图片并要求参考结构或风格时，在阶段 1 前执行：

1. 完整读取 `user-template-adaptation.md`。
2. 运行 `scripts/ingest_reference_template.py <input> --out-dir <run>/reference-template`。默认 `scope=task-only`、`reuse_level=structure-and-style`。
3. 检查 `template-intake-manifest.json`、`contact-sheet.png` 和代表页；修正脚本产生的角色、配色和密度候选。
4. 补全 `template-profile.json` 的内容 DNA 与视觉 DNA，建立 `project-facts.json`。
5. 按目标页面语义角色写 `template-selection.json` 和 `slide-plan.json`；每页只指定一个主参考页。
6. 确定参考策略：`direct-reference`、`distilled-style-anchor` 或 `text-style-spec`。
7. 正常模式下向用户展示模板理解和大纲；“直接生成/无需确认”时记录默认值并继续。
8. 没有用户明确授权时，不得将动态模板写入长期 `assets/reference-templates/`。

## 阶段 1 · 生成图片型 PPT（GordenImagePPTGen）

1. **A0 设计模式**：平台投资建议书快捷任务固定使用 `gorden-native` 原生设计规范，记录 `templateUsage=disabled`，不得读取 `investment-template-catalog.md`、`docs/投资建议书` 或用户上传模板，也不得设置 `reference_template`。
2. **A1 确认**：风格 / 受众 / 页数 / 语言（用户说"直接生成"则跳过，并声明所用设定）。比例跟随用户（默认 16:9；用户要 3:2 就全套 3:2）。
3. **A2 大纲 `outline.json`**：解构内容；为**每页指派不重复的复杂框架**；**统一一套配色**；写厚每页 `detailed_content`（真实数据，禁编造）。
4. **A3 提示词**：把 outline 落地成每页 self-contained 提示词，**【页面文字】写满全部真实文字(verbatim)**，并明确只使用 Gorden 原生设计规范。
5. **A4 出图**：必须逐页调用 `../GordenImagePPTGen/scripts/generate_gateway_slide_image.py` 走用户网关出图；投资建议书快捷任务不得传 `--image` 模板参考图；**每页必须是含全部真实文字的成品图，绝不占位符/空模板**；错字/失败只重出该页；把网关返回 URL 下载到 `slides/NN-*.png`；写 `imagegen-manifest.json`。
6. **A5 合成**：`compose_pptx.py deck.json out/<topic>-image-deck.pptx`（每页只一个 `background`）。
7. **A6 文字与事实审计**：按页面可见文字清单和当前项目事实库校验，排查新增标题、标签、编号、来源文字、虚构人物、客户、日期和数字；发现问题只重生成受影响页面。

### A4 阻塞门禁

- “生成图片”只指调用图像生成模型，不指用 Python/PIL、SVG、HTML、Canvas、matplotlib、PowerPoint shapes 或截图渲染生成 PNG。
- 禁止先做可编辑 PPTX / 原生 shapes，再导出图片充当阶段 1。
- 禁止用代码在生成图上补字、盖字、改字。
- 若网关接口/API key 不可用，必须停止并说明阻塞原因，不能用代码绘图兜底。
- 没有 `imagegen-manifest.json`，或任一页缺 `task_id`、`metadata_json` 与 `copied_to`，阶段 1 判失败，不能进入阶段 2。

> 详见 `../GordenImagePPTGen/references/image-prompt-guide.md`（§0 内容优先、§1.5 复杂度、§1.7 唯一框架+清晰优先、§4 图表目录、§7 outline 结构）。

## 阶段 2 · 还原为可编辑 PPTX（GordenImage2PPTX）

对阶段 1 的**每一张** `slides/NN-*.png`，按强制四层执行：

1. **B1 探色** → 定抠图底色（默认绿，含绿改非绿）。
2. **B2 背景**：用 imagegen 复刻干净背景（无文字/图标/框架/卡片），禁止 PPT 色块或裁原图。
3. **B3 骨架图**：用 imagegen 在抠图底色上提取容器/卡片(含填充/标题条)/分隔线/图表骨架，**不含文字图标** → 抠图成全幅透明 `frame`。
4. **B4 元素图标**：用 imagegen 把所有图标/装饰排成 N×N 绿底网格 → 抠图 → 切片；禁止从原图裁图标。
5. **B5–B7**：`chroma_key.py` 保色抠图（骨架+图标）→ `slice_grid.py` 切图标 → 定位(尺寸对照原图) → 视觉 OCR 文字 → 写 `layout.json`。
6. **B8 合成**：`compose_pptx.py` 出可编辑 .pptx + `--preview-dir` 预览。
7. **B9 QA**：预览对比原图，调 `layout.json` 重合成至贴合。

每页必须写 `imagegen-assets-manifest.json`，记录 B2/B3/B4 的模型生成源图 `generated_source` 与复制路径 `copied_to`；缺失则阶段 2 判失败。

> 详见 `../GordenImage2PPTX/references/image-to-pptx.md`（B1–B9 全流程 + schema + 抠图保真铁律）。

## 两条防退化铁律（必须守）

- 🔴 阶段 1：**绝不生成占位符/无文字模板图**。`visual_generation_prompt` 只是画面半成品，禁止单独出图——必须合并全部文字。
- 🔴 阶段 1：**必须调用用户网关生成每页图片**，禁止任何代码绘制整页幻灯片图替代。
- 🔴 阶段 2：**B2 背景、B3 骨架图、B4 元素图标图都必须调用 imagegen 生成**。禁止用原生 `shapes`、PPT 色块、代码绘图或裁原图局部替代图片层。

## 最终交付

① 所有 PPT 图片 ② `imagegen-manifest.json` ③ 每页 `imagegen-assets-manifest.json` ④ 每页背景图 ⑤ 每页骨架图 ⑥ 每页图标/装饰 ⑦ 每页文本数据 `layout.json` ⑧ 图片型 `.pptx` ⑨ 可编辑 `.pptx`。
