---
name: draft-investment-proposal
description: "Use when需要根据公司资料、访谈、财务数据、融资文件或交易方案生成、重写或终审中文股权投资提案、投委会材料或投资决策DOCX，尤其要求与案例DOCX的字体、段落、页眉页脚、分页和表格样式精确一致。"
---

# 决策级投资提案

## 核心原则

一次生成是用户只发起一次请求，不是内部只运行一轮。先把证据变成可审计的投资判断，再自动修订内容和版式，最后只交付一份通过门禁的 DOCX。

不得以“证据谨慎”为由只写尽调清单，也不得以“提案完整”为由编造股权、财务、市场、可比或回报数字。证据不足时，将缺口转成明确的判断影响、核验动作和估值、付款、治理或终止响应。

## 必须读取的契约

依次完整读取：

1. [核心规范](references/core-standard.md)
2. [Document Blueprint](references/document-blueprint.md)
3. [证据策略](references/evidence-policy.md)
4. [决策级内容](references/decision-grade-content.md)
5. [Manifest Schema](references/manifest-schema.md)
6. [输出契约](references/output-contract.md)
7. [案例精确版式](references/exact-case-style.md)
8. [自适应表格系统](references/adaptive-table-system.md)
9. [Formatter 契约](references/formatter-contract.md)
10. [Reviewer 契约](references/reviewer-contract.md)
11. [一次生成工作流](references/one-shot-workflow.md)
12. [模板画像](references/template-profile.md)

如有冲突，优先级为：事实与计算可审计性 > 固定 Blueprint > 用户指定的案例精确版式 > 决策级内容门禁 > Formatter > 模板共性。案例精确版式任务中，通用排版规则不得覆盖主版式权威。

## 强制流水线

### 1. 读取全部资料

- 逐份读取当前项目文件，不只读取摘要或首个文件。
- 统一公司主体、人物、时间线、客户、合同、融资、财务和交易数字。
- 对同一指标保留口径、期间、币种、单位、审计状态和来源。
- 仅对会改变投资判断的缺口进行定向公开核验；公开网页不能替代工商、合同、审计、股东名册和交易文件。

运行时默认执行“本地项目资料库优先，网络补全为辅，补全结果缓存复用”：`Local Project Retrieval` → `Network Cache Retrieval` → `Evidence Gap Analysis` → `In-process Candidate Discovery` → `LLM Gateway Page Verification` → `Network Cache Writeback`。主服务进程内公开检索器只发现与缺口相关的候选 URL，LLM Gateway 负责页面核验；不得一开始就发起宽泛的全网搜索，不恢复或依赖 SearXNG。只有用户明确要求“只联网搜索”时才跳过本地优先顺序；联网环节不可用时，使用已有项目证据继续形成受限初稿。

### 2. 建立 Decision Manifest

按 [Manifest Schema](references/manifest-schema.md) 建立内部 JSON，至少包含：

- investment_case：why now、why company、why price、value creation、downside；
- coverage：商业化、财务、技术、市场竞争、股权、交易、回报、团队；
- Calculation Ledger：派生计算和情景计算；
- table plans：表格类型、列角色、列宽权重、对齐和表题策略；
- decision：建议、授权边界和至少三项终止条件。

运行：

```bash
python scripts/validate_manifest.py proposal-manifest.json
```

未通过时先修 Manifest，不得直接写 Word。

### 3. 完成可审计计算

- 允许从已核验输入机械推导持股比例、投前/投后估值、综合入股估值、增长率、MOIC 和 IRR；必须保存公式、输入、单位、来源和结果。
- 允许基础、审慎、乐观三情景；假设必须显式标为 scenario，不得伪装成公司预测或市场事实。
- Reviewer 必须独立重算；结果或单位不一致时删除结果并修复。

### 4. 先规划内容和表格

- 用 [决策级内容](references/decision-grade-content.md) 把事实组织为投资闭环，不按资料顺序堆砌。
- 股权、财务、融资、交易、预测回报和可比估值优先使用表格；缺少结构化证据时不创建空表。
- 每张表先生成 table plan。列角色不同却给出等宽列属于硬错误。
- 数字列右对齐，日期和短标签居中，叙述列左对齐；财务预测使用案例三线表，股权和交易使用案例全框线表。不得自行发明第三种样式。

### 5. 生成并总编辑 17 节

- 严格使用固定 17 节，不扩章、不改名、不重排。
- 开篇在两段内说清投资主体、目标公司、金额、工具、目标权益、价格逻辑和提请审议事项。
- 事实章节先写项目事实，分析集中回答投资意义；风险和结论写触发情形、影响、动作和交易响应。
- 同一事实、数字、来源或缺口只完整出现一次，其余章节只引用对当前判断的新影响，不换词复述。
- 全篇先形成事实闭环，再压缩到投委会可读密度；不为表格强制另起一页，不制造可避免的大面积留白。

### 6. 内容门禁与自动修订

按 [Reviewer 契约](references/reviewer-contract.md) 评分：

- 85–100：决策级版本；
- 70–84：仅当客观证据缺失且结论为条件式、缺口均有交易响应时，允许受限交付；
- 低于 70：不得进入 Formatter。

评分不达标时完整执行“定位失败项 → 只重写相关章节 → 全篇去重 → 重算评分”，最多三轮。不得把第一轮草稿直接包装成交付物。

### 7. Word 格式化与验收

- 使用 documents 技能的模板复刻模式。校验`assets/primary-layout-authority.docx`指纹，从其工作副本生成，不从空白文档开始。
- 在任务临时目录建立`artifact.md`，按案例精确版式契约保留页面、四类真实样式、页眉线条、文本框PAGE域和编号组件；按案例表格组件生成原生表格。
- 先运行案例精确版式校验：

```bash
python scripts/validate_case_style_fidelity.py final.docx
```

- 再运行结构校验：

```bash
python scripts/validate_proposal.py final.docx --manifest proposal-manifest.json --render-dir render
```

- 使用案例可用字体配置渲染全部页面并逐页检查；发现截断、表格拥挤、等宽列、数字左对齐、字体层级丢失、页眉页脚漂移或大面积空白时自动修复并重渲染。
- 最终冻结哈希，确认交付目录只有一份 DOCX。

## 不得交付的状态

- 只写风险与待办，没有清晰投资逻辑和价格判断；
- 只有管理层目标，没有历史财务、现金消耗或预测假设边界；
- 有交易金额但没有投前/投后、股比、完全稀释口径或交割条件；
- 有“可比公司”标题却没有可比逻辑、数据时点或明确缺口响应；
- 有退出描述却没有可计算场景或不能计算的具体原因；
- 所有表格统一等宽、统一左对齐或偏离案例全框线/三线表组件；
- 标题、正文、页眉页脚或表格字体没有复用案例真实样式；
- 用普通段落边框代替案例锚定页眉线，或用普通段落PAGE域代替案例页脚文本框；
- 生成 PDF、PPT、Markdown、重复 DOCX 或把内部 Manifest 交付给用户。

## 最终交付

只交付一份 DOCX。简要说明主方案、结论状态和关键限制，不输出内部证据账本、Manifest、计算日志、渲染图或 Reviewer 过程。已使用来源只写入系统任务来源表和产物审计元数据；正式正文不生成文末免责声明或“引用资料”清单。
