---
name: write-investment-dd-report
description: 创建、改写、审计并逐页视觉核验字段完整、公司专属、可供投资决策使用的中文投资尽职调查报告（DOCX）。适用于综合、业务、财务、法律、技术、初筛、投前预审及投委会导向的尽调；通过结构化字段和来源等级硬门禁检查股权、客户闭环、财务、交易、估值、风险和结论，禁止用原则或框架替代事实底表；支持德塔 V5 投委会版 A4 版式、字段级公开检索、证据审计及 Claude Code 兼容运行。
---

# 专业投资尽职调查报告

生成可供投资决策使用的报告，而不是融资材料复述稿或证据清单。以资深投资经理的口吻回答：公司本质是什么、哪些事实已经核实、投资判断依赖什么、哪些事项可能推翻判断。证据边界在后台管理，重大风险必须对应可执行的交易保护，最终交付经过视觉验收的 DOCX。

## 任务路由

- **新建**：根据项目资料及必要的合法公开信息创建新报告。
- **改写**：除非用户要求全面重写，否则保留既有报告，重点修复证据、逻辑、完整性和排版。
- **审计**：仅诊断内容或格式；用户未要求修改时不得改动报告。
- **专项尽调**：按业务、财务、法律、技术、初筛、投前预审或综合尽调确定范围；专项报告不得包装成综合尽调。

优先使用当前客户端可用的 DOCX 能力。在 Codex 中调用 Documents 技能并执行“渲染—检查—迭代”门禁；在 Claude Code 或其他兼容客户端中，使用本技能自带的生成、审计、渲染脚本及可读取图片的工具。PDF 或电子表格对结论重要时，应使用相应能力读取和核验。需要且用户未禁止时，通过客户端合法联网工具检索最新公开信息，并保留内部来源清单；不得掩盖无法核验的关键缺口。

## 固定封面规则

封面主标题在所有报告类型下均固定为：

```text
尽职调查报告
```

- `meta.report_title` 必须严格等于 `尽职调查报告`。
- 封面不得出现“公开信息预尽职调查报告”“初步尽职调查报告”“预尽调报告”“投前预审报告”等变体。
- `screening`、`pre_ic`、公开信息口径等只保留在 `meta.report_type`、尽调范围、报告依据或内部工作底稿中，不得进入封面主标题。
- 生成器和审计脚本必须对此执行硬校验；标题不符合时停止生成，不得自动放宽。

## 先解析技能运行环境

不得假设当前工作目录就是技能目录。

- Claude Code：以 `${CLAUDE_SKILL_DIR}` 作为技能根目录。
- Codex：将技能目录目录表中本 `SKILL.md` 所在目录赋给 `DD_SKILL_ROOT`。
- 其他兼容客户端：将本 `SKILL.md` 所在目录赋给 `DD_SKILL_ROOT`。
- Python 解释器通过 `DD_PYTHON` 指定；优先使用已安装 `python-docx` 与 `PyMuPDF` 的环境。

所有内置命令采用以下模式：

```bash
DD_SKILL_ROOT="${CLAUDE_SKILL_DIR:-$DD_SKILL_ROOT}"
DD_PYTHON="${DD_PYTHON:-python3}"
"$DD_PYTHON" "$DD_SKILL_ROOT/scripts/check_runtime.py"
```

如运行检查提示缺少 Python 依赖或没有 DOCX 渲染器，应停止并修复环境。Claude Code 的安装、工具映射、环境恢复和视觉验收要求见 [cross-client-runtime.md](references/cross-client-runtime.md)。

## 按需读取参考规范

- 始终读取 [evidence-policy.md](references/evidence-policy.md)、[diligence-data-schema.md](references/diligence-data-schema.md)、[public-research-protocol.md](references/public-research-protocol.md)、[source-sufficiency-routing.md](references/source-sufficiency-routing.md)、[report-framework.md](references/report-framework.md)、[human-investment-writing.md](references/human-investment-writing.md)、[deta-v5-template-contract.md](references/deta-v5-template-contract.md)、[deta-v5-semantic-blueprint.md](references/deta-v5-semantic-blueprint.md)、[layout-spec.md](references/layout-spec.md) 和 [quality-gates.md](references/quality-gates.md)。
- 涉及财务报表、预测、现金流、收入质量、营运资金或资金需求时，读取 [financial-analysis.md](references/financial-analysis.md)。
- 涉及定价、可比公司、稀释、退出、MOIC 或 IRR 时，读取 [valuation-and-returns.md](references/valuation-and-returns.md)。
- 涉及投资建议、交割条件或将发现转化为交易保护时，读取 [risk-and-deal-terms.md](references/risk-and-deal-terms.md)。
- 确定行业后，读取 [sector-modules.md](references/sector-modules.md) 中对应部分。
- 使用 DOCX 生成器前，读取 [report-json-schema.md](references/report-json-schema.md)。

## 工作流程

### 1. 锁定项目身份与尽调范围

记录准确的法律主体、项目名称、报告类型、投资阶段、目标读者、待支持的决策、报告币种、信息截止日、版本和保密等级。名称相近的主体、关联方、基金和产品，在证据确认前一律视为不同对象。

盘点全部源文件及其日期、用途，保留原件。必要时检查批注、修订痕迹、隐藏工作表、附录、图片页和扫描材料。

### 2. 根据资料充分度确定报告类型

按 [source-sufficiency-routing.md](references/source-sufficiency-routing.md) 对股权、团队、产品、客户、财务、预测、合规和估值证据评分，并选择以下唯一映射：

- `screening_public` → `meta.report_type=screening`；
- `business_dd` → `meta.report_type=business`；
- `financial_dd` → `meta.report_type=financial`；
- `legal_dd` → `meta.report_type=legal`；
- `technical_dd` → `meta.report_type=technical`；
- `pre_ic` → `meta.report_type=pre_ic`；
- `comprehensive_ic` → `meta.report_type=comprehensive`。

只有核心决策事项获得一手或符合字段门禁的证据支持时，才使用 `pre_ic` 或 `comprehensive_ic`。仅有公开信息或融资材料时只能使用 `screening_public`，但封面标题仍固定为“尽职调查报告”。

用户要求德塔 V5 完整格式时，只有 `pre_ic` 或 `comprehensive_ic` 才可将 `meta.template_profile` 设为 `deta_v5_up_to_ic`。`screening_public` 和专项模式不得使用该配置，不得用方法论表格、估值原则、经营指标框架或治理建议填充完整上会章节。用户要求德塔完整上会稿但P0证据不足时，应先继续穷尽公开检索并取得目标公司资料；P0门禁仍未通过时，阻止生成完整上会稿，不得交付一份外观完整但决策字段缺失的报告。

尽调范围在前言中集中说明一次。正文只保留可能改变投资决定的不确定性，普通资料请求统一放入附录。

### 3. 先建立证据台账

按 [evidence-policy.md](references/evidence-policy.md) 在任务目录创建 `evidence.json`。每项重大事实使用稳定 ID，并记录主体、期间、单位、来源、来源类型、验证状态、重要性、冲突和拟使用位置。

```bash
"$DD_PYTHON" "$DD_SKILL_ROOT/scripts/audit_evidence.py" evidence.json
```

出现重复 ID、来源缺失、主体冲突未解决或重大数字缺少期间/单位时，必须停止并修复。不得用貌似合理的文字填补数据缺口。

### 4. 建立投委会字段数据层

按 [diligence-data-schema.md](references/diligence-data-schema.md) 在任务目录创建 `diligence-data.json`。每项关键字段必须记录状态、来源等级、期间、单位、证据 ID 和结构化数据。股权、客户闭环、财务、交易参数、估值和投资结论不得只存在于自由文本中。

先运行字段审计：

```bash
"$DD_PYTHON" "$DD_SKILL_ROOT/scripts/audit_ic_completeness.py" \
  diligence-data.json --evidence evidence.json
```

P0字段缺失、来源等级不足、必需子字段为空或报告模式不匹配时，必须继续取数、降级报告模式或停止完整上会稿生成。不得删除P0字段来规避门禁。

### 5. 建立并回答投资问题

结合 [report-framework.md](references/report-framework.md) 和适用行业模块，优先提出可能证伪投资逻辑的问题：

- 客户为什么可能不购买、不续费、不验收或不付款？
- 产品实现交付或规模化之前还必须完成什么？
- 所谓优势有哪些独立证据或客户证据？
- 合同、交付、验收、收入、发票和回款之间哪些勾稽关系不成立？
- 当前估值已经隐含了哪些假设？
- 哪些下行情形会永久损害价值或退出能力？

每个答案标记为：已核实事实、公司口径、公开事实、分析师测算、分析判断、未解决缺口或冲突证据。

### 6. 检索公开信息并解决冲突

按 [public-research-protocol.md](references/public-research-protocol.md) 执行字段级公开信息穷尽检索。主体、团队、产品、客户案例、融资、知识产权、合规、市场与竞争八个问题域均须至少设计两个不同目的的查询，并绑定具体 `field_ids`；对外部可核实事项，不得仅因用户资料包未提供就写成缺口。法规、许可、工商信息、技术标准和市场数据优先使用一手或权威来源。重大事实原则上采用两个独立来源；只使用单一来源时，应在内部说明理由。每条来源必须用结构化原子事实绑定正确字段、主体、产品、期间、地域、币种和单位。

报告主要依赖公开信息、融资材料或管理层口径时，在任务目录创建 `public-research.json` 并运行：

```bash
"$DD_PYTHON" "$DD_SKILL_ROOT/scripts/audit_public_research.py" public-research.json
```

检索审计必须为零错误、零警告。网络检索无法替代私有财务、合同、银行流水和资本化表；此类记录不写成正文免责声明，而是使用已核实经营代理指标、收窄估值口径，并转化为分期投资、价格调整、交割条件或终止权。

来源冲突时，保留双方口径，分析差异原因、决策影响和解决冲突所需证据；不得默默采用更有利的数据。

### 7. 先形成合伙人观点

在规划章节前，先写一份简短的内部投资观点，直接回答：

- 公司当前的业务本质；
- 已验证的收入或客户引擎；
- 本次投资真正押注的增长变量；
- 最可能推翻决定的一至三项事实；
- 投资建议及判断置信度。

据此分配篇幅，不得平均描述每个产品、政策、市场和风险。证据不足以支持明确观点时，只能保留 `screening_public` 口径；不得因用户要求德塔完整结构而绕过P0门禁。取得足够证据后再升级为 `pre_ic` 或 `comprehensive_ic`。

### 8. 围绕投资决策组织报告

从 [report-framework.md](references/report-framework.md) 和德塔语义蓝图中选择适用章节。投资结论置于报告前部，但最后撰写。历史实际、当前状态、已签订单、管理层预算、分析师预测和情景测算必须清晰区分。

`deta_v5_up_to_ic` 使用八个编号章节：投资概要、公司概况、产品与技术、业务情况、行业和市场、未来发展规划、投资方案、风险提示与对策；其后为不编号的“投资结论及建议”。投资概要依次包含：公司情况、交易要点、行业概况、商业模式和经营管理、投资价值与风险。必须使用语义蓝图规定的表格原型，不得以泛化的章节摘要替代。

综合报告的决策页至少包含：投资建议、拟投资金额/估值/结构/预计持股、三至五条投资逻辑、三至五项重大风险及剩余风险、交割先决条件和投后约束、基准/下行/上行情景回报，以及可能改变决策的明确事项。上述内容必须由 `diligence-data.json` 的对应字段驱动。

### 9. 撰写面向读者的正文

遵循 [human-investment-writing.md](references/human-investment-writing.md)，使用自然、克制、结论先行的中文。一级章节必须以投资判断开头，不得以“公开资料显示”、资料限制或尽调过程开头。

必须区分：公司陈述与调查结论；行业吸引力与公司获取能力；意向、框架协议、约束性订单、交付、验收、收入确认、开票和回款；设计、仿真、内部测试、第三方测试、客户验证、定点和量产；管理层计划与分析师预测；风险缓释意愿与可执行交易保护。

只有可比记录才使用量化表格。不得堆砌宣传性文字。未经明确范围和可靠证据，不得使用“唯一”“第一”“领先”“顶尖”“确定性强”“无重大风险”等表述。

证据 ID、搜索状态和验证分类保留在 `report.json`、`evidence.json` 与 `public-research.json` 中，不要写成反复出现的审计语言。重大管理层信息集中归因一次，将改变投资逻辑的不确定性合并呈现，常规资料请求移至附录。如果一个段落可以原封不动贴到另一家公司报告中，必须重写。

正文禁止出现资料状态和模型式退让语言，包括“本报告基于公开资料编制”“未获取”“未披露”“未公开”“待定”“产品—市场匹配尚未确立”“当前阶段不具备形成投资结论的条件”“建议补充数据后再评估报价”“公开信息未显示”“后续尽调需厘清”等。不得在表格中用“待定”“未披露”“未公开”占位。应改写为已观察事实、商业机制、估值边界和交易安排。普通非关键字段没有可信内容时可以删除；[diligence-data-schema.md](references/diligence-data-schema.md) 所列P0字段不得删除、不得由原则性文字替代，必须继续取数、降低报告模式或阻止完整上会稿生成。

读者可见正文不得出现工作底稿语言。标题、表题、字段和行内容不得描述“核查框架”“验证框架”“核查重点”“底稿要求”“资料清单”“尽调工作流”“完成标准”等分析师任务。正文表格只能呈现公司事实、可比记录、分析判断和交易含义；核查清单、待勾稽事项和资料请求只放入证据台账或一个最终附录。

专项、投前预审和综合上会报告的每张表必须设置 `semantic_role` 和 `data_field_ids`。禁止用“经营质量评价框架”“建议的经营里程碑”“建议的估值处理”替代历史经营数据、管理层计划或估值测算。

满足以下内容密度要求：

- 每个产品说明客户痛点、购买方、收费逻辑、交付依赖、成熟度、已有证明及关键未决证据；
- 每条客户记录区分接触、试用、合同、交付、验收、开票、收入、回款和续约；
- 每张财务表标明期间、单位及实际/预算/预测属性；没有源台账时不得编制预测；
- 每项重大风险说明已观察事实、触发条件、概率/影响、交易条件、责任人、期限、证据和救济；
- 不得虚构未知交易条款。未取得条款清单时，正文应给出投资判断：是否建议报价、采用何种估值方法、满足哪些条件后启动价格谈判。原始金额、估值、股权结构资料请求留在后台或精简附录。投资概要、交易概要和结论中不得出现“尚未形成可审议方案”“尚未得到台账支持”“尚不能证明”等文件状态语言。

### 10. 执行证据、字段、内容和叙事门禁

按 [report-json-schema.md](references/report-json-schema.md) 将初稿表达为 `report.json`，事实和重大分析块必须关联证据 ID。

```bash
"$DD_PYTHON" "$DD_SKILL_ROOT/scripts/audit_evidence.py" evidence.json
"$DD_PYTHON" "$DD_SKILL_ROOT/scripts/audit_public_research.py" \
  public-research.json
"$DD_PYTHON" "$DD_SKILL_ROOT/scripts/audit_ic_completeness.py" \
  diligence-data.json --report report.json --evidence evidence.json
"$DD_PYTHON" "$DD_SKILL_ROOT/scripts/audit_report_content.py" \
  report.json --evidence evidence.json
"$DD_PYTHON" "$DD_SKILL_ROOT/scripts/audit_narrative_quality.py" \
  report.json --strict
```

当报告不依赖公开信息时，可省略公开研究审计；字段完整性审计不得省略。证据错误必须为零。每条证据警告都要人工审阅：可以解决的立即解决；无法解决的明确标记为公司口径、冲突或缺口，且不得承担投资建议或估值的主要支撑。字段、公开研究、内容和严格叙事审计必须同时实现零错误、零警告。交付排版前，应修复缺失P0字段、来源等级不足、无依据表述、冲突数字、重复限制语、泛化投资套话、过程化章节开头、重复段落和过长句子。

### 11. 使用德塔 V5 视觉系统生成 DOCX

使用脱敏模板 `assets/deta-v5-dd-template.docx`。该模板保留德塔 V5 投委会版 A4 页面系统，不含原公司内容。

```bash
"$DD_PYTHON" "$DD_SKILL_ROOT/scripts/build_report_docx.py" \
  --input report.json \
  --diligence-data diligence-data.json \
  --evidence evidence.json \
  --output final-report.docx
```

生成器会再次执行字段完整性门禁；即使调用者漏跑前置审计，P0字段、来源等级、模式或正文语义角色不合格时也必须拒绝生成 DOCX。

生成器必须遵守 [layout-spec.md](references/layout-spec.md) 中的页面尺寸、页边距、保密页眉、连续页码、字体、字号、行距、缩进、表格和图片宽度规范。六列财务表、股权表或情景测算表前后应使用明确的横向/纵向 `section_break`，完成后立即恢复纵向。内容变化可以导致页数变化，但不得通过缩小字体或制造空白页强行保持相同页码。

### 12. 执行结构审计和逐页视觉检查

```bash
"$DD_PYTHON" "$DD_SKILL_ROOT/scripts/audit_docx_style.py" final-report.docx
"$DD_PYTHON" "$DD_SKILL_ROOT/scripts/render_and_verify.py" \
  final-report.docx --output-dir render --emit-pdf final-report-qa.pdf
```

DOCX 样式审计必须为零错误、零警告。之后以 100% 比例逐页打开渲染图，不得仅凭缩略图或拼图批准。检查封面、目录、正文、全部表格与图片、跨页衔接和末页；核验字体、字号、行距、首行缩进、标题层级、段落节奏、表格行完整性、保密页眉、页码、裁切、空白和孤立标题。普通正文页有效内容低于约 25% 或连续出现稀疏页时应退回修复，但为了保持表格行完整或明确章节收束所需的留白除外。

macOS 上存在 Microsoft Word 时优先使用 Word 原生渲染，因为其中文分页和目录域结果最具权威性。Word 与 LibreOffice 结果不一致时，以 Word 结果修复和验收。Claude Code 必须使用可读取图片的工具逐张打开 PNG；渲染成功或生成总览图不等于视觉验收。每次修改内容或布局后，都要重新生成、审计、渲染并逐页检查，并在内部 QA 日志中记录页数及“全部页面已检查”。

### 13. 清洁交付

向用户交付最终 DOCX。证据台账、来源清单、报告 JSON、渲染图和审计日志默认作为内部工作文件保留，除非用户要求。说明仍未解决且可能影响决策的重大事项及任何渲染限制。不得暗示执行了实际未完成的独立核验。

## 不可交付条件

存在以下任一情形时，不得交付：

- 法律主体、信息截止日或报告类型不明确；
- `diligence-data.json` 缺失、字段完整性审计未通过，或 `screening_public`/专项模式与 `deta_v5_up_to_ic` 混用；
- P0字段被删除、以原则性文字替代，或关键字段来源等级低于 [diligence-data-schema.md](references/diligence-data-schema.md) 要求；
- `meta.report_title` 不严格等于“尽职调查报告”，或封面含有“公开信息预”等标题变体；
- 重大表述缺少依据，或绑定了错误主体、期间、币种或单位；
- 将意向或框架协议表述为约束性订单或收入；
- 财务预测无法对应驱动因素和里程碑；
- 估值采用不可比公司且未进行口径归一或敏感性分析；
- 专项尽调的重大结论未纳入综合结论；
- 风险措施只有“加强管理”“持续跟踪”“投后赋能”，却没有责任人、期限、证据、约束条款、条件或救济；
- 必要章节空白、被排版遮挡或由泛化赞美替代；
- 正文仍含反复审计语言、通用投资套话、重复分析或无结论的章节开头；
- 正文出现“未披露、未公开、待定、本报告基于公开资料编制、未获取、产品—市场匹配尚未确立、公开信息未显示、后续尽调需厘清”等资料状态、占位或模型退让语言；
- 主要依赖公开信息的报告没有通过公开研究覆盖审计；
- 正文含工作底稿标题、验证清单、资料请求表或分析师完成标准；
- 专项、投前预审或综合上会报告的表格缺少 `semantic_role`/`data_field_ids`，或用经营框架、估值原则代替事实底表；
- 仍有证据审计错误、未经审阅的证据警告，或内容、叙事、DOCX 审计存在任何错误或警告；
- 最新 DOCX 未在最后一次修改后重新渲染，或未以 100% 比例逐页检查全部渲染页面。
