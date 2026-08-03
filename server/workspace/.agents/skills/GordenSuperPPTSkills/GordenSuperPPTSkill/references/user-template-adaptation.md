# 用户模板动态适配

## 目录

- 默认行为
- 输入契约
- T0-T6 模板摄取流程
- 借鉴强度
- 模板分析产物
- 语义页型映射
- 阶段 1 参考策略
- 样本残留门禁
- 长期模板晋升

## 默认行为

当用户提供 PDF、PPTX 或页面图片并要求“参考结构、风格、排版或故事线”时，启用 `user-reference` 模式：

1. 默认 `scope=task-only`，不得把用户文件写入技能的长期 `assets/`。
2. 默认 `reuse_level=structure-and-style`，内容完整性和事实准确性高于像素级复刻。
3. 默认先完成模板分析和逐页映射；用户说“直接生成/无需确认”时跳过确认门。
4. 默认交付图片型 PPT 和可编辑 PPTX；用户明确只要一种时按其要求执行。
5. 只有用户明确要求“以后长期使用/加入技能/注册模板”时，才进入长期模板晋升流程。

## 输入契约

尽量从用户请求和附件中自动取得以下信息，缺失但不影响执行时使用默认值：

| 字段 | 默认值 |
|---|---|
| `reference_template` | 用户本次提供的 PDF/PPTX/页面图片 |
| `target_topic` | 用户描述的公司、项目或主题 |
| `target_materials` | 用户附件 + 已授权公开检索资料 |
| `audience` | 投资决策委员会/管理层，按内容推断 |
| `page_count` | 按事实密度自定；投资类通常 14-20 页 |
| `reuse_level` | `structure-and-style` |
| `scope` | `task-only` |
| `confirmation` | 先展示模板理解和大纲；“直接生成”则跳过 |

只有当缺失信息会显著改变交付物时才向用户提问。

## T0-T6 模板摄取流程

### T0 原始文件摄取

运行：

```bash
python3 scripts/ingest_reference_template.py <template.pdf|pptx|image-dir> \
  --out-dir <run>/reference-template \
  --scope task-only \
  --reuse-level structure-and-style
```

脚本只完成确定性证据提取，不替代模型的视觉判断。检查 `template-intake-manifest.json`、`contact-sheet.png` 和全部 `rendered/page-NNN.png`。

### T1 内容结构 DNA

完整浏览总览图和页标题，补全 `template-profile.json`：

- 章节顺序与叙事模式。
- 每页的语义角色。
- 各类页面的数量和内容密度。
- 结论如何从行业、公司、验证、财务推导到投资决策。

不要把模板事实写进当前项目事实库。

### T2 视觉 DNA

至少记录：

- 画布比例与安全区。
- 主色、辅助色、强调色及使用比例。
- 字体气质和标题层级；无法确定具体字体时记录可替代字体类型。
- 栅格、边距、卡片、表格、图表、照片和章节页规则。
- 信息密度、留白和视觉节奏。

### T3 页型库

从模板选择 8-15 张代表页，按语义角色建立页型库。优先覆盖：封面、摘要、行业、痛点、产品、技术、团队、验证、竞争、商业模式、财务、投资、风险和退出。

若模板缺少目标项目必需的页型，从内置模板库补齐，并将模式标记为 `hybrid-reference`。

### T4 当前项目事实库

独立建立 `project-facts.json`，每条事实标记：

- `verified`：用户资料或可靠来源验证。
- `public-claim`：公开报道声称，尚未尽调确认。
- `unknown`：信息缺失，只能列为尽调问题。

禁止用模板样本数据填补 `unknown`。

### T5 逐页语义映射

写 `template-selection.json` 和 `slide-plan.json`，将目标页面角色映射到参考页。不要按照页码机械替换。

### T6 确认门

正常模式下先向用户展示：模板理解、全局视觉系统、章节调整和逐页大纲。用户说“直接生成/无需确认”时，记录采用的默认值并继续。

## 借鉴强度

| 模式 | 允许调整 | 适用 |
|---|---|---|
| `strict-template` | 尽量固定页数、顺序和槽位 | 用户明确要求接近 1:1 |
| `structure-and-style` | 保留故事逻辑和视觉系统，允许重组页面 | 默认、最推荐 |
| `style-only` | 只借鉴配色、字体、栅格和组件语言 | 模板内容与目标差异大 |
| `hybrid-reference` | 用户模板为视觉主模板，内置模板补充缺失页型 | 用户模板不完整 |

无论哪种模式，模板内容都不是当前项目事实。

## 模板分析产物

```text
<run>/reference-template/
├── source/                       # 原始文件副本；仅本任务
├── rendered/page-NNN.png         # 全部参考页
├── contact-sheet.png             # 总览
├── extracted-text.json           # 提取文字
├── page-index.json               # 标题、尺寸、密度和角色提示
├── page-archetypes.json          # 代表页候选
├── sample-fingerprint.json       # 样本残留候选词
├── template-profile.json         # 内容 DNA + 视觉 DNA
└── template-intake-manifest.json # 来源、哈希、作用域和渲染证据
```

脚本生成的角色和配色只是候选；必须结合视觉检查修正。

## 语义页型映射

逐页记录：

```json
{
  "target_slide": 6,
  "target_role": "product-architecture",
  "reference_page": "reference-template/rendered/page-009.png",
  "reference_strategy": "direct-reference",
  "borrow": ["三层架构", "左侧层级标签", "蓝黄强调比例"],
  "replace": ["全部文字", "Logo", "产品图", "客户", "数据"],
  "content_source_keys": ["product.matrix", "technology.engine"]
}
```

每页只指定一个主参考页。第二参考页只能补充信息组织，不得同时混合两套构图。

## 阶段 1 参考策略

### `direct-reference`

通过网关脚本 `--image` 传入原参考页。视觉还原度最高，样本残留风险也最高。适合封面、章节页和样本元素较少的页面。

### `distilled-style-anchor`

先用图像模型把代表页蒸馏成无文字、无 Logo、无人物、无项目数据的风格锚点，再用于后续页面。适合品牌较重、保密或样本残留风险高的模板。风格锚点也必须记录图像生成任务证据。

### `text-style-spec`

只把视觉 DNA 写入提示词，不传原图。样本残留风险最低，但视觉贴合度较低。

默认按页选择：封面/章节页可用 `direct-reference`；正文优先 `distilled-style-anchor` 或经审核的直接参考；敏感模板使用 `text-style-spec`。

## 样本残留门禁

阶段 1 出图后、阶段 2 开始前执行两轮检查：

1. 文本扫描：将 OCR/视觉识别结果与 `sample-fingerprint.json` 对照。
2. 视觉扫描：检查 Logo、人物、产品照片、二维码、水印、页码、品牌图形和模板日期。

发现以下任一项必须重生成该页：

- 模板公司、产品、客户、股东或合作方名称残留。
- 模板人物、Logo、二维码、报告人、日期、页码或水印残留。
- 模板收入、估值、订单、客户数、市场规模或预测数字残留。
- 未经当前项目证据支持的“唯一、独家、全球领先”等绝对化结论。

禁止用代码在位图上遮挡或补字。

## 长期模板晋升

仅在用户明确授权后执行：

1. 将 `scope` 改为 `persistent-candidate`，不得直接标记为已注册。
2. 完成来源、版权、保密性和样本残留检查。
3. 选择代表页，生成总览和模板说明。
4. 复制到 `assets/reference-templates/<template-slug>/`。
5. 更新模板 `manifest.json` 和相应目录文件。
6. 运行技能验证和一次不含原项目上下文的前向测试。

没有明确授权时，任务结束后不得把用户模板沉淀进长期模板库。
