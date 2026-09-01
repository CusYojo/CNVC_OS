# sbl_jedi 项目协作指令

本文件适用于整个仓库。若工作目录下另有更具体的项目指令，先读取并遵守其适用范围。默认使用中文沟通；命令、标识符和错误信息保留原文。

## 工作方式与修改边界

- 开始前确认当前目录、分支和 `git status --short`，读取相关源码、配置、测试及需求文档。运行状态以当前进程、接口和数据库证据为准，不把 README 或历史记录当作实时状态。
- “排查、解释、审查”默认只读；“修复、实现”才修改对应功能。代码修改不等于获得迁移业务数据、重启服务、发布生产或推送代码的授权。
- 保留已有未提交和未跟踪文件；只改本次任务相关内容。不执行无差别清理、覆盖或 `git add -A`；需要提交时逐项确认文件。
- 优先使用 `rg` / `rg --files` 定位代码，使用小范围补丁。不要顺手重构、升级依赖或格式化无关文件。
- 修改前说明范围，过程中同步重要发现，结束时交代修改内容、验证结果及未完成项。

## 项目与目录

这是面向 VC、PE 与产业基金团队的 AI 辅助投资管理系统，包含项目管理、线索获取、材料生成、会议、流程及风险等业务。

- 前端：React 18、TypeScript、Vite、React Router、Zustand、Tailwind CSS。
- 后端：Node.js、TypeScript ESM、Express 5、Drizzle ORM 与 MySQL；不能因为存在 `pg` 依赖就推断主业务库是 PostgreSQL。
- 生产模式由一个 Node 主服务同时提供 Web、API、Socket.io、内嵌 JW Agent Runtime 和 Radar 调度。不要恢复已退役的独立服务入口。

主要入口：

- `src/pages/`：业务页面；`src/components/`：复用组件；`src/layout/`：导航与布局。
- `src/lib/api.ts`、`src/store/`、`src/types/`：API 封装、前端状态和类型。
- `server/src/index.ts`、`server/src/routes/`：服务启动和路由。
- `server/src/services/`、`server/src/repositories/`：业务逻辑和数据访问。
- `server/src/contracts/`、`server/src/schemas/`：共享契约与输入校验。
- `server/src/db/`、`server/drizzle/`：数据库配置、模型与迁移。
- `server/tests/`：Node 测试；`server/src/scripts/`：检查、验收和运维脚本。
- `server/scripts/build-platform.mjs`、`start.sh`、`deploy.sh`：构建、启动和部署。
- `.github/workflows/`：CI 门禁；根目录业务计划与验收清单按任务相关性读取。

`dist/`、`server-dist/`、`.runtime/`、日志、上传目录、`server/generated/` 和 AI 产物目录不是日常源码修改目标。不要直接修补编译产物，也不要清理用户材料或运行检查点。

## 环境与常用命令

在仓库根目录执行命令，使用 npm 和现有 `package-lock.json`。优先使用与 CI 一致的 Node.js 22；以当前 `package.json` 和工作流为准，不凭空使用不存在的 `lint` 或 `test` 脚本。

| 用途 | 命令 | 注意事项 |
| --- | --- | --- |
| 安装锁定依赖 | `npm ci` | 仅在需要安装或重建依赖时执行 |
| 前后端开发 | `npm run dev` | 启动 API 与 Vite；先确认端口和现有进程 |
| 单独开发入口 | `npm run dev:web` / `npm run dev:server` | 不与已有同端口服务重复启动 |
| 类型检查 | `npm run check:types` | 前端与后端 TypeScript 检查 |
| 服务端测试 | `npm run test:server` | 会加载 `.env`；运行前检查测试数据库与写入开关 |
| 平台门禁 | `npm run check:platform` | 含类型、数据库边界、单服务和迁移清单检查 |
| 生产构建 | `npm run build` | 可能只生成待激活候选版本 |
| 激活已有候选 | `npm run activate:build:if-present` | 仅在允许更新运行版本且旧服务已停止时执行 |
| 生产模式启动 | `bash start.sh` | 包装 `npm run start:app`，运行 `server-dist/index.js` |

开发 Web 默认 `127.0.0.1:5173`，API 默认 `127.0.0.1:4100`；Vite 代理目标见 `vite.config.ts`，API 端口见 `API_PORT`。实际使用前核对配置和监听，不把默认端口当作已运行的证据。

## 代码与业务契约

- 沿用相邻文件风格和现有组件、API、错误处理及权限服务；后端本地 ESM 导入遵循现有 `.js` 扩展名约定。
- 修改字段时检查数据库模型、服务、路由/输入校验、前端类型和所有展示位置，避免只改一层。
- 结构化业务数据以服务端 MySQL 为权威；Zustand 和浏览器存储不能成为业务事实源，不用 Mock 数据掩盖接口失败。
- 保留会话、CSRF、Origin、项目/文件访问权限、用户隔离和审计链路；不能靠放宽鉴权或关闭安全检查解决验收失败。
- 共享契约应保持可在浏览器安全导入，不能把数据库连接、文件系统或服务端密钥带进前端包。
- UI 修复验证空值、加载失败、权限差异及刷新后状态；涉及布局或交互时检查真实页面，不只检查 JSX 或构建结果。

## 数据库与敏感信息

- 先读 `server/src/db/schema.ts` 与 `server/src/db/config.ts` 再写 SQL，不猜字段名或表名前缀。使用 `mysqlTableName()` / `quoteMysqlIdentifier()`，值使用参数化查询。
- `DB_FREFIX` 是现有配置键的实际拼写，不擅自改为 `DB_PREFIX`。不把本机数据库地址、账号、密码或其他真实密钥写进代码与文档。
- 不输出完整 `.env`、`.runtime/secrets/`、Cookie、令牌或含敏感材料的日志；诊断只展示必要的脱敏字段。
- 运行账号与 DDL 迁移账号分离；不得为方便开发让应用启动时自动执行 DDL。涉及模型变化时同步迁移及必要契约检查，保留已有迁移顺序与历史。
- 迁移、回填、批量评分和重处理先核对目标库、样本与影响范围，优先 preview / dry-run；写入必须在用户授权范围内，并保留审计、恢复依据与幂等性验证。
- 不对业务库打开 `ALLOW_MYSQL_INTEGRATION_TESTS` 或 `ALLOW_MYSQL_ACCEPTANCE_WRITES`。需要写入的集成/验收测试只能使用确认隔离的测试库，不绕过安全守卫。

## AI、线索与文档任务

- 排查线索按“原始来源 → 摄入 → 证据/快照 → 评分 → API → UI”追踪。Worker 运行、原始数据存在或健康检查通过，不代表补全、评级或展示成功。
- 保留来源、实体绑定、证据引用与版本。搜索命中不等于已验证事实；空 AI 输出不能覆盖其他来源的有效数据。
- 涉及模型批量调用时核对实际生效的模型与路由，先验证小样本；配额耗尽时报告并保留可恢复结果，不擅自换模型或持续重试。
- 文档任务的 `ready` 状态不等于交付合格：按任务检查文件存在、下载权限、内容、来源与可读性；版式相关变更需要渲染查看。

## 验证与交付

- 先运行与改动直接相关的测试，再按风险扩大到 `check:types`、`test:server` 和平台门禁。单个测试可按现有脚本方式使用 `node --env-file-if-exists=.env --import tsx --test <测试文件>`，同样先核对环境安全。
- 纯文档变更检查内容、路径、命令是否存在及补丁格式即可，不必为此启动服务、连接业务库或全量构建。
- 检查本次补丁的空白错误（如 `git diff --check`）；新建未跟踪文件还需单独检查，不能把空 diff 当作已验证文件。
- 检查失败时区分本次回归、经证实的既有问题和环境缺失；不能未调查就归因于基线，也不能删除测试或削弱契约来获得通过。
- 用户要求本地生效或部署时，才执行相应运行流程：先构建成功，再确认旧进程归属并停止、激活候选、检查启动条件、重启、验收；保留回滚点。不要用宽泛进程匹配杀掉其他项目。
- 构建脚本在 4100 被占用时保留候选；端口空闲时可能自动激活。不得删除锁文件强行构建，应先核实锁与进程归属。
- 本地发布可结合 `npm run accept:build-release` 和 `npm run check:single-service-prestart`，先阅读脚本确认适用前提；不要将这些验收脚本一概视为只读。
- 运行验收检查 `/api/health`、`/api/health/components`、实际提供的静态资源和相关页面 DOM；业务功能还需真实端到端样本。
- 最终明确区分“源码已改”“测试通过”“本地版本已生效”和“生产已发布”。只报告实际执行过的检查，列出未验证项。

本文件保持精简、稳定；命令或架构变化时同步维护，不记录短期队列数量、临时故障、私人凭据或一次性运行状态。
