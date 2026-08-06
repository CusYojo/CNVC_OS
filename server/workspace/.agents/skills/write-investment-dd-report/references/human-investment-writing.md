# Human Investment Writing Standard

Write as a senior investment manager briefing a partner who may stop reading after three minutes. Preserve evidence discipline backstage while making the reader-facing report direct, company-specific, and natural.

## Narrative order

Form the investment view before expanding chapters:

1. **Company essence**: what the business is today, not every market it mentions.
2. **Verified engine**: what customers demonstrably pay for and how the company delivers it.
3. **Growth wager**: which new product, market, or operating change the investment actually underwrites.
4. **Decisive uncertainty**: the one to three facts most likely to change the decision.
5. **Recommendation**: invest, conditionally invest, defer, or decline, with the reason stated in one paragraph.

Use this view to decide chapter emphasis. Do not give equal space to every product or risk.

## Paragraph standard

- Open each level-one chapter with an answer, not a source disclaimer or a description of the diligence process.
- Give each paragraph one job: judgment, supporting evidence, implication, or exception.
- Prefer concrete nouns, observed behavior, named products, customers, periods, amounts, and operating metrics.
- Vary sentence length. Use short sentences for conclusions and longer sentences only when the causal chain requires them.
- Group related uncertainty once. Move routine verification requests to the diligence-gap appendix.
- Use “我们判断” or an equally direct formulation when making an analyst judgment. Do not impersonate certainty.
- If a paragraph could be pasted into another company's report unchanged, rewrite it.

## Keep evidence backstage

Attach evidence IDs in `report.json`, but do not narrate the evidence ledger. In reader-facing prose:

- state verified facts directly;
- attribute material management information once, for example “根据公司提供的2025年管理报表”;
- translate an unresolved thesis-changing fact into a present valuation or transaction action, for example“现阶段估值只计入已实现并回款的客户毛利，续费样本达到约定门槛后再释放经常性收入溢价”；
- avoid repeating “公开资料显示”“尚未核验”“正式尽调需” throughout the report;
- place source lists, evidence status, and ordinary requests in the appendix or concise table notes.

Reader-facing prose must not use search or file status as a substitute for judgment. Ban “本报告基于公开资料编制”, “未获取”, “未披露”, “未公开”, “待定”, “公开信息未显示”, “目前无法判断”, “尚不足以直接推导”, “产品—市场匹配尚未确立”, “当前阶段不具备形成投资结论的条件”, “建议补充数据后再评估报价”, “进入第二阶段专项尽调”, “条件满足前不锁定股权价格” and “后续尽调需厘清”. Do not use those words as table placeholders. Replace them with observed operating evidence, valuation treatment, milestone pricing or transaction protection. P0 fields may not be omitted; they must trigger further evidence work, a lower report mode or a blocked IC deliverable.

## Write investment implications, not process commentary

Weak:

> 公开资料能够证明公司存在客户，但尚未取得合同、验收单及回款凭证，后续需进一步核验。

Strong:

> 公司已有跨年度复购的机构客户，现阶段应按“软件工具+人工研判+项目实施”的混合业务估值，不采用纯SaaS倍数。若客户抽查显示标准软件续费和交付人效持续改善，再给予平台化溢价。

Weak:

> 公司形成了多元化产品矩阵，具备一定技术基础和发展潜力。

Strong:

> 公司当前收入底盘仍来自成熟软件和项目服务，新产品的价值首先体现在复用既有客户，而不是单独贡献估值。若新产品无法提高客单价、续费或交付人效，多产品布局反而会分散研发资源。

Weak:

> 产品—市场匹配尚未确立，建议补充核心财务与运营数据后再评估报价。

Strong:

> 当前商业证据集中在项目交付和产品上线。本轮报价以投资主体已实现的合同毛利与现金回收为锚；平台交易密度、复购和履约效率达到约定指标后，通过下一期投资释放平台溢价。

Weak:

> 公开信息未显示关联交易，实验室与公司之间的人员、设备、数据或知识产权共享关系需厘清。

Strong:

> 公司技术与高校团队保持紧密协同。交易文件应将核心人员服务、职务成果归属、数据授权和设备使用边界一次性固化；未由投资主体控制的成果不进入估值，交割后新增成果按协议自动归集。

## Prohibited habits

- Do not obtain authority through unsupported precision.
- Do not convert project investment, framework agreements, pilots, registrations, or customer lists into revenue or cash flow.
- Do not use generic pairs such as “机遇与挑战并存” or “具有广阔发展前景”.
- Do not fill missing evidence with industry background, policy summaries, or repeated diligence requests.
- Do not end every section with the same “但仍需进一步核验” construction.
- Do not write document-production status as an investment conclusion. Phrases such as “尚未形成可审议方案”“尚未得到台账支持”“尚不能证明” and “资料不足” belong in workpapers, not the investment summary, transaction table or final recommendation.
- Do not use “继续跟进”“进入第二阶段专项尽调” or similar process actions as the final recommendation. Select invest, conditional invest, defer or decline.
- Do not use “经营质量评价框架”“建议的经营里程碑” or “建议的估值处理” where the report requires actual operating data, management plans or a valuation result.
- When a private-company metric cannot be verified online, do not imply that more web search can create an audited number. Use verified operating proxies, choose a conservative valuation treatment, and convert the missing private record into a named signing or pricing condition.
- Do not let tables replace synthesis; introduce what the table proves and explain what changes the decision.

## Final partner edit

Before layout, read only the reader-facing text and ask:

1. Can a partner understand the company and the recommendation within three minutes?
2. Does each chapter begin with a conclusion?
3. Are the strongest claims supported without cluttering the prose with audit language?
4. Are thesis-changing gaps ranked rather than repeated?
5. Does the report sound specific to this company?

Rewrite until all five answers are yes, then run the automated narrative audit.
