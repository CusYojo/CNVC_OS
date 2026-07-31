# 视觉分析与证据融合协议

## 目录

- 当前 Agent 原生模式
- HTTP 请求
- 响应格式
- 区域对象
- 安全约束
- 离线 JSON
- Linux 服务建议

## 当前 Agent 原生模式

当运行本 Skill 的 Codex Agent 已支持图片输入时，优先复用当前 Agent 的视觉
能力，不再调用第二个视觉模型。`gpt-5.6-sol` 是推理模型配置；真正的前提是
该 Linux Agent 运行面能够读取本地 PNG/JPEG。

运行：

```bash
python3 "$SKILL_DIR/scripts/prepare_agent_vision.py" \
  --input "/absolute/source.pdf" \
  --work-dir "/absolute/build" \
  --agent-model "gpt-5.6-sol"
```

该命令生成：

- `agent-vision-request.json`：`analysisPages` 列出语义分析候选页，
  `qaPages` 列出最终必须复核的全部页面，并记录实际 Agent 模型；
- `agent-vision/page-XX.json`：当前 Agent 的页面理解结果；
- `agent-vision/qa-page-XX.json`：当前 Agent 对源页面与 PPT 渲染的复核结果。

识别结果遵循 `agent-vision-analysis.schema.json`，复核结果遵循
`agent-visual-qa.schema.json`。Agent 必须实际查看图片，不能仅依据 PDF
文本、文件名或路径推断视觉布局。

为支持批处理编排，也可由上层系统对每页调用支持图片输入和结构化输出的
Codex 非交互任务，再把结果写回上述 JSON 文件。无论由同一任务还是子任务
执行，证据裁决和安全约束保持不变。

## HTTP 请求

`analyze_pages_with_vision.py` 向 `--vision-endpoint` 发送 JSON POST：

```json
{
  "schemaVersion": "1.0",
  "task": "analyze-pdf-slide-for-editable-reconstruction",
  "instructions": "Return JSON only...",
  "allowedRegionTypes": ["flowchart", "table", "chart"],
  "allowedActions": ["semantic-rebuild", "keep-raster"],
  "pdfFacts": {
    "page": 3,
    "width": 960,
    "height": 540,
    "elements": [
      {
        "id": "p03-e0018",
        "index": 18,
        "kind": "text",
        "bbox": [120, 80, 300, 105],
        "text": "数据处理"
      }
    ]
  },
  "image": {
    "mimeType": "image/png",
    "base64": "..."
  }
}
```

如环境变量 `PDF_PPT_VISION_API_KEY` 存在，请求会带：

```text
Authorization: Bearer <value>
```

转换日志和报告不得记录该值。

## 响应格式

服务可直接返回分析对象，也可包装在 `analysis` 中：

```json
{
  "pageType": "hybrid",
  "confidence": 0.96,
  "regions": [
    {
      "id": "p03-flow-01",
      "type": "flowchart",
      "bbox": [0.08, 0.31, 0.82, 0.46],
      "recommendedAction": "semantic-rebuild",
      "confidence": 0.94,
      "reconstructionComplete": true,
      "coverFill": "#FFFFFF",
      "objects": []
    }
  ]
}
```

坐标固定使用左上角原点的归一化 `[x, y, width, height]`。

同一 HTTP 端点还会收到 `task=compare-pdf-source-and-ppt-render` 的最终视觉
复核请求。返回：

```json
{
  "passed": true,
  "confidence": 0.94,
  "issues": [],
  "summary": "未发现影响交付的结构或布局差异"
}
```

离线回放使用 `qa-page-01.json` 或 `review-page-01.json`。

允许的区域类型：

- `flowchart`
- `table`
- `chart`
- `matrix`
- `icon-group`
- `photo`
- `screenshot`
- `illustration`
- `decoration`
- `watermark`
- `text-block`
- `unknown`

允许的动作：

- `semantic-rebuild`
- `ocr-text`
- `keep-raster`
- `review`
- `ignore`

## 区域对象

### 形状

```json
{
  "id": "source-node",
  "type": "shape",
  "geometry": "roundRect",
  "bbox": [0.10, 0.35, 0.16, 0.08],
  "fill": "#4472C4",
  "line": {"fill": "#4472C4", "width": 1},
  "text": "数据采集",
  "textEvidenceId": "p03-e0018"
}
```

`textEvidenceId` 应引用请求 `pdfFacts.elements[].id`。融合器默认拒绝没有原生
文字证据的模型文字。

### 连接线

```json
{
  "id": "source-to-process",
  "type": "connector",
  "bbox": [0.26, 0.38, 0.12, 0.02],
  "from": "source-node",
  "to": "process-node",
  "kind": "straight",
  "fromSide": "right",
  "toSide": "left",
  "line": {"fill": "#202020", "width": 1},
  "tail": {"type": "triangle"}
}
```

### 独立文字

```json
{
  "id": "flow-caption",
  "type": "text",
  "bbox": [0.10, 0.28, 0.30, 0.04],
  "text": "业务处理流程",
  "textEvidenceId": "p03-e0012",
  "textStyle": {
    "fontSize": 20,
    "bold": true,
    "color": "#202020"
  }
}
```

### 表格与图表

模型可以提出表格或图表候选，但只有 `verifiedData=true` 才会进入自动构建。
生产系统应在视觉分析之前或之后增加 OCR/人工数据校验，不得让模型自行把
像素高度换算为最终业务数字。

## 安全约束

- 视觉模型不得改写 PDF 原生文字。
- 无法确认时输出 `unknown` 或 `review`。
- 不得根据常识补齐数值、日期、人名和产品名。
- `reconstructionComplete=true` 表示区域内需要保留的逻辑对象已经完整列出。
- 只有完整区域才允许使用 `coverFill` 清除原像素。
- 复杂背景不要返回纯色 `coverFill`；应由人工或图像修补流程生成背景资产。
- 服务响应必须限制大小并通过 JSON 解析；不要执行模型返回的代码。

## 离线 JSON

JSON 回放目录使用：

```text
page-01.json
page-02.json
```

或：

```text
slide-01.json
slide-02.json
```

推荐使用 JSON 回放完成：

- 单元测试；
- 模型版本对比；
- Prompt 回归；
- 无 GPU 环境验证；
- 机密材料的人工校正。

## Linux 服务建议

默认建议让当前 Codex Agent 完成视觉识别和复核。只有在转换 Worker 不具备
图片输入能力、需要独立扩缩容，或必须由其他视觉模型提供服务时，才采用下述
HTTP 架构：

- 将视觉模型部署为独立 GPU 服务。
- CPU 转换 Worker 只允许访问内部视觉端点和对象存储。
- 按页面图 SHA-256、模型版本、Prompt 版本和 Schema 版本缓存结果。
- 限制请求图像大小、响应 JSON 大小、单页超时和任务总页数。
- `audit` 模式下保留模型结果但不修改 PPT。
- 视觉服务失败时，`assist` 安全降级，`required` 立即失败。
