# 扁平化 PDF 重建流程

## 目录

- 路线选择
- OCR 基线
- 扁平化水印处理
- 修正规则与排除区域
- 独立图标、原生图表和表格覆盖
- 质检要求

## 路线选择

如果一页主要由一张接近全页的图片组成，且几乎没有可用的文字或矢量内容，
则该页属于扁平化页面。根据需求选择以下输出方式：

- **图片高保真版**：每页放置一张清晰的整页图片。适用于 1:1 外观优先，
  且用户未明确要求对象级可编辑的情况。
- **OCR 可编辑版**：从页面图片中移除已识别文字，再添加独立文本框。
  适用于用户明确要求文字可编辑的情况。
- **语义重建版**：以 OCR 可编辑版为基础，再通过覆盖清单将重要图表、
  表格、图标和示意图替换为 PowerPoint 原生对象或独立 SVG。
  适用于用户明确要求编辑图标、图表或表格的情况。

不得把图片高保真版称为“完全可编辑”。整页图片可以移动、裁剪或替换，
但图片内部的文字和图表不能单独编辑。

## OCR 基线

`prepare_flattened_ocr.py` 支持跨平台 OCR。`--ocr-engine auto` 在 macOS
且存在 `swiftc` 时调用 Apple Vision；Windows、Linux 或没有 `swiftc`
的 macOS 使用 PATH 中的 Tesseract。也可通过 `--ocr-json-dir` 使用
PaddleOCR、RapidOCR、云 OCR 或人工修订的统一 JSON。文字移除功能需要
`opencv-python-headless`。

不同系统的依赖、字体和验证方式见
[cross-platform.md](cross-platform.md)。

建议将 `--minimum-confidence 0.45` 作为安全默认值。只有在以原始尺寸
检查页面后，才可以进一步降低。低置信度的界面截图、论文页面和密集技术
表格通常应保留为栅格图片。

## 扁平化水印处理

扁平化页面的水印已经烧录进像素层，`--watermark-mode auto` 只能过滤独立
文字对象，不能直接清除这类水印。若用户要求无水印输出，必须：

1. 在源页面渲染图中定位水印区域，判断其是否跨越文字、图表或照片；
2. 对纯色背景使用精确匹配的覆盖形状；
3. 对渐变、纹理或照片背景使用局部背景修补或图像修复；
4. 再执行 OCR 文字元素化，并避免把水印识别结果添加为文本框；
5. 以原始尺寸逐页检查修补边缘、正文损伤和水印残影。

不得通过整页白色半透明遮罩“淡化”水印，这会同时改变模板颜色和对比度；
不得把仍含烧录水印的整页图片版描述为“已去水印”。

## 修正规则与排除区域

传入一个 JSON 文件，其中包含精确替换规则，以及基于左上角原点的归一化
排除区域：

```json
{
  "replacements": {
    "Al Scientist": "AI Scientist",
    "选代": "迭代"
  },
  "exclude_regions": {
    "9": [
      { "x": 0.70, "y": 0.13, "width": 0.29, "height": 0.47 }
    ]
  }
}
```

对于 OCR 后会明显劣于源文件的截图或密集文字区域，使用排除区域保留原图。

## 独立图标、原生图表和表格覆盖

向 `build_flattened_ocr_ppt.mjs` 传入覆盖 JSON。坐标单位为幻灯片像素。
应先应用覆盖形状，再添加图标、图表或表格，避免扁平化原图从下方透出。
对于原生表格区域，应跳过其中的 OCR 文字，防止内容重复。
需要重建流程图时，也可使用 `covers`、带文字的 `shapes`、`connectors`
和 `texts`；完整格式见
[embedded-diagram-workflow.md](embedded-diagram-workflow.md)。

```json
{
  "slides": {
    "11": {
      "icons": [
        {
          "mode": "native",
          "name": "editable-status-icon",
          "position": { "left": 70, "top": 350, "width": 48, "height": 48 },
          "cover": {
            "position": { "left": 66, "top": 346, "width": 56, "height": 56 },
            "fill": "#FBFDFF",
            "line": { "style": "solid", "fill": "none", "width": 0 }
          },
          "parts": [
            {
              "name": "icon-circle",
              "geometry": "ellipse",
              "position": { "left": 0, "top": 0, "width": 48, "height": 48 },
              "fill": "#1677FF",
              "line": { "style": "solid", "fill": "none", "width": 0 }
            },
            {
              "name": "icon-center",
              "geometry": "ellipse",
              "position": { "left": 16, "top": 16, "width": 16, "height": 16 },
              "fill": "#FFFFFF",
              "line": { "style": "solid", "fill": "none", "width": 0 }
            }
          ]
        },
        {
          "mode": "svg",
          "name": "editable-brand-icon",
          "position": { "left": 830, "top": 56, "width": 44, "height": 44 },
          "cover": true,
          "backgroundFill": "#FFFFFF",
          "asset": "assets/brand-icon.svg"
        }
      ],
      "shapes": [
        {
          "name": "chart-cover",
          "geometry": "roundRect",
          "position": { "left": 117, "top": 325, "width": 432, "height": 197 },
          "fill": "#FBFDFF",
          "line": { "style": "solid", "fill": "#C4D9F7", "width": 1 }
        }
      ],
      "charts": [
        {
          "type": "doughnut",
          "config": {
            "position": { "left": 228, "top": 332, "width": 238, "height": 185 },
            "categories": ["胜出", "待突破"],
            "series": [{ "name": "结果", "values": [28, 12] }],
            "hasLegend": false,
            "doughnutOptions": { "holeSize": 48 }
          }
        }
      ],
      "skipTextRegions": [
        { "left": 560, "top": 360, "width": 265, "height": 162 }
      ],
      "tables": [
        {
          "mode": "manual",
          "name": "grade-table",
          "position": { "left": 571, "top": 369 },
          "columnWidths": [120, 120],
          "rowHeights": [29, 29],
          "values": [["S级", "9项"], ["A级", "9项"]],
          "fontSize": 16
        }
      ]
    }
  }
}
```

`icons` 支持以下模式：

- `native` 或 `shape`：使用 PowerPoint 原生形状。单个图标可直接设置
  `geometry`、`fill` 和 `line`；复合图标使用 `parts`。部件坐标默认相对
  于图标 `position` 的左上角，设置 `"absolute": true` 后改为绝对坐标。
- `svg`：使用 `asset` 指向 SVG 文件，或通过 `svg` 直接提供 SVG 字符串。
  SVG 是独立矢量对象，可在 PowerPoint 中转换为形状后修改内部路径和颜色。
- `image` 或 `raster`：使用独立栅格图片，仅在无法可靠重建时使用；
  它不具备内部路径和颜色编辑能力。

相对资源路径以覆盖 JSON 所在目录为基准。`cover` 可以是纯色形状，也可以
通过 `cover.asset` 使用背景修补图。对复杂纹理、渐变或照片背景，
优先使用修补图，避免移动图标后出现明显色块。

数据驱动的图形优先使用原生图表。如果原生表格的自动尺寸计算造成换行或
垂直溢出，应改用手工布局表格。

## 质检要求

- 以原始尺寸检查每一页 OCR 可编辑幻灯片。
- 修正被误识别为文字的图标字形。
- 逐个移动图标做抽查，确认底层没有残留旧图标。
- 确认原生复合图标的各组成部件可以分别选择和修改。
- 确认 SVG 图标可单独选择，并在 PowerPoint 中执行“转换为形状”。
- 确认可编辑文字下方没有残留旧文字。
- 确认目标水印已清除，且背景修补没有覆盖正文、图表或照片细节。
- 确认相邻的长文本框之间没有重叠。
- 如果可以使用 Microsoft PowerPoint，在其中打开最终文件。
- 在 PowerPoint 导出结果中复查独立图标、原生图表和表格；LibreOffice
  与 Microsoft PowerPoint 对 SVG、标记、行高和字体的尺寸计算可能不同。
