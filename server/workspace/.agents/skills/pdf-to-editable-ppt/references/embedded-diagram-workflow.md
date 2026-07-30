# 内嵌流程图与信息图语义重建

## 目录

- 判断是否需要重建
- 坐标与覆盖原则
- 覆盖清单
- 对象顺序
- 质检

## 判断是否需要重建

即使 `route-report.json` 显示 `object-rich`，页面中的流程图、架构图、表格或
产品矩阵仍可能是一张图片。满足任一条件时，执行语义重建：

- 用户指定图片内部的框、文字、箭头或图标需要编辑；
- 一张图片覆盖页面面积超过约 10%，且图片内部含多个逻辑节点；
- 页面渲染能看到文字，但 `pdf-model.json` 在该图片边界内没有对应文本对象；
- 移动图片会同时移动多个本应独立的标签、框或连接线。

先查看图片资源和页面渲染，再决定重建整个图片区域还是有清晰背景的局部区域。
不要把“图片对象可以移动”当成“图片内部元素可编辑”。

## 坐标与覆盖原则

富对象构建器的覆盖清单使用最终幻灯片像素坐标。默认 16:9 页面通常为
`1280 × 720 px`；PDF 坐标到幻灯片坐标的比例为
`1280 / pdf-model.json.page_width`。

重建前必须清除旧像素内容：

- 纯色背景：使用 `covers` 中的原生矩形；
- 渐变、纹理或照片：使用 `covers[].asset` 指向局部背景修补图；
- 整张流程图：覆盖完整图片区域，再重建图内标题、节点、文字和连接线；
- 局部重建：覆盖范围应略大于旧文字和图形的抗锯齿边缘。

不得只叠加新对象。移动、删除或改色新对象后露出旧像素内容即为失败。

## 覆盖清单

向 `convert_pdf.py` 传入 `--overrides`。富对象与 OCR 构建器共同支持：

- `covers`：纯色覆盖形状或背景修补图片；
- `imageReplacements`：在原图片的显示列表顺序中替换为清理后的完整图片；
- `shapes`：原生矩形、圆角矩形、椭圆、自定义路径等，可直接携带文字；
- `connectors`：绑定到命名节点的直线、折线或曲线；
- `texts`：独立文本框；
- `icons`：原生复合形状、SVG 或独立栅格图标；
- `charts`：PowerPoint 原生图表；
- `tables`：原生或手工布局表格。

最小示例：

```json
{
  "slides": {
    "3": {
      "covers": [
        {
          "name": "flow-background-repair",
          "position": { "left": 40, "top": 330, "width": 620, "height": 300 },
          "fill": "#FFFFFF",
          "line": { "style": "solid", "fill": "none", "width": 0 }
        }
      ],
      "shapes": [
        {
          "name": "source-node",
          "geometry": "roundRect",
          "position": { "left": 80, "top": 430, "width": 180, "height": 54 },
          "fill": "#4472C4",
          "line": { "style": "solid", "fill": "#4472C4", "width": 0 },
          "text": "源节点",
          "textStyle": {
            "fontSize": 18,
            "bold": true,
            "color": "#FFFFFF"
          }
        },
        {
          "name": "target-node",
          "geometry": "roundRect",
          "position": { "left": 380, "top": 430, "width": 160, "height": 54 },
          "fill": "#FFE699",
          "line": { "style": "solid", "fill": "#FFE699", "width": 0 },
          "text": "目标节点"
        }
      ],
      "connectors": [
        {
          "name": "source-to-target",
          "from": "source-node",
          "to": "target-node",
          "kind": "elbow",
          "fromSide": "right",
          "toSide": "left",
          "line": { "style": "solid", "fill": "#000000", "width": 1.2 },
          "tail": { "type": "triangle", "width": "sm", "length": "sm" }
        }
      ],
      "texts": [
        {
          "name": "flow-title",
          "position": { "left": 40, "top": 340, "width": 320, "height": 30 },
          "text": "可编辑流程图",
          "textStyle": { "fontSize": 20, "bold": true }
        }
      ]
    }
  }
}
```

`connectors[].from` 和 `to` 必须引用同一页 `shapes[].name`。所有对象名称应
稳定且表达语义，避免只使用 `shape-1`、`text-2`。

## 文字密集型矩阵图片

产品矩阵、工艺流程表和能力地图通常把几十个带底色的单元格烧录在一张图片
中。此时优先保留矩形底色和分隔关系，只清除文字像素并重建文本框：

```bash
python scripts/prepare_embedded_image_ocr.py \
  --image "<build-dir>/assets/page-10-image-004.png" \
  --source-pdf "<source.pdf>" \
  --slide-number 10 \
  --left 77.69 --top 100.89 --width 1124.62 --height 613.92 \
  --source-asset-name "page-10-image-004.png" \
  --output-dir "<work-dir>/embedded-ocr-page-10" \
  --output-overrides "<work-dir>/overrides.json" \
  --base-overrides "<work-dir>/base-overrides.json" \
  --ocr-engine auto \
  --languages "zh-Hans,en-US" \
  --corrections "<work-dir>/ocr-corrections.json"
```

校正文件可以同时修订单元格和单元格外自由文字：

```json
{
  "replacements": {},
  "exclude": [],
  "cell_text": {
    "6": "掩膜",
    "10": "清洗"
  },
  "free_text": {
    "1": "量检测需求",
    "2": "PLSINTECH产品应用"
  }
}
```

单元格编号和坐标见 `embedded-ocr-report.json`。每次修改校正文件后可以复用
已有的逐格 OCR JSON，快速重新生成覆盖清单。

竖排中文有两种视觉形式：

- 每个汉字保持正向、逐字向下：按字符行分割，不旋转汉字；
- 整段文字旋转 90 度：按横排 OCR 后在文本框中保留旋转角度。

不得把两种形式混为一谈。若自动判断错误，在校正清单中明确文字内容，并在
渲染对比时检查字符朝向。

## 对象顺序

构建器按以下顺序处理语义覆盖：

1. 原图片原位替换和背景修补；
2. 节点和容器；
3. 附着式连接线；
4. 节点重新置顶；
5. 独立文字、图表、表格和图标。

这样连接线位于修补背景之上、节点之下。若连接线仍与节点文字相交，调整
`fromSide`、`toSide` 或连接线 `kind`，不要通过把整张流程图重新栅格化解决。
连接线两端的箭头方向必须以最终渲染为准；在当前 Artifact Tool 导出中，
指向 `to` 节点的箭头通常使用 `tail`。若方向相反，交换 `head` 与 `tail`
后重新渲染确认。

## 质检

- 渲染目标页并与源 PDF 并排检查位置、尺寸、颜色、圆角和换行；
- 在 inspect 结果中搜索每个语义名称，确认节点文字、连接线和标签均为对象；
- 分别移动一个节点、一个标签和一条连接线，确认旧像素不会露出；
- 修改一个节点文字，确认文字没有与背景图片重复；
- 在 Microsoft PowerPoint 中检查连接线会随节点移动；
- 运行 `slides_test.py`，修复任何非预期重叠、裁切或画布溢出；
- 交付时列明仍保留为栅格图片的照片、复杂插画或未授权重建区域。
