---
name: create-reference-driven-editable-ppt
description: 根据用户需求、业务数据与可选 PDF/PPTX/页面图片参考模板，生成投资建议书、IC 报告、商业计划书、融资 BP、路演、项目方案及其他专业演示稿；先调用 GordenImagePPTGen 生成图片型 PPT，再将页面无损打包为 PDF，并调用 pdf-to-editable-ppt 输出元素级可编辑 PPTX。用户资料不足时必须联网检索公开信息，建立来源清单并把无法验证的内容列为尽调缺口。适用于“制作投资建议书/IC报告/BP/PPT”“参考附件模板生成”“根据这些数据做PPT”“交付可编辑PPT”等创建型请求。
---

# 参考模板驱动的可编辑 PPT 生产编排

## 目标

交付一套事实可追溯、视觉完整且准确标注可编辑范围的演示稿：图片型 PPTX、桥接 PDF、元素级可编辑 PPTX及全部生成与验收清单。

本技能是编排器，不替代子技能：

1. 使用 GordenSuperPPTSkill 的动态模板摄取能力（用户提供模板时）。
2. 完整执行 GordenImagePPTGen 生成页面图片和图片型 PPTX。
3. 使用本技能 `package_slides_as_pdf.py` 无损打包页面图片。
4. 完整执行 `pdf-to-editable-ppt`，对扁平化 PDF 使用 OCR 与语义覆盖清单重建可编辑对象。

## 开始前必须读取

1. 完整读取 [`references/pipeline.md`](references/pipeline.md)。
2. 始终读取 [`references/input-and-research.md`](references/input-and-research.md)；无论是否有模板，都要执行资料充分性审计与按需联网补全。
3. 进入可编辑化前，读取 [`references/semantic-bridge.md`](references/semantic-bridge.md) 和 [`references/qa-gates.md`](references/qa-gates.md)。
4. 完整读取 [`references/output-contract.md`](references/output-contract.md)，按其中的交付与来源披露边界执行。
5. 完整读取实际解析出的 GordenImagePPTGen 与 `pdf-to-editable-ppt` 的 `SKILL.md`；执行后者时同时遵循其要求的 PDF 与 Presentations 技能。

先运行：

```bash
python3 scripts/resolve_dependencies.py --json
```

用户提供了参考模板文件时追加 `--require-template-adapter`。关键依赖不可用时停止，不得用代码绘制整页图片或把只有整页图片的文件描述为元素级可编辑。

## 默认决策

- 画布：16:9；页数按事实密度自定，投资类通常 14-20 页。
- 模板：用户模板默认 `task-only`、`structure-and-style`；未明确授权不得加入长期模板库。
- 研究：资料不足时自动联网补全；用户明确禁止联网时，只使用其资料并暴露缺口。
- 生成：阶段 1 必须通过 GordenImagePPTGen 网关逐页出图并保留 `imagegen-manifest.json`。
- 可编辑：用户说“可编辑 PPT”但未缩小范围时，按 `--editable-scope all`；仅在用户明确说“只需文字可编辑”时使用 `text`。
- 确认：用户说“直接生成/无需确认”时跳过大纲确认，但不得跳过事实、来源、模板残留和可编辑性门禁。

## 投资机构写作口径

- 可见内容面向投资团队、投资总监和投委会，按“事实—判断—交易影响”组织；不得写成系统项目卡片、工作流汇报、资料处理说明或模型分析过程。
- `project.stage`、项目来源、负责人、评分和进度仅供系统内部路由，不得进入幻灯片。严禁出现“项目阶段：线索、线索阶段、进入初筛、申请立项、启动尽调、提请上会、提交投决、继续跟踪、暂缓推进、归档”等内部状态词。
- 不写“综合当前项目阶段与可核验事实、基于已提供材料、项目档案显示、资料显示、证据显示、具备继续推进价值、赛道窗口、亮点成立依赖后续核验”等模型化套话；不使用“值得注意的是、由此可见、综上所述、赋能、抓手、生态闭环、新范式”等通用 AI 表达。
- 每段优先以公司、具名产品、客户、合同、财务科目、股东、交易条款或风险事项为主语。公司披露、管理层预测、公开信息和已核实事实必须区分；不得用形容词或“亮点、潜力、窗口”替代事实。
- 投资摘要直接说明投资逻辑是否成立、关键支持事实、主要反证、交易约束和待完成的实质工作。证据不足时写“暂不形成确定性投资结论”，不得用内部阶段词替代专业判断。
- 封面和责任声明不得显示“AI 辅助初稿、由 AI 生成”等模型身份；统一使用“内部讨论稿”或“仅供内部审议，不构成最终投资决策”。

## 编排清单

```text
== P0 输入与项目身份 ==
- [ ] 锁定项目法定名称、受众、用途、页数、语言、模板作用域和可编辑范围
- [ ] 写 project-identity.json 与 input-manifest.json

== P1 模板摄取（仅用户提供模板时）==
- [ ] 若用户提供了参考模板文件，追加 `--require-template-adapter` 重新执行依赖解析
- [ ] 运行 GordenSuperPPTSkill/scripts/ingest_reference_template.py（需模板适配器已安装）
- [ ] 检查总览并补全模板内容 DNA、视觉 DNA 和代表页型
- [ ] 建立 sample-fingerprint.json；不得继承模板样本事实

== P2 数据审计与联网补全 ==
- [ ] 建立 project-facts.json、source-registry.json、research-questions.json
- [ ] 对每页检查最低事实密度；不足则联网检索
- [ ] 重大数据执行实体、单位、期间和交叉验证
- [ ] 无法验证的收入、估值、客户、订单、融资等写入 diligence-gaps.json

== P3 故事线与语义源 ==
- [ ] 写 template-selection.json、slide-plan.json、outline.json
- [ ] 写 slide-semantics.json：准确文字、图表数据、表格、节点、连接线和来源键
- [ ] 每页只指定一个主参考页；全篇只保留一套视觉主系统
- [ ] 对全部页面可见文字执行投资经理文风检查；内部阶段词、取证过程、模型身份或 AI 套话命中即退回重写

== P4 图片稿 ==
- [ ] 完整执行 GordenImagePPTGen；逐页真实网关出图
- [ ] 检查文字、事实、模板样本残留和跨页一致性；错误页整体重生成
- [ ] 交付 slides/*.png、图片型 PPTX 和 imagegen-manifest.json

== P5 PDF 桥接 ==
- [ ] package_slides_as_pdf.py 将页面图片全幅、无补字地打包为 PDF
- [ ] 确认 pdf-bridge-manifest.json 的页数、比例和逐页哈希

== P6 元素级可编辑化 ==
- [ ] 对桥接 PDF 完整执行 pdf-to-editable-ppt
- [ ] 明确 flattened-mode=ocr 与 editable-scope；all 模式必须提供语义 overrides
- [ ] 使用 slide-semantics.json 校正 OCR，并重建图标、卡片、流程图、图表和表格

== P7 验收与交付 ==
- [ ] 运行 validate_pipeline_handoff.py
- [ ] conversion-handoff.json 必须 readyForContentReplacement=true
- [ ] 逐页渲染检查、视觉对比、slides_test.py 和可编辑前景审计均通过
```

## 联网研究硬门禁

资料不足时必须联网，不得用模型常识填满页面。按 [`references/input-and-research.md`](references/input-and-research.md) 执行：

- 优先公司官网、监管/工商/政府、论文、专利、官方政策和权威统计等一手来源。
- 技术问题只用论文、官方文档或其他一手技术来源支撑。
- 融资、估值、客户、收入和重大市场数据优先两源交叉验证；无法交叉验证时标为 `public-claim`。
- 输入资料先按主体、日期、口径和来源去重；同一事实或数字只在语义最匹配的页面完整表达一次，其他页面不得重复堆砌。
- 始终核对公司实体、币种、单位、统计口径和期间。
- 搜不到不等于为零；写 `unknown` 或尽调问题，不得编造。
- 最终页面或来源附录必须提供人类可读来源，不得只留搜索结果或工具内部标识。

## 可编辑性声明

- `image`：仅整页图片可移动、裁剪和替换。
- `text`：经核对的文字为独立文本框，复杂视觉仍可能是栅格。
- `all`：按语义对象重建；仍需明确列出保留为栅格的照片、插画或无法可靠拆分的复杂区域。

自然语言“可编辑 PPT”默认 `all`。若任何要求对象尚未元素化，不能宣称“全部可编辑”，必须继续修复或明确报告阻塞。

## 输出目录

```text
<run>/
├── input/ reference-template/ facts/
├── project-identity.json source-registry.json diligence-gaps.json
├── outline.json slide-plan.json slide-semantics.json
├── generation/{prompts/,slides/,imagegen-manifest.json,image-deck.pptx}
├── bridge/{image-deck.pdf,pdf-bridge-manifest.json}
├── editable/{work/,final-editable.pptx}
└── out/{image-deck.pptx,image-deck.pdf,final-editable.pptx,pipeline-handoff-report.json}
```

最终只把经过门禁的文件标记为成品，并准确说明其可编辑范围。
