# 浙江赛智伯乐股权投资管理有限公司投资中台（一期 MVP）

面向 VC、PE 与产业基金团队的 AI 辅助投资项目管理系统。当前版本已实现 PRD 一期核心闭环：

> 项目录入 → BP/资料沉淀 → AI 项目摘要与问答 → 上会材料生成 → 会议纪要与待办 → 阶段流转与风险跟踪

## 快速启动

环境要求：Node.js 20+，npm 10+。

```bash
npm ci
npm run dev
```

开发模式默认地址：

- Web：`http://127.0.0.1:5173`（端口被占用时 Vite 会自动顺延）
- API：`http://127.0.0.1:4100`
- 健康检查：`http://127.0.0.1:4100/api/health`
- JW Agent Runtime：已内嵌在 API 进程，通过 `/api/agent/*` 与同端口 `/socket.io` 访问
- 组件健康检查：`http://127.0.0.1:4100/api/health/components`

`npm run dev` 会启动 Web 和 API（内含 JW Agent Runtime）。Radar 采集、查询、
微信群聊 Push、同步与定时任务均在 Node 主服务内执行并写入 MySQL。

生产构建与启动：

```bash
npm run build
npm run start:app
```

构建后 `start:app` 是唯一项目启动入口：单个 Node 进程内运行 Express、JW Runtime、
Radar TypeScript 采集器与 MySQL 持久化调度器。项目只监听 `127.0.0.1:4100`，不再启动 3584 或
8121 服务。MySQL 与 LLM Gateway 是外部基础设施，需要另行可用。

生产运行时不会自动执行 MySQL DDL，只核对已应用迁移和必需表；`.env` 的
`DB_USERNAME/DB_PASSWORD` 应使用 DML-only 账号，DDL 迁移账号由部署脚本通过
root-only 文件临时注入。`npm run audit:mysql-privileges` 可检查运行账号是否越权。

旧 Radar JSONL/JSON 仅在迁移归档核对时可从显式 `RADAR_DATA_DIR` 幂等导入：

```bash
npm run migrate:radar
```

线上候选读取、原始事件、来源、采集状态、同步游标和 Job 运行记录均以 MySQL
为准；线上运行不读取旧 JSONL、Excel 或 Python 服务目录。

36氪新项目由独立的 `kr36-project-sync` 采集到 `lead_source_candidates`，再由
`kr36-project-daily-admission` 按日准入正式线索；两套任务默认关闭、独立开关，
采集全部行业中成立于 2025 年及以后的项目；AI、具身智能和半导体标签仅用于统计，不再作为准入条件。历史
`lead-reserve-daily-intake` 已默认停用，仅可通过 `LEGACY_LEAD_RESERVE_INTAKE_ENABLED=true`
进行显式回滚；新链路默认每日准入10个合格候选。
`npm run preview:kr36-projects` 仅访问公开来源并输出预览，不写数据库；
`npm run report:kr36-supply` 只读查看候选库存和当日准入状态。
线索评分使用 `lead_score_jobs` 持久化领取、续租和延迟重试；AI 文档任务的执行租约
保存在 `ai_tasks`，因此应用重启或多实例交接不再依赖进程内队列状态。

Web 登录使用 MySQL `auth_sessions` + HttpOnly Cookie，REST 与 Socket.io
共享同一会话和吊销状态；写请求必须通过 CSRF 与 Origin 校验。
旧 Bearer JWT 默认禁用。

仓库不提供或展示共享演示密码。迁移账号必须在上线前通过受控的
`npm run prepare:weak-password-rotation-roster` 生成 0600 私有轮换清单，再用
`npm run rotate:user-password` 逐一设置强密码并吊销旧会话；生产发布会执行
`npm run audit:password-hashes`，命中已知弱密码时拒绝继续。
历史固定演示账号生成器已永久退役；`SEED_DEMO_USERS` 即使被旧环境误设为 `1` 也不会创建账号。

系统用户、部门、角色、权限和字典均由 MySQL 提供唯一权威；系统管理写入只认数据库权限码
`system.manage`，不按角色显示名称兜底。身份资料与角色/部门绑定在同一事务提交，撤权即时生效。

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
12. 以系统管理员进入系统数据页，查看 MySQL 用户、AI 模板和服务端审计日志。

## 技术结构

```text
src/
  components/     通用 UI、上传、弹窗、抽屉、Toast
  layout/         桌面端主布局和导航
  pages/          13 个独立业务页面
  store/          Zustand 会话内视图状态；业务数据由服务端 API 水合
  types/          完整 TypeScript 领域类型
server/src/
  controllers/    HTTP 控制器
  middleware/     统一错误处理
  models/         接口模型
  routes/         REST API
  services/       AI、审计与文件生成服务
```

前端不持久化权威业务数据，也不使用 Mock 初始值。登录后由 MySQL-backed API 水合；读取失败显示空态，退出会清理跨用户视图状态。浏览器 Local Storage 仅可保存 AI 页面最近选择等非权威偏好。

## 文件生成

`POST /api/materials/generate` 会按材料类型生成有效文件：

- `pptx`：PPT 投资建议书
- `docx`：Word 投资备忘录
- `xlsx`：Excel 财务分析模型
- `ic`：IC 精简版 PPT

文件按创建用户隔离保存在 `server/generated/<userId>/`，并通过受登录会话保护的 `/api/generated/:fileName` 下载；旧 `/generated/*` 匿名静态链路已停用。生成内容带内部资料声明和资料不足提示，避免将 AI 初稿误当作最终投资结论。

## API 契约

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

## 后续生产集成

- 登录已切到 MySQL 用户 + HttpOnly 服务端会话；正式 SSO、TLS Secure Cookie、密钥轮换和统一 IAM 仍需按迁移门禁完成。
- 业务数据、会话、任务、Radar 与调度状态已使用 MySQL；对象存储和生产文件归档仍需接入。
- AI 对话和专业任务使用 JW Runtime/统一 LLM Gateway；目标网关和模型必须在生产单独验收。
- 当前知识检索使用 MySQL 片段；如接入向量库，必须保留项目权限与片段来源。
- 外部风险源：在风险服务层接入工商、法院、舆情等数据，人工录入与处置流程保持不变。

## 一期边界

当前是一期 MVP。核心业务 API 和持久化已迁到 MySQL；仍不包含正式 SSO、实时工商/法院/舆情 API、复杂多基金隔离、在线 Office 编辑、电子签和 LP Portal。生产发布范围以迁移验收清单为准。
