# 替换白名单格式

## 顶层结构

新任务使用 1.4 版。旧版清单仍可校验，但 1.4 版才同时具备操作级证据、
页面闭环、缺失内容处置和最终旧项目文字/媒体/OCR 残留门禁。

```json
{
  "schemaVersion": "1.4",
  "sourceMode": "pdf-converted",
  "conversionHandoff": "/absolute/work/conversion-handoff.json",
  "templatePptx": "/absolute/editable-template.pptx",
  "templateSha256": "64位sha256",
  "projectName": "目标公司或项目",
  "defaultAction": "KEEP",
  "researchPolicy": {
    "enabled": true,
    "asOfDate": "2026-07-29",
    "minimumIndependentSources": 2,
    "unresolvedPolicy": "mark-not-disclosed-or-delete-optional"
  },
  "sources": [],
  "evidenceRegistry": [],
  "protectedObjects": [],
  "slotGroups": [],
  "entityBindings": [],
  "slotAssignments": [],
  "contentPolicy": {
    "optionalMissingAction": "delete-slot-group",
    "requiredMissingAction": "dedicated-gap-slide-only",
    "unavailableWebsiteAction": "omit-slot",
    "forbidOperationalPlaceholders": true
  },
  "residualPolicy": {
    "forbiddenTextTerms": [
      "旧项目公司名",
      "未提供公司官网",
      "缺少原始文件",
      "现有材料没有BP",
      "未提供公司资料"
    ],
    "forbiddenMediaSha256": [],
    "requiredTextTerms": ["目标公司或项目"],
    "gapOnlyTextTerms": ["未披露", "待核实", "公开信息未检索到", "口径不一致"],
    "gapSlideNumbers": [27],
    "ocrRequired": true
  },
  "pageClosures": [],
  "operations": []
}
```

未出现在 `operations` 中的对象全部保持不变。

PDF 转换模板必须使用 `sourceMode: "pdf-converted"` 并提供
`conversionHandoff`。原生 PPTX 使用 `sourceMode: "native-pptx"`。

## 来源与证据登记

先登记用户材料和网络原文，再登记最小可验证陈述：

```json
{
  "sources": [
    {
      "sourceId": "src-user-company-profile",
      "sourceType": "user_material",
      "title": "目标公司介绍材料",
      "publisher": "目标公司",
      "accessedDate": "2026-07-29",
      "locator": "company-profile.pdf，第3页"
    },
    {
      "sourceId": "src-official-product",
      "sourceType": "company_official",
      "title": "产品介绍",
      "publisher": "目标公司",
      "url": "https://example.com/product",
      "publishedDate": "2026-06-01",
      "accessedDate": "2026-07-29"
    }
  ],
  "evidenceRegistry": [
    {
      "evidenceId": "ev-company-name",
      "claim": "目标公司的法定或正式使用名称",
      "valueType": "user-provided",
      "materiality": "basic",
      "status": "verified",
      "semanticKeys": ["cover.project_name"],
      "sourceIds": ["src-user-company-profile"],
      "confidence": "high",
      "asOfDate": "2026-07-29"
    },
    {
      "evidenceId": "ev-product-feature",
      "claim": "产品具备官网披露的某项能力",
      "valueType": "official-fact",
      "materiality": "material",
      "status": "verified",
      "semanticKeys": ["product.primary.feature"],
      "sourceIds": ["src-official-product"],
      "confidence": "high",
      "asOfDate": "2026-07-29"
    }
  ]
}
```

每项操作必须使用 `evidenceIds` 引用证据。详细来源优先级、重大数据定义、
交叉验证、估算和冲突处理见
[evidence-and-web-research.md](evidence-and-web-research.md)。

## 槽位分配与语义键

每个被修改页面的内容区域都必须进入 `slotAssignments`。例如：

```json
{
  "assignmentId": "slide-03-mission",
  "slide": 3,
  "slotGroupId": "mission-card",
  "semanticKey": "company.mission",
  "semanticRole": "企业使命",
  "requirement": "required",
  "disposition": "replace",
  "shapeIds": [21, 22, 23],
  "expectedContentShapeIds": [22, 23],
  "sourceNote": "公司正式介绍材料"
}
```

所有实际替换操作都必须包含相同的 `semanticKey`。必填槽位不得为空；可选
槽位没有内容时必须使用 `disposition: "delete"` 并删除完整槽位组；共享
图标和固定模板使用 `keep`。

## 缺失内容与最终残留策略

- 官网、地址、社交账号等非必要信息缺失时，删除或省略整个字段，不显示
  “未提供公司官网”。
- 财务、客户、订单、资质等重大缺口只允许出现在
  `gapSlideNumbers` 指定的专用缺口页。
- `forbiddenTextTerms` 同时登记固定后台提示和本次模板的旧公司名、旧产品名、
  旧案例名。
- `forbiddenMediaSha256` 登记旧 Logo、旧人物、旧产品及旧项目宣传素材哈希。
- `requiredTextTerms` 至少包含 `projectName`。

最终验收必须同时扫描可编辑文字、PPTX 媒体哈希和逐页渲染 OCR。

## 修改页闭环

每个修改页都要完整列出模板对象：

```json
{
  "slide": 5,
  "reviewedShapeIds": [2, 3, 4, 5, 6],
  "allowedKeepShapeIds": [2, 3],
  "targetShapeIds": [4, 5, 6],
  "unknownShapeIds": []
}
```

`reviewedShapeIds` 必须与对象地图中的整页对象完全一致；
`targetShapeIds` 必须与该页实际操作目标完全一致；其余对象只有在逐页确认
属于固定模板、投资机构品牌或有证据的上下文后，才可进入
`allowedKeepShapeIds`。`unknownShapeIds` 非空时必须失败。

## 保护共享图标

使命、愿景、价值观等通用语义图标可直接复用，不需要替换。先将它们登记
为保护对象：

```json
{
  "slide": 3,
  "shapeId": 21,
  "classification": "shared_semantic_icon",
  "reason": "企业使命的通用语义图标，目标公司继续复用"
}
```

保护对象不得出现在任何 `operations` 或可删除槽位组中。

## 文字替换与排版锁定

```json
{
  "slide": 1,
  "shapeId": 3,
  "semanticKey": "cover.project_name",
  "evidenceIds": ["ev-company-name"],
  "role": "封面项目名称",
  "action": "replace_text",
  "text": "目标公司投资建议书",
  "reason": "替换模板项目名称",
  "sourceNote": "用户提供的公司名称",
  "fitPolicy": "preserve",
  "styleLock": "exact"
}
```

`styleLock: "exact"` 表示字体、字号、字重、颜色、文字框坐标、尺寸和层级
均继承模板，不得在应用计划中覆盖。新文字需要不同换行时，可显式设置：

```json
"allowLineCountChange": true
```

该字段只记录已人工确认换行变化，不授权修改字体、字号或文字框。

PDF 元素化后一句话被拆成多个文字对象时，使用：

```json
{
  "slide": 4,
  "shapeIds": [18, 19, 20],
  "primaryShapeId": 18,
  "semanticKey": "company.summary",
  "evidenceIds": ["ev-company-summary"],
  "role": "公司简介碎片组",
  "action": "replace_text_group",
  "text": "目标公司的完整简介。",
  "styleLock": "exact",
  "reason": "合并替换 PDF 文字碎片",
  "sourceNote": "公司正式介绍材料",
  "fitPolicy": "preserve"
}
```

执行器只把完整文字写入 `primaryShapeId`，并清空其余碎片对象。不得将完整
文字复制到组内每一个对象。

清空普通旧文字时，必须显式设置：

```json
{
  "slide": 4,
  "shapeId": 18,
  "semanticKey": "project.legacy_note",
  "evidenceIds": ["ev-legacy-note-unavailable"],
  "role": "旧项目专属说明",
  "action": "replace_text",
  "text": "",
  "allowEmpty": true,
  "styleLock": "exact",
  "reason": "目标资料没有对应内容，清除旧项目专属信息",
  "sourceNote": "用户材料未披露",
  "fitPolicy": "preserve"
}
```

如果该文字属于可选卡片、荣誉或产品槽位，不要只清空文字，应删除完整槽位。

## 末页责任声明受控例外

最后一页只有标题槽位、没有第二个可编辑正文槽位时，允许新增一次责任声明
文本框。不得把该动作应用到其他页面或其他正文内容：

```json
{
  "slide": 34,
  "shapeId": 12,
  "semanticKey": "slide.34.generated.disclaimer",
  "evidenceIds": ["ev-slide-34"],
  "role": "责任声明",
  "action": "add_disclaimer_textbox",
  "text": "本演示文稿仅供内部讨论，不构成最终投资决策。",
  "name": "references.disclaimer.generated",
  "bbox": [102, 446, 1075, 158],
  "fontSize": 12,
  "fontFace": "Noto Sans CJK SC",
  "fontColor": "4B5563",
  "styleLock": "controlled-disclaimer",
  "reason": "末页没有责任声明正文槽位",
  "sourceNote": "系统固定责任声明",
  "fitPolicy": "preserve"
}
```

`shapeId` 必须是该页未占用的新编号，`bbox` 使用页面像素坐标且不得超出
画布。对象名必须固定为 `references.disclaimer.generated`，透明背景、无
边框、字号限制在 8–18 pt；每份 PPTX 最多新增一个。若末页已有正文槽位，
必须继续使用 `replace_text` 原位写入，不得新增。

## 可选槽位与整组删除

先声明完整槽位。下面的例子包含荣誉文字和左右月桂：

```json
{
  "slotGroupId": "award-slot-07",
  "evidenceIds": ["ev-award-07-unavailable"],
  "semanticKey": "company.award.07",
  "slide": 5,
  "groupType": "award_slot",
  "optional": true,
  "shapeIds": [61, 62, 63],
  "contentShapeIds": [62],
  "decorationShapeIds": [61, 63],
  "layoutPolicy": "preserve-grid"
}
```

目标资料没有第七项荣誉时，使用：

```json
{
  "slide": 5,
  "slotGroupId": "award-slot-07",
  "role": "第七项荣誉完整槽位",
  "action": "delete_slot_group",
  "missingContent": true,
  "reason": "目标公司只提供六项荣誉，删除多余空槽位",
  "sourceNote": "用户荣誉清单",
  "fitPolicy": "preserve"
}
```

删除操作必须同时移除内容对象和该槽位专属装饰，不移动剩余网格，也不允许
包含共享图标或固定模板对象。

## 人物图片与姓名、职务绑定

先声明实体绑定：

```json
{
  "bindingId": "team-card-zhang-san",
  "entityId": "person-zhang-san",
  "entityType": "person",
  "displayName": "张三",
  "asset": "/absolute/team/zhang-san.jpg",
  "sourceNote": "管理层提供的团队资料",
  "slide": 8,
  "slotGroupId": "team-card-01",
  "imageShapeId": 42,
  "labelBindings": [
    {
      "shapeId": 43,
      "labelType": "name",
      "expectedText": "张三"
    },
    {
      "shapeId": 44,
      "labelType": "title",
      "expectedText": "创始人兼首席执行官"
    }
  ]
}
```

再分别创建图片和文字操作，所有槽位必须与绑定一致：

```json
{
  "slide": 8,
  "shapeId": 42,
  "bindingId": "team-card-zhang-san",
  "semanticKey": "team.zhang-san",
  "evidenceIds": ["ev-team-zhang-san"],
  "role": "张三人物照片",
  "action": "replace_image",
  "asset": "/absolute/team/zhang-san.jpg",
  "assetSha256": "图片文件的64位sha256",
  "assetClass": "person_photo",
  "companySpecific": true,
  "reason": "替换旧项目管理层照片",
  "sourceNote": "管理层提供的团队资料",
  "fitPolicy": "preserve"
}
```

```json
{
  "slide": 8,
  "shapeId": 43,
  "semanticKey": "team.zhang-san",
  "evidenceIds": ["ev-team-zhang-san"],
  "role": "人物姓名",
  "action": "replace_text",
  "text": "张三",
  "styleLock": "exact",
  "reason": "与人物照片绑定",
  "sourceNote": "管理层提供的团队资料",
  "fitPolicy": "preserve"
}
```

```json
{
  "slide": 8,
  "shapeId": 44,
  "semanticKey": "team.zhang-san",
  "evidenceIds": ["ev-team-zhang-san-title"],
  "role": "人物职务",
  "action": "replace_text",
  "text": "创始人兼首席执行官",
  "styleLock": "exact",
  "reason": "与人物照片绑定",
  "sourceNote": "管理层提供的团队资料",
  "fitPolicy": "preserve"
}
```

校验器会阻止以下情况：

- 张三照片对应“李四”姓名；
- 同一张照片绑定给两个不同人物；
- 图片操作与实体绑定使用不同文件；
- 人物或产品图片没有 `bindingId`；
- 图片、姓名、职务不在同一页或声明的卡片槽位中。

产品使用相同机制，`entityType` 为 `product`，图片
`assetClass` 为 `product_screenshot`，并至少绑定
`product_name`；有型号时增加 `product_model`。

## 公司与机构 Logo 绑定

目标公司 Logo 使用 `entityType: "company"` 和
`entityRole: "target_company"`；投资机构 Logo 使用
`entityType: "institution"` 和 `entityRole: "investment_institution"`。
Logo 绑定至少包含一个 `company_name` 标签。被确认属于投资机构固定品牌的
Logo 应登记为 `protectedObjects/template_brand`，不要创建替换操作。

如果目标公司没有提供 Logo，且官方来源也无法取得，不得沿用旧 Logo 或生成
虚构 Logo；删除可选 Logo 槽位，或在原文字槽写入规范公司名称。

## 其他图片替换

```json
{
  "slide": 7,
  "shapeId": 42,
  "semanticKey": "company.visual.primary",
  "evidenceIds": ["ev-company-visual-primary"],
  "role": "旧公司产品以外的公司专属视觉",
  "action": "replace_image",
  "asset": "/absolute/target-visual.png",
  "assetSha256": "图片文件的64位sha256",
  "assetClass": "company_specific_visual",
  "companySpecific": true,
  "reason": "替换旧公司专属素材",
  "sourceNote": "目标公司正式材料",
  "fitPolicy": "preserve"
}
```

`assetClass` 可使用：

- `company_logo`
- `person_photo`
- `product_screenshot`
- `customer_evidence`
- `company_specific_visual`
- `user_approved_visual`

如果不是公司专属素材，必须设置 `explicitUserApproval: true`。模板分析器把
某些小图片判断为候选图标时，还必须设置
`allowIconSlotReplacement: true`；共享语义图标即使授权也应保持不变。

## 原生图表和表格数据

图表：

```json
{
  "slide": 12,
  "shapeId": 8,
  "semanticKey": "experiment.result_chart",
  "evidenceIds": ["ev-experiment-result"],
  "role": "实验结果图表",
  "action": "replace_chart_data",
  "categories": ["任务组合", "正向信号", "待突破"],
  "series": [
    {"name": "任务数", "values": [40, 28, 12]}
  ],
  "reason": "更新为目标项目实验数据",
  "sourceNote": "内部材料第12页",
  "fitPolicy": "preserve"
}
```

表格：

```json
{
  "slide": 19,
  "shapeId": 10,
  "semanticKey": "commercial.pipeline_table",
  "evidenceIds": ["ev-commercial-pipeline"],
  "role": "商业线索表",
  "action": "replace_table_data",
  "values": [
    ["项目", "金额", "阶段"],
    ["客户A", "600万元", "在谈"]
  ],
  "reason": "更新目标项目商业线索",
  "sourceNote": "管理层材料，需尽调核验",
  "fitPolicy": "preserve"
}
```

图表和表格操作不会进入普通 `content-plan.json`，而会写入
`native-operations.json`，后续使用 Python `zipfile` + Open XML 对
原生对象定向修改。

## 禁止行为

- 不得通过清单列出全部图片并循环分配素材。
- 不得把共享图标标记为公司专属图片。
- 不得单独删除空槽位中的一个图标、月桂、边框或文字。
- 不得只按人物/产品素材的文件名或顺序推断对应关系。
- 不得把整个页面截图作为内容替换结果。
- 不得在 `reason` 或 `sourceNote` 中使用模糊表述规避来源检查。
- 不得修改对象坐标、尺寸、层级、字体、字号或样式。
