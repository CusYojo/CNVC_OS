# 跨客户端运行规范

## 目的

同一套尽调技能可在 Codex、Claude Code 或其他兼容客户端中运行，且不改变证据、写作、版式与逐页视觉门禁。

## 技能根目录

不得使用相对于任务工作区的路径执行技能脚本。

- Claude Code 将当前技能目录暴露为 `${CLAUDE_SKILL_DIR}`。
- Codex 在技能目录表中提供技能路径，应将该目录赋给 `DD_SKILL_ROOT`。
- 其他客户端应解析 `SKILL.md` 所在目录，并赋给 `DD_SKILL_ROOT`。

执行脚本前统一设置：

```bash
DD_SKILL_ROOT="${CLAUDE_SKILL_DIR:-$DD_SKILL_ROOT}"
DD_PYTHON="${DD_PYTHON:-python3}"
```

证据、报告 JSON、源文件、渲染页面和最终 DOCX 一律使用绝对路径，并保存在技能目录之外的任务目录中。

## Python 依赖

脚本要求 Python 3.10 或以上版本，并可导入以下模块：

- `python-docx` 提供的 `docx`
- `PyMuPDF` 提供的 `fitz`

执行：

```bash
"$DD_PYTHON" "$DD_SKILL_ROOT/scripts/check_runtime.py"
```

优先使用已配置好的 Python 环境。缺少模块且用户允许安装时，在任务目录创建独立虚拟环境，只安装缺失包，并将 `DD_PYTHON` 指向该环境；不得修改系统 Python。

## 渲染

渲染器按以下顺序选择：

1. macOS 已安装 Microsoft Word 时，通过 AppleScript 使用 Word；
2. 其他情况使用 `soffice` 或 `libreoffice`。

渲染只是视觉验收的前置条件，不等于完成验收。必须通过当前客户端的图片读取工具，以 100% 比例逐张检查所有页面 PNG。Claude Code 使用支持图片的 Read/文件查看能力；Codex 使用本地图片查看器。出现空白页、文本裁切、孤立表格行、目录域错误、标题编号错误、字体不一致、连续稀疏页或页码缺失时，必须退回修复。

## 客户端工具映射

| 工作需要 | Codex | Claude Code 或兼容客户端 |
|---|---|---|
| 读取并盘点本地文件 | shell 与文件工具 | Read、Glob、Grep 或 shell |
| 最新公开信息检索 | 可用的 web/browser 工具 | WebSearch、WebFetch 或获授权的浏览器工具 |
| 生成和审计 DOCX | 本技能 Python 脚本；生成器强制读取 `diligence-data.json` 与 `evidence.json` | 本技能同一组 Python 脚本和参数 |
| 渲染 DOCX | 本技能渲染脚本 | 本技能渲染脚本 |
| 逐页检查 | 图片查看器 | 支持图片的 Read/文件查看器 |

不同客户端的工具名称可以不同，但证据规则和质量门禁不得变化。

## Claude 安装

安装目录：

```text
~/.claude/skills/write-investment-dd-report
```

Codex 与 Claude 位于同一台机器时，优先通过符号链接指向同一份受维护的技能目录，避免模板、脚本和规范出现版本分叉。只有两个环境无法共享文件时才复制技能目录；每次更新后必须分别验证两份副本。

Claude 不要求额外的专属元数据，标准 `SKILL.md` 前置字段即可。`agents/openai.yaml` 属于 Codex 界面元数据，Claude 可以忽略。

## 完成门禁

任何客户端均不得在以下条件未全部满足时交付：

- 运行环境检查通过；
- 证据、字段完整性、公开研究（适用时）、报告内容、严格叙事和 DOCX 样式审计均为零错误、零警告；
- Claude Code 与 Codex 均使用 `audit_ic_completeness.py`，不得因客户端缺少专属工具而跳过字段门禁；
- 最终渲染的文件就是最新版本 DOCX；
- 最后一次修改后，每一张渲染页面均已逐页打开检查；
- 封面主标题严格为“尽职调查报告”。
