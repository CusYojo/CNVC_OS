---
name: artifact-template-deta-3
description: "Create a document using the 标准项目投资合规性说明 Deta 3 template and its retained reference file. Use when the user selects this template, names 标准项目投资合规性说明 Deta 3, explicitly invokes /sbl-investment-compliance:artifact-template-deta-3, or asks for a concise Deta-style investment compliance note."
---

# 标准项目投资合规性说明 Deta 3

Create a document from this template. Keep the reference file unchanged.

## Workflow

1. Read `${CLAUDE_SKILL_DIR}/artifact-template.json` and resolve its paths relative to `${CLAUDE_SKILL_DIR}`.
2. Use `${CLAUDE_SKILL_DIR}/assets/reference.docx` as the retained template. Clone it to the output location before editing; never modify the bundled reference in place.
3. Treat the user's prompt and available sources as the content input. Do not invent facts merely to fill a template slot.
4. Clone or import the reference instead of replacing its visual system with generic defaults.
5. Render the finished DOCX to PDF with Microsoft Word or headless LibreOffice, convert all pages to images with Poppler when available, inspect every page, and then return the final artifact.

## Fidelity

Preserve page setup, sections, styles, lists, tables, headers, footers, and recurring page elements.

User instructions control requested content and explicit deviations. The retained reference controls layout and formatting where the user has not requested a change.

## 可执行排版契约

- 页面：A4 纵向；上、下页边距 2.5 cm，左、右页边距 2.8 cm；无页眉页脚；不得用空白段落制造层级。
- 总标题：黑体 14 pt，不加粗，居中；西文采用 Times New Roman；1.5 倍行距。
- 一级标题：宋体 12 pt，加粗，左对齐，段前 12 pt、段后 0 pt、1.5 倍行距；沿用参考文件的“一、二、三、四”真实编号。
- 二级标题：宋体 12 pt，不加粗，左对齐，段前后 0 pt、1.5 倍行距；沿用“（1）（2）（3）”真实编号。
- 正文：宋体 12 pt，不加粗，两端对齐，首行缩进约 2 个字符，段前后 0 pt、1.5 倍行距；数字和西文使用 Times New Roman。
- 投资理由及投资情形分析条目：阿拉伯数字加全角顿号；编号或结论引导语可加粗，论证正文不加粗；段前 6 pt、段后 0 pt。
- 落款：公司名称和中文日期各占一行，宋体 12 pt，不加粗，右对齐；公司名称段前 30 pt，日期段前 0 pt。
- 全文不得使用下划线或斜体。生成后检查页面、页边距、字体、字号、粗体、对齐、缩进、行距及段前后间距，并逐页渲染验收。

## 德塔式正文约束

- 固定采用“公司情况介绍—投资理由—投资计划—投资情形分析”的四段结构，结论先行、依据后置。
- 公司介绍只写客观事实；公司简介仅保留成立时间、注册地、法定代表人、主营业务及定位等决策相关信息，不展示统一社会信用代码、18 位信用代码、注册资本、认缴资本、实缴资本或实收资本。投资理由原则上五点，只写方向、产品、业务、团队及交易结构的正向匹配逻辑。
- 投资计划集中写金额、估值、增资与老股结构、分期原则和治理安排，正式文件保留语只出现一次。
- 投资情形分析固定覆盖七项，并采用“符合／不涉及／不会导致／未发现 + 简要依据”的写法。
- 第一项涉及老股时，用“老股受让部分以基金合伙协议允许为前提”简洁收束；第七项只作其他违法违规情形判断，不承载交割核查清单。
- 核查条件集中到最相关条目或结尾，不在各段反复使用“但”“仍需”“以……为准”等防御性尾句。
- 结尾使用一个条件性结论句干脆收束；可能反转结论的硬条件不得删除，应保存在内部核查底稿中。
