# Codex 与 Claude Code 运行兼容规则

## 目录

1. 技能发现
2. 技能根目录解析
3. Python 环境
4. DOCX 渲染与视觉质检
5. 字体处理
6. 宿主中立行为
7. 兼容性验收

## 技能发现

两个宿主共用同一技能目录：

- Codex 个人目录：`~/.codex/skills/draft-investment-qa/`
- Claude Code 个人目录：`~/.claude/skills/draft-investment-qa/`

Claude Code 2.1.203 及以上版本可跟随技能目录软链接。优先把 Claude Code 位置软链接到 Codex 主目录，避免脚本、模板和规则漂移。更早版本应复制完整目录并建立明确同步机制。

Claude Code 使用 `/draft-investment-qa` 调用；Codex 使用 `$draft-investment-qa` 调用。

## 技能根目录解析

不得相对于用户项目目录执行技能脚本。

Claude Code：

```bash
QA_SKILL_DIR="${CLAUDE_SKILL_DIR}"
```

Codex：把 `QA_SKILL_DIR` 设为当前 `SKILL.md` 所在绝对目录；默认个人位置为：

```bash
QA_SKILL_DIR="$HOME/.codex/skills/draft-investment-qa"
```

报告输入和输出保存在用户工作区；技能脚本、参考规则和模板保存在 `QA_SKILL_DIR`。

## Python 环境

要求 Python 3.9 及以上。校验器只使用标准库，DOCX 生成依赖 `python-docx`。

执行预检：

```bash
python3 "$QA_SKILL_DIR/scripts/check_runtime.py"
```

缺少 `python-docx` 时不得全局安装。获得安装许可后，在工作区创建任务级虚拟环境：

```bash
python3 -m venv ./tmp/qa-skill-venv
./tmp/qa-skill-venv/bin/python -m pip install \
  -r "$QA_SKILL_DIR/requirements.txt"
```

后续校验和生成均使用该解释器。Windows 使用对应的 `Scripts/python.exe`。

## DOCX 渲染与视觉质检

优先使用宿主提供的专业文档渲染器；否则依次选择：

1. Microsoft Word 导出 PDF，再把每页转为 PNG；
2. LibreOffice 无界面导出 PDF，再用 `pdftoppm` 或 PyMuPDF 生成 PNG；
3. 其他能可靠保留 Word 版式的原生 DOCX 渲染器。

必须检查每一页。XML 校验或文本提取不能替代视觉质检。中文缺字、文字截断、表格破损、标题孤行、页眉页脚错误或意外空白页均不合格。

若 LibreOffice 出现中文缺字而系统安装了 Microsoft Word，应改用 Word 核验，不得因此修改规定字体。预览 PDF 仅是质检中间件，除非用户要求，不得交付。

## 字体处理

DOCX 样式固定声明：常规中文使用宋体，粗体中文使用黑体，拉丁文字和数字使用 Times New Roman。不得因本机预览环境缺少字体而静默替换。

不得捆绑或下载未经许可的字体。缺少必要字体时应说明限制，并在合法安装对应字体的环境中完成核验后，才能声称视觉质检通过。

## 宿主中立行为

- 只在合法且必要时使用宿主提供的网络检索，并保持相同的反编造和出处规则。
- 数据库或连接器只能只读访问，并且只取必要字段。
- 使用宿主常规文件编辑工具，不依赖 Codex 专用指令或 Claude Code 专用动态命令注入。
- `agents/openai.yaml` 仅作为可选 Codex 界面元数据；Claude Code 会把它当作普通辅助文件忽略。
- 同一技能需兼容多个 Agent Skills 宿主时，不得加入 Claude Code 专属 YAML 头部字段。

## 兼容性验收

全部满足才算通过：

1. `SKILL.md` 的 `name` 为合法的小写连字符名称，`description` 清晰有效；
2. 所有引用的规则、模板和脚本都能从技能目录解析；
3. `check_runtime.py` 能运行并报告 DOCX 生成准备状态；
4. 从技能目录之外运行 `validate_qa_report.py --json` 成功；
5. 从技能目录之外运行 `render_qa_docx.py` 成功；
6. Claude Code 能以 `/draft-investment-qa` 发现技能；
7. Codex 能以 `$draft-investment-qa` 发现技能；
8. 最终 DOCX 通过结构校验和逐页视觉质检。
