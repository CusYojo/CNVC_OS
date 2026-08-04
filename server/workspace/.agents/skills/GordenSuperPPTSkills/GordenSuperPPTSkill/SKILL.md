---
name: gorden-super-ppt-skill
description: >-
  一键全流程 PPT：先用 GordenImagePPTGen 生成「图片格式的 PPT」，再用 GordenImage2PPTX 把它逆向还原成「可编辑 .pptx」。
  支持摄取用户临时提供的 PDF、PPTX 或页面图片模板，借鉴其内容结构、视觉风格与页型，并默认隔离样本事实；也内置德塔智能 IC、
  蓝成应急及二者混合的投资建议书参考模板。打包并依次编排这两个子技能，
  最终同时交付 图片型 PPT + 可编辑 pptx + 全部中间产物。Orchestrates image-PPT
  generation and image→editable-PPTX conversion end to end. 当用户只给主题/内容、要一份"既好看又能编辑"的完整 PPT 成品，
  或没点名具体功能时使用。
---

# GordenSuperPPTSkill — 端到端 PPT 全流程编排

把两个子技能串起来跑：

```
内容 ─▶【阶段1 GordenImagePPTGen】图片型 PPT（每页 .png + 图片版 .pptx）
       ─▶【阶段2 GordenImage2PPTX】对每页图片做 背景图+骨架图+元素图标+文本 还原 ─▶ 可编辑 .pptx
```

本技能本身不重复造轮子——它**依次完整执行两个子技能**。两个子技能需与本技能同处（同一仓库/同一 skills 目录）：
- 阶段 1：**[`../GordenImagePPTGen/SKILL.md`](../GordenImagePPTGen/SKILL.md)**（功能 A：生成图片型 PPT）
- 阶段 2：**[`../GordenImage2PPTX/SKILL.md`](../GordenImage2PPTX/SKILL.md)**（功能 B：图片 → 可编辑 PPTX）

端到端运行手册见 **[`references/pipeline.md`](references/pipeline.md)**。
投资建议书的结构化内容、证据、产物与验收边界见 **[`references/output-contract.md`](references/output-contract.md)**。

## 用户动态模板

用户提供 PDF、PPTX 或页面图片并要求参考结构、风格、排版或故事线时，先完整读取 **[`references/user-template-adaptation.md`](references/user-template-adaptation.md)**，运行 `scripts/ingest_reference_template.py`，再进入阶段 1。

- 默认模式：`user-reference` + `scope=task-only` + `reuse_level=structure-and-style`。
- 默认只把模板放在本次任务目录，不得自动复制进长期 `assets/`。
- 逐页按语义角色映射参考页，不按原页码机械替换。
- 用户明确要求“长期使用/加入技能/注册模板”时，才把模板标记为 `persistent-candidate` 并执行晋升检查。
- 用户说“直接生成/无需确认”时跳过大纲确认门，但仍必须产出模板分析、事实库、映射和残留审计文件。

## 投资建议书参考模板

处理投资建议书、IC 报告、融资分析或产业项目汇报时，先完整读取 **[`references/investment-template-catalog.md`](references/investment-template-catalog.md)**，再进入阶段 1。模板资产位于 `assets/reference-templates/`，资产索引和校验信息见 `assets/reference-templates/manifest.json`：

| 模式 | 主用途 |
|---|---|
| `deta-ic` | 底层技术、硬科技、AI/机器人项目的技术论证与 IC 决策 |
| `lancheng-investment` | 场景落地、产业协同、国资渠道和商业化验证 |
| `hybrid-investment-ic` | 默认混合模式：用一套视觉系统，组合技术证据链与商业落地链 |

模板只授权复用故事结构、布局骨架、信息密度和视觉语言，不授权复用样本公司事实。每次生成必须建立当前项目的独立事实库，并执行样本残留检查。

## 阶段 1 图片生成硬门禁

阶段 1 的“生成图片”只允许解释为：**实际调用 GordenImagePPTGen 的用户网关脚本生成每一页幻灯片成品图**。

禁止用以下方式替代阶段 1 出图：
- Python/PIL、SVG、HTML、Canvas、matplotlib、PowerPoint shapes、截图渲染。
- 用代码绘制整页幻灯片图，再把它当作“图片型 PPT”。
- 先用可编辑 PPTX / 原生 shapes 做页面，再导出为 PNG 充当阶段 1 结果。
- 用代码在已生成图片上补字、盖字、改字。

阶段 1 必须满足：
- 每页都调用 `../GordenImagePPTGen/scripts/generate_gateway_slide_image.py` 一次或多次，最终选定一张模型生成图。
- 网关返回的图片 URL 必须下载到本任务 `slides/NN-*.png`，不能只保存 URL。
- 必须写入 `imagegen-manifest.json`，逐页记录 `task_id`、`metadata_json` 与 `copied_to`。

如果网关接口/API key 不可用，必须停止并说明阻塞原因，不能使用代码绘图兜底。

## 何时用哪个

| 用户意图 | 用哪个技能 |
|---|---|
| 「做一份 PPT / 生成图片版 PPT / AI 出图幻灯片」 | 只用 **GordenImagePPTGen** |
| 「把这些 PPT 图片/截图转成可编辑 PPTX / 抠图标 / 提取文字」 | 只用 **GordenImage2PPTX** |
| 没点名，只给主题/内容要一份能用的成品；或要"既能看又能编辑" | 用 **本技能**（A→B 串联） |

- 用户**明确**点名某一功能 → 直接用对应子技能，不必走 Super。
- 没点名时默认走 Super：先完整出图，再逐页还原为可编辑，最后一次性交付全部产物。

## 编排流程（逐项打勾）

```
== 阶段 T：用户模板摄取（用户提供模板时）==
- [ ] 读取 user-template-adaptation.md，运行 ingest_reference_template.py
- [ ] 视觉检查 contact-sheet.png 和全部代表页，修正 template-profile.json / page-archetypes.json
- [ ] 建立独立 project-facts.json、template-selection.json 和 slide-plan.json
- [ ] 默认 scope=task-only；没有明确授权不得注册为长期模板

== 阶段 1：GordenImagePPTGen（完整跑功能 A）==
- [ ] 投资类材料：读取 investment-template-catalog.md，写 template-selection.json，并逐页指定主参考页
- [ ] 读 ../GordenImagePPTGen/SKILL.md，按 A1–A5 执行
- [ ] 每页实际调用用户网关生成成品图
- [ ] 产出：outline.json、template-selection.json（使用参考模板时）、prompts/NN-*.md、imagegen-manifest.json、slides/NN-*.png、图片型 .pptx
- [ ] 铁律：每页图必须含【全部真实文字 verbatim】，绝不出占位符/无字模板图
- [ ] 门禁：没有 imagegen-manifest.json 或任一页缺 task_id / copied_to，则阶段 1 失败，不能进入阶段 2

== 阶段 2：GordenImage2PPTX（对阶段1每张图完整跑功能 B）==
- [ ] 读 ../GordenImage2PPTX/SKILL.md，对每页图片按 B1–B9 执行
- [ ] 强制四层：背景图 → 骨架图(绿幕抠图) → 元素图标(绿幕抠图) → 文本(OCR)，缺一不可
- [ ] 背景图、骨架图、元素图标图必须由 imagegen 提取式生成
- [ ] 禁止用 PPT 色块、原生 shapes、代码绘图、裁原图局部替代背景/骨架/图标图片层
- [ ] 产出：每页 imagegen-assets-manifest.json + background/frame/icons/layout.json + 合成的可编辑 .pptx

== 交付 ==
- [ ] 一次性交付：① 所有 PPT 图片 ② 每页背景图 ③ 每页骨架图 ④ 每页图标/装饰 ⑤ 每页文本数据(layout.json) ⑥ 图片型 .pptx ⑦ 可编辑 .pptx
```

## 关键约束（两阶段都要守）

1. 🔴 阶段1**必须调用用户网关出图，绝不用代码绘图替代，且绝不出占位符图**；阶段2**背景/骨架/图标图片层也必须调用 imagegen 生成，绝不跳过骨架图与元素图标**（四层强制）。这两条是上一版退化的根因，务必守住。
2. **比例统一**：A 和 B 全程同一比例（默认 16:9；用户要 3:2 就全套 3:2）。
3. **配色统一、每页框架不重复**（阶段1）；**抠图保色保线、图标尺寸对照原图**（阶段2）。
4. 数据零编造；语言跟随用户；页脚干净；少用纯绿（绿幕抠图会冲突）。
5. 使用参考模板时，每页只设一个主参考页，并通过阶段 1 网关脚本的 `--image` 传入；只学习布局与风格，禁止继承样本实体、Logo、人物、日期和数字。
6. 用户动态模板默认仅本任务使用；长期晋升必须得到用户明确授权，并完成来源、保密性、样本残留和模板清单检查。

## 输出目录结构（建议）

```
<topic-slug>/
├── reference-template/                      # 用户动态模板摄取产物（如有）
├── outline.json / template-selection.json / imagegen-manifest.json / prompts/ / slides/   # 阶段1
├── out/<topic>-image-deck.pptx              # 阶段1 图片型成品
└── editable/                                # 阶段2
    ├── NN/{background.png, frame.png, icons/*.png, layout.json}
    ├── deck.json
    ├── preview/slide_*.png
    └── <topic>-editable.pptx                # 阶段2 可编辑成品
```

> 子技能各自自带脚本与 references；本技能只负责编排与交付。若两个子技能不在同处，请先安装它们，或直接分别调用。
