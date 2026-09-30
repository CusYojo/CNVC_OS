# 小赛独角兽 Agent 控制台：验证记录

日期：2026-09-30。

## 范围

- 在已登录的全局工作空间右下角挂载小赛独角兽，打开轻量 Agent 侧边面板。
- 根据工作台、项目、新项目发现、机构、尽调、协作、审批和知识库切换上下文与推荐动作。
- 复用现有 `/conversations` 与 JW Agent Runtime，不新增后端入口、数据库表或独立服务。
- 默认只读；任何业务写入都要先列出计划与影响，等待用户确认。
- 支持 Agent 追问、停止生成、错误重试、新对话、Escape 关闭与焦点恢复。

## RED → GREEN

1. 先新增 `server/tests/saiUnicornAgent.test.ts`，定义路由上下文、情境动作、项目授权边界、提示词写入确认与响应式挂载要求。
2. RED：执行单测时因 `src/lib/saiAgent.ts` 不存在报 `ERR_MODULE_NOT_FOUND`；已保留为 `ba7b1b3` 检查点。
3. 实现纯逻辑与 React 面板后，6 项测试首次 GREEN。
4. 审阅会话呈现时补充“只回显用户目标”用例。RED 为缺失 `extractSaiPromptGoal` 导出；实现后 7 项全部 GREEN。

## 自动化验证

- `node --env-file-if-exists=.env --import tsx --test server/tests/saiUnicornAgent.test.ts`：9/9 通过。
- `node --env-file-if-exists=.env --import tsx --test --experimental-test-coverage --test-coverage-include='src/lib/saiAgent.ts' server/tests/saiUnicornAgent.test.ts`：纯逻辑模块行覆盖率 98.21%、分支覆盖率 95.08%、函数覆盖率 100%。
- `npm run check:types`：前后端 TypeScript 检查通过。
- `git diff --check`：通过。
- `npm run build`：生产构建通过；仅有仓库已有的混合导入与大 chunk 警告。

## 形象与动效

- 使用现有侧边栏青绿色马匹作为风格参考，以 ImageGen 生成青玉、宣纸分层质感的成熟独角兽；非卡通吉祥物风格。
- 第一步使用 `stylized-concept` 模式生成透明底角色；第二步使用图像编辑模式改为 1:1 紧裁的 UI 头像。
- 最终工程素材：`public/sai-unicorn-agent.png`，512 × 512，RGBA 透明底。
- 最终编辑提示要点：保留青玉、半透明分层和金色独角；头部和上胸在 1:1 画布紧凑排布，保留 6–8% 透明安全区；禁止背景、文字、Logo、水印与外部阴影。
- 动效仅用于打开、状态和等待反馈，所有动效均响应 `prefers-reduced-motion: reduce`。

## 界面验证边界

- 本地 5173 登录页、标题和无控制台错误已通过隔离浏览器验证。
- 隔离浏览器无现成业务会话，仓库也已退役固定演示账号；未将服务器密码误用为应用登录密码，未对业务库造测试数据。
- 因 Chrome 扩展会话当时无法被验收工具读取，本轮未完成登录后真实数据的桌面/手机截图对比；通过 CSS 断点、安全区、语义标记、Escape/焦点回归与 TypeScript 检查保底。

## 设计依据

- Apple Human Interface Guidelines：Motion（动效应帮助理解状态与层级）。
- Material Components：Side Sheet（侧边补充工作面，不覆盖主任务语义）。
- Microsoft Copilot UX Guidance（透明、人在回路和明确输出边界）。
