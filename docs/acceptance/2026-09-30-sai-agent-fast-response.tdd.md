# 小赛 Agent 快响应与有效反馈：验证记录

日期：2026-09-30。

## 问题证据

- 小赛与完整 AI 助手共用现有 `/conversations` 和 `/agent/conversations/:agentId/messages` API，由 4100 端口的单一 Node 服务内嵌运行 JW Agent Runtime。
- 两者在未显式选择模型时均使用 `interactive-assistant` 路由；当前该路由已配置为 `Doubao-seed-2-0-mini`。
- 改造前本地健康指标显示近 15 分钟 7 次 Agent 请求中，可观测的首字延迟平均 91,692 ms，p50 为 71,949 ms，最大 111,435 ms。
- 界面原本在首字到达前只显示通用“思考中”，用户无法确认已读取的上下文、执行边界和交付结构。

## 改造范围

- 提交后立即展示有事实的本地回执：用户目标、当前项目或工作台摘要、三步处理路径和补充信息上限。
- 通过原有消息 API 显式传递 `responseMode: 'compact'`，不新增端口、服务或数据库变更。
- 轻量模式只暴露项目摘要、材料检索/读取和公开情报等只读工具；不加载 Skill、Plugin 与上传能力提示，不创建 AI 任务或进化提案。
- 最大 Agent 轮次从平台上限 12 收紧为 5；每次用户请求最多允许一轮、一个合并问题的信息补充。
- 首个完整答案必须包含直接结论、可追溯依据或明确缺口、一个可执行下一步。

## RED → GREEN

1. 先新增 `server/tests/saiAgentFastResponse.test.ts`，定义回执事实、只读工具白名单、最多一次补充和答案结构契约。
2. RED：因 `server/src/runtime/jwAgentCompactMode.ts` 尚不存在而报 `ERR_MODULE_NOT_FOUND`；已保留为 `0ee208c` 检查点。
3. 实现纯函数、Runtime 集成和即时回执界面后，新旧 15 项契约测试全部 GREEN。

## 自动化验证

- `node --env-file-if-exists=.env --import tsx --test server/tests/saiUnicornAgent.test.ts server/tests/saiAgentFastResponse.test.ts`：15/15 通过。
- Node 原生覆盖率：相关模块总体行覆盖率 98.30%、分支覆盖率 96.36%、函数覆盖率 100%；`jwAgentCompactMode.ts` 行覆盖率 90.57%。
- `npm run check:platform`：通过，包含前后端类型、数据库边界、生产发布门禁、单服务和迁移清单检查。
- `npm run build`：生产构建成功，新构建已激活且保留回滚版本；仅有仓库已存在的混合导入和大 chunk 警告。
- 本地 `/api/health` 和 `/api/health/components` 返回 `ok: true`，JW Agent Runtime 仍为单服务内嵌运行。
- `git diff --check`：通过。

## 验证边界

- 轻量模式减少了上下文、工具和多轮执行开销，但外部模型 Provider 的首字速度不能由前端或 Runtime 保证。
- 本轮未修改项目中心—新项目发现模块的接口、数据库配置或端口。
- 验收工具未能获取当前已登录浏览器会话；本轮未以真实业务账号发起付费模型对话，避免制造业务数据或额外费用。
