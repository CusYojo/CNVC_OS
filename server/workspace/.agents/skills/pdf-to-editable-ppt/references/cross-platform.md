# 跨平台运行

## 目录

- 通用依赖
- macOS
- Windows
- Linux
- OCR 后端
- 字体与验证

## 通用依赖

核心转换在 macOS、Windows 和 Linux 上使用相同的 Python
脚本。运行前执行：

```bash
python3 "$SKILL_DIR/scripts/check_environment.py" --json
```

检查器会在移除 `DISPLAY` 和 `WAYLAND_DISPLAY` 后，通过
LibreOffice `--headless` + pdftoppm 真实渲染一张冒烟幻灯片，验证
Linux OpenXML 渲染管线可用。`core_ready=true`、
`strict_watermark_qa_ready=true` 和 `linux_visual_qa_ready=true`
必须同时成立。不要把 macOS 或 Windows 的 `node_modules` 复制到 Linux。

必需依赖：

- Python 3、PyMuPDF、Pillow；
- Poppler 的 `pdftoppm`；
- LibreOffice（Linux 无头渲染与冒烟验证）；
- Node.js 与 `pptxgenjs`（PPTX 构建器）；
- 内置 Python `zipfile`（PPTX 包扫描与验证）。

OCR 模式还需要 `opencv-python-headless`，并需要 Apple Vision、
Tesseract 或预先生成的 OCR JSON 中的一种。

## macOS

富对象与图片模式不依赖 AppleScript。扁平化 OCR 的 `auto` 模式优先使用
Apple Vision，需要 Xcode Command Line Tools 提供 `swiftc`。也可以显式
使用 Tesseract：

```bash
python3 "$SKILL_DIR/scripts/convert_pdf.py" \
  --input "/data/source.pdf" \
  --output "/data/editable.pptx" \
  --work-dir "/data/build" \
  --flattened-mode ocr \
  --ocr-engine tesseract
```

## Windows

在 PowerShell 中使用 `$env:USERPROFILE`，不要复制 Bash 的 `$HOME` 或
反斜杠续行写法：

```powershell
$skillDir = "$env:USERPROFILE\.codex\skills\pdf-to-editable-ppt-vision"
py "$skillDir\scripts\convert_pdf.py" `
  --input "D:\data\source.pdf" `
  --output "D:\data\editable.pptx" `
  --work-dir "D:\data\build"
```

将 Poppler 和 Tesseract 的可执行文件目录加入 PATH；无法加入时使用
`--pdftoppm` 和 `--tesseract` 传入完整路径。OCR 默认字体为
`Microsoft YaHei`。

如果安装了桌面版 Microsoft PowerPoint，可通过 PowerShell COM 导出验证
PDF：

```powershell
$app = New-Object -ComObject PowerPoint.Application
$deck = $app.Presentations.Open("D:\data\editable.pptx")
$deck.SaveAs("D:\data\verification.pdf", 32)
$deck.Close()
$app.Quit()
```

## Linux

Debian/Ubuntu 可安装：

```bash
sudo apt-get update
sudo apt-get install -y \
  python3 python3-pip \
  libreoffice \
  poppler-utils \
  tesseract-ocr \
  tesseract-ocr-eng \
  tesseract-ocr-chi-sim \
  fonts-noto-cjk

python3 -m pip install \
  pymupdf pillow opencv-python-headless
```

Alpine Linux 使用 musl，Debian/Ubuntu/RHEL 通常使用 glibc。生产环境优先
使用 Debian/Ubuntu/RHEL 系 glibc 镜像，并在镜像内安装固定版本 Node.js。
将 `AI_PDF_TO_PPT_NODE_PROJECT_ROOT` 指向包含 `node_modules/pptxgenjs` 的
项目根目录。若 Presentations 技能脚本位于自定义目录：

```bash
export PRESENTATIONS_SKILL_DIR="/opt/codex-skills/presentations"
python3 "$SKILL_DIR/scripts/check_environment.py" --json
```

不得仅凭命令存在就继续；LibreOffice 无头冒烟测试未通过时必须停止。

最终水印严格验收需要中文 Tesseract 语言包。只有英文语言包时不得把中文
水印 OCR 标记为已完成；严格模式实际要求 `chi_sim` 与 `eng` 同时存在。
安装 `tesseract-ocr-chi-sim` 和英文语言包，或在 macOS 使用 Apple Vision。

然后使用通用转换命令。OCR 默认字体为 `Noto Sans CJK SC`，标题默认使用
`Noto Serif CJK SC`。如果成品主要在 Windows 打开，可显式设置：

```bash
python3 "$SKILL_DIR/scripts/convert_pdf.py" \
  --input "/data/source.pdf" \
  --output "/data/editable.pptx" \
  --work-dir "/data/build" \
  --flattened-mode ocr \
  --ocr-body-font "Microsoft YaHei" \
  --ocr-title-font "Microsoft YaHei"
```

Linux 没有 Microsoft PowerPoint。使用 Presentations 技能的渲染器完成
逐页检查，并可用 LibreOffice 做兼容性冒烟测试：

```bash
libreoffice --headless --convert-to pdf --outdir /data/verify \
  /data/editable.pptx
```

LibreOffice 对字体、SVG、表格行高和图表标记的计算可能不同，不得把它的
差异直接当作 PowerPoint 文件损坏。

纯终端环境仍必须实际审阅逐页 PNG。可以把渲染目录传给具有图像读取能力的
审阅工具，或将其安全下载到有桌面的受控环境。仅运行渲染命令、没有查看
结果，不满足视觉验收。交付说明必须写明“未经过 Microsoft PowerPoint
原生验证”。

## OCR 后端

`--ocr-engine auto` 的选择顺序：

1. macOS 且存在 `swiftc`：`apple-vision`；
2. 其他情况且存在 `tesseract`：`tesseract`；
3. 都不存在：停止并提示安装或使用 `--ocr-json-dir`。

可用值：

- `apple-vision`：仅 macOS；
- `tesseract`：三大系统均可用；
- `json`：读取 `slide-XX.json`，适合 PaddleOCR、RapidOCR、云 OCR
  或人工修订结果；
- `auto`：按上述规则选择。

统一 JSON 每行字段：

```json
{
  "text": "可编辑文字",
  "confidence": 0.98,
  "x": 0.10,
  "y": 0.70,
  "width": 0.30,
  "height": 0.05
}
```

坐标均为 `0–1`；`x`、`y` 使用左下角原点，与 Apple Vision
`boundingBox` 一致。每页文件名必须为 `slide-01.json`、
`slide-02.json` 等。

## 字体与验证

- 生成系统与最终打开系统的字体不同会改变换行和基线。
- 优先安装源 PDF 使用的字体；无法安装时，明确指定 OCR 字体并逐页复查。
- Windows PowerPoint 是最终兼容性验证的首选；macOS PowerPoint 次之。
- Linux 使用内置渲染器与 LibreOffice 双重检查，但交付时说明没有经过
  Microsoft PowerPoint 原生验证。

## 服务器安全与资源限制

- 使用非 root 服务账号并在运行前设置 `umask 077`；
- 为每个任务使用独立工作目录，不复用已有 `node_modules`；
- 默认保留 `--max-pages 300`、`--command-timeout-seconds 1800` 和
  `--watermark-qa-ocr-timeout-seconds 120` 的保护限制；
- 对不可信 PDF/PPTX 使用容器、CPU/内存/磁盘配额和禁网策略；
- 工作目录包含源文件、逐页渲染、OCR 文本与来源备注，任务完成后按数据
  保留策略清理，不得写入公共临时目录或宽权限共享盘。
