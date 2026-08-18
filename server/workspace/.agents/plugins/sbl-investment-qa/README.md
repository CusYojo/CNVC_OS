# 投资 Q&A 报告 · Claude Code 插件

这是独立生成的 Claude Code 插件转换版本。源目录未被修改。

## 目录结构

- `.claude-plugin/plugin.json`：Claude Code 插件清单。
- `skills/generate-investment-qa-report/`：证据、问题设计、写作、审计、DOCX 生成与验证工作流。
- `tests/`：处理器回归测试。

## 环境准备

```bash
python3 -m pip install -r "/absolute/path/to/Q&A报告-ClaudeCode/requirements.txt"
```

逐页视觉核验需 Microsoft Word 或 LibreOffice，以及提供 `pdftoppm` 的 Poppler。

## 加载与调用

```bash
claude --plugin-dir "/absolute/path/to/Q&A报告-ClaudeCode"
```

在 Claude Code 中调用：

```text
/sbl-investment-qa:generate-investment-qa-report
```

示例请求：

```text
使用 /sbl-investment-qa:generate-investment-qa-report，
根据 /absolute/path/to/project.zip 生成德塔式项目 Q&A 报告。
```
