---
name: GordenImagePPTGen
description: >-
  通过用户网关的 GPT Image 异步接口生成「图片格式的 PPT 文档」——每页一张高信息密度、排版复杂、风格统一的幻灯片图（默认科技商务/高密度信息图，
  也支持简洁/卡通/水墨/科技等任意风格），并合成为每页一张全幅图片的 .pptx。Generates image-based slide decks
  (one rendered image per slide) from a topic or content. 当用户要"做 PPT / 生成图片版 PPT / AI 出图幻灯片 /
  把内容做成 PPT 图片"时使用。本技能**只产出图片型 PPT**（每页 .png + 合成的 .pptx）；若还要可编辑 pptx，接着用 GordenImage2PPTX。
---

# GordenImagePPTGen — 生成图片格式的 PPT

把主题/内容变成「图片型 PPT」：设计 → 出图 → 合成。每页是一张由网关图片生成模型生成的图片。必须使用图片生成，不能通过SVG绘制，必须调用图片生成模型。

```
内容 ─▶ A2 设计大纲(outline.json) ─▶ A3 每页提示词 ─▶ A4 网关 GPT Image 出图 ─▶ A5 合成图片型 .pptx
```

## 运行时与图片后端（先读）

图片生成的调用方式因运行时而异，**动手前先读 [`references/runtime-notes.md`](references/runtime-notes.md)**。核心约定：

1. **图片一律用 raster 图像生成后端**（本技能默认调用用户网关 `scripts/generate_gateway_slide_image.py`；其它运行时也优先走同一脚本）。**禁止**用 SVG/HTML/Canvas/代码画图冒充。
2. **禁止在已生成的位图上用代码补字/盖字/改字**。文字错了没关系，后续改成可编辑pptx后支持手动修改。
3. 网关返回的临时图片 URL 必须立刻下载到本任务输出目录 `slides/`，不能只在 manifest 里保存 URL。
4. 阶段 A4 必须写 `imagegen-manifest.json`，逐页记录网关 `task_id`、下载后的 slide 路径和 metadata 路径；没有 manifest 或任一页缺 `task_id` / `copied_to`，本技能执行失败。

## imagegen 硬门禁

本技能中的“生成图片”只指调用图像生成模型，不指用代码画 PNG。

禁止使用以下方式生成整页幻灯片图：
- Python/PIL、SVG、HTML、Canvas、matplotlib、PowerPoint shapes、截图渲染。
- 先生成可编辑 PPTX，再导出为图片。
- 用代码绘制页面骨架、图表、图标、文字并保存为 PNG。

允许代码做的事仅限：
- 写 `outline.json`、`prompts/NN-*.md`、`imagegen-manifest.json`、`deck.json`。
- 从网关返回的临时 URL 下载整张已生成图片到 `slides/`，并保留 metadata。
- 裁切/缩放整张已生成图片以统一比例（不得补字或重画局部内容）。
- 合成图片型 PPTX、生成预览、做 QA 检查。

如果网关接口/API key 不可用，必须停止并说明阻塞原因，不能用代码绘图兜底。

## 全局铁律

1. 🔴 **绝不出占位符图**：本技能产出的是**含全部真实文字(verbatim)的成品幻灯片图**，不是空模板。出图提示词的【页面文字】必须写满真实文字；`outline.json` 的 `visual_generation_prompt`（只描述画面）**禁止单独出图**，必须与全部文字合并后再出（详见 image-prompt-guide 文首铁律）。出现 lorem/占位框/无字卡片即判失败、改提示词重出。
2. **数据零编造**：完全使用用户提供的数据/数值/专名。数据少就把内容做厚（真实的结构化拆解）+ 大字号/中心聚焦排版，**绝不**编造或填充虚假内容。
3. **语言跟随用户**：问答用用户语言；幻灯片内文字用内容语言（默认中文）。
4. **少用绿色**：尽量避免大面积纯绿（下游 GordenImage2PPTX 默认绿幕抠图会冲突）。
5. **页脚干净**：不加页码/logo/水印（除非用户要求）。

## 默认风格与复杂度

**默认 = 信息密度极高、排版复杂、模块化网格、每页一个不重复的高阶框架**（房子型/莫比乌斯环/Bento 便当盒/同心雷达/多层架构/鱼骨/漏斗/3D 阶梯等）。**简单 = 不合格**。完整提示词体系、复杂度强制清单、风格库、图表形式目录、verbatim 规则见 **[`references/image-prompt-guide.md`](references/image-prompt-guide.md)**。

- ⭐ **内容优先**（最易踩坑）：「排版太简单」几乎都是**每页内容太薄**。**先备厚内容、再出图**：每页 ≥4 个并列模块、每模块 标题+2~3 要点+1 个特大号指标，外加导语(关键词高亮)+底部横幅（≈20+ 信息点/页）。见 image-prompt-guide §0。
- **每页不重样 + 统一配色**：每页选一个**不同**的复杂框架；全篇**统一一套配色**（有参考图就提取其配色）。见 §1.7、§4。
- **豪华 ≠ 浮夸**：清晰永远第一，避免过度辉光/3D 戏剧化导致花哨难读；"清晰科技"是稳妥默认（浅底+细网格+扁平模块+克制强调+高密度）。见 §1.7、§5。
- **排版参考图库** `参考图/`：出图前挑结构相近的参考图，把**布局骨架**写进提示词（也可作 reference 传入后端），可学排版与风格气质，但不照搬其文字/品牌（§1.6）。
- **比例**：跟随用户。默认 16:9；用户要 3:2（或后端原生 3:2 且接受）就直接出 3:2，全套统一、不裁切。见 runtime-notes §5。

## 工作流（逐项打勾）

```
- [ ] A1 确认：风格 / 受众 / 页数 / 语言（除非用户说"直接生成/不用确认"）
- [ ] A2 大纲(outline.json)：解构内容 → 每页指派不重复的复杂框架、统一配色、写厚 detailed_content（见 image-prompt-guide §7 / §1.7）
- [ ] A3 每页提示词：把 outline 落地成 self-contained 提示词（含【全部真实文字 verbatim】），存 prompts/NN-*.md
- [ ] A4 出图：逐页调用 `scripts/generate_gateway_slide_image.py` 走网关出图（每页含全部真实文字，绝不占位符）→ 下载到输出目录 → 写 imagegen-manifest.json
- [ ] A5 合成：compose_pptx.py 把每页图片做成全幅图片型 .pptx
```

要点：
- **页数**：用户指定就用；没指定按内容量自定（一般 11–20 页，封面+结尾必有）。
- **A3 提示词自包含**：颜色(hex)、版式、**全部文字**、图表形式、字体风格全写死，便于可复现、单页重出。
- **A4**：先确认所有 `prompts/NN-*.md` 就位再开跑；每页必须有一次真实网关出图调用；失败/错字只重试该页；网关 URL 有时效，必须立即下载到 `slides/`。
- **imagegen-manifest.json**：必须逐页记录 `slide`、`prompt_file`、`task_id`、`metadata_json`、`copied_to`、`backend`。这是阶段 1 的验收证据。
- **A5**：生成 `deck.json`（每个 slide 只有 `background` 指向该页 PNG），跑：

```bash
python3 scripts/compose_pptx.py deck.json out/<topic>-image-deck.pptx
```

## 输出目录结构

```
<topic-slug>/
├── outline.json            # A2 设计大纲（逐页结构化）
├── imagegen-manifest.json  # A4 每页网关生成证据
├── prompts/NN-*.md         # A3 每页出图提示词（可复现）
├── slides/NN-*.png         # A4 生成的每页图片
├── deck.json               # A5 合成清单（每页 background）
└── out/<topic>-image-deck.pptx
```

## 脚本与依赖

| 脚本 | 干嘛 |
|---|---|
| `scripts/generate_gateway_slide_image.py` | 调用用户网关创建生图任务、轮询结果、下载图片并写 metadata |
| `scripts/compose_pptx.py` | 把每页图片按 deck.json 合成全幅图片型 .pptx（`--preview-dir` 可出预览） |

- 出图依赖：设置 `GATEWAY_IMAGE_API_KEY`（或 `MODEL_GATEWAY_API_KEY` / `OPENAI_API_KEY`）。`GATEWAY_IMAGE_BASE_URL` 可省略，默认 `https://getways-jumu.zeelin.cn`。
- 单页出图示例：
  ```bash
  python3 scripts/generate_gateway_slide_image.py --prompt @prompts/01-cover.md --out-dir slides --size 2560x1440 --quality high
  ```
- 合成依赖：`python3` + `python-pptx`、`Pillow`（缺就 `pip3 install python-pptx pillow`）。
- 下一步要可编辑 pptx → 用 **GordenImage2PPTX**；要一键全流程 → 用 **GordenSuperPPTSkill**。

## 内容参考库

本技能附带以下内容参考文件，设计时按需查阅，解决「不知道每页讲什么」的问题：

| 文件 | 用途 |
|------|------|
| [`references/content-frameworks.md`](references/content-frameworks.md) | **8 套商业场景逐页内容范本** — 融资BP/产品发布/述职/项目汇报/学术答辩/培训/市场分析/战略规划，每套含故事线 + 逐页角色 + 核心信息 + 推荐视觉框架 + 内容要点填空区 |
| [`references/color-palettes.md`](references/color-palettes.md) | **10 套内置配色方案** — 含精确 hex 值 + 使用规则，覆盖科技商务/深蓝/极简/暖金/学术/紫金/培训/杂志/暗紫/自然 |
| [`references/storytelling-guide.md`](references/storytelling-guide.md) | **6 大叙述模式** — 倒金字塔/英雄之旅/WHY-HOW-WHAT/对比阵痛/金字塔论证/SCQA + 文案铁律 + 受众适配指南 |
| [`references/design-templates.md`](references/design-templates.md) | **17 种页面视觉布局模版** — 封面/目录/市场/痛点/方案/产品架构/功能/Bento/壁垒/竞对/数据面板/团队/商业模式/路线图/案例/财务/融资/结尾，每种含精确的【版式结构】段落（可直接写入出图提示词）+ 变体 + 栅格基数 |
| [`references/bp-case-studies.md`](references/bp-case-studies.md) | **25 份真实 BP 蒸馏** — 4 类公司（硬科技/硬件制造/平台方案/消费服务）逐页结构对照 + 通用 8 页必含框架 + 文案铁律 |
| [`references/image-prompt-guide.md`](references/image-prompt-guide.md) | **原有** 提示词体系/复杂度清单/图表目录/verbatim 规则 |
