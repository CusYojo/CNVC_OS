# 德塔V5尽调报告 · Claude Code 插件

这是独立生成的 Claude Code 插件转换版本。源目录未被修改。

## 目录结构

- `.claude-plugin/plugin.json`：Claude Code 插件清单。
- `skills/generate-deta-dd-report/`：资料解析、事实与冲突裁决、DOCX 排版、审计及渲染。
- `skills/artifact-template-deta-2/`：Deta V5 模板、结构、样式与编辑契约。

## 环境准备

```bash
python3 -m pip install -r "/absolute/path/to/尽调报告-ClaudeCode/requirements.txt"
```

如需读取旧 `.xls` 文件，可额外安装 `pandas` 和 `xlrd`。渲染推荐 Microsoft Word；无 Word 时需 LibreOffice 和 Poppler。

## 加载与调用

```bash
claude --plugin-dir "/absolute/path/to/尽调报告-ClaudeCode"
```

在 Claude Code 中调用：

```text
/sbl-deta-dd-report:generate-deta-dd-report
```

示例请求：

```text
使用 /sbl-deta-dd-report:generate-deta-dd-report，
根据 /absolute/path/to/project.zip 生成德塔V5式正式上会尽调报告。
```

如只需按模板修订或排版，调用 `/sbl-deta-dd-report:artifact-template-deta-2`。
