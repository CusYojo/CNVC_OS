# AI-007～AI-011 Skill 开发与验收报告

## 1. 结论

合规性说明、投资提案、投资建议书（PPT）、尽调报告和项目 Q&A 已分别生成独立中文 Agent Skill，并完成当前仓库内的运行接线。

当前结论：**AI-007～AI-011 均由服务端确定性加载对应 Skill；五个 Skill 的用户可见名称、说明、工作流、契约和默认提示均为中文，结构、任务绑定、版本审计、持久化恢复和隔离 API 链路已纳入自动验收。**

## 2. Skill 清单

| 业务能力 | Skill 名称 | 当前调用方式 |
|---|---|---|
| 合规性说明 | `generate-compliance-statement` | AI-007 持久任务创建及内容生成时强制加载 |
| 投资提案 | `draft-investment-proposal` | AI-008 持久任务创建及内容生成时强制加载 |
| 投资建议书（PPT） | `build-investment-recommendation-ppt` | AI-009 持久任务创建及内容生成时强制加载 |
| 尽调报告 | `write-due-diligence-report` | AI-010 持久任务创建及内容生成时强制加载 |
| Q&A | `answer-project-qa` | AI-011 用户确认问题后由 `POST /api/ai/qa` 确定性加载，回答保存到会话并可恢复 |

Skill 根目录：

`server/workspace/.agents/skills/`

每个 Skill 包含：

- `SKILL.md`：触发条件、执行流程、安全和责任边界。
- `references/*.md`：输入、章节、证据、状态、引用及输出契约。
- `agents/openai.yaml`：显示名称、简短说明和默认调用提示。

目录名和 frontmatter `name` 按 Agent Skill 规范保留小写 ASCII kebab-case 技术标识；这些标识仅用于注册、调用和版本审计，不作为用户界面文案。除 JSON 字段、API 参数及上述技术标识外，五个 Skill 的用户可见内容均使用中文。

Skill 中未复制 `docs` 业务样本的真实项目正文或二进制文件；样本仍只用于结构和视觉方向参考。

当前属于“受控模板复用”接入：

- DOCX 生成器会实际读取对应 `docs` 主样本，校验并记录 SHA-256，复用可安全继承的字体表/主题部件，并按样本的中文字体、页边距、页眉页脚、页码和长文档分节规则生成新的可编辑正文。
- PPTX 生成器会实际读取 `docs` 主样本，只继承公司级 Logo、山景和紫色视觉规则；样本项目照片、证书、产品图、投资人 Logo 和正文一律不复用。中文文本统一写入 `zh-CN`，东亚主题字体使用“微软雅黑”。
- Q&A 按 `docs/Q&A` 样本提炼为“问题—答复—来源—待核验”的中文业务格式，不在用户界面展示 Skill/模板内部版本号。
- 生成器不会直接修改原样本，也不会把样本项目正文复制到其他项目产物。由于原样本含真实项目内容及专属媒体，当前不做整包无差别克隆。

## 3. 运行接线

- `aiSkillService.ts` 从 `AI_SKILL_ROOT` 或 `$AGENT_WORKSPACE/.agents/skills` 安全加载 Skill，校验目录名、frontmatter、普通文件及非符号链接，并计算 SHA-256 版本。
- `aiTemplateCatalog.ts` 为四类文档任务配置唯一 `skillName` 和 `docs` 主模板，同时为 Q&A 登记 `docs/Q&A/` 下的业务样本集合及模板版本；模板缺失时服务端拒绝执行。
- `aiBusinessContentService.ts` 将 Skill、模板版本和模板文件名作为受信任业务规则加入 system message；模板正文及项目证据始终作为不可信输入，样本项目事实不得复用。
- 每个正式产物的元数据记录 `skillName`、`skillVersion` 和 `skillSha256`。
- `GET /api/ai/skills` 返回五个当前可用 Skill 及其可审计版本。
- Q&A 提供投资亮点、核心风险、财务、客户、竞争、合规和资料缺口七类问题；选择问题只填入输入框，不自动发送。
- 用户确认问题后，前端直接调用 `POST /api/ai/qa`。Express 校验用户、项目和会话权限，确定性加载 `answer-project-qa`，仅检索截止日前的当前项目知识片段，并返回事实状态、来源定位、去重证据数量、置信状态和责任声明。
- Q&A 的用户问题和结构化回答保存到当前会话；页面刷新、重新登录或再次打开会话时，通过 `GET /api/ai/qa?conversationId=...` 恢复。
- AI-011 不再向普通 Flue 消息拼接 `【业务技能】answer-project-qa` marker，也不依赖外部 Agent 是否自行识别提示词来决定是否使用 Skill。

## 4. 自动验收

- 官方 `quick_validate.py`：5/5 Skill 通过。
- 独立前向测试：合规性说明与项目 Q&A 均能在证据不足时正确降级，无英文用户文案、样本事实污染、自动发送或证据越界。
- `npm run accept:ai-skills`：40/40 通过，包含逐 Skill 中文化、docs 模板绑定、中文业务契约、Q&A 直连 API 及恢复接线检查。
- `npm run accept:ai-api`：40/40 通过，覆盖 Q&A Skill 版本、docs Q&A 模板版本、来源定位、责任声明、会话恢复、四类文件任务及跨用户隔离。
- `npm run accept:ai-business`：55/55 通过；新增 UTF-16/GB18030 中文编码识别、历史损坏片段清洗、Windows-1252/Latin-1 错译恢复、U+FFFD 拦截、中文字体/语言标记、模板摘要、模板资产继承和样本项目泄露扫描。
- `npm run check`：通过。
- `npm run build`：通过。
- 构建与接口检查：五个快捷入口、Q&A 七分类、选择后仅填入、结构化回答卡及刷新恢复接线均通过；浏览器控制连接本轮不可用，目标浏览器完整 E2E 仍列为发布前人工/自动化门禁。

隔离 API 验收确认：

- API 返回五个 Skill 及 SHA-256 版本。
- 四类文档任务均暴露唯一 Skill 绑定。
- DOCX、Markdown、PPTX 和 PNG 产物均保存实际执行的 Skill 名称、版本和摘要。
- 四类任务完成进度、幂等、取消、失败重试、来源、鉴权下载和跨用户隔离保持通过。
- Q&A 返回实际执行的 `answer-project-qa` 名称、版本和 SHA-256 摘要，同时记录本次采用的 docs Q&A 模板版本及文件清单，且只引用当前项目证据。
- Q&A 责任声明、来源数量和来源定位可通过结构化接口检查；刷新后按会话恢复同一回答。
- 其他用户不能读取该会话的 Q&A 回答，也不能在无项目权限时创建 Q&A 回答。

机器结果：

- `docs/ai-assistant/验收产物/AI-007-AI-011-skill-acceptance.json`
- `docs/ai-assistant/验收产物/AI-007-AI-010/api-acceptance-report.json`
- `docs/ai-assistant/验收产物/AI-007-AI-010/acceptance-report.json`

## 5. 发布边界

1. AI-007～AI-011 的当前应用链路从仓库或 `AI_SKILL_ROOT` 确定性加载 Skill，不依赖外部 Flue 的自动发现。若外部 Flue 的普通 Agent 也需要直接调用这些 Skill，生产环境仍应将同一目录只读挂载到 `$AGENT_WORKSPACE/.agents/skills/`，且不能重复注册同名 Skill。
2. 仍需使用真实模型网关完成五项内容质量 UAT，并由法务、投资业务和财务负责人确认责任边界。
3. AI-007～AI-010 仍需 Microsoft Office/WPS 人工兼容验收；AI-007 需要法务确认免责声明。
4. AI-011 已完成本地构建版本的中文问题选择、确认门禁、结构化回答卡和刷新恢复烟测；发布前仍需在目标部署环境补充真实 Flue/模型网关、失败重试、重新登录及无权限项目不可见的完整 E2E。
5. 修复不会改写或删除历史成功产物；历史文件可能仍保留旧乱码和旧版式，必须通过“重试”或重新点击快捷入口生成新版本。

完成上述事项前，五项能力应保持内部试用或灰度状态。
