# Evaluation and correction checklist

Score each dimension from 0 to 5. A deliverable passes at 22/25 or above, with no zero and no hard-gate failure.

## Evidence — 5

- Every decisive factual block has source IDs.
- Signed/official/audited evidence controls conflicts.
- Claims, calculations, and pending items are distinguishable.
- The public-verification record identifies the target by legal name and unified social credit code, records a query cutoff date, and binds direct sources to matched identifiers.
- Search-result snippets are not treated as official evidence; access limitations and public/internal conflicts are explicit.

## Compliance reasoning — 5

- All seven checks are present.
- When supplied, return-investment and concentration calculations show denominator, numerator, date, and post-investment headroom; when unavailable after a supplement request, the audit layer records the gap without inventing a result.
- Related-party and other-law conclusions state their review perimeter and conditions.
- `delivery_readiness.status` is `ready` or a valid `proceed_with_available_materials`. The latter records the supplement request/outcome, all evidence limitations, and `continuation_authorization` with `authorized: true`, `basis: explicit_user_instruction`, and a non-empty instruction; `blocking_issues` is empty. `awaiting_user_input` is never deliverable.

## Transaction accuracy — 5

- New shares and old shares are separated.
- Pre-money, post-money, ownership, fully diluted basis, payment, governance, and final-document caveats reconcile.
- No amount, percentage, fund name, SPV, seller, or date is inherited from the template.

## Writing quality — 5

- Formal, concise, neutral, and decision-oriented.
- No promotional adjectives unsupported by evidence.
- No absolute legal assurance; conditions are concrete and actionable.
- 公司情况介绍不夹带重复尽调提醒；投资理由只保留正向匹配逻辑。
- 七项分析结论先行，同一条件只出现一次；结尾为一个不超过 120 个汉字的条件性结论句。
- 投资理由小标题为15—34个紧凑字符的项目特异性投资判断，包含具体对象/能力、差异化机制和投资含义，不是可套用于任意项目的栏目标签。
- “投资情形分析”以本次拟议交易、适用基金条款及投资后基金状态为判断对象，七项依次对应投资限制、返投影响、关联交易、投资方向、投资配置、集中度和其他法律监管事项。
- 七项分析不得以“待确认／不能测算／无法核对／待定”作为可交付文件的判断引导语；结尾必须包含具体前提及“原则上符合”。
- 七项可见分析的任意位置均不得出现“尚未确定／待明确／待补充／仍需／应结合……判断／应核对／核查后方可确定／不能测算／无法核对／不宜作出结论／最终仍应核实”等审计过程语言；相关任务进入 `open_issues`。决定性资料缺失时先暂停；用户明确授权按现有材料继续后，缺口才形成 QA 警告。
- 第一项涉及老股时只保留一条基金协议前提；第七项不枚举交割核查事项。
- 投资计划末段保留语只出现一次，宜控制在 72 个字符以内。
- 公司简介首段以 `target_company.legal_name` 记录的目标公司法定全称开场，完成首次主体识别后再使用“公司/标的公司”；不出现股东持股比例、表决权比例、资本表或控制权展开。
- 公司简介不出现统一社会信用代码、营业执照号码、注册号、组织机构代码、证照编号或18位登记标识。
- 公司简介不出现收入确认、开票与交付/验收时点、跨期或审计调整、回款异常、税务会计问题等财务尽调事项；精确收入、利润、毛利率、应收账款或现金流指标只有在用户明确要求、审计依据充分、无重大冲突且 `company_profile_financial_disclosure` 记录完整时才可例外披露。“已形成初步商业化收入”等无精确数值的阶段性表述可以保留。
- 核心团队一人一段；每段提供 `role_title` 和 `person_name`，并以两者精确拼接的“职务/Title 在前、姓名在后”顺序开场；team coverage 至少覆盖角色、教育/专业训练、代表经历、专业方向或有依据的公司实际职责中的三类，并以自然职业表述准确保留拟任/兼职/双聘状态。成员简介不追加推断性的项目帮助或公司匹配判断，团队整体投资价值只在投资理由集中分析一次。
- 公司情况介绍、投资理由和投资计划不出现附件文件名、文件日期/内部版本、路径、扩展名或“公司资料记载／根据文件所列”等来源过程；法律法规正式名称和必要的合规审阅范围限定除外。
- 四大章节不出现 `closing.company` 的出具方完整名称；投资方、基金、投资载体和管理人分别使用“我方”“本基金”“指定基金主体”“管理人/基金管理人”。目标公司法定全称必须在公司简介首段开场出现，后文使用“公司/标的公司”；出具方完整名称只保留在落款。
- `qa.json` 的 `content_completeness_status` 为 `pass`；`content_richness` 达到样例校准的最低密度，且没有靠重复、宣传用语或空泛行业描述凑字数。

## Template fidelity — 5

- A4; top/bottom 2.54 cm; left/right 3.175 cm; no visible header/footer.
- Title: 黑体 14 pt, non-bold, centered. Main text and headings: 宋体 12 pt for Chinese, western text, and digits; black; 1.5 line spacing.
- Main headings and subheadings are bold; main headings have 12 pt before; body has an approximately two-character first-line indent.
- Numbered reason/compliance items use 12 pt before; the number and entire conclusion lead through the first `。` or `：` are bold; reasoning remains normal weight.
- Conclusion has 12 pt before and a 420-DXA first-line indent.
- Closing company/date lines are right-aligned; both have 12 pt before; the date uses `YYYY年   M   月   D   日`.
- Exactly two reference-derived blank transition paragraphs are present, before 投资情形分析 and before the closing company line. No other blank paragraph, underlining, or italics.
- Core document properties match the current title, management company, and document date. Optional template application/custom properties are removed together with their relationships and content-type declarations; no WPS/KSO save record or user identifier remains.

## Hard-gate failures

- Missing one of the seven compliance checks.
- Missing or invalid public-verification binding for an online run; confidential transaction terms appear in search queries; the primary target is not disambiguated; or an unresolved material public/internal conflict remains.
- A negative public check says “不存在／绝无／完全没有” or relies only on a search-result page instead of a direct source.
- Unresolved contradiction in investment amount, valuation, ownership, fund identity, or transaction form.
- Template residue such as 德塔智能, 1,500万元, 24亿元, 2.7亿元, 0.56%, or the original date when not intentionally sourced.
- Template or privacy residue in DOCX package metadata, including stale title/subject/author/modifier/date, application GUIDs, WPS/KSO save records, user identifiers, or dangling metadata relationships.
- Final DOCX not rendered and visually inspected, unless LibreOffice is unavailable and the limitation is disclosed.
- Investment reasons contain defensive tails such as “但”“仍需”“取决于”“适宜设置为” or “交割前应”.
- The conclusion contains more than one sentence or appends a generic disclaimer after the conditional conclusion.
- The conclusion says “暂无法形成结论／不能形成结论／无法判断／待定”, or does not contain “原则上符合”.
- Any of the seven compliance checks uses an indecisive lead instead of an explicit affirmative judgment.
- Any of the seven compliance checks narrates unfinished review, missing inputs, calculation requests or a refusal to conclude, even if its first words look affirmative. One concrete result-specific condition is allowed; an open-ended audit instruction is not.
- Any 投资理由 summary title is an over-broad category label or falls outside the sample-calibrated 15–34 compact-character range.
- Any 投资情形 item departs from the fixed seven-role map, or substitutes target-company historical financing for the contemplated transaction or post-investment fund calculation.
- The seventh compliance item is used as a closing-condition checklist instead of a concise legal/regulatory conclusion.
- Any mismatch in required A4 geometry, margins, all-script font/size, line spacing, main/subheading/lead bold roles, alignment, spaced-date treatment, or the exact two-transition-paragraph rule.
- 公司简介泄漏持股、表决权、资本表或控制权信息；或 `content_completeness_status` 不为 `pass`。核心团队数量/维度和其他证据密度不足在已请求补件后记为警告，不单独阻断。
- `target_company.legal_name` 缺失，或公司简介首段没有以该目标公司法定全称开场。
- 公司简介显示证照/登记序列号；或公司情况介绍、投资理由、投资计划存在附件名称、日期/版本、路径、扩展名或证据取得过程式来源元话语。
- 四大章节出现 `closing.company` 的出具方完整名称，而不是只在落款使用。
- 公司简介出现财务尽调问题；或在没有有效 `company_profile_financial_disclosure` 例外记录时出现精确财务指标。
- 公司简介出现法定代表人、注册资本、实缴资本或认缴资本，而不是保持业务介绍优先并将常规工商事实留在审计层。
- 任一核心团队段落缺少 `role_title` 或 `person_name`，或未以 `role_title + person_name` 的精确顺序开场。
- 任一核心团队段落包含“使其能够统筹”“可支持/支撑/连接公司”“可为公司提供”“能够为平台/产品/业务提供工程化支持”“有助于公司”“将补强公司”或“与公司产品路线具有对应/匹配关系”等推断性项目帮助/公司匹配措辞。
- `delivery_readiness` 缺失、补件请求记录缺失、状态为 `awaiting_user_input` 或 `blocked`、`blocking_issues` 非空，或已提供的金额/估值/持股/返投/集中度数据相互矛盾。
- `proceed_with_available_materials` 没有 `authorized: true`、`basis: explicit_user_instruction` 和非空用户指令记录；用户沉默或未回复不得视为授权。
- 已有证据明确显示禁止性或不合规事项，却仍强行写成“原则上符合”；仅在取得明确继续授权后，`status: pending` 才可在 `proceed_with_available_materials` 下形成警告。
