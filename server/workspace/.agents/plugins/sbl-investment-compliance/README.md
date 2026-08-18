# 投资合规性说明 · Claude Code 插件

这是独立生成的 Claude Code 插件转换版本。源目录未被修改。

## 目录结构

- `.claude-plugin/plugin.json`：Claude Code 插件清单。
- `skills/generate-investment-compliance-note/`：从 ZIP 或尽调目录生成合规性说明。
- `skills/artifact-template-deta-3/`：Deta 3 DOCX 模板与排版契约。

## 环境准备

```bash
python3 -m pip install -r "/absolute/path/to/合规性说明-ClaudeCode/requirements.txt"
```

推荐安装 Microsoft Word 或 LibreOffice，以及提供 `pdftoppm`/`pdftotext` 的 Poppler。

## 加载与调用

```bash
claude --plugin-dir "/absolute/path/to/合规性说明-ClaudeCode"
```

在 Claude Code 中调用：

```text
/sbl-investment-compliance:generate-investment-compliance-note
```

示例请求：

```text
使用 /sbl-investment-compliance:generate-investment-compliance-note，
根据 /absolute/path/to/project.zip 生成投资合规性说明。
```

如只需模板排版，调用 `/sbl-investment-compliance:artifact-template-deta-3`。
