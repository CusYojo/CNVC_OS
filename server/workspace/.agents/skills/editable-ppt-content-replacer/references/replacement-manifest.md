# 替换白名单格式

## 顶层结构

新任务使用 1.3 版。1.0/1.1/1.2 版清单仍可校验，但 1.3 版才具备
操作级证据绑定、重大数据来源门槛和估算披露约束。

```json
{
  "schemaVersion": "1.3",
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
`native-operations.json`，后续使用 Artifact Tool 对原生对象定向修改。

## 禁止行为

- 不得通过清单列出全部图片并循环分配素材。
- 不得把共享图标标记为公司专属图片。
- 不得单独删除空槽位中的一个图标、月桂、边框或文字。
- 不得只按人物/产品素材的文件名或顺序推断对应关系。
- 不得把整个页面截图作为内容替换结果。
- 不得在 `reason` 或 `sourceNote` 中使用模糊表述规避来源检查。
- 不得修改对象坐标、尺寸、层级、字体、字号或样式。
