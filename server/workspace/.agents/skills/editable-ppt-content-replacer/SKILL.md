---
name: editable-ppt-content-replacer
description: 基于已经完成1:1复原的可编辑PPTX模板生成当前项目投资建议书或同模板新报告；先验证 PDF 转换交接，再按语义槽位白名单最小化替换文字、数据、Logo、人物和产品素材。用户资料不足时只针对内容缺口联网检索，并通过来源登记、重大数据交叉验证、估算披露和操作级证据绑定阻止凭空捏造。通过完整槽位覆盖、semanticKey、排版指纹和实体绑定阻止空白内容框、错填数据、人物产品错配、模板样本残留与水印残留，同时锁定共享图标和版式。适用于投资建议书 PPT、PDF 模板元素化后的内容替换，以及用户强调“只换内容、不重新设计、不批量替换全部元素”的 PowerPoint 任务。
---

# 可编辑模板 PPT 内容定向替换

将 `pdf-to-editable-ppt` 的输出视为已经验收的锁定模板。只修改白名单中的
内容对象，不重新转换 PDF，不重新元素化模板，不替换共享图标或固定装饰。
资料不足时只能删除预先声明的完整可选槽位组，不能留下空图标、空边框或
半个卡片。

只交付一个最终 PPTX，核心内容必须保持为原生可编辑对象；不得再生成第二份
纯图片 PPTX，也不得用整页背景图覆盖模板后冒充可编辑结果。

新任务使用 1.3 版替换清单。1.3 版继承 PDF 转换交接和完整槽位覆盖约束，
并要求每项替换绑定证据。用户资料不完整时，先生成资料缺口清单，再按来源
优先级联网检索；无法证实的内容必须明确标注或删除完整可选槽位。

## 必须遵循

- 遵循演示文稿模板跟随和原位编辑规范。
- 正式投资建议书任务同时遵循
  [references/output-contract.md](references/output-contract.md)。
- 输入模板必须是已经可编辑的 `.pptx`；若只有 PDF，先使用
  `pdf-to-editable-ppt`，完成并验收 1:1 可编辑底稿后再运行本流程。
- PDF 转换模板必须提供 `conversion-handoff.json`，且其中
  `watermarkQaPassed`、`editabilityReviewPassed` 和
  `readyForContentReplacement` 均为 `true`。不得跳过交接门槛。
- 生产运行时使用 Python 标准库读取和原位修改 PPTX OpenXML，只重写白名单
  文字所在的 slide XML 与来源备注；禁止依赖 Codex Desktop 私有包或使用
  `python-pptx` 重建模板。
- 默认所有对象均为 `KEEP`。只有清单明确授权的对象才能修改。
- 共享语义图标（例如使命、愿景、价值观图标）必须登记为保护对象并复用，
  不因文字内容变化而替换。
- 人物和产品图片必须先建立实体绑定，再与姓名、职务、产品名或型号一起
  原位替换；不得按素材顺序、文件名顺序或图片尺寸循环分配。
- 不得清空全部文字、删除全部图片、按尺寸批量替换图片、循环分配素材、
  重建已经可编辑的图标，或重新设计页面。
- 用户资料不足时允许联网补全公开事实，但每项外部事实必须进入
  `sources` 和 `evidenceRegistry`，并由操作的 `evidenceIds` 引用。
- 搜索结果页和搜索摘要只用于发现来源，不能作为证据。优先使用公司官网、
  监管披露、政府、学术或标准机构的一手材料。
- 不得发明客户、合同、订单、认证、财务、融资、估值、市场份额、专利、
  员工数或其他未被证据支持的信息，也不得把推断写成已验证事实。
- 缺少对应内容且网络检索仍无法证实时，必填槽位使用“未披露”“待核实”
  或“公开信息未检索到”；可选槽位删除 `optional=true` 的完整槽位组。
  不得沿用模板项目的专属数据。

## 输入契约

必须获得：

1. 已经 1:1 复原的可编辑模板 PPTX；
2. 用户需求和目标公司/项目资料；
3. 可使用的 Logo、人物、产品、案例和数据素材；
4. 用户明确要求替换的范围。
5. PDF 转换任务生成的 `conversion-handoff.json`；原生 PPTX 模板除外。

模板 PPTX 是后续结构与视觉的唯一基准。不要再次读取原 PDF 来重建页面，
除非仅用于最终视觉对照。

## 无头与跨平台准备

Linux 或纯终端环境先运行：

```bash
python3 "$SKILL_DIR/scripts/check_environment.py" --json
```

检查器会验证本技能和 `pdf-to-editable-ppt` 的必要脚本，并复用 PDF 技能的
PptxGenJS 生成、LibreOffice/Poppler 无头渲染、Tesseract 语言和字体检查。
技能不在同一父目录时设置 `PDF_TO_EDITABLE_PPT_SKILL_DIR`。
`readyForDefaultWorkflow` 不为 `true` 时不得进入严格全流程。

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

1.3 版清单设置：

```json
{
  "schemaVersion": "1.3",
  "sourceMode": "pdf-converted",
  "conversionHandoff": "/absolute/work/conversion-handoff.json"
}
```

原生可编辑 PPTX 设置 `sourceMode: "native-pptx"`，不需要转换证书。

### 2. 建立对象地图

使用本技能自带的 OpenXML 模板分析脚本：

```bash
python3 "$SKILL_DIR/scripts/analyze_template_openxml.py" \
  --input "/absolute/editable-template.pptx" \
  --output "/absolute/build/template-map.json"
```

分析器必须读取原 PPTX 的稳定对象 ID、文字、坐标、样式、媒体引用和版式关系；
不得只从字体、颜色或截图推断模板。

逐页检查渲染图与对象地图。按
[references/object-classification.md](references/object-classification.md)
将对象区分为固定视觉、通用语义、内容槽、公司专属素材和数据槽。

同时建立四类结构化关系：

1. `protectedObjects`：共享图标、模板品牌、固定视觉和通用装饰；
2. `slotGroups`：内容对象与其配套图标、月桂、边框、标签等完整槽位；
3. `entityBindings`：人物/产品图片与姓名、职务、产品名、型号的对应关系。
4. `slotAssignments`：每个内容区域的语义、必填性和最终处置。

### 3. 识别资料缺口并联网补全

先比较 `slotAssignments` 与用户材料，只对缺少内容的槽位建立检索任务。
不得用网络内容覆盖用户已经提供且没有冲突的资料。联网补全时必须读取
[references/evidence-and-web-research.md](references/evidence-and-web-research.md)，
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

### 4. 建立替换白名单

创建 `replacement-manifest.json`。格式和示例见
[references/replacement-manifest.md](references/replacement-manifest.md)。

硬性要求：

- `defaultAction` 必须为 `KEEP`；
- `operations` 只列真正需要修改的对象；
- 每项必须包含页码、角色、动作、原因和来源；对象替换使用 `shapeId`，
  完整槽位删除使用 `slotGroupId`；
- 共享图标、背景、页眉、页脚和机构标识必须登记为保护对象，不得进入
  替换白名单；
- 可选内容必须按完整槽位组声明，空内容只能用 `delete_slot_group` 删除
  整组，不能单独删除装饰或清空一个文字框后留下空图标；
- `replace_image` 只允许替换公司专属素材，或记录用户对该对象的明确授权。
- `person_photo` 和 `product_screenshot` 必须引用有效 `bindingId`；
- 1.1 及以上文字操作必须设置 `styleLock: "exact"`。
- 1.2 及以上所有操作必须设置 `semanticKey`，并与目标槽位分配完全一致。
- 1.3 版所有操作必须设置非空 `evidenceIds`；证据必须支持该槽位实际写入
  的事实、数字、图片或删除理由，且操作的 `semanticKey` 必须出现在证据
  声明的 `semanticKeys` 中。
- 重大事实必须有一手来源，或至少两个独立可信发布方；估算值必须在页面
  可见文字或 `displayQualifier` 中标注“估算/测算”。

每个被修改页面都必须先盘点可见内容槽，不得只列“准备替换”的对象。槽位
分为：

- `required + replace`：必须有来源明确的非空内容；
- `optional + replace/delete`：有内容则填充，无内容则删除完整槽位组；
- `shared + keep`：使命、愿景、价值观等共享图标和语义框架；
- `template + keep`：背景、机构标识、页眉、页脚和固定装饰。

`expectedContentShapeIds` 中的每个对象都必须得到内容。不得留下截图红框所示
的空白矩形、空标签、空卡片或只有图标没有文字的区域。

### 5. 校验并生成应用计划

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

校验失败时不得继续。人物/产品关系未解析、保护对象被修改或槽位组不完整
时属于硬错误。

### 6. 原位替换文字和图片

使用本技能自带的 OpenXML 原位应用脚本：

```bash
python3 "$SKILL_DIR/scripts/apply_template_plan_openxml.py" \
  --template "/absolute/editable-template.pptx" \
  --plan "/absolute/build/content-plan.json" \
  --output "/absolute/build/content-replaced.pptx" \
  --render-dir "/absolute/build/final-renders" \
  --libreoffice "/usr/bin/libreoffice" \
  --pdftoppm "/usr/bin/pdftoppm"
```

如果生成脚本提示普通应用计划为空，则跳过本步骤，直接从锁定模板执行原生
图表或表格数据更新。

该阶段只允许：

- 原位替换文本内容；
- 原位替换公司专属图片；
- 保持文本框和图片框的坐标、尺寸、裁切、样式和层级。

不得在此阶段修改共享语义图标、装饰对象或页面结构。

### 7. 删除没有内容的完整可选槽位

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

### 8. 更新原生图表和表格

仅当 `native-operations.json` 非空时执行，并使用经过专项验证的公开运行时
按稳定对象 ID 修改现有图表系列或表格单元格。

本技能当前没有可安全通用化的原生图表/表格批量执行器。终端任务必须为这些
操作生成逐项执行报告并重新 inspect 目标对象；如果没有对应执行代码或无法
按稳定对象 ID 定位，必须停止并报告限制，不得把非空
`native-operations.json` 当作已经应用。

- 保留图表类型、坐标轴、配色、字体和位置；
- 保留表格列宽、行高、边框、填充和字体；
- 只写入用户资料或 `evidenceRegistry` 已支持的数据；
- 不得用新图表覆盖原图表；
- 原对象无法解析为原生图表或表格时，报告限制，不得猜测重建。
- 饼图、扇形图和其他数据图形必须有来源明确的数据映射；不得保留无标签
  扇区、示例数据、悬空说明或“能力组合示意”与实际数据混用。

### 9. 写入来源备注

将外部来源和重要用户材料写入对应页面的演讲者备注，使用 `[Sources]`
区块，至少包含来源标题、发布方、直接 URL（用户材料写文件与页码）及访问
日期。页面正文保持模板风格，来源不应以不可编辑图片覆盖页面内容。

同时保留 `research-evidence-report.json` 作为机器可读审计记录。备注与
证据登记表中的来源必须一致，不得在交付阶段临时添加未登记来源。

### 10. 处理文本适配

文字放不下时依次：

1. 精简重复表达；
2. 调整人工换行；
3. 保持模板字体、字号、颜色、段落、坐标、尺寸和层级不变；
4. 仍无法容纳时报告内容冲突，不得自动缩小字号。

严格模式不得移动文本框、改变固定元素、自动扩页或重新排版。

### 11. 最终验收

在执行完整槽位删除前，使用同一份 `content-plan.json` 验证普通替换阶段：

```bash
python3 "$SKILL_DIR/scripts/validate_template_result_openxml.py" \
  --template "/absolute/editable-template.pptx" \
  --result "/absolute/final.pptx" \
  --plan "/absolute/build/content-plan.json" \
  --output "/absolute/build/fidelity-report.json"
```

最终文件随后必须：

1. 渲染模板和结果的全部页面；
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
10. 检查估算、冲突和无法证实内容是否使用了可见限定词，且没有把推断写成
    已验证事实。

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
`chi_sim` 与 `eng` 两个语言包。服务器没有 Microsoft PowerPoint 时，执行
LibreOffice `--headless` 与 Poppler 逐页渲染检查，并在交付中
明确披露替代验证。

再分析最终 PPTX，生成 `final-template-map.json`，并运行：

```bash
python3 "$SKILL_DIR/scripts/validate_final_content.py" \
  --manifest "/absolute/build/replacement-manifest.json" \
  --template-map "/absolute/build/template-map.json" \
  --result-map "/absolute/build/final-template-map.json" \
  --watermark-qa-report "/absolute/build/final-watermark-qa.json" \
  --output "/absolute/build/final-content-coverage-report.json"
```

任一必填槽位为空、可选槽位没有完整删除、共享槽位被修改、水印复检失败或
语义键错配，都不得交付。

服务器处理包含商业秘密的模板时使用非 root 账号、`umask 077`、独立工作
目录和 CPU/内存/磁盘/超时限制。任务目录包含图片、OCR、证据登记和来源备注，
不得留在公共临时目录；完成后按数据保留策略清理。

## 成功标准

- 页面数量和尺寸不变；
- PDF 转换交接证书和最终水印复检均通过；
- 所有未授权对象的类型、位置、尺寸、内容和媒体保持不变；
- 共享语义图标继续保留，不因内容替换而被重建；
- 资料不足的可选槽位按完整组删除，没有空月桂、空边框或孤立图标；
- 字体、字号、文字框坐标、尺寸、颜色和层级与模板保持一致；
- 文字和明确数据与用户资料对应；
- 所有联网补全内容都有可访问的原始来源、访问日期和操作级证据绑定；
- 重大数据有一手来源或至少两个独立可信发布方，计算值有公式，估算值有
  可见限定；
- 人物照片与姓名、职务一致，产品图片与产品名、型号一致；
- 公司专属素材只在已绑定的原槽位中替换；
- 不包含旧项目专属数据，也不包含编造内容；
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
