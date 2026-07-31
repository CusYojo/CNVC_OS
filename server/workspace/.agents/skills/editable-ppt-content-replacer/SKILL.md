---
name: editable-ppt-content-replacer
description: 基于已经完成1:1复原的可编辑PPTX模板生成当前项目投资建议书或同模板新报告；先锁定项目身份、清除模板样本指纹并建立唯一事实库和逐页内容方案，再按语义槽位替换文字、数据、Logo、人物和产品素材。对每张正文页建立独立检索问题、证据包和最低有效内容密度，联网补充行业、政策、基准、竞争、公开案例及可验证项目事实；通过来源、事实键、单位期间、重大数据交叉验证、实体绑定、文字容量预算和全页视觉门禁阻止错填、编造、旧项目残留及排版失控。适用于投资建议书 PPT、PDF 模板元素化后的内容替换，以及用户强调“只换内容、不重新设计”的 PowerPoint 任务。
---

# 可编辑模板 PPT 内容定向替换

将 `pdf-to-editable-ppt` 的输出视为已经验收的锁定模板。只修改白名单中的
内容对象，不重新转换 PDF，不重新元素化模板，不替换共享图标或固定装饰。
资料不足时只能删除预先声明的完整可选槽位组，不能留下空图标、空边框或
半个卡片。

只交付一个最终 PPTX，核心内容必须保持为原生可编辑对象；不得再生成第二份
纯图片 PPTX，也不得用整页背景图覆盖模板后冒充可编辑结果。

新任务使用 1.6 版替换清单。1.6 版继承 1.5 的身份、证据、内容安全与
全页闭环约束，并新增模板背景锁、背景候选逐项复核、Logo 透明底检测和
Logo 相邻底板审计。详细模型见
[references/content-safety-model.md](references/content-safety-model.md)。
背景与 Logo 的专用规则见
[references/background-and-logo-safety.md](references/background-and-logo-safety.md)。
用户资料不完整时，非必要字段直接省略，重大缺口只允许
集中进入专用“待核实事项”页，不得把“未提供公司官网”“缺少原始文件”
等制作过程提示散落到成稿中。

## 必须遵循

- 使用当前会话中的 Presentations 技能。
- 正式投资建议书任务同时遵循
  [references/output-contract.md](references/output-contract.md)。
- 输入模板必须是已经可编辑的 `.pptx`；若只有 PDF，先使用
  `pdf-to-editable-ppt`，完成并验收 1:1 可编辑底稿后再运行本流程。
- PDF 转换模板必须提供 `conversion-handoff.json`，且其中
  `watermarkQaPassed`、`editabilityReviewPassed` 和
  `readyForContentReplacement` 均为 `true`。不得跳过交接门槛。
- 使用 Python `zipfile` + Open XML 直接操作 PPTX 包结构，不依赖外部
  Node.js 运行时或 `@oai/artifact-tool`。
- 1.6 版设置 `defaultAction: "FAIL_UNCLASSIFIED_CONTENT"`。固定视觉逐项
  登记后保留；项目相关内容必须替换或删除；未知对象必须阻止交付。
- 模板母版、版式背景以及幻灯片中的全页、跨边或大面积早期图层默认视为
  背景候选。必须建立 `backgroundPolicy`；确认的模板背景必须登记为
  `protectedObjects/template_background`，禁止进入替换或删除操作。
- 公司 Logo 默认使用透明底 RGBA PNG、`imageFitMode: "contain"`。与 Logo
  高重叠的相邻对象必须逐项识别：模板底板保留，旧公司专属底板随旧 Logo
  完整删除；不得把旧底板误当模板背景，也不得让透明 Logo 叠在旧底色上。
- 共享语义图标（例如使命、愿景、价值观图标）必须登记为保护对象并复用，
  不因文字内容变化而替换。
- 人物和产品图片必须先建立实体绑定，再与姓名、职务、产品名或型号一起
  原位替换；不得按素材顺序、文件名顺序或图片尺寸循环分配。
- 不得清空全部文字、删除全部图片、按尺寸批量替换图片、循环分配素材、
  重建已经可编辑的图标，或重新设计页面。
- 用户资料不足时允许联网补全公开事实，但每项外部事实必须进入
  `sources` 和 `evidenceRegistry`，并由操作的 `evidenceIds` 引用。
- 每张正文页必须建立逐页检索问题和证据包。默认至少包含 6 个有效内容项、
  2 条不同证据陈述和 1 个页面检索问题；行业、市场、政策、竞争与公开案例
  页至少绑定 1 个网络原文来源。封面、章节页和结束页豁免。
- 搜索结果页和搜索摘要只用于发现来源，不能作为证据。优先使用公司官网、
  监管披露、政府、学术或标准机构的一手材料。
- 不得发明客户、合同、订单、认证、财务、融资、估值、市场份额、专利、
  员工数或其他未被证据支持的信息，也不得把推断写成已验证事实。
- 缺少对应内容且网络检索仍无法证实时，非必要槽位删除
  `optional=true` 的完整槽位组；重大必填缺口只能在专用缺口页以
  “未披露”“待核实”或“口径不一致”集中呈现。官网、地址等非必要字段
  缺失时直接省略，不得显示“未提供……”类占位语。不得沿用模板项目的
  专属数据或素材。

## 输入契约

必须获得：

1. 已经 1:1 复原的可编辑模板 PPTX；
2. 用户需求和目标公司/项目资料；
3. 可使用的 Logo、人物、产品、案例和数据素材；
4. 用户明确要求替换的范围。
5. PDF 转换任务生成的 `conversion-handoff.json`；原生 PPTX 模板除外。

模板 PPTX 是后续结构与视觉的唯一基准；原 PDF 只用于最终视觉对照。

## 无头与跨平台准备

Linux 或纯终端环境先运行：

```bash
python3 "$SKILL_DIR/scripts/check_environment.py" --json
```

检查器会验证本技能和 `pdf-to-editable-ppt` 的必要脚本，并复用 PDF 技能的
LibreOffice 无头 PDF 导出、pdftoppm 渲染、Tesseract 语言包和字体检查。
技能不在同一父目录时，设置 `PDF_TO_EDITABLE_PPT_SKILL_DIR`。
Presentations 技能不在默认插件缓存时同时设置 `PRESENTATIONS_SKILL_DIR`。
原生 PPTX 要求 `readyForNativePptxWorkflow=true`；PDF 转换模板另要求 `readyForPdfConvertedWorkflow=true`，否则停止。

## 工作流程

### 1. 验证 PDF 转换交接

如果模板由 `pdf-to-editable-ppt` 生成，先检查：

- 1.0 版证书中的 PPTX 路径和 SHA-256 与当前模板完全一致；
- 1.1 版证书允许交接目录整体迁移，但必须设置
  `pathBinding: "sha256"`，且当前模板 SHA-256、对象地图 SHA-256 和证书
  完全一致；水印 QA 与可编辑性报告必须能从交接目录内的安全相对路径读取，
  且各自 SHA-256 与证书一致；
- 水印策略不是 `keep`，渲染后水印 OCR 已通过；
- 没有未复核的大面积内嵌图片或尚未元素化页面；
- `readyForContentReplacement=true`。

1.6 版清单设置：

```json
{
  "schemaVersion": "1.6",
  "sourceMode": "pdf-converted",
  "conversionHandoff": "/absolute/work/conversion-handoff.json"
}
```

原生可编辑 PPTX 设置 `sourceMode: "native-pptx"`，不需要转换证书。

### 2. 锁定项目身份并建立对象地图

先用用户材料核实正式名称、地区和至少一个官方标识，创建
`projectIdentity`。身份置信度未达到 `high` 时停止；不得搜索或写入同名
公司的内容。

使用本技能自带的 Python Open XML 模板分析脚本：

```bash
python3 "$SKILL_DIR/scripts/analyze_template_openxml.py" \
  --input "/absolute/editable-template.pptx" \
  --output "/absolute/build/template-map.json"
```

分析器通过 Python `zipfile` 解包 PPTX，读取幻灯片 XML、版式关系、
稳定对象 ID、文字、坐标、层级、背景候选、样式、媒体引用、表格值、图表
缓存与嵌入工作簿签名；不得只从字体、颜色或截图推断模板。自动背景候选
只是复核入口，不可直接批量标记为删除。

生成背景候选复核草稿：

```bash
python3 "$SKILL_DIR/scripts/generate_background_policy_draft.py" \
  --template-map "/absolute/build/template-map.json" \
  --output "/absolute/build/background-policy-draft.json"
```

逐页查看渲染图，将每个 `unreviewed` 候选改为模板背景、项目内容视觉、
Logo 底板或非背景，并填写具体理由。草稿不可直接作为正式清单。

生成模板污染指纹草稿：

```bash
python3 "$SKILL_DIR/scripts/generate_template_fingerprint.py" \
  --template-map "/absolute/build/template-map.json" \
  --pptx "/absolute/editable-template.pptx" \
  --output "/absolute/build/template-fingerprint-draft.json"
```

逐页复核草稿，将旧公司、产品、人物、客户、案例、数字和媒体写入
`templateFingerprint`。草稿 `reviewed=false` 时不得继续。

逐页检查渲染图与对象地图。按
[references/object-classification.md](references/object-classification.md)
将对象区分为固定视觉、通用语义、内容槽、公司专属素材和数据槽。

同时建立四类结构化关系：

1. `protectedObjects`：共享图标、模板品牌、固定视觉和通用装饰；
2. `slotGroups`：内容对象与其配套图标、月桂、边框、标签等完整槽位；
3. `entityBindings`：人物/产品图片与姓名、职务、产品名、型号的对应关系。
4. `slotAssignments`：每个内容区域的语义、必填性和最终处置。

对全部页面生成页面闭环草稿：

```bash
python3 "$SKILL_DIR/scripts/generate_page_closure_draft.py" \
  --manifest "/absolute/build/replacement-manifest.json" \
  --template-map "/absolute/build/template-map.json" \
  --output "/absolute/build/page-closure-draft.json"
```

草稿会把未被操作覆盖的对象放入 `unknownShapeIds`。必须逐页检查渲染图，
确认对象属于固定模板、投资机构品牌或有证据的上下文后，才能移入
`allowedKeepShapeIds`，并在 `keepDecisions` 中写明分类和理由。不得直接
批量标成保留。每一页的 `unknownShapeIds` 必须为空。

### 3. 建立唯一事实库并按页面证据密度联网补全

先比较 `slotAssignments`、用户材料和逐页结论，为每张正文页建立 1–3 个
具体检索问题。既补足缺失槽位，也补充能解释该页结论的行业基准、政策、
竞争、标准、公开案例和可验证项目事实；不得用网络内容覆盖用户已经提供且
没有冲突的资料。不得用无关数据、同名公司资料或模板旧数据凑数。联网补全
时必须读取
[references/evidence-and-web-research.md](references/evidence-and-web-research.md)，
并读取
[references/page-research-and-density.md](references/page-research-and-density.md)，
并执行以下顺序：

1. 登记用户材料的文件、页码或对话位置；
2. 搜索公司官网、监管披露、政府、学术或标准机构等一手来源；
3. 重大数据没有一手来源时，至少使用两个独立可信发布方交叉验证；
4. 为计算结果登记输入来源和公式；为估算登记方法、假设和可见“估算/测算”
   标记；
5. 来源冲突时登记 `status: "conflicting"`，并在页面中显示“待核实”
   “存在差异”或“口径不一致”；
6. 无法找到证据时登记 `valueType: "unavailable"`，按必填标注、可选删除
   的策略处理。

每条网络来源记录标题、发布方、发布日期、访问日期和直接 URL。网页搜索
结果、聚合摘要、无发布方截图和无法定位原文的二手转述均不得作为证据。
将全部可写入内容汇总为唯一 `facts`；数值同时记录单位、币种、期间、口径
和证据。页面操作只能通过 `factKeys` 引用事实，不得直接从原始材料或搜索
结果临时生成数值。

### 4. 建立逐页研究包与内容方案

为每页创建 `slideBrief`，先声明页面目标、唯一结论、允许的
`semanticKeys`、`factKeys` 和每个文字框的字符/行数预算，再建立形状操作。
同一事实只在最相关页面完整出现一次；摘要只保留必要结论。

将全部页面划分为 `substantive` 正文页与封面、章节、结束豁免页，并创建
`contentDensityPolicy`。每张正文页同时登记：

- `researchQueries`：1–3 个带主体、地区、期间或指标的具体检索问题；
- `pageResearchSummary`：采用资料、补充范围和仍不可得信息；
- `evidenceIds`：该页实际使用且陈述不同的证据；
- `contentItemSemanticKeys`：至少 6 个真正写入页面的有效内容项；
- `densityStatus: "ready"`；豁免页使用 `"exempt"`；
- 行业、市场、政策、竞争和公开案例页设置
  `externalContextRequired: true`。

标题、页码、装饰短语、同义重复和把一句话拆成多个文本框不计入有效内容项。
模板承载不足时先精简和重构，不得缩小字号或把文字框容量使用率推高到 85%
以上。

### 5. 建立替换白名单

创建 `replacement-manifest.json`。格式和示例见
[references/replacement-manifest.md](references/replacement-manifest.md)。

硬性要求：

- `defaultAction` 必须为 `FAIL_UNCLASSIFIED_CONTENT`；
- `operations` 只列真正需要修改的对象；
- 每项必须包含页码、角色、动作、原因和来源；对象替换使用 `shapeId`，
  完整槽位删除使用 `slotGroupId`；
- 共享图标、背景、页眉、页脚和机构标识必须登记为保护对象，不得进入
  替换白名单；
- `backgroundPolicy.preserveTemplateBackground=true` 且
  `allowBackgroundDeletion=false`；自动识别的每个背景候选都必须在
  `candidateDecisions` 中逐项分类。只有经过显式视觉复核并确认
  `not_background` 的候选才允许删除。
- 可选内容必须按完整槽位组声明，空内容只能用 `delete_slot_group` 删除
  整组，不能单独删除装饰或清空一个文字框后留下空图标；
- `replace_image` 只允许替换公司专属素材，或记录用户对该对象的明确授权。
- `replace_image` 必须声明 `assetSha256`、`imageFitMode` 和
  `aspectRatioValidated=true`。公司 Logo 必须通过
  `bindingId` 绑定 `entityType=company|institution` 和明确的
  `entityRole`；没有目标公司 Logo 时改用规范公司名称文字，不得沿用旧
  Logo 或虚构 Logo。
- `company_logo` 必须设置 `logoTransparencyValidated=true` 与
  `logoSlotPolicy`。透明底模式必须通过实际 PNG Alpha 检查；所有与 Logo
  高重叠的相邻图层都要登记在 `companionObjects`。旧公司底板必须进入
  明确的完整槽位删除操作，模板底板或遮罩必须登记为保护对象。
- `person_photo` 和 `product_screenshot` 必须引用有效 `bindingId`；
- 1.1 及以上文字操作必须设置 `styleLock: "exact"`。
- 1.2 及以上所有操作必须设置 `semanticKey`，并与目标槽位分配完全一致。
- 1.3 及以上版本所有操作必须设置非空 `evidenceIds`；证据必须支持该槽位实际写入
  的事实、数字、图片或删除理由，且操作的 `semanticKey` 必须出现在证据
  声明的 `semanticKeys` 中。
- 重大事实必须有一手来源，或至少两个独立可信发布方；估算值必须在页面
  可见文字或 `displayQualifier` 中标注“估算/测算”。
- `replace_text_group` 必须选择 `fragment-map`、`line-reflow` 或
  `composite-box`；前两者逐形状提供 `fragmentTexts`，后者仅在主形状是
  完整文本槽且容量足够时使用。所有文字操作必须提供 `capacityCheck`。
- 新建 1.6 版任务必须声明 `contentDensityPolicy`、`contentPolicy`、
  `residualPolicy`、`pageClosures`、`objectPolicy` 和 `visualQaPolicy`。
  `forbiddenTextTerms` 至少包含旧公司名、旧产品名、旧项目占位语及
  “未提供公司官网”“缺少原始文件”“现有材料没有BP”“未提供公司资料”；
  `forbiddenMediaSha256` 登记旧 Logo、旧人物和旧产品素材哈希；
  `forbiddenNumericTokens` 登记旧财务、融资、估值、订单、人员和图表数字，
  并设置 `scanEmbeddedData=true`；
  `requiredTextTerms` 至少包含目标项目名。

每个被修改页面都必须先盘点可见内容槽，不得只列“准备替换”的对象。槽位
分为：

- `required + replace`：必须有来源明确的非空内容；
- `optional + replace/delete`：有内容则填充，无内容则删除完整槽位组；
- `shared + keep`：使命、愿景、价值观等共享图标和语义框架；
- `template + keep`：背景、机构标识、页眉、页脚和固定装饰。

`expectedContentShapeIds` 中的每个对象都必须得到内容。不得留下截图红框所示
的空白矩形、空标签、空卡片或只有图标没有文字的区域。

### 6. 校验并生成应用计划

先运行：

```bash
python3 "$SKILL_DIR/scripts/validate_replacement_manifest.py" \
  --manifest "/absolute/build/replacement-manifest.json" \
  --template-map "/absolute/build/template-map.json" \
  --report "/absolute/build/manifest-validation.json"
```

再运行：

```bash
python3 "$SKILL_DIR/scripts/generate_apply_plan.py" \
  --manifest "/absolute/build/replacement-manifest.json" \
  --template-map "/absolute/build/template-map.json" \
  --output "/absolute/build/content-plan.json" \
  --structural-output "/absolute/build/structural-operations.json" \
  --native-output "/absolute/build/native-operations.json"
```

校验器同时生成：

- `slot-usage-report.json`：完整槽位及删除范围；
- `typography-fidelity-report.json`：每个文字框的样式指纹和行数变化；
- `asset-binding-report.json`：人物/产品、图片与文字槽的对应关系；
- `protected-object-report.json`：共享图标与固定对象锁定清单。
- `conversion-handoff-audit.json`：PDF 去水印与元素化交接核验。
- `research-evidence-report.json`：来源、证据、重大数据交叉验证和操作映射。
- `page-closure-report.json`：全部页面对象的保留、替换、删除和未知状态。
- `residual-policy-report.json`：禁止文字、禁止媒体、目标项目必要文字和
  专用缺口页规则。
- `content-safety-report.json`：项目身份、污染指纹、事实库和逐页内容方案。
- `content-density-report.json`：逐页检索问题、有效内容项、证据、网络来源
  和文字容量使用率。

校验失败时不得继续。人物/产品关系未解析、保护对象被修改或槽位组不完整
时属于硬错误。

### 7. 原位替换文字和图片

使用本技能自带的 Python Open XML 原位应用脚本：

```bash
python3 "$SKILL_DIR/scripts/apply_template_plan_openxml.py" \
  --template "/absolute/editable-template.pptx" \
  --plan "/absolute/build/content-plan.json" \
  --output "/absolute/build/content-replaced.pptx" \
  --render-dir "/absolute/build/final-renders"
```

该阶段只允许：

- 原位替换文本内容；
- 中文替换内容的运行语言标记规范化为 `zh-CN`；该操作不得改变字体、字号、
  颜色、段落、坐标、尺寸或层级；
- 原位替换公司专属图片；
- 图片替换必须为目标图片对象创建独立媒体关系，只允许授权图片槽的媒体
  哈希变化；不得覆盖被其他页面或对象共享的原媒体文件。仅当旧媒体在整个
  PPTX 包中已无任何关系引用时，才删除该孤立媒体文件；
- 保持文本框和图片框的坐标、尺寸、裁切、样式和层级。
- 仅当最后一页没有第二个可编辑正文槽位、无法承载强制责任声明时，执行
  一次 `add_disclaimer_textbox`：对象名固定为
  `references.disclaimer.generated`，使用透明背景、无边框、8–18 pt 中文
  字体，并限制在最后一页画布内。除此之外不得新增文本框。

不得在此阶段修改共享语义图标、装饰对象或页面结构。上述责任声明文本框是
唯一受控例外，必须同时进入应用计划、保真报告和最终内容覆盖报告。

### 8. 删除没有内容的完整可选槽位

仅当 `structural-operations.json` 非空时执行，并使用普通替换后的文件作为
输入：

```bash
python3 "$SKILL_DIR/scripts/apply_structural_plan.py" \
  --input "/absolute/build/content-replaced.pptx" \
  --plan "/absolute/build/structural-operations.json" \
  --output "/absolute/build/structural-replaced.pptx" \
  --report "/absolute/build/structural-apply-report.json"
```

该步骤只能删除 `optional=true` 的完整槽位组，并同时删除其内容对象和
专属装饰对象。不得压缩剩余网格、移动相邻卡片或删除共享图标。

### 9. 更新原生图表和表格

仅当 `native-operations.json` 非空时执行。使用 Python `zipfile` + Open XML，
按稳定对象 ID 修改现有图表系列或表格单元格。

尺寸不变的原生表格可使用：

```bash
python3 "$SKILL_DIR/scripts/apply_native_table_plan_openxml.py" \
  --input "/absolute/current-stage.pptx" --input-sha256 "当前输入文件的64位sha256" \
  --plan "/absolute/build/native-operations.json" --output "/absolute/build/table-replaced.pptx" \
  --report "/absolute/build/native-table-apply-report.json"
```

该执行器发现图表操作、行列数变化或对象不匹配时必须停止。原生图表仍没有
可安全通用化的执行器；`native-operations.json` 含图表时必须报告限制，
不得把非空计划当作已经应用。

- 保留图表类型、坐标轴、配色、字体和位置；
- 保留表格列宽、行高、边框、填充和字体；
- 只写入用户资料或 `evidenceRegistry` 已支持的数据；
- 不得用新图表覆盖原图表；
- 原对象无法解析为原生图表或表格时，报告限制，不得猜测重建。
- 饼图、扇形图和其他数据图形必须有来源明确的数据映射；不得保留无标签
  扇区、示例数据、悬空说明或“能力组合示意”与实际数据混用。

### 10. 写入来源备注

将外部来源和重要用户材料写入对应页面的演讲者备注，使用 `[Sources]`
区块，至少包含来源标题、发布方、直接 URL（用户材料写文件与页码）及访问
日期。页面正文保持模板风格，来源不应以不可编辑图片覆盖页面内容。

同时保留 `research-evidence-report.json` 作为机器可读审计记录。备注与
证据登记表中的来源必须一致，不得在交付阶段临时添加未登记来源。

### 11. 处理文本适配

文字放不下时依次：

1. 精简重复表达；
2. 调整人工换行；
3. 保持模板字体、字号、颜色、段落、坐标、尺寸和层级不变；
4. 仍无法容纳时报告内容冲突，不得自动缩小字号。

严格模式不得移动文本框、改变固定元素、自动扩页或重新排版。

### 12. 最终验收

在执行完整槽位删除前，使用同一份 `content-plan.json` 验证普通替换阶段：

```bash
python3 "$SKILL_DIR/scripts/validate_template_result_openxml.py" \
  --template "/absolute/editable-template.pptx" \
  --result "/absolute/final.pptx" \
  --plan "/absolute/build/content-plan.json" \
  --output "/absolute/build/fidelity-report.json"
```

最终文件随后必须：

1. 使用 LibreOffice `--headless` + pdftoppm 渲染模板和结果的全部页面为 PNG；
2. 对授权替换区域之外进行视觉差异检查；
   纯终端服务器必须实际审阅逐页 PNG；只生成渲染图但未读取，不算完成。
3. 将最终删除对象与 `structural-apply-report.json` 逐项核对；
4. 将人物/产品页与 `asset-binding-report.json` 逐项核对；
5. 检查旧公司名称、Logo、数据和案例残留；
6. 检查文字溢出、字号变化、图片裁切、重叠、空图标和装饰残影；
7. 运行 `slides_test.py`；
8. 在 Microsoft PowerPoint 中打开并导出验证 PDF；不可用时说明替代验证。
9. 抽查所有联网补全内容与 `research-evidence-report.json`、页面来源备注
   一致；重大数据满足一手来源或双来源要求。
10. 检查 `content-density-report.json`，确认全部正文页达到有效内容、
    证据、逐页检索和外部来源门槛，且没有用同义重复或无关数据凑数。
11. 检查估算、冲突和无法证实内容是否使用了可见限定词，且没有把推断写成
    已验证事实。
12. 核对全部页面 `pageClosures`，确保全部模板对象均已复核且未知对象为零。
13. 检查 `background-lock-report.json`，确认模板背景候选均为保留且未进入
    删除操作；对比模板与成品逐页渲染，确认非授权区域的底色、纹理、边栏、
    页眉页脚和品牌框架未变化。
14. 检查 `logo-transparency-report.json` 和每个 Logo 的全尺寸裁剪图，确认
    PNG 透明边界通过、旧公司底板已处理、模板底板未误删，且没有矩形色块。

必须再次渲染最终 PPTX，并使用 PDF 转换技能的水印验收脚本：

```bash
python3 "/absolute/pdf-to-editable-ppt/scripts/validate_watermark_handoff.py" \
  --pptx "/absolute/final.pptx" \
  --render-dir "/absolute/build/final-renders" \
  --watermark-report "/absolute/pdf-build/watermark-report.json" \
  --output "/absolute/build/final-watermark-qa.json" \
  --mode strict
```

Tesseract 不在 `PATH` 时必须同时传入 `--tesseract`；Linux 需要
`chi_sim` 与 `eng` 两个语言包。服务器没有 Microsoft PowerPoint 时，使用
LibreOffice `--headless` PDF 导出 + pdftoppm 逐页渲染，然后对渲染结果
执行 OCR 验收；在交付中明确披露"未经过 Microsoft PowerPoint 原生验证"。

再分析最终 PPTX，生成 `final-template-map.json`，并运行：

```bash
python3 "$SKILL_DIR/scripts/validate_residual_content.py" \
  --manifest "/absolute/build/replacement-manifest.json" \
  --pptx "/absolute/final.pptx" \
  --result-map "/absolute/build/final-template-map.json" \
  --render-dir "/absolute/build/final-renders" \
  --output "/absolute/build/final-residual-qa-report.json"
```

该步骤同时扫描可编辑文字、演讲者备注、旧数字、图表缓存、嵌入工作簿、
媒体哈希和逐页渲染 OCR。任何旧项目内容仍存在时必须失败。

逐页审阅渲染图后运行：

```bash
python3 "$SKILL_DIR/scripts/validate_visual_qa_report.py" \
  --template-map "/absolute/build/final-template-map.json" --pptx "/absolute/final.pptx" \
  --render-dir "/absolute/build/final-renders" \
  --review "/absolute/build/visual-review.json" \
  --output "/absolute/build/final-visual-qa-report.json"
```

再运行：

```bash
python3 "$SKILL_DIR/scripts/validate_final_content.py" \
  --manifest "/absolute/build/replacement-manifest.json" \
  --template-map "/absolute/build/template-map.json" \
  --result-map "/absolute/build/final-template-map.json" \
  --watermark-qa-report "/absolute/build/final-watermark-qa.json" \
  --residual-qa-report "/absolute/build/final-residual-qa-report.json" \
  --visual-qa-report "/absolute/build/final-visual-qa-report.json" \
  --output "/absolute/build/final-content-coverage-report.json"
```

任一必填槽位为空、可选槽位没有完整删除、共享槽位被修改、水印复检失败或
语义键错配、页面闭环未完成、模板背景丢失、Logo 出现未授权底色、最终残留
扫描失败，都不得交付。

商业秘密任务使用受限账号、`umask 077` 和独立目录，并按保留策略清理。

## 成功标准

- 页面数量和尺寸不变；
- PDF 转换交接证书和最终水印复检均通过；
- 所有未授权对象的类型、位置、尺寸、内容和媒体保持不变；
- 共享语义图标继续保留，不因内容替换而被重建；
- 母版、版式背景及确认的幻灯片背景对象保持原样，背景候选没有被通用旧内容
  清理逻辑删除；
- 资料不足的可选槽位按完整组删除，没有空月桂、空边框或孤立图标；
- 字体、字号、文字框坐标、尺寸、颜色和层级与模板保持一致；仅当末页缺少
  责任声明正文槽位时，允许新增一个经过白名单授权的可编辑责任声明文本框；
- 白名单中文替换目标使用 `zh-CN` 运行语言标记，模板受保护对象的原始语言
  元数据保持不变；
- 项目身份已锁定；全部文字和数据只引用唯一事实库，数值的单位、期间与口径
  在各页一致；
- 所有联网补全内容都有可访问的原始来源、访问日期和操作级证据绑定；
- 每张正文页都有独立检索问题、逐页研究摘要、至少 6 个有效内容项和至少
  2 条不同证据；外部环境页至少有 1 个网络原文来源；
- 重大数据有一手来源或至少两个独立可信发布方，计算值有公式，估算值有
  可见限定；
- 人物照片与姓名、职务一致，产品图片与产品名、型号一致；
- 公司专属素材只在已绑定的原槽位中替换；
- 公司 Logo 使用透明底素材且无旧 Logo 底板残留；保留底板时有明确的模板
  视觉理由；
- 不包含旧项目专属文字、Logo、人物、产品、案例和数据，也不包含编造内容；
- 非必要字段缺失时不显示后台占位语；重大资料缺口只出现在专用缺口页；
- 全部页面对象均已完成页面闭环复核，`unknownShapeIds` 为零；
- 最终文字、旧数字、图表/工作簿数据、媒体哈希和渲染 OCR 残留扫描全部通过；
- 每页容量预算和逐页视觉 QA 通过，单框容量使用率不超过 85%，无溢出、
  重叠、错误裁切、空槽或重复套话；
- 所有必填内容槽均非空，所有可选空槽均完整删除；
- PPTX 可正常打开、编辑和导出。

## 交付说明

只交付最终 PPTX，并简述：

- 替换了哪些文字、数据和公司专属素材；
- 删除了哪些完整可选槽位；
- 哪些共享图标和模板元素保持不变；
- 人物/产品素材绑定核对结果；
- 哪些照片或截图仍是栅格图片；
- 哪些信息因资料不足标记为待补充。
- 联网补全了哪些信息、使用了哪些来源类型、哪些重大数据完成交叉验证；
- 哪些信息仍无法证实、存在来源冲突或仅能作为估算。
