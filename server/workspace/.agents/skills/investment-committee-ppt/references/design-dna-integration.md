# Design DNA 集成与自主生成

## 正式身份

- Base Profile：`investment-editorial-research`
- Display Name：`Investment Editorial Research / 投资研究编辑部`
- Base Version：`v001`
- Default Adapter：`dense-investment-committee`
- Adapter Name：`Dense Investment Committee / 高密度投委会`
- Adapter Version：`a001`

`v001` 保存可跨公司的视觉心理、构图、字体、色彩、内容承载和演示节奏；`a001` 增加投委会所需的高解释密度、证据分级、指标保留、财务/订单/交易路径和 12 pt 正文下限。

## 自主调用规则

用户显式调用 `$investment-committee-ppt`，或任务明确匹配本 Skill 且未提供另一种风格时，视为已经选择 `v001 + a001`。这是专用投资 PPT 流程，不进入通用 PPT-Design-DNA 的无图 Discovery 和风格候选确认；但仍必须完成资料审计、Design Contract、逐页蓝图、Page Specs、生成与 QA。

这项默认选择只决定“如何呈现”，不决定“写什么”。新公司的事实、行业、产品、图片、客户、数字、财务和交易条件必须重新从材料与公开证据建立。

## 项目解析

建档脚本会自动生成解析快照：

```powershell
python scripts/scaffold_project.py --company "公司名" --output-dir ".codex_work/公司名_ppt"
```

也可以单独解析：

```powershell
python scripts/resolve_design_profile.py --output ".codex_work/公司名_ppt/active-design-dna.json"
```

解析器会：

1. 读取 `profile-index.json` 和 `profile.json`。
2. 载入当前不可变版本 `v001.json`。
3. 应用 `a001.json` 的参数变化。
4. 深度合并 execution、tokens、质量约束和负面约束。
5. 记录 Profile、Adapter 和版本身份。

生成器必须读取解析快照，不应只参考 `design-profile.yaml` 或凭模型记忆复述风格。

## 与通用 PPT-Design-DNA 共用

通用 `$PPT-Design-DNA` 默认只检查当前项目根目录的 `design-profiles/profile-index.json`。如需让它在普通 PPT 任务中列出本风格，运行：

```powershell
python scripts/install_design_profile.py --workspace "."
```

这会将 Profile 安装到当前项目的 `design-profiles/`。如果已存在同名 Profile，脚本默认停止；只有用户明确批准替换后才使用 `--replace`。

之后可以说：

```text
使用 $PPT-Design-DNA，选择 Investment Editorial Research，使用 Dense Investment Committee Adapter。
```

## 新参考稿和项目级 Adapter

如果用户提供另一份高质量参考稿：

- 先用 `reference-comparison.md` 提取可迁移的布局语法。
- 保持公司事实和参考图主体防火墙。
- 若参考只改变局部场景，创建项目工作区内的 Adapter；不要修改捆绑 `v001/a001`。
- 若用户明确要形成新的长期风格，按 PPT-Design-DNA 的 Profile 管理规则另建不可变版本或新 Profile。

## 不可复制的示例内容

大衍最终 PPT 不是模板文件。以下内容不得带入新公司：

- 大衍名称、Logo、产品照片与团队人物。
- 客户、订单、收入、回款、估值、股权和交易数据。
- 公开图片中的特定人物和产品主体。
- 与大衍业务专属的 Real–Sim–Real 叙事，除非新公司材料独立支持。

可复用的是：行动标题、state-and-explain、暖纸与字体系统、密度节奏、版式母型、证据邻接、去表格化关系图和原生渲染 QA。

## 降级条件

以下情况不应机械套用 a001：

- 用户明确要求路演、发布会或极低密度展示。
- 公司材料太少，无法形成高密度证据链。
- 企业品牌规范禁止楷体或指定另一套配色。
- 输出环境不能使用 PowerPoint，原生 PDF QA 必须标明降级。

发生冲突时保留基础研究原则，调整 Adapter，不把缺失内容用空泛句子填满。
