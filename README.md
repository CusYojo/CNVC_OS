# 浙江赛智伯乐股权投资管理有限公司投资中台（一期 MVP）

面向 VC、PE 与产业基金团队的 AI 辅助投资项目管理系统。当前版本已实现 PRD 一期核心闭环：

> 项目录入 → BP/资料沉淀 → AI 项目摘要与问答 → 上会材料生成 → 会议纪要与待办 → 阶段流转与风险跟踪

## 快速启动

环境要求：Node.js 20+，npm 10+。

```bash
npm ci
npm ci --prefix cybernaut-assistant
npm run dev
```

开发模式默认地址：

- Web：`http://127.0.0.1:5173`（端口被占用时 Vite 会自动顺延）
- Mock API：`http://127.0.0.1:3100`
- 健康检查：`http://127.0.0.1:3100/api/health`
- Agent Runtime：`http://127.0.0.1:3584`
- Agent 健康检查：`http://127.0.0.1:3584/health`

`npm run dev` 会同时启动 Web、API 和 `cybernaut-assistant`。如只调试
Agent Runtime，可运行 `npm run dev:agent`；启动后可运行
`npm run check:agent-runtime` 验证服务契约。

生产构建与启动：

```bash
npm run build
npm start
```

构建后 Express 会同时托管前端、API 与生成文件，访问 `http://127.0.0.1:3100`。

演示账号（密码均为 `123456`）：

- 投资经理：`lin@cybernaut.com`
- 系统管理员：`admin@cybernaut.com`

## 页面路径

| 页面 | 路径 |
|---|---|
| 登录 | `/login` |
| 首页工作台 | `/` |
| 项目管理 | `/projects` |
| 项目详情 | `/projects/:id` |
| 项目获取池 | `/sourcing` |
| AI 智能助手 | `/ai` |
| 上会材料生成 | `/materials` |
| 会议纪要 | `/meetings` |
| OA 项目流程 | `/workflow` |
| 风险预警 | `/risks` |
| 投后工具 | `/post-investment` |
| 知识库 | `/knowledge` |
| 系统管理 | `/system` |

## 推荐验收 Demo

1. 使用投资经理账号登录。
2. 在工作台点击“创建项目”，创建一个 AI 医疗项目。
3. 在项目详情上传 BP，观察上传、解析与知识库状态。
4. 生成项目 AI 摘要，查看亮点、风险、尽调问题、缺口和来源。
5. 打开 AI 助手询问“这个项目最大的风险是什么？”，检查答案来源与置信度。
6. 打开上会材料，完成项目/模板选择、资料检查、大纲确认和文件生成。
7. 下载真实生成的 PPTX、DOCX 或 XLSX 初稿。
8. 新建项目会议，粘贴会议文本，生成纪要与 3 项待办。
9. 回到工作台查看会议待办。
10. 在 OA 流程中将项目从初筛流转至立项/尽调。
11. 新增风险事件，检查工作台、风险列表和项目详情同步。
12. 进入系统管理查看用户、角色权限、模板和审计日志。

## 技术结构

```text
src/
  components/     通用 UI、上传、弹窗、抽屉、Toast
  layout/         桌面端主布局和导航
  mock/           一期演示数据
  pages/          13 个独立业务页面
  store/          Zustand 业务状态与联动动作
  types/          完整 TypeScript 领域类型
server/src/
  controllers/    HTTP 控制器
  middleware/     统一错误处理
  mock/           服务端 mock 数据
  models/         接口模型
  routes/         REST API
  services/       AI、审计与文件生成服务
```

前端业务状态会持久化到浏览器 Local Storage，刷新后仍可继续演示。清理键 `cybernaut-investment-mvp-v7` 可恢复初始演示数据。

## 文件生成

`POST /api/materials/generate` 会按材料类型生成有效文件：

- `pptx`：PPT 投资建议书
- `docx`：Word 投资备忘录
- `xlsx`：Excel 财务分析模型
- `ic`：IC 精简版 PPT

文件保存在 `server/generated/` 并通过 `/generated/:fileName` 下载。生成内容带内部资料声明和资料不足提示，避免将 AI 初稿误当作最终投资结论。

## Mock API

分页接口统一返回：

```json
{ "list": [], "total": 0, "page": 1, "pageSize": 20 }
```

错误统一返回：

```json
{ "code": "INVALID_ARGUMENT", "message": "错误说明", "details": null }
```

当前提供的主要端点：

- `POST /api/auth/login`
- `GET /api/projects`
- `POST /api/projects`
- `POST /api/ai/chat`
- `POST /api/ai/project-summary`
- `POST /api/ai/bp-parse`
- `POST /api/ai/meeting-summary`
- `GET /api/ai/jobs/:id`
- `POST /api/materials/generate`
- `GET /api/users`
- `GET /api/templates`
- `GET /api/audit-logs`

## 接入真实服务的位置

- 登录/SSO：替换 `server/src/routes/index.ts` 中的 `/auth/login`，在前端增加真实 token 刷新。
- 数据库：将 `src/store/useAppStore.ts` 的动作改为调用 API，再把 `server/src/mock/db.ts` 替换为 ORM Repository。
- 文件存储与解析：替换 `addFile` 模拟过程，接入对象存储、Office/PDF 文本提取和异步任务队列。
- LLM/RAG：替换 `server/src/services/aiService.ts`，保留现有 `answer + sources + confidence` 返回契约。
- 向量库：在资料解析完成后写入向量库，检索结果必须保留项目权限与片段来源。
- 外部风险源：在风险服务层接入工商、法院、舆情等数据，人工录入与处置流程保持不变。

## 一期边界

当前是可交互、可演示、方便后续接真实接口的 MVP。账号密码、文件解析、语音转写、AI/RAG、通知与大部分业务 API 使用本地模拟；不包含实时工商/法院/舆情 API、复杂多基金隔离、在线 Office 编辑、电子签和 LP Portal。
