# 质量门禁与交接

## G0 身份与事实

- 项目法定实体唯一。
- 页面所有事实都有事实键和来源，或明确标为假设/尽调缺口。
- 模板样本公司、人物、Logo、日期和数字无残留。

## G1 图片生成

- `imagegen-manifest.json` 存在。
- 每页都有 `task_id`、`metadata_json`、`copied_to`，文件真实存在。
- 页面数量与大纲一致；逐页视觉检查已完成。
- 错字和事实错误通过重生成处理，没有位图补字。

## G2 PDF 桥接

- `pdf-bridge-manifest.json` 通过。
- PDF 页数等于页面图片数。
- 所有页面比例一致，逐页 SHA-256 与输入页面对应。
- PDF 不包含额外文字层或重新绘制内容。

## G3 可编辑转换

`conversion-handoff.json` 必须满足：

- `schemaVersion=1.2`
- `producerSkill=pdf-to-editable-ppt`
- `sourcePdf` 与桥接 PDF 一致
- `route=flattened`
- `editableScope=all`，除非用户明确缩小范围
- `watermarkQaPassed=true`
- `editabilityReviewPassed=true`
- `semanticBuildPassed=true`
- `editableSurfacePassed=true`
- `layoutCalibrationPassed=true`
- `unresolvedEditablePages=[]`
- `readyForContentReplacement=true`

同时验证最终 PPTX 和报告 SHA-256。

## G4 视觉与兼容性

- 最终 PPTX 每页渲染并与桥接 PDF 对比。
- 检查标题、正文、表格、图表、照片和信息密集页。
- 运行 Presentations `slides_test.py`，无画布溢出。
- 能使用 Microsoft PowerPoint 时执行原生导出复核；不能时说明 LibreOffice/内置渲染替代验证。

## G5 可编辑前景

- 打开 `editable-foreground-only.pptx` 检查前景对象确实独立。
- 图标、流程节点、连接线、表格和图表与语义清单一致。
- 不得把独立栅格图标描述为路径可编辑。
- 不得把照片或复杂插画描述为原生形状。

## 最终交付表述

准确区分：图片高保真版、文字可编辑版、语义重建版。列出仍为栅格的对象和任何兼容性限制。未通过任一硬门禁时，停止交付并报告具体文件与失败项。
