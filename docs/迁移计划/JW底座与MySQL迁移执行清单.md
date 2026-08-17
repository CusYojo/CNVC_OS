# JW 底座与 MySQL 迁移执行清单

> 依据文档：[《智能投资管理平台 JW 底座与 MySQL 统一迁移计划》](./JW底座与MySQL统一迁移计划.md)  
> 使用方式：实施人员完成任务后勾选，并在“证据/备注”中填写提交、日志、截图、报告或工单链接。  
> 完成原则：任务完成不等于阶段通过；每个阶段仍需通过对应验收门禁。

## 1. 清单信息

| 项目 | 内容 |
|---|---|
| 迁移批次 |  |
| 目标环境 | 开发 / 测试 / 预生产 / 生产 |
| 计划开始时间 |  |
| 计划切换时间 |  |
| 项目负责人 |  |
| 技术负责人 |  |
| 数据负责人 |  |
| 测试负责人 |  |
| 运维负责人 |  |
| 安全负责人 |  |
| 回滚负责人 |  |

## 2. 状态和门禁规则

- `[ ]`：未完成。
- `[x]`：已完成并已附证据。
- `阻塞`：存在必须先解决的依赖或故障。
- `不适用`：必须说明理由并由负责人批准。
- P0 任务未完成，不得进入下一阶段或正式切换。
- 数据、权限、密钥、回滚相关任务不得口头确认，必须保留书面或机器可读证据。

## 3. 阶段 0：基线冻结与迁移准备

### 3.1 代码与工作区

- [x] `MIG-0001` 记录当前 `/Users/hyw/Desktop/sbl_jedi` 分支、提交、远端差异和未提交文件清单。（P0）`capture:migration-git-baseline` 已生成 0600 JSON/Markdown 证据，固定项目基线 `main@0a43c7d2`、当前 `codex/mysql-migration`、远端差异和 355 个逐文件状态；报告不采集文件正文或环境变量值。
- [x] `MIG-0002` 记录 `/Users/hyw/Desktop/jw` 底座来源分支和提交。（P0）同一证据固定 `master@80218a4e`、上游差异及 2 个未跟踪文件。
- [x] `MIG-0003` 创建独立迁移分支，禁止直接在未冻结的主分支实施。（P0）当前工作区已从 `main@0a43c7d2` 原样切到 `codex/mysql-migration`，两个分支仍指向同一基线提交，未暂存、提交或覆盖任何已有改动。
- [ ] `MIG-0004` 将用户已有的无关改动与迁移改动隔离。（P0）已完整冻结当前脏文件清单并切到独立分支；但迁移工作开始前没有建立逐文件所有权基线，无法可靠反推哪些旧改动属于用户，故保持未完成且禁止自动清理、暂存或归类。
- [x] `MIG-0005` 记录 Node.js、npm、Python、MySQL、操作系统及关键原生依赖版本。`capture:migration-environment-baseline` 已固定 Darwin arm64、Node 24.16.0、npm 11.13.0、Python 3.12.10、MySQL 8.0.36、LibreOfficeDev 26.8 和 Poppler 26.05；同时明确记录本机 Tesseract/Fontconfig 当前不可用，不用缺失值冒充版本。
- [x] `MIG-0006` 归档当前 `package.json`、锁文件、环境变量样例和启动脚本。已将 11 个批准配置文件写入确定性 `configuration-baseline.tar`，逐文件和归档均有 SHA-256、字节数、权限及 0600 报告；真实 `.env` 明确排除，连续两次归档 SHA-256 一致。
- [x] `MIG-0007` 建立迁移决策记录、问题台账和变更日志。新增《迁移决策与问题台账》，用稳定 `ADR/ISSUE` ID 固定 9 项架构/数据决策和 12 项未关闭问题、处置及关闭条件；详细变更继续由两份执行记录维护，并要求问题关闭同步更新清单和机器证据。
- [x] `MIG-0008` 建立 JW 文件、模块、路由、配置和数据源迁移白名单，并将全部 Aipin 内容列入拒绝清单。（P0）见《JW迁移白名单与Aipin拒绝清单》；本机 37 个 JW 会话均为 Aipin，全部拒绝。
- [x] `MIG-0009` 建立“页面操作 → API → 当前事实源 → 目标 Repository/表 → 审计 → 验收”追踪矩阵；标明真实、Mock、浏览器偏好和已隐藏入口。（P0）新增《页面API事实源与验收追踪矩阵》，覆盖 14 个保留/重定向路由、核心读写操作、MySQL/文件/外部依赖、目标表、审计和验收；另列退场、隐藏、未实现 IM 和仅可作为 UI 偏好的浏览器状态。业务/数据/运维签字仍由 `PRE-012/013、GATE-M0-06` 跟踪。

### 3.2 数据与文件备份

- [x] `MIG-0010` 完成当前 PostgreSQL 全量备份并验证可读取。（P0）`accept:legacy-source-backups` 重新验证 `cybernaut_mvp_dump.sql` 为 55,468,089 bytes、SHA-256 `5afbad0b…d361d2e`，16 个完整 COPY 数据块/16,574 行可流式解析。
- [x] `MIG-0011` 完成迁移白名单内 JW Agent Runtime SQLite 数据备份并验证可读取；Aipin 数据不作为迁移输入。（P0）三个 SQLite 一致性备份的批准 SHA-256、0600 权限和 `integrity_check=ok` 全部重验通过；Aipin 数据仅留在灾备原件，不进入 MySQL。
- [x] `MIG-0012` 完成 Flue SQLite 数据库备份并验证可读取。（P0）两个已发现候选库的一致性备份仍存在，SHA-256 分别匹配批准基线 `1d3a56f0…c2beeb9d`、`51aa2a0d…f022589`，均为 0600 且 `integrity_check=ok`；这不替代生产机“无其他 flue.db”的资产签字。
- [x] `MIG-0013` 完成项目文件、Agent 工作区、产物目录和模板目录备份。（P0）`accept:file-asset-backup-restore` 对当前 `.env` 配置/默认的 7 个本地根完成 0600 tar 归档：249 个文件、113,537,425 原始字节，归档 SHA-256 `33844e8d…3fb973d9`；隔离解包后 249/249 文件内容身份一致，连续两次归档哈希一致。17 个项目原件已获精确批准缺失处置，不再要求纳入备份；7 个 AI 产物和生产未盘点根仍由文件门禁阻断。
- [x] `MIG-0014` 记录各数据源记录数量、最大更新时间、文件数量和总容量。PostgreSQL 为 16 表/16,574 行，最大时间 `2026-07-24T09:22:34.330Z`；JW sessions/project-master/lead-memory 分别为 25 表/2,208 行/最大 `2026-08-05T09:38:33.395Z`、1/0/无时间、24/109/最大 `2026-08-05T09:33:01.613Z`；Flue data/runtime 为 13/1/无时间、13/67/最大 `2026-08-06T10:40:56.489Z`。当前 7 个文件根为 249 文件/113,537,425 bytes，最大 mtime `2026-08-10T06:31:33.839Z`。生产源是否还有其他根仍由 `MIG-0017~0019` 和生产盘点门禁跟踪。
- [ ] `MIG-0015` 对数据库备份和文件备份执行至少一次恢复演练。（P0）MySQL 当前目标库已完成隔离恢复并校验 DDL/行数/内容哈希；本地 7 个文件根也已从 113,835,008-byte tar 隔离恢复，249 个文件内容身份与源完全一致且临时恢复目录已清理。17 个项目原件已批准永久缺失；生产文件根、7 个 AI 产物和异地介质恢复仍未完成，故不整项勾选。
- [ ] `MIG-0016` 记录备份保存位置、保留周期、访问权限和恢复负责人。技术基线已写入《MySQL备份恢复手册》并由 `accept:mysql-backup-inventory` 核验：默认本地根、35 天保留、目录 0700/文件 0600、备份/恢复/批准三个责任角色、168 小时本机与 26 小时生产新鲜度、30 天恢复演练周期均已固定；当前正式备份 73 表/67,708 行与相邻报告 SHA/范围一致。报告同时明确当前仅 1 份本地介质，生产异地位置、静态加密确认和正式责任人尚未配置，生产模式会失败关闭，故不整项勾选。
- [ ] `MIG-0017` 从生产 `pg_catalog` 导出表、列、索引、约束、触发器、扩展和容量快照，并与 `schema.ts`、启动 DDL 和修复脚本对比。（P0）
- [ ] `MIG-0018` 盘点 Radar JSONL、微信群聊目录、采集状态 JSON、公众号 Excel、`lead_reserve`、游标、cron/timer 和未入池记录。（P0）
- [ ] `MIG-0019` 对项目原文件、旧 `/generated`、AI 产物、自定义模板、Agent workspace、Skill/模板和 Radar 文件生成含归属、大小、mtime、SHA-256、权限的 manifest。（P0）最新本地 `inventory:files` 覆盖 7 根、240 个在线文件和 113,548,136 bytes，含数据库归属/大小/mtime/SHA，在线未决归属为 0；另有 67 个可恢复隔离原件。17 个项目原件已按精确 ID 批准缺失并落账；7 条 AI 产物旧机路径和生产全部根批准仍未闭环，因此不整项勾选。

### 3.3 契约与回归基线

- [x] `MIG-0020` 固化当前页面路由清单和导航截图。新增《迁移契约与交互基线》，固定 15 个保留/重定向/受保护前端路由；一次性隔离 MySQL Schema 和 `.invalid` 合成管理员生成登录、首页完整导航、AI 助手、公共线索池和系统管理 5 张 0600 截图，未使用生产业务数据。机器证据记录每张图的字节数和 SHA-256。
- [x] `MIG-0021` 固化当前 REST API、错误格式和鉴权契约。基线锁定 13 个 `/api` 挂载组并动态抽取 112 条 REST 方法定义；统一错误为 `code/message/details/requestId`，认证固定为 MySQL 服务端 Session、CSRF/Origin、角色和项目访问复核。源文件 checksum 与复验命令已固化。
- [x] `MIG-0022` 固化当前 AI 助手会话、文件、任务卡和产物交互基线。基线覆盖会话、流式消息 Part、停止/恢复、项目文件、六类任务卡和受权产物；真实 JW 多轮证据继续作为动态验收。隔离浏览器同时发现并修复无项目时输入框显示 `undefined`，现明确提示先选择项目。
- [x] `MIG-0023` 固化线索池采集、同步、主体审查、评分、补全和转项目链路。基线固定不可变捕获→主体→研究→初筛→人工复核→正式线索→评分→有来源补全→单事务转项目，并绑定 Radar/公开情报/人工复核的重复主体失败关闭契约及验收命令。
- [x] `MIG-0024` 建立核心业务冒烟测试和人工回归步骤。（P0）已增加 `npm run check:mysql`，覆盖核心 CRUD、JSON 查询、聚合、AI 任务和清理。
- [x] `MIG-0025` 建立公司、项目、团队、实验室和论文线索金标样本集。SHA-256 锁定的 `lead-subject-gold-v1` 包含公司、项目、团队、实验室、论文五类正样本及噪声、多主体负样本，真实 `gpt-5.6-sol` 连续两轮 10/10；`accept:migration-fixture-readiness` 另锁定重复主体、弱来源和冲突来源准备契约，全部为安全合成资料。
- [x] `MIG-0026` 记录旧系统已知问题，避免迁移后被误判为新增缺陷。新增《旧系统与迁移环境已知问题基线》，将 `ISSUE-001～012` 逐项标记为旧数据/旧文件、迁移环境、生产治理、外部网关或批准延期，并明确各项不可错误外推的验收结论；机器基线校验 12 个 ID 完整存在。
- [x] `MIG-0027` 固化 Aipin 模块、API、表、队列、配置、页面和进程特征，供静态扫描及验收使用。（P0）《JW迁移白名单与Aipin拒绝清单》固定代码/数据拒绝域；`check:aipin-exclusion` 同时核验 159 个活动运行时/配置文件、部署/.env 配置、环境变量名、PostgreSQL/Flue 迁移表白名单、JW 备份 SHA/SQLite 基线及目标 MySQL 62 张表和全部 546 个文本/JSON 列，严格模式发现任一命中即退出 2。
- [x] `MIG-0028` 对 OA 审批/流程日志、投后更新、通知已读、旧材料记录、组织字典和模板逐项确认正式化、只读归档或退场。（P0）OA/流程日志以及组织、角色、权限、字典正式化到 MySQL；AI 模板作为 `ai_task_templates` 只读展示；旧材料页转统一 AI 任务，投后和通知继续退场。浏览器本地组织/角色/字典写入永久禁止。
- [ ] `MIG-0029` 固化六类专业 AI 任务的内容、来源、版式、字体和 Office/WPS 渲染金样，并记录 Python、LibreOffice、Poppler、Tesseract 及字体版本。（P0）

### 3.4 阶段门禁

- [ ] `GATE-M0-01` 旧系统可以从备份恢复。（P0）
- [ ] `GATE-M0-02` 核心功能均有可重复验收方法。（P0）
- [ ] `GATE-M0-03` 迁移分支和工作区隔离完成。（P0）独立 `codex/mysql-migration` 分支及完整脏文件证据已建立；既有用户改动与迁移改动尚未形成可验证的逐文件归属，因此不整项勾选。
- [ ] `GATE-M0-04` 负责人批准进入 MySQL Schema 实施阶段。（P0）
- [x] `GATE-M0-05` JW 迁移白名单和 Aipin 拒绝清单已完成评审。（P0）`ADR-003` 已采用，白名单/拒绝清单、源数据基线、严格排除报告及 `MIG-0008/0027/0201/0707/0726`、`DEL-013` 证据闭合。最新复验 214 个活动文件、82 张目标表、688 个文本/JSON 列均 0 Aipin 命中，37 个拒绝会话/2,168 条消息目标写入 0；任何新来源或哈希变化必须重新评审。
- [ ] `GATE-M0-06` 权威数据源矩阵、非数据库资产清单和页面功能追踪矩阵已由业务、数据和运维共同批准。（P0）
- [ ] `GATE-M0-07` 三份迁移文档、决策记录和清单已纳入版本控制并绑定基线提交。（P0）

## 4. 阶段 1：MySQL Schema 与 Repository

### 4.1 MySQL 基础设施

- [ ] `MIG-0101` 确认 MySQL 部署方式、拓扑、高可用、备份和恢复目标。（P0）
- [ ] `MIG-0102` 创建开发、测试、预生产和生产数据库及最小权限账号。（P0）当前 `.env` 指向的目标已完成正式换号：Runtime 仅 `SELECT/INSERT/UPDATE/DELETE`，Migration 仅目标 Schema DML+`CREATE/ALTER/DROP/INDEX/REFERENCES`，两账号精确绑定当前应用来源，`.env` 和迁移凭据文件均为 0600，并保留 0600 回滚副本。权限审计、Runtime DML/DDL 拒绝、Migration DDL、独立迁移、生产只读 Schema 验证和单服务实启通过。但本项要求开发/测试/预生产/生产四个环境各自的正式数据库与凭据，其他环境未提供，故不整项勾选。
- [x] `MIG-0103` 配置字符集、排序规则、时区、连接数和慢查询日志。`accept:mysql-operational-config` 已在 `.env` 指向的 MySQL 8.0.36 实例实测：数据库与应用连接均为 `utf8mb4/utf8mb4_0900_ai_ci`，全局/会话时区均为 `+08:00`，`max_connections=2520`（应用池 10、队列 40、历史峰值 18），慢查询日志开启、阈值 1 秒并写 `TABLE`。门禁首次发现 mysql2 仅配置 `utf8mb4` 时连接排序规则会退回 `utf8mb4_general_ci`，现已改为显式批准排序规则并加入发布门禁；0600 报告不含主机、库名、用户名或密码。
- [ ] `MIG-0104` 配置 TLS 或受控网络访问。
- [x] `MIG-0105` 建立数据库连接池、健康检查、超时和重试策略。连接池固定大小、有界等待队列、10 秒建连超时、TCP keepalive 和结构化脱敏错误；统一组件健康检查包含多项 MySQL 只读查询，运行配置门禁另执行 `SELECT 1`。`accept:mysql-resilience` 通过故障代理实测队列耗尽、断网失败关闭、同一 Pool 恢复后重连、已提交数据保留和未提交事务回滚；业务 Job 使用幂等键/租约重试，不对未知提交状态的任意事务盲重放。
- [ ] `MIG-0106` 建立数据库备份任务和恢复演练流程。（P0）已建立 `db:backup`、`accept:mysql-backup-inventory`、`accept:mysql-backup-restore` 和《MySQL备份恢复手册》；一致性备份、报告配对、SHA/权限/新鲜度、同库隔离前缀恢复、恢复 RTO 强制、逐表 DDL/行内容校验及精确清理实测通过。旧 `DB_RESTORE_*`/`CREATE DATABASE` 路径已去除，恢复只使用拆分的 Migration 账号。生产自动备份应由外部 MySQL/基础设施平台承担，不新增项目 service/timer；异地加密介质、生命周期任务和正式负责人尚未批准，故不整项勾选。

### 4.2 统一 Schema

- [x] `MIG-0110` 完成 `iam_*` 身份权限表设计。按 `ADR-013`，计划前缀是概念域：`users/auth_sessions/auth_legacy_bearer_policy/iam_user_mappings/identity_resolution_issues/project_members` 继续承担身份与项目授权；迁移 `0036/0037` 新增部门、角色、权限、用户绑定和字典表，并以 `system.manage` 作为系统管理写权限的唯一数据库权威，不复制第二用户表或浏览器事实源。
- [x] `MIG-0111` 完成 `investment_*` 投资业务表设计。项目、线索、会议/参与人、待办、风险、OA 请求/节点/记录/流程日志及评分 Job 已进入现有兼容表名；命名裁决和只读架构门禁阻止复制 `investment_projects` 等第二套事实表。
- [x] `MIG-0112` 完成 `knowledge_*` 文件知识库表设计。`project_files/project_file_versions/file_chunks/knowledge_chunks/ai_summaries` 分别承担元数据、不可变版本、解析块、检索投影和摘要；文件字节完整性仍由独立 manifest/恢复门禁跟踪，不因 Schema 完成而关闭缺失原件。
- [x] `MIG-0113` 完成 `agent_*` 会话消息表设计。`agent_conversations/agent_messages/agent_message_parts` 与两张来源映射表覆盖会话、消息、内容/工具 Part、序号、幂等和旧源追踪；Repository 真实 MySQL 并发与恢复专项已通过。
- [x] `MIG-0114` 完成 `ai_task_*` 专业 AI 任务表设计。任务、来源、产物、系统/自定义模板及模板分析进度已落正式表，领取租约、重试、取消和产物完成事务由 AI Task Repository 统一承载。
- [x] `MIG-0115` 完成 `lead_pipeline_*` 线索处理表设计。迁移 `0031` 后，原始事件、当前状态、追加式状态历史、Prompt/Skill/Schema/工具版本、Run、Decision、Evidence、Review 和 Entity Match 已落 MySQL。按 `ADR-010`，业务状态由 `lead_pipeline_items/transitions` 保存，通用调度租约和重试由 `runtime_jobs/runtime_job_runs` 保存，不再复制一张产生双权威源的专用 Job 表。最新 81 张业务表/133 条外键及事件、决策、复核、实体匹配跨表不变量通过。
- [x] `MIG-0116` 完成 `runtime_*` 模型、能力、插件和 IM 配置表设计。按 `ADR-013` 映射到 `ai_model_*`、`ai_capabilities`/Binding/会话选择和 `im_*`；`ai_capabilities.kind` 统一覆盖 Skill/Agent/MCP/Plugin。Provider/Bot 只有 AES-GCM 密文、提示和指纹列，配置使用 enabled/version/唯一键；不新增重复的 `runtime_models/runtime_plugins/runtime_im_bots`。
- [x] `MIG-0117` 完成 `scheduler_*` 调度、租约和运行记录表设计。按 `ADR-013` 使用 `runtime_jobs/runtime_job_runs`：到期时间、lease owner/expiry、当前 Run、连续失败、结果/错误和级联历史完整；行锁、心跳、终态与多实例过期接管已有真实 MySQL 验收，不复制 `scheduler_jobs`。
- [x] `MIG-0118` 完成 `audit_*` 审计与安全事件表设计。操作、拒绝和认证安全事件追加到 `audit_logs`，包含用户、模块、动作、结果、request ID、IP 和时间索引；迁移事件由 runs/issues/mappings/CDC 控制面承载；模型、能力和 IM 的变更前态由 `admin_configuration_revisions` 加密追加保存。运行态审计和配置历史均只追加、不更新或删除；测试夹具清理由脚本边界独立允许。
- [x] `MIG-0123` 确认目标 Schema 不包含 Aipin 表；`lead_pipeline_*` 按当前项目业务独立设计，不映射 Aipin Schema。（P0）`check:mysql` 盘点当前前缀下 81 张业务表和 1 张内部迁移台账表并显式拒绝任何 Aipin 表；模型配置、线索、评分、模板分析、OA、系统管理与 Agent 全局运行许可表均由当前项目迁移 SQL 独立建立。
- [x] `MIG-0119` 明确 UUID、JSON、UTC 时间、布尔值和长文本映射。`check:mysql` 已实测标准 UUID、JSON、BOOLEAN、已知 UTC 毫秒时刻和 70,000 字符 LONGTEXT 往返一致；`accept:timezone` 进一步验证现有 `+08:00 DATETIME(3)` 历史口径经显式 Schema 映射后保持同一 UTC 瞬间，API 输出 UTC ISO、页面固定显示 `Asia/Shanghai`，并覆盖数据库默认时间。
- [x] `MIG-0120` 为 PostgreSQL 部分唯一索引设计 MySQL 等价约束。按 `ADR-014`，OA 活动流程使用可空 `active_key` + `uq_oa_active_project`，终态写 NULL；无条件唯一键用普通唯一索引。活动线索名称目标为条件生成可空列 + 唯一索引，但迁移 `0002` 已因 9 组/25 条同名线索（另有 33 组/82 条公司名重复）删除旧约束，必须先关闭 `MIG-0125/ISSUE-006` 才能用新迁移恢复；本项只完成等价设计，不冒充去重完成。
- [x] `MIG-0121` 为中文检索建立方案并完成最小效果验证。保留“MySQL 按 scope/refId 权威隔离取块 + 应用层中文 2-gram/英文词排序”方案，避免依赖 MySQL 未启用的中文全文 parser；检索统一做 NFKC 全半角归一化、来源名+正文加权、短语/词覆盖评分和稳定同分排序。SHA-256 锁定的 `chinese-retrieval-gold-v1` 使用 8 份技术、客户、财务、股权、风险、团队、竞争和退出代表资料及 8 个问题，实测 Recall@3、Top-1、MRR 均为 1.0，并通过项目/Scope 隔离、无关查询零结果、全角 `ＣＥＯ`、三次顺序一致和夹具清零；已加入发布门禁。
- [x] `MIG-0122` 建立旧 ID 到新 ID 的迁移映射表。已建立 `iam_user_mappings`，记录在线 PostgreSQL 与完整备份两套用户 UUID 到目标用户的映射。
- [x] `MIG-0124` 固定 MySQL 8.x 小版本、InnoDB、`utf8mb4`、排序规则、`sql_mode`、隔离级别和服务端时区。批准契约为 MySQL 8.0.36、InnoDB、utf8mb4/utf8mb4_0900_ai_ci、READ-COMMITTED、+08:00 及固定严格 sql_mode；`check:mysql` 对服务器变量、82 张目标物理表和 133 条外键强校验，漂移即失败。
- [ ] `MIG-0125` 输出邮箱、公司名、线索名的大小写、空白、全半角和 Unicode 归一化冲突报告，并完成处置。（P0）`audit:mysql-normalization` 已输出机器/人工报告：邮箱和项目无冲突；线索名 9 组/25 条、线索公司名 33 组/82 条精确重复，共 42 组/107 次引用/82 条唯一线索。0600 裁决底稿和严格验证绑定报告 SHA、稳定组 ID、全行指纹、审批元数据及跨组一致性。新增可回放执行器在单事务内锁行复核、保护已转项目主记录、迁移评分任务/Pipeline/Entity Match/储备映射、保留从记录完整快照，并原子写 Run/Issue/Mapping/Audit；9 项真实 MySQL 探针验证四类引用各迁移一次后整体回滚，正式写入 0。当前 42 组仍为 `pending`，预览按设计退出 2；业务逐组裁决和正式 apply 尚未完成，故不勾选。
- [x] `MIG-0126` 明确审批、流程日志、投后、通知、材料、组织字典和模板的目标表及生命周期。《附属业务域迁移与退场报告》逐域裁决：OA/流程日志、组织/角色/权限/字典、模板和材料生成能力正式迁移；旧投后页、通知/已读和旧材料页退场。17 个项目原件已获精确批准永久缺失；页面退场不替代剩余 7 个 AI 产物和生产全量文件根门禁。
- [x] `MIG-0127` 建立姓名型 owner/collaborator/assignee 到用户 ID 的映射规则，隔离重名、离职和无法映射记录。（P0）迁移 0013 新增项目负责人、待办负责人、风险执行人、会议主持人的稳定用户 ID，以及项目成员、会议参与人关系表；仅“名称唯一且账号启用”的用户自动绑定，重名、禁用和缺失用户进入 `identity_resolution_issues`，鉴权不再读取姓名字段。`accept:identity-mapping` 已验证默认拒绝与派生 ID 防篡改。

### 4.3 Repository 与事务

- [x] `MIG-0130` 定义 Repository 目录结构、接口规范和错误约定。新增 `repositories/contracts.ts`、领域接口、MySQL 实现目录和组合根；稳定区分 NOT_FOUND/CONFLICT/INTEGRITY/TRANSIENT/UNKNOWN，穿透 Drizzle `cause` 映射 MySQL 错误且不包装业务异常。《MySQL Repository 接口与事务规范》固定依赖方向、空集合、脱敏、事务和并发规则，静态门禁持续校验。
- [x] `MIG-0131` 实现 `UserRepository` 和权限 Repository。身份管理 Service 已移除 Drizzle/Schema 依赖；登录/会话、系统用户入口、密码轮换、OA、项目/线索、AI Task、IM、身份解析与宿主工具的用户访问，以及项目成员原子替换真实走接口。运行态 Route/Service/Runtime/Middleware 直接导入 `users` 表的数量为 0，并由静态门禁约束。`accept:identity-repository` 6 项在 MySQL 验证并发唯一冲突、两类失败回滚、成员原子提交和会话撤销；其他领域 Repository 已在 `MIG-0133/0134/0136` 完成并通过专项。
- [x] `MIG-0132` 实现项目、线索、会议、待办、风险 Repository。均已切 MySQL；会议、待办、风险查询进一步复用项目访问 SQL，并按创建者/执行人收口无项目记录。
- [x] `MIG-0133` 实现 Agent 会话、消息、内容块和工具调用 Repository。接口、MySQL 实现、组合根及运行路径迁移完成；会话对写入、消息序号、外部 ID 幂等、终态保护、并发元数据合并、工具中断与流式恢复均已收口，运行态直接导入四张 Agent 会话表的数量为 0。来源绑定轮换后，7 项真实 MySQL 专项全部通过。
- [x] `MIG-0134` 实现 AI 任务、来源、产物和模板 Repository。任务创建/幂等、领取/续租/取消、失败/自动恢复/停机释放，主产物/预览/来源/完成态，自定义模板、模板分析进度和系统模板注册表均通过 `AiTaskRepository`；运行态对六张领域表的直接导入为 0。主产物、预览、来源和任务完成态以单事务提交，并发取消或租约变化时整体回滚；6 项真实 MySQL 专项全部通过。
- [x] `MIG-0135` 实现线索 Pipeline Job、Run、Decision、Evidence Repository。Pipeline 业务状态与通用租约调度分别由现有事件/Runtime Job Repository 承载；Run/Decision/Evidence/Review/Version 和新增 Entity Match 均由宿主事务服务实现。Entity Match 使用 SHA-256 幂等键追加候选与最终处理，保留规范主体、别名、匹配类型、候选 Lead 快照和事件/决策/复核绑定；专项 4 项及人工复核 14 项、公开情报 9 项、Radar/Pipeline 11 项验收通过。
- [x] `MIG-0136` 实现 Provider、Model、Capability、IM Repository。配置与 IM Service 均不再导入 Drizzle、mysql2、数据库客户端或本领域表。`AiConfigurationRepository` 接管 Provider/Model/Route、默认模型并发锁、能力目录同步、能力/授权、测试结果和会话选择；`ImIntegrationRepository` 接管 Bot、绑定、线索推送规则、Outbox 并发幂等/`SKIP LOCKED` 租约、投递日志与终态原子提交、入站唯一键去重。两组各 6 项真实 MySQL 专项全部通过。
- [x] `MIG-0137` 定义跨表事务边界、幂等键和乐观锁规则。《MySQL领域命名与约束裁决》已固定身份/成员/会话、Agent 消息/Part、AI Task/产物/来源、Provider/Model/Capability、IM Outbox/投递、周期 Job 和 OA 的事务边界；数据库唯一键、外部 ID/任务幂等键、lease owner/expiry、`FOR UPDATE`/`SKIP LOCKED` 与 version/lock_version 分层裁决并发。五组 Repository 共 31 项真实 MySQL 专项支撑该结论。
- [x] `MIG-0138` 实现 MySQL Schema 迁移、回滚和种子数据命令。（P0）按 `ADR-015` 固定一致性迁移前备份→独立账号只前进迁移→`mysql-core-seed-v1` 版本化种子→发布门禁；回退不在活动前缀倒序 DROP，而把备份恢复到全新隔离 `rollback_*_` 前缀，逐表验证 DDL、行数和顺序无关内容 SHA 后再等待 `DB_FREFIX` 切换审批。最新真实隔离验收完成 82 表/69,118 行恢复并只前进到 `0039`，恢复前缀 Schema、版本化种子幂等、不生成演示账号、当前清单唯一台账和 82 表精确清理均通过，活动前缀始终不变；旧清单台账按追加式审计保留，不把历史清单删除为“幂等”。生产最终停写点仍须重建备份；PONR 后有新写入且无反向 CDC 时不得据此宣称无损回切。
- [x] `MIG-0139` Repository 单元测试和并发测试通过。（P0）身份、Agent 会话、AI Task、AI 配置和 IM 五组真实 MySQL 专项共 31 项全部通过；配置历史/回滚再以 10 项真实 MySQL 专项覆盖。最新 `check:mysql` 21 项、74 表/124 外键、严格目标结构、账号分离、生产构建和 147 项静态门禁同时通过。
- [ ] `MIG-0140` 实现 PostgreSQL CDC/变更日志，覆盖新增、更新、物理删除、级联删除、tombstone、watermark、重放和漂移对账。（P0）技术实现/目标端通过，源端未验收：`postgres-trigger-v1` 为 17 张批准表生成 `AFTER INSERT OR UPDATE OR DELETE` 触发器，记录旧 ID、完整 tombstone、操作者、迁移批次、级联标记、全局 sequence 和 txid；MySQL 迁移 `0029` 增加检查点和唯一事件账本。应用器以 `txid < txid_snapshot_xmin(txid_current_snapshot())` 作为安全边界，避免长事务 sequence 先分配后提交造成漏数，并按相互交错的源事务组件提交。隔离目标验收已覆盖乱序、重放、中断、物理/级联删除；当前配置的 PostgreSQL `127.0.0.1:5432` 离线，真实触发器和源端四类写入尚无证据，故不勾选。
- [ ] `MIG-0141` 在 MySQL 影子迁移用户、项目、项目成员和旧 ID 映射，并持续增量追平。（P0）全量映射已稳定；CDC 目标应用器会维护 `legacy_postgres` 用户映射并保留其他实体 ID，但真实源端尚未上线，无法证明“持续追平”，故不勾选。
- [ ] `MIG-0142` 为每个实体声明唯一写入所有者；双写只允许通过统一 Outbox/CDC，不允许业务服务分别向两库写入。（P0）前向应用强制 `PG_CDC_AUTHORITY_MODE=legacy-postgres-authoritative`，缺失时失败关闭；手册明确切换后 MySQL 为唯一所有者并立即停止前向 CDC，且没有反向 CDC 时越过 Point of No Return 后不得无损回切。仍待生产数据负责人签字和旧应用停写取证。
- [x] `MIG-0143` 建立静态门禁：Repository、迁移器和批准的兼容适配器之外不得引用 `pg`、`node-postgres`、`drizzle-orm/pg-core` 或 PostgreSQL 方言。（P0）`check:db-boundary` 仅放行三个历史盘点/迁移工具。
- [x] `MIG-0144` 完成 `ILIKE`、JSONB 函数、GIN、`RETURNING`、类型转换和部分唯一索引的逐调用点替换清单及等价测试。核心查询已通过 MySQL 真实库冒烟。

### 4.4 阶段门禁

- [x] `GATE-M1-01` 空库可以通过一条标准命令初始化。（P0）命令：`npm run db:migrate`。
- [x] `GATE-M1-02` Schema 重复执行不会破坏已有数据。（P0）已重复执行 Schema 和两类数据迁移器。
- [x] `GATE-M1-03` Repository 测试、事务测试和权限测试通过。（P0）五组 Repository 共 31 项覆盖权限、并发、事务失败回滚、乐观锁、租约、幂等和审计；服务测试 156/156，通过账号最小权限与目标结构门禁。
- [ ] `GATE-M1-04` 数据负责人批准进入 JW Runtime 接入阶段。（P0）
- [ ] `GATE-M1-05` 用户、项目、成员和旧 ID 映射已稳定追平，冲突与孤儿记录均有处置结论。（P0）
- [ ] `GATE-M1-06` CDC 可在中断恢复后准确捕获新增、更新、物理删除和级联删除。（P0）目标端隔离演练通过：sequence 3 后中断、续跑至 6，3 新增/1 更新/2 删除/1 级联删除与 6 条唯一事件账本一致；源 PostgreSQL 离线，尚缺真实捕获演练。

## 5. 阶段 2：JW Runtime 接入与 MySQL 持久化

### 5.1 Runtime 模块化

- [x] `MIG-0201` 按白名单明确从 JW 迁移的 Express、Socket.io、Agent、Config、Skills、MCP、插件和文件模块。（P0）白名单和 Aipin 拒绝项见《JW迁移白名单与Aipin拒绝清单》；活动代码门禁持续扫描。
- [x] `MIG-0202` 将 JW 单体服务拆分为 runtime、domain、repository 和 transport 模块。当前分别落在 `runtime/`、`services/`、MySQL `db/` 与 `routes/`，不引入旧 JW 单体启动器。
- [x] `MIG-0203` 保留当前 React/Vite 前端，不引入 JW Vue 页面作为正式页面。（P0）生产构建仍以根 React/Vite 应用为唯一 Web 前端。
- [x] `MIG-0204` 建立统一启动、停止、健康检查和优雅退出流程。唯一入口负责 Schema、恢复、Worker、Socket、HTTP 和 MySQL 生命周期。
- [x] `MIG-0205` 建立统一请求 ID、日志和错误处理。HTTP 统一生成/透传受限请求 ID；AsyncLocalStorage 将请求 ID 关联到下游异步日志和审计写入，所有运行态 console 记录统一补齐 ISO 时间、级别、服务和可空请求 ID，错误响应与预期 4xx 使用固定结构并集中脱敏。Schema 迁移 `0027_add_audit_request_result` 补齐审计结果和请求 ID，真实 HTTP 写入关联及 `accept:structured-logs` 均通过。
- [x] `MIG-0206` 删除或跳过 JW 启动流程中的 Aipin 初始化、路由注册、数据库连接、队列和 Worker 启动逻辑。（P0）活动 Runtime 不含 Aipin 引用，静态门禁阻止回归。
- [x] `MIG-0207` 确认不复制 `aipin-project-service`、`aipin-data-routes`、`aipin-data-mysql-store`、`aipin-processing-queue` 及其专用依赖。（P0）根依赖和生产构建中均不存在这些包。
- [x] `MIG-0208` 从 JW `AgentSessionManager` 抽取不依赖 Aipin、lead-memory、微信 SQLite、独立报告模式和桌面 IPC 的 `AgentSessionCore`。（P0）以 `jwAgentRuntime` 实现等价的最小会话核心，只依赖 MySQL、Claude Agent SDK 和宿主注入的投资 MCP。
- [x] `MIG-0209` 为动态加载、子进程、文件访问、网络目标和数据库访问建立运行 allowlist 与依赖闭包报告。（P0）Runtime 禁用内建 Claude Code 工具、Skills 和文件设置源，强制 `dontAsk`；单一宿主 MCP 仅放行项目摘要、项目搜索、文件列表、文件片段读取、受控 AI 任务创建/查询和公开情报七个工具。项目与任务由服务端稳定身份绑定，公开情报 Python 仅能访问 Bing/Sogou 且请求内容不出现在 argv；子进程统一监督，systemd 使用只读文件系统和显式可写目录。互动 SDK 环境已从继承全部宿主变量收紧为最小白名单，不含 DB/内部密钥；文件、子进程、网络、数据库和动态加载五类越界调用均拒绝并持久化 `denied` 审计，工作目录和模型网关分别受 UUID/路径及 HTTPS/主机白名单约束。

### 5.2 Agent 与会话持久化

- [x] `MIG-0210` 接入 `AgentSessionManager` 和 Claude Agent SDK Runner。`jwAgentRuntime` 按 MySQL 会话创建/恢复 SDK Query，并将流式消息、工具调用和结果持久化。
- [x] `MIG-0211` 将 Agent 会话持久化切换到 MySQL。新会话事务写入 `chat_conversations` 与 `agent_conversations`，列表、订阅和恢复均读取 MySQL。
- [x] `MIG-0212` 将 Agent 消息、思考、工具调用和工具结果持久化切换到 MySQL。JW Runtime 写入 `agent_messages` / `agent_message_parts`，Socket 快照从同一事实源恢复。
- [x] `MIG-0213` 将 Provider/Profile 配置持久化切换到 MySQL。迁移 `0025` 建立 Provider、Model 和七类 Profile 主备路由表；Runtime 统一从 MySQL 解析并在无可用配置时保留迁移期环境变量兜底。
- [x] `MIG-0214` 将当前平台及通用 Agent Runtime 所需的定时任务、队列和运行记录持久化切换到 MySQL；不包含 Aipin 队列。Radar/摄入、评分与 AI 文档任务分别使用 MySQL Job/租约表。
- [x] `MIG-0215` 实现服务重启后的会话恢复和任务恢复。（P0）启动主动将遗留 streaming 会话恢复为 idle，把 running 工具消息/Part 标记为 interrupted/output-error 并保留元数据和顺序；`accept:jw-restart` 7 项通过。AI Task、评分与 Runtime Job 另有 MySQL 租约恢复。
- [x] `MIG-0216` 移除 JW Runtime 对 SQLite 的必需依赖。进程内 JW Runtime 只读写 MySQL `agent_*` 表；SQLite 仅作为离线历史迁移输入。（P0）
- [x] `MIG-0217` 新 Agent 会话只使用阶段 1 已稳定的 MySQL 用户/项目 ID；禁止创建临时身份归属。（P0）用户 ID 来自已回查 MySQL 的 JWT，项目 ID 创建前校验访问权，项目名称由目标表回填而非信任客户端。

### 5.3 Socket.io 与鉴权基础

- [x] `MIG-0220` 接入 Socket.io 服务和 Agent 事件转发。同一 3100 HTTP Server 挂载 `/socket.io`，JW 流式快照按会话事件推送。
- [x] `MIG-0221` 实现 Socket 握手身份验证和会话权限验证。（P0）握手 JWT 回查 MySQL 启用用户，订阅同时校验会话所有者与项目访问权。
- [x] `MIG-0222` 实现连接、断开、重连和服务端主动失效处理。前端自动重连并用 MySQL 快照恢复；服务端周期复核账号/项目权限并断开失效连接。
- [x] `MIG-0223` 约束跨用户和跨项目事件广播范围。（P0）房间名只由服务端已授权的内部会话 ID 生成；跨用户订阅和跨项目会话创建验收均被拒绝。
- [x] `MIG-0224` 完成多连接、并发会话和重连压力测试。本地上限档以 64 个并发 Socket、16 个独立 Agent 会话和 5 轮全量断开重连完成 385 次连接，64 路并发快照全部到达，跨用户接受、握手/订阅瞬时失败和测试身份残留均为 0。首轮压力发现 Socket 查询会与 10 连接/40 等待的 MySQL Pool 形成重连风暴，现由握手、订阅、广播和周期重认证共用默认 8 个许可的全局背压，避免挤占 HTTP/Worker 连接；发布后启动门禁执行安全合成身份基线。
- [x] `MIG-0225` 定义阶段 2 临时 JWT 与目标 IAM 的映射和吊销规则，避免阶段 8 再次改写会话所有者。（P0）已取消临时 JWT 归属：REST/Socket 只接受 MySQL `auth_sessions` 对应的稳定用户 ID，新会话直接绑定该 ID；旧 Bearer 默认拒绝。

### 5.4 单一业务服务骨架

- [x] `MIG-0230` 确认“一个服务”为一个 systemd/容器部署单元、多个受控执行进程，不要求 Python、Office/PDF 和长 AI 任务进入 Node 主事件循环。（P0）`cybernaut-app` 直接启动单个 API/JW/调度器 Node 进程；Flue 与 Radar 常驻 HTTP 子服务均已退场，Radar 改为短时 Job。
- [x] `MIG-0231` 建立 `cybernaut-app` 单一 Node 入口，将 Express、Socket.io、JW Runtime、投资业务 API 和健康检查挂载到同一 HTTP Server。（P0）HTTP、WebSocket 与组件健康均由 `server-dist/index.js` 的 3100 入口提供。
- [x] `MIG-0232` 定义 Node Worker/Python 子进程的 Job/IPC、退出码、心跳、超时、取消、资源上限和日志契约。生产服务与 Runtime 的外部命令统一经 `supervisedProcessService` 启动，捕获退出码/stdout/stderr，支持超时、AbortSignal、进程组 SIGTERM→SIGKILL 和健康观测；MySQL Job/AI Task 提供租约心跳与运行审计，systemd 提供 MemoryMax、CPUQuota、TasksMax 和文件描述符上限。`accept:process-supervisor` 覆盖成功、超时、嵌套进程组终止、停机排空和停止后拒绝新任务。
- [x] `MIG-0233` 实现优雅停机：停止新流量和调度、处理租约、终止超时子进程、刷新游标和审计、关闭数据库连接。（P0）停机依次撤销就绪状态、关闭 Socket、停止 Runtime/评分调度、释放 AI Task 执行租约、终止 JW 会话和受监督子进程、关闭 HTTP 与 MySQL Pool；本地 SIGINT 实启停后 3100/3584/8121 全部关闭且无 Node/Python/Office 孤儿进程。
- [x] `MIG-0234` 多实例调度使用 MySQL Leader Lease/Job Lease，禁止每实例重复运行 cron。（P0）Radar/储备池周期任务使用 `runtime_jobs` 租约；线索评分使用 `lead_score_jobs` 租约；AI 文档任务使用 `ai_tasks` 执行租约与续租。`accept:runtime-job-leader` 实测两个实例并发只有一个租约/Run，同周期不重复，过期 owner 标记 abandoned 后可由另一实例以新 Run 接管；生产发布强制执行该门禁。
- [x] `MIG-0235` 建立迁移期和最终期两份端口、进程、systemd、cron/timer、Nginx、日志和健康检查拓扑清单。（P0）详见《单服务迁移期执行记录-20260808》第 4 节；当前只保留 3100 与 `cybernaut-app.service`。

单服务验证记录见《单服务迁移期执行记录-20260808》。JW Runtime、Socket.io、业务 API、健康检查和 MySQL 调度器现已进入同一 Node/HTTP Server；Radar、评分和 AI 文档任务均已采用 MySQL 租约，并完成并发领取验证。统一子进程监督与优雅停机门禁已在本地通过；目标服务器仍须完成 systemd cgroup、资源限额和生产长任务中断恢复取证。

### 5.5 阶段门禁

- [x] `GATE-M2-01` JW Runtime 不依赖 SQLite 即可完成多轮对话。（P0）`accept:jw-multiturn-live` 通过同一 3100 服务创建随机 `.invalid` 全局会话，向真实 `gpt-5.6-sol` 发送两轮随机挑战；第二轮准确回忆首轮代号，同一 SDK Session ID 延续。MySQL 精确保存 2 条用户消息、2 条助手消息、4 个 Part、连续序号及模型/Turn/耗时/成本状态，工具调用为 0；活动 Runtime 的 SQLite/Flue/3584 引用和 3584/8121 监听均为 0。删除前关闭消息队列和 SDK Query、等待输出循环结束，验收后身份、认证会话、Agent 会话、审计与工作区零残留。
- [x] `GATE-M2-02` 服务重启后会话和消息从 MySQL 正确恢复。（P0）`accept:jw-restart` 验证遗留流式会话、运行中工具、消息/Part、元数据、顺序、快照和幂等恢复。
- [x] `GATE-M2-03` Socket 鉴权和事件隔离测试通过。（P0）`accept:socket` 已验证握手、所有者订阅、跨用户/跨项目拒绝、禁用账号 REST/Socket 失效、推送、重连和无效令牌；验收只创建随机 `.invalid` 身份并精确清理，不再挑选或临时禁用现有业务用户。64 连接/16 会话/5 轮重连上限档在全局 MySQL 背压后无瞬时失败、无错误广播和无残留。
- [ ] `GATE-M2-04` Runtime 模块边界通过代码评审。（P0）
- [x] `GATE-M2-05` 构建产物、注册路由、目标 Schema、启动日志和运行进程均不包含 Aipin。（P0）`check:single-service` 扫描活动文件，Aipin 只允许出现在离线 Flue 源拒绝逻辑；目标 MySQL 表名盘点无 Aipin。
- [x] `GATE-M2-06` Agent Runtime 的依赖闭包、运行网络/文件/子进程/数据库访问均符合 allowlist。（P0）内建工具/Skills/设置源关闭，宿主 MCP 固定七个白名单工具、12 Turn/5 美元默认预算；公开情报网络固定两域名，项目文件和 AI 任务均经宿主作用域服务，外部进程统一监督。
- [x] `GATE-M2-07` 单一业务入口可独立启动、停止和接受 HTTP/Socket 流量，子进程故障不会导致主服务退出。（P0）`start:app` 实启停、HTTP 组件健康、`accept:socket` 与 `accept:process-supervisor` 均通过；超时/失败子进程被隔离回收，主监督进程继续运行。

## 6. 阶段 3：AI 助手对话替换

### 6.1 React Client

- [x] `MIG-0301` 实现 `useJwAgent(agentId)`；采用 HttpOnly 会话 Socket.io 实时快照 + 断线低频 REST 补偿，不依赖 Flue Hook。
- [x] `MIG-0302` 实现 JW/MySQL Agent 消息到当前 React 安全消息模型的转换器。
- [x] `MIG-0303` 接入会话列表、新建、切换、改名和删除；索引与 Agent 会话事务创建、同步改名/删除。
- [x] `MIG-0304` 接入文本、思考、工具调用、工具结果和错误展示。文本使用 React Markdown + GFM，覆盖标题、加粗、表格、代码块和安全外链，危险 `javascript:` href 被清空；思考内容默认放在关闭的独立 `<details>` 中，展开后仍不进入最终答案节点。Agent 任务错误显示持久化错误编号，React 渲染错误边界生成独立编号；通用 API 错误的用户可见消息附带可信请求编号，但仅在响应头/正文完全一致且格式合法时采用，伪造编号失败关闭。工具调用的运行中、完成和失败状态统一保留带 `type` 的动态 Part，重复 SDK 事件不使终态回退；`accept:jw-message-rendering` 与 `accept:jw-tool-lifecycle` 已生成 0600 证据并进入发布门禁，真实单服务浏览器复核三态、详情展开、刷新恢复和无横向溢出。
- [x] `MIG-0305` 接入流式内存快照、MySQL 历史补偿、停止和状态显示。真实 LLM 网关的全局两轮上下文、MySQL 消息/Part 和 SDK Session 延续已通过；真实 partial 流式 UI、项目工具链和生产浏览器仍由阶段 3/生产冒烟门禁跟踪。
- [x] `MIG-0306` 接入 Socket 断线重连和历史补偿。Socket.io 自动重连，连接后重新订阅并获取 MySQL 快照，断线期间每 5 秒低频恢复读取。
- [x] `MIG-0307` 接入模型选择、用量和上下文压缩状态。会话创建及会话顶部均可选择当前用户有权使用的启用模型；切换与消息提交按会话串行，运行中/等待交互时返回 409，切换会关闭旧 SDK Query、保留 MySQL 消息与 SDK Session ID，下一轮从最新 `modelId` 重建 Runtime。Runtime 按 Claude Agent SDK 原生 `init/result/status/compact_boundary` 事件把活动模型、输入/输出/缓存 Token、总 Token、成本、Turn、耗时及压缩中/成功/失败状态写入 MySQL；压缩事件按 UUID 幂等计数，REST/Socket Snapshot 和 AI 页面可在无内存 Session 时恢复显示。`accept:jw-model-switch` 和 `accept:jw-usage-compaction` 已用真实 MySQL完成权限/忙碌拒绝、历史保留、幂等、失败恢复、重复边界、状态清除和零残留验收；当前版本 `accept:jw-interaction-live` 又从真实模型结果核对模型、Token/缓存 Token、成本、Turn、耗时和压缩 idle 状态，`CHAT-013` 关闭。真实网关的不同目标模型切换后新一轮仍由 `CHAT-012` 保持部分通过。
- [x] `MIG-0308` 接入 `AskUserQuestion` 交互请求。Runtime 只向模型暴露该一个 Claude Code 内建工具，并通过显式 `permissions.ask` 规则进入宿主权限回调，绝不放入会绕过回调的 `allowedTools`；顶层使用 `permissionMode=default` 允许 ask 规则进入回调，文件/Shell 等内建工具不可见，未知工具仍由服务端拒绝。问题先写入 MySQL Snapshot，REST/Socket 恢复后可由所属用户回答或取消并恢复 SDK Tool Permission。支持单选、多选和有界自由输入，拒绝跨用户、过期及非法回答；停止、超时、服务重启和新请求替换均会失败关闭并释放等待。回答正文只回传当前 SDK 调用、不写会话元数据。`accept:jw-interaction` 覆盖本地权限/恢复边界，`accept:jw-interaction-live` 证明真实外部模型主动提问、授权回答后同轮继续生成；唯一 3100 服务真实浏览器完成交互、刷新恢复和零残留，发布/静态门禁已接入，`CHAT-011` 关闭。
- [x] `MIG-0309` 保持当前 AI 助手页面布局、风格和主要交互，仅替换底层 Hook 与停止接口。（P0）

### 6.2 会话迁移与兼容

- [x] `MIG-0310` 制定 PostgreSQL 会话索引、Flue 历史和 JW 历史合并规则。用户/项目归属只取稳定 MySQL 会话索引；Flue canonical stream 只提供消息事实；白名单 JW 通用会话为 0，Aipin 会话全部拒绝。详见《Flue会话迁移工具与候选库盘点-20260808》。（P0）
- [x] `MIG-0311` 实现旧会话迁移或只读归档程序。已实现显式源文件、预览/应用、归属映射、审计运行和阻断报告；生产 Flue 库仍需从部署机取得后执行。
- [x] `MIG-0312` 保留无法完整转换的旧工具调用原始 JSON。工具调用、工具结果、附件引用、压缩/结算等事件保存在消息 Part 或会话迁移元数据中。
- [x] `MIG-0313` 旧 Flue/索引历史只作为 MySQL 消息读取，不会启动 Flue 或恢复旧 Flue 进程；仅 JW 自身 `sdkSessionId` 可恢复 Claude Agent SDK 会话。
- [x] `MIG-0314` 建立新会话灰度边界；原“Flue 流量开关”按 `ADR-012` 取消，不允许为灰度重新接回已退役 Runtime。新增 `JW_GLOBAL_NEW_CONVERSATIONS_ENABLED` / `JW_PROJECT_NEW_CONVERSATIONS_ENABLED`，只控制对应范围的新建 JW 会话，严格布尔解析、关闭时返回明确 503，已有 MySQL 会话仍可读取和续聊，策略显式 `fallbackRuntime=null`。真实 MySQL 验收覆盖两开关独立组合、禁用范围零创建、既有会话追加、错误配置失败关闭和夹具零残留；部署与静态门禁已接入。（P0）
- [x] `MIG-0315` 实现 PostgreSQL 索引、Flue canonical stream 和白名单 JW 历史的消息级合并算法，处理重复、乱序、附件、工具调用和停止状态。已通过两次幂等应用、精确重复合并、思考/工具、附件引用和中断状态冒烟；白名单 JW 通用会话当前为 0。（P0）
- [x] `MIG-0316` 对迁移前后消息顺序、可见文本、内容块、附件和工具引用生成内容级核验报告。（P0）增强 `check:flue-migration` 后先后发现并修复三项真实缺口：同毫秒消息曾按随机 UUID 重排，现固定 `created_at,sequence,id`；孤立或新生成的 Flue Agent 正文曾不创建用户可见 `chat_conversations` 索引，现与 Agent/消息在同一事务创建并逐对复核；子会话 128 字符外部 ID 曾溢出旧 64 字符 `agent_id`，现不截断、不制造冲突值，超长值只保留在规范 Agent 表并以共享 UUID 关联。真实 MySQL 连续应用两次覆盖既有孤立 Agent 和新生成子会话，两组 chat/agent 索引各保持 1，主会话 3 消息/7 Part、子会话 1 消息/1 Part，来源/目标 checksum 稳定；文本、思考、附件、工具输入输出和 interrupted 状态逐项通过。失败或成功的临时源报告均按临时目录+报告 SHA+文件名精确清理。新增只读跨源聚合审计确认当前 13/13 会话索引/Agent 成对、消息/Part/任务绑定零违规；本地授权源业务消息为 0，生产源未批准，故 `CHAT-019/020/MIG-0715` 仍不提前关闭。
- [ ] `MIG-0317` 首批仅灰度全局普通对话；项目对话全量切换必须等待阶段 4 和阶段 6 组合门禁。项目基础链路已由真实模型调用服务端绑定的 `get_project_summary` 并验证 MySQL 工具持久化，但文件/RAG、专业任务和生产浏览器组合门禁尚未完成，仍不得全量切流。（P0）

### 6.3 阶段门禁

- [x] `GATE-M3-01` 新 AI 会话完全不请求 Flue。（P0）真实两轮全局会话只经过 3100/JW Runtime、外部模型网关和 MySQL；活动 Runtime 静态引用中 SQLite/Flue/3584 为 0，执行期间 3584/8121 均关闭，消息和 SDK Session 只落 MySQL。
- [x] `GATE-M3-02` 刷新、重启和网络中断后会话可恢复。（P0）刷新恢复使用第二个认证 Session 从 MySQL 重建三条不同历史；`accept:jw-restart` 在进程完整启停后恢复消息、Part、顺序、状态和工具中断结果；增强后的 `accept:socket` 用 12 个并发连接、6 个会话做 3 轮全断开重连，每轮断线窗口向目标会话写入 1 条唯一确认消息，重连订阅快照逐轮核对累计消息 ID 无丢失、无重复，最终 3/3 仍在 MySQL 且夹具清零。
- [ ] `GATE-M3-03` AI 助手视觉回归通过。（P0）本地单服务浏览器已复核会话栏、模型/Token 状态、Markdown 标题/表格/代码/链接和折叠思考内容，当前视口无横向溢出、控制台 0 错误；仍缺生产 TLS、多角色和多分辨率完整视觉矩阵，保持未通过。
- [x] `GATE-M3-04` 停止、错误、工具和交互事件均通过验收。（P0）真实项目摘要工具、流式停止/停止后续聊、工具运行/完成/自然失败三态、终态幂等、MySQL 刷新恢复和浏览器展示均通过。修复 SDK 顶层 `dontAsk` 提前拒绝显式 ask 的冲突后，真实外部模型主动发起 `AskUserQuestion`，授权回答恢复同一 SDK Turn 并继续生成；唯一 3100 服务浏览器完成选项提交、交互卡清除、发送恢复及刷新持久化。本地越权、取消、Abort、超时、重启与零残留门禁继续通过。
- [ ] `GATE-M3-05` 项目对话尚未满足组合门禁时可关闭项目新会话准入，且不影响全局新会话和已有 MySQL 会话；不得恢复旧链路。（P0）独立开关、失败关闭、无备用 Runtime 和既有会话延续已通过真实 MySQL 验收；生产配置值和项目组合门禁仍未签字，故本项保持未通过。

## 7. 阶段 4：文件、工作区与项目知识库

### 7.1 文件工作区

- [x] `MIG-0401` 建立用户、会话、项目分层工作区目录。项目原文件按 projectId、Agent workspace 按会话、普通生成材料按 userId 隔离，旧共享根默认不可见。
- [x] `MIG-0402` 实现路径规范化、路径穿越和符号链接逃逸防护。（P0）项目文件、workspace、generated 和正式 AI 产物均校验词法根、realpath 并拒绝符号链接。
- [x] `MIG-0403` 实现文件扩展名、MIME、大小和数量限制。支持 22 种扩展名与内容签名；默认单文件 100 MiB、每项目 500 个/5 GiB、每用户 20 GiB，OOXML 另限 5,000 条目/250 MiB 解压容量；项目锁保证并发配额不超卖。
- [x] `MIG-0404` 实现上传、预览、下载、删除和临时文件清理。真实 HTTP 验证受权上传/下载、安全沙箱预览、删除及跨用户拒绝；原子临时文件失败即清理，删除同时清理当前和全部版本路径。删除前将每个数据库存储路径绑定到所属 projectId/fileId，禁止删除存储根、符号链接、真实路径越界和校验后被替换的 inode；污染为其他项目路径的历史版本只删除自身元数据，不会删除其他项目原件。主服务启动时另按 `PROJECT_FILE_TEMP_MAX_AGE_MS` 清理崩溃遗留，只匹配服务自有 `.UUID.tmp` 普通文件并在删除前复核 realpath、文件类型、inode 和 mtime；正式文件、新鲜临时文件、普通 `.tmp` 与符号链接均不删除，隔离门禁通过。
- [x] `MIG-0405` 实现文件 SHA-256、重复检测、版本和审计记录。`project_files` 记录精确字节/SHA/当前版本/稳定上传人，`project_file_versions` 保存不可变版本路径；项目锁内拒绝新增重复内容，替换/删除写审计。历史原件已强匹配恢复 1/18，其余 17 条已按精确 ID 批准永久缺失并保留元数据/补传入口；剩余文件全量风险由 FILE-006/012 跟踪。
- [x] `MIG-0406` 实现授权下载或短期签名 URL。项目文件、AI 产物、workspace 和 generated 文件均经统一 HttpOnly 服务端会话及归属校验下载；真实项目文件下载在会话有效时返回原字节，将同一会话的 MySQL `expires_at` 置为过去后，同一 Cookie/URL 立即返回 401，证明授权不会超出服务端会话期限。
- [ ] `MIG-0407` 逐根迁移项目原文件、旧 `/generated`、AI 产物、自定义模板、Agent workspace、Skill/模板和 Radar 文件 manifest。（P0）累计 66 个历史验收/孤儿 workspace 文件已用严格内容或双 MySQL 会话不存在性证据移入私有可恢复隔离，正常会话删除链路也已补精确 workspace 清理；最新在线扫描 240 个文件、未决归属 0，当前 7 个阻断全部是旧机器根外 AI 产物路径，`technicalReady=false`、`approved=false`。新增 0600 精确源缺口底稿，锁定7个产物的任务、格式、文件名和行指纹；当前处置仍为 pending，不得以隔离、排除生成测试或管理员页面可查看替代批准。
- [x] `MIG-0408` 将旧 `/generated` 公开静态下载迁移为受权接口或按批准方案失效，并记录历史链接处置结果。（P0）旧路径固定 404；新产物改用 `/api/generated/:file`，按创建用户隔离。旧文件 manifest/归属仍由 MIG-0019/0407 处理。
- [ ] `MIG-0409` 固定 Python、LibreOffice、Poppler、Tesseract、字体和原生模块版本，形成部署依赖清单。新增机器可读 `server/document-runtime-dependencies.json` 和 SHA-256 绑定的 11 包完整 Python 传递依赖锁；安装脚本不再使用宽范围 requirements，部署后强制执行只读现场版本核验。契约固定 Python 3.11～3.13、LibreOffice 7.4～26、Poppler 22～26、Tesseract 5.x、Fontconfig 2.14～2.x 的兼容区间，并要求 Linux 同时具备 `chi_sim`/`eng` 与 Noto Sans/Serif CJK SC。静态 8 项和本机 live 4 项通过：Python 3.12.10、LibreOfficeDev 26.8.0.0、Poppler 26.5.0、Fontconfig 2.18.0，11/11 Python 包精确一致；完整版本输出仅保存 SHA-256，不保存路径。当前 macOS 不强制 Tesseract/Fontconfig 字体匹配；目标 Linux 的精确 apt snapshot/镜像 digest、实际包版本、OCR 语言和字体证据尚未取得，因此不勾选。

### 7.2 项目知识库工具

- [x] `MIG-0410` 接入项目文件解析和切片流程。真实 API 上传写入私有原文件后异步调用 `ingestFile`；文件分块、统一知识分块与解析成功状态现由同一 MySQL 事务提交，任何一步失败均整体回滚并记录失败状态。迁移 `0030` 为同 scope/ref/source/chunk 增加唯一约束；`accept:knowledge-ingestion-atomicity` 实测失败替换保留旧可检索版本、成功替换精确、重复执行无重复、唯一约束拒绝旁路重复且夹具清零。
- [x] `MIG-0411` 实现 `search_project_docs`。工具只接收 query/是否比较线索池，userId/projectId 由当前会话服务端绑定；项目、机构和线索证据按真实分块评分返回。
- [x] `MIG-0412` 实现 `get_project_summary`。工具不接受客户端或模型提交的 projectId，由服务端会话绑定；每次复核启用用户及稳定项目权限，从 MySQL 返回项目主记录、最新 AI 摘要、文件/会议/待办/风险统计和可展示来源定位，13 项知识工具验收覆盖摘要契约及越权拒绝。
- [x] `MIG-0413` 实现 `list_project_files` 和 `read_project_file`。工具不能传 projectId；列表返回完整性/版本/解析状态，读取仅返回当前项目已解析片段，不暴露 storagePath 或任意文件系统读取。
- [x] `MIG-0414` 工具结果包含来源、定位、项目 ID 和权限结果。统一返回 `permission`、projectId/refId、citationId、sourceId/type/name、真实 chunkIndex/locator、内容与截断标记；9 项隔离验收通过。
- [x] `MIG-0415` Agent 会话绑定 `userId`、`projectId`、`scope` 和受控 `cwd`。会话按 userId 查找并复核稳定项目权限，Runtime Session 显式接收该 userId/projectId，cwd 固定为受控 workspace/conversationId。
- [x] `MIG-0416` 跨用户、跨项目、路径构造越权测试通过。（P0）`accept:security-boundary` 自启动编译后的统一服务，覆盖其他用户文件列表/API 上传原件下载/Agent 知识请求拒绝，以及 project/workspace/generated 符号链接、`..`、绝对路径、双重编码和跨用户路径读取拒绝；同时验证三类 SQL 注入载荷不改变查询或数据。
- [ ] `MIG-0417` 缺失、重复、零字节、无归属和哈希冲突文件进入隔离报告，不按路径或文件名自动猜测归属。（P0）

### 7.3 阶段门禁

- [x] `GATE-M4-01` 项目会话只能检索对应项目资料。（P0）跨项目知识请求返回 403，JW 项目资料 MCP 由服务端绑定当前用户和项目，不接受模型自报归属。
- [x] `GATE-M4-02` 上传、预览、下载和产物工作正常。（P0）`accept:resources` 45 项真实 HTTP/权限验收通过；文件上传、当前/历史版本下载、沙箱预览、替换、解析、删除及异步知识夹具清理链路正常。AI 产物的生产历史缺件继续由 FILE-012 跟踪，不以功能门禁替代数据对账。
- [x] `GATE-M4-03` 文件权限和路径安全测试通过。（P0）45 项真实 HTTP 综合验收及 13 项服务层文件验收覆盖用户/项目隔离、原字节回读、伪造内容、大小/MIME/签名、压缩包边界、绝对/双编码路径、跨用户路径和符号链接逃逸。
- [x] `GATE-M4-04` 项目知识库引用可追溯到来源。（P0）`accept:project-knowledge-tools` 验证每条结果返回 citationId、scope、refId/projectId、sourceId/type/name、真实 chunkIndex/locator 和内容；中文金标进一步验证项目/Scope 隔离，原子入库门禁保证解析成功状态与这些可检索来源同时提交。
- [ ] `GATE-M4-05` 全部文件根 manifest 对账完成，旧公开下载入口已关闭或获得书面例外。（P0）

## 8. 阶段 5：线索池 Claude Agent SDK Pipeline

### 8.1 原始事件与任务状态机

- [x] `MIG-0500` 按当前项目线索池契约独立设计 Pipeline，禁止复用 Aipin 表、项目服务、处理队列、路由和状态机。（P0）新增的 `lead_pipeline_raw_events/items/transitions`、服务与验收均为当前项目独立实现；静态门禁继续拒绝活动代码中的 Aipin 引用。
- [x] `MIG-0501` 将雷达、公众号、新闻、群聊和 arXiv 原始候选写入 `lead_pipeline_raw_events`。Radar 统一候选入口在任何过滤、模型判断和正式线索写入前记录原始事件，覆盖其公众号、新闻、群聊和 arXiv 渠道；36氪 `lead_reserve` 同样先写原始事件。
- [x] `MIG-0502` 实现 `sourceType + sourceId/contentHash` 幂等规则。（P0）稳定来源 ID 经 NFKC/空白归一化后与规范内容哈希共同生成事件 ID；无来源 ID 时退化为内容哈希，同来源内容变化生成不可变新版本。并发和重复执行验收 9 项通过。
- [x] `MIG-0503` 实现 discovered 到 ready/review/rejected/failed 的状态机。每次变化追加 `lead_pipeline_transitions`，理由、证据、置信度、操作者、错误和正式线索 ID 均持久化；已 ready 事件不能被自动重跑静默撤回。
- [x] `MIG-0504` 实现 MySQL Job 租约、领取、续租、超时和死信。（P0）已新增通用 `runtime_jobs` / `runtime_job_runs` 调度器；Radar 已接入并通过双实例只领取一次验证；评分与 AI 文档任务也分别使用持久化租约。评分终态失败明确写 `dead_letter/dead_lettered_at`，普通调度不能复活，只能经审计的人工重试。
- [x] `MIG-0505` 删除对进程内评分队列、Map 和 Timer 的可靠性依赖。（P0）新增 `lead_score_jobs`，评分领取、续租、延迟重试、失败、死信与恢复均以 MySQL 为准；`accept:lead-score-lifecycle` 11 项覆盖并发领取、三类重启恢复、活租约保护和人工重试。
- [x] `MIG-0506` 保存每次 Agent Run 的模型、Token、工具、耗时和错误。`lead-subject-agent` 与 `lead-scoring-agent` 的每次 SDK 尝试均写入 runtime、模型、精确 Token、零工具次数、SDK 耗时、微美元成本和脱敏错误，失败重试逐次留痕；主体与评分审计验收同时覆盖成功和失败记录。
- [ ] `MIG-0507` 迁移或归档 Radar JSONL、微信群聊原文、采集状态 JSON、公众号 Excel、`lead_reserve` 未入池记录和 `imported` 进度。（P0）`accept:radar-lead-source-reconciliation` 已确认有 `detail_json` 的 9,903 条储备记录全部进入唯一不可变原始事件，656 条 imported 记录均有无孤儿/无重复正式线索映射，9,247 条有详情未入池记录继续保留。97 条缺失详情保留原行并标记 `source_missing`；新增精确决策底稿逐条绑定源键哈希和当前行指纹，严格模式在未获 `approved-permanent-quarantine` 前退出2且数据库写入0。406 条历史 imported 的源导入时间保持未知；生产 Radar/微信群聊/公众号原资产 manifest、恢复演练和负责人批准未完成，故不勾选。
- [x] `MIG-0508` 保留并验证 Radar 来源键、采集时间、主库同步游标、36氪 `seq` 和 cron/timer 运行位置。（P0）Radar 进入 MySQL 事件/状态表；新门禁验证来源键/游标/状态/来源唯一性，`lead_reserve` 保留 10,000 条、656 条 imported 进度及其正式线索映射，`seq` 无重复；4 个旧 cron/timer 工作项由 MySQL Runtime Job 替代。历史 imported 时间空值作为源缺口显式计数。
- [x] `MIG-0509` 定义线索页面读源、Pipeline 写源和人工复核写源的原子切换方案；禁止跨库不可见写入。（P0）公共线索列表/详情、原始事件/状态/决策和人工复核列表/处理均使用同一 MySQL 前缀与稳定用户 ID；活动服务端数据库边界禁止 PostgreSQL 业务读取，静态门禁和人工复核真实事务验收通过。

### 8.2 Agent Profiles 与工具

- [x] `MIG-0510` 实现 `lead-subject-agent`。Radar 主体审查已切到 Claude Agent SDK，使用严格 JSON Schema 输出；Profile 禁用内建工具、Skills、MCP、插件、子 Agent、设置源和会话持久化，工具请求一律拒绝并中断。
- [x] `MIG-0511` 实现 `lead-research-agent`。使用 Claude Agent SDK 严格输出事实、逐字引文、来源、冲突和缺口；宿主拒绝任何不在不可变输入中连续出现的引文。真实 `gpt-5.6-sol` 调用以 2 Turn、0 工具完成。
- [x] `MIG-0512` 实现 `lead-screening-agent`。严格输出 `accept/reject/review`、理由、置信度、证据和风险；无证据 accept 由宿主拒绝，冲突与不足必须进入 review。真实 `gpt-5.6-sol` 调用以 2 Turn、0 工具完成。
- [x] `MIG-0513` 实现 `lead-scoring-agent`。已使用 Claude Agent SDK 严格 JSON Schema 输出，禁用工具、Skills、MCP、插件、子 Agent、设置源和会话持久化；宿主负责评分标准归一化、总分/结论重算、证据校验与 MySQL 写入。
- [x] `MIG-0514` 实现 `lead-enrichment-agent`。只允许 `companyName/industry/businessRegion/summary/team/fundingRounds/sources` 七类补丁，标量仅 `set_if_empty`、数组仅 `append_unique`；每项必须绑定输入原文，未知字段和覆盖式操作被拒绝。真实 `gpt-5.6-sol` 调用以 2 Turn、0 工具完成。
- [x] `MIG-0515` 实现受控的原始事件、已有线索、公开搜索和来源读取工具。新增版本化 `lead-research-host-tools-v1` 宿主工具门面，固定为读取不可变原始事件、读取已有线索、受限 Bing/Sogou 公开搜索和读取来源片段四项；原始事件哈希会在读取时复验，公开搜索不能传入任意 URL，Agent 仍保持零 SDK 工具和无数据库环境。公开情报新建/补全及 Radar 自动摄入均在线使用该证据包；Radar 复用已采集公开原文而不重复联网，5 项在线编排验收通过。
- [x] `MIG-0516` 实现 `submit_lead_decision` 暂存提交工具。新增宿主专用 `submit_lead_decision` 契约，只能追加经 Schema/引文校验的 Decision 和 Evidence，不能创建或更新正式线索；4 项真实 MySQL 验收覆盖三类输出、Run 指标和失败留痕。
- [x] `MIG-0517` 禁止 Agent 获得通用 MySQL 写权限或任意 Shell 数据库权限。（P0）主体、研究、初筛、评分、补全五类 Agent 均使用显式环境白名单，不接收 `DB_*`，且 `Bash/Read/Write/Edit/Glob/Grep/WebFetch/WebSearch/Task/Skill` 均不可用；结构化结果只能交给宿主校验和暂存/事务写入。
- [x] `MIG-0518` 为每类 Agent 配置工具白名单、模型、轮数、超时和预算。五类 Profile 均固定模型路由、1—2 Turn、超时和预算上限；主体/评分及研究/初筛/补全均为零 SDK 工具，后者使用版本化 `lead-research-host-tools-v1` 宿主工具集，并在 Run 中按实际路径记录 2/3/4 次受控宿主读取，不向 Agent 暴露 Shell、任意网络或数据库能力。Radar 以 `RADAR_WORKFLOW_CONCURRENCY` 限制并发，默认 8、最大 16。

### 8.3 决策、评分和人工复核

- [x] `MIG-0520` 建立版本化结构化输出 Schema。主体、研究、初筛、项目七维/论文五维评分和补全均有严格 Zod/JSON Schema，并以不可变 `prompt/profile/schema/skill/toolset` 版本注册；当前 MySQL 版本表共 10 条，包含三个 Profile 从 `host-evidence-only-v1` 升级到 `lead-research-host-tools-v1` 前后的不可变版本。
- [x] `MIG-0521` 实现主体名称、证据、来源、冲突和置信度门禁。主体名称必须在原始证据中出现；研究/初筛/补全的每条事实或补丁必须绑定 sourceId 和连续引文，无证据 accept、幻觉引文、未知补全字段均失败；研究冲突保留，初筛输出显式置信度并将不确定项转 review。
- [x] `MIG-0522` 实现公司/项目七维评分。评分 Agent 严格返回七个标准维度及其完整子项；宿主按版本化标准覆盖名称/上限并重算维度分、总分和结论，验收及真实网关调用均通过。
- [x] `MIG-0523` 实现论文专属评分和正确路由。论文进入五维专属 Schema，无公司主体、融资或子项强制要求；验收及真实网关调用均通过。
- [ ] `MIG-0524` 实现实体重复匹配和事务提交前复检。部分完成：迁移 `0031` 新增追加式 `lead_pipeline_entity_matches`，统一保存 Radar、公开情报和人工复核的规范主体、别名、匹配类型、候选 Lead 快照、歧义状态及最终 selected/created/rejected 映射；记录绑定原始事件、触发决策、复核和解决决策，删除 Lead 只置空实时外键而保留候选快照。Radar 与公开情报多匹配时正式写入先回滚，再单独提交 `entity_resolution/review`、候选冲突和未绑定 Pipeline review；人工复核必须显式选择同主体且非终态目标。两个绕过正式链的旧手工入口已失败关闭，`accept:lead-dedup-safety` 验证退出 78、零写入、零业务标识输出。专项 4 项、人工复核 14 项、公开情报 9 项、Radar/Pipeline 11 项通过，`LEAD-006` 已关闭。当前库仍有 42 组/107 条历史重复待逐组裁决，且工商主体/通用别名归一化规则尚未获业务批准，故本项和 `DB-015/MIG-0125/ISSUE-006` 仍不勾选。
- [x] `MIG-0525` 实现人工复核队列、处理页面和审计。新增按稳定用户/角色授权的 MySQL 列表与处理 API，并在公共线索页加入证据优先的人工复核工作台；接受时主体和引文必须能在不可变原始事件中定位，宿主在同一事务写入子 Decision、正式线索/绑定、Pipeline 状态和审计日志，拒绝不建线索。10 项真实 MySQL 验收覆盖越权、回滚、幂等和历史保留。
- [x] `MIG-0526` 人工结论以新决策记录保存，不覆盖 Agent 历史。人工结论新增 `manual_review` 子决策并以 `parent_decision_id` 指向触发它的 Agent 决策；自外键使用 RESTRICT，15 项验收验证重试幂等、冲突覆盖拒绝和 Agent 历史保留。
- [x] `MIG-0527` 旧 Flue 评分标记为 `legacy-import`。当前获批准的 Flue 来源经锁定清单确认业务会话、消息及评分均为 0，不制造不存在的评分记录；对实际随 PostgreSQL dump 保留下来的旧评分，874 条线索和 5 条项目评分已统一标记 `legacy-import`，绑定源 SHA-256、分类运行和原评分 checksum，并明确证据不可重建。未来评分只接受 `agent-run` 及完整 Run/Decision/Input/Evidence 链。

### 8.4 替换旧调用

- [x] `MIG-0530` 替换直接 LLM HTTP 主体审查调用。（P0）`radarAiReviewService` 已删除网关 URL、密钥、`fetch` 和 `/chat/completions` 路径，改为调用受限 `lead-subject-agent`；静态门禁阻止主体审查重新引入直接 HTTP。
- [x] `MIG-0531` 替换 Flue 公开情报采集调用。（P0）线索新建补全、已有线索增量补全及尽调网络研究均调用主服务内 `collectCompanyIntel`，活动路由不含 `FLUE_BASE_URL`、`/workflows/intel-collect` 或 localhost 自调用；Python 采集器由统一子进程监督器单次执行，只允许 Bing/Sogou 两个固定网络目标，请求通过权限 0600 临时文件传递。
- [x] `MIG-0532` 替换 Flue `score-project` 评分调用。（P0）项目七维评分已切到受限 `lead-scoring-agent`，评分调用链不再使用直接 LLM HTTP。
- [x] `MIG-0533` 替换 Flue `score-paper` 评分调用。（P0）论文五维评分已切到同一受限 Agent Profile，并由宿主按论文路由校验和持久化。
- [x] `MIG-0534` 保留确定性采集、游标、清洗、幂等和最终事务提交。Radar 游标、36氪 seq/imported 与 MySQL Job 进度已保留；公开情报继续使用确定性受限采集和宿主清洗。相同公开情报事件并发重放只形成一条正式线索、一个审计和一组状态历史，原始证据、线索创建/增量合并、审计及 Pipeline `ready + lead_id` 在同一 MySQL 事务提交；无效目标或实体歧义会整事务回滚。
- [x] `MIG-0535` 将 `cybernaut-radar-sync.service/.timer` 和 `sync_radar.mjs` 改为 MySQL 持久化调度 Job，删除 localhost HTTP 自调用。（P0）调度器直接调用 `runRadarSyncImport`，旧脚本已删除。
- [x] `MIG-0536` 将 `daily_intake.mjs`/cron 改为持久化摄入 Job，保留 36氪 `seq/imported`、评分触发、补偿和告警。（P0）新增 `lead-reserve-daily-intake`、事务映射与评分补偿字段；旧脚本入口已删除，生产部署默认每日 50 条。
- [x] `MIG-0537` 将 Radar 常驻循环拆为可单次执行、可超时和可重试的 Python 采集适配器，由 `cybernaut-app` 监督执行。`job.py` 不触发 FastAPI startup，子进程支持超时、取消、重试与运行记录。
- [x] `MIG-0538` 以 MySQL 原始事件、来源、游标和运行记录替换 Radar JSONL/状态文件的在线事实源。（P0）新增四张 Radar 表；API 从 MySQL 分页，Python Job 前后物化/回写；新门禁确认 3 份采集状态、39 个来源、1 份同步状态和 4 个调度任务可恢复，候选投影到原始事件零断链。当前候选为空只证明空集一致，原始文件长期归档仍归 `MIG-0507`。
- [x] `MIG-0539` 完成契约切换后删除 Radar FastAPI 业务端口、独立健康接口、`RADAR_BASE_URL` 和 `cybernaut-radar.service`；未通过门禁时记录限期退场例外，不与主切换强绑。（P0）生产只监听 3100；旧 FastAPI 路由仅保留为离线导出/回滚兼容代码，不在启动链。

### 8.5 质量与成本

- [x] `MIG-0540` 建立主体准确率、误收、误拒、重复和评分偏差指标。`lead-subject-gold-v1` 已计算总体准确率、正样本召回、自动接受精度、误收、误拒和人工转交率；`lead-scoring-gold-v1` 已建立项目七维与论文五维的预设分数区间、排序和偏差指标并真实通过。管理员运维快照新增按二进制精确值分组的线索名称/公司名称重复组和涉及记录量，当前与规范化审计一致为名称 9 组/25 条、公司 33 组/82 条、合计 42 组；`LEAD_ENTITY_DUPLICATE_GROUPS` 已进入统一 Outbox，7 项真实 MySQL 验收确认两类重复各精确 +1/+2 并清理回基线。该项只关闭“建立指标”，不代表 42 组历史重复已完成业务裁决，处置仍由 `MIG-0125/DB-015` 阻断。
- [ ] `MIG-0541` 建立单条 Token、时长、工具次数和成本指标。主体、项目/论文评分、研究/初筛/补全三套金标均已建立成本、时延、Turn 和工具阈值；工作流最终实测约 0.00854 美元和 10.13 秒/条。三类线索 Agent 已统一兼容 SDK 顶层 `usage` 与按模型 `modelUsage` 的蛇形/驼峰字段，并计入缓存创建/读取输入 Token，禁止按成本估算 Token；专项 4 项本地验收通过。但 2026-08-11 单候选非报告在线探针仍只返回输出 202 Token、输入 0 Token，解析来源为 `unavailable`，说明当前网关没有提供可用的精确输入 Token。加上主体仍为批次分摊，故整项保持未完成。
- [x] `MIG-0542` 金标集覆盖公司、项目、团队、实验室和论文。新增 SHA-256 锁定的 `lead-subject-gold-v1`：五类正样本及谓语片段、通用词、新闻栏目、荣誉资讯、多主体歧义五类负样本共 10 条；真实 `gpt-5.6-sol` 连续两次 10/10 通过。
- [x] `MIG-0543` 建立模型、提示词、Skill、工具和 Schema 变更回归门禁。（P0）主体、项目/论文评分以及研究/初筛/补全三套金标均锁定数据 SHA、模型、Prompt/Profile/Skill/Toolset/Schema 版本，并由 `deploy.sh` 在生产编译、数据库初始化后且服务重启前强制执行真实模型质量、来源绑定、成本、时延、Turn 和零工具门禁。初筛弱来源规则已版本化升级到 v2。
- [x] `MIG-0544` 建立批处理并发、速率、预算和熔断限制。迁移 `0021_add_lead_agent_runtime_guard` 新增 MySQL 持久化许可表，主体、评分、研究、初筛和补全五类真实调用共享全局并发、分钟速率、UTC 日预算预留/实耗和连续失败熔断；过期许可自动回收，终态成本/错误可审计。默认并发 16、60 请求/分钟、100 美元/日、0.75 美元/次预留、连续失败 5 次熔断 5 分钟，均可通过有界环境变量收紧。`accept:lead-agent-runtime-guard` 7 项和静态发布门禁通过；生产通知与升级路径继续由 `OPS-010` 跟踪。

### 8.6 阶段门禁

- [x] `GATE-M5-01` 新线索不再使用直接 LLM HTTP 或 Flue Workflow。（P0）主体审查、项目七维评分和论文五维评分均已切到 Claude Agent SDK；活动线索路径无 Flue 调用，静态门禁禁止评分函数及线索路由回退到 `fetch`、`/chat/completions` 或 `scoreWithGateway`。项目摘要等非线索旧功能仍复用网关封装，不影响本门禁范围。
- [x] `GATE-M5-02` 处理结论可追溯到原始事件、证据和 Agent Run。（P0）五类 Profile 的版本契约均已建立；主体、研究、初筛、评分和补全在线链路均形成 Raw Event→受控宿主证据包→Claude Agent SDK Run→Decision→Evidence，保存模型、版本、Token、成本、耗时、零 SDK 工具次数、宿主工具次数和脱敏错误。公开情报与 Radar 均只有 Screening `accept` 才进入宿主原子建档，`review/reject/failed` 不创建正式线索；Radar 失败使用新 attempt 留痕重试，已 ready/review/rejected 的同一事件不自动重跑。
- [x] `GATE-M5-03` 重启和多 Worker 不造成任务丢失或重复线索。（P0）Radar 双实例只产生一次运行；评分的 queued/running/retrying 重启恢复、并发单租约、死信隔离与人工重试均通过真实 MySQL 验收；储备池摄入事务与幂等映射测试通过。
- [x] `GATE-M5-04` 金标回归和人工复核流程通过。（P0）人工复核 API、React 页面、权限、证据门禁、事务提交和历史不覆盖已通过 10 项真实 MySQL 验收；主体、项目/论文评分、研究/初筛/补全三套真实金标全部通过并接入部署发布门禁，覆盖主体误收/误拒、评分偏差、事实/冲突、弱来源、来源绑定和禁止覆盖已有字段。
- [x] `GATE-M5-05` 线索 Pipeline 的代码依赖、运行调用和数据库访问均不指向 Aipin。（P0）新增 Pipeline Schema、迁移器、服务、Radar/公开情报及五类 Agent 接入和验收均为本项目代码；最新 `check:single-service` 53 项扫描 228 个活动文件并拒绝 Aipin 引用，且固定 Radar 适配器文件必须由 MySQL 下发并在任务后回灌；`check:mysql` 拒绝目标库 Aipin 表。
- [ ] `GATE-M5-06` 线索页面、Pipeline 和人工复核使用同一权威数据源，Radar/`lead_reserve` 游标无重复或遗漏。（P0）三个在线读写面已统一到 MySQL，跨库不可见写入已关闭；97 条缺失 `detail_json` 的储备记录已受控隔离且台账覆盖 97/97，但原内容无法凭空恢复，加上未取得的 Radar/群聊/公众号原始资产，全量游标/来源无遗漏结论仍不足，故不勾选。
- [x] `GATE-M5-07` Radar Sync 和 36氪摄入不依赖外部 cron/timer、脚本型入口或本机 HTTP 自调用。（P0）两者均由 MySQL Job 调用进程内领域服务；旧脚本已删除。
- [x] `GATE-M5-08` Python 采集子进程超时、崩溃和重复执行不会影响 API/Socket 可用性或重复建线索。（P0）`accept:radar-job-isolation` 7 项验证 Radar Python 超时按监督契约终止、退出码 17 崩溃被主进程隔离、无残留子进程，失败后 MySQL 和真实单次 Radar 健康检查继续工作；同步底层按规范主体名和 Radar 来源键获取排序后的 MySQL advisory locks，跨实例并发两次及随后重复执行只产生一条 lead。

## 9. 阶段 6：专业 AI 任务整合

- [x] `MIG-0601` 合规说明接入统一 `ai_task` 服务。由同一目录、API、`createAiTask`、`ai_tasks` 表、MySQL 租约 Worker 和 `composeComplianceStatement` 执行分支承载；统一接入验收通过。
- [x] `MIG-0602` 投资建议书接入统一 `ai_task` 服务。由同一目录、API、`createAiTask`、`ai_tasks` 表、MySQL 租约 Worker 和 `investmentProposalRuntime` 执行分支承载；统一接入验收通过。
- [x] `MIG-0603` 投资建议 PPT 接入统一 `ai_task` 服务。由同一目录、API、`createAiTask`、`ai_tasks` 表、MySQL 租约 Worker 和 `prepareInvestmentRecommendationPptWorkflow` 执行分支承载；统一接入验收通过。真实视觉模型网关回归仍属于 `MIG-0612/0613`，不以接入验收替代。
- [x] `MIG-0604` 尽职调查报告接入统一 `ai_task` 服务。由同一目录、API、`createAiTask`、`ai_tasks` 表、MySQL 租约 Worker 和 `generateDueDiligenceReportWithSkill` 执行分支承载；统一接入验收通过。
- [x] `MIG-0605` 项目 Q&A 接入统一 `ai_task` 服务。由同一目录、API、`createAiTask`、`ai_tasks` 表、MySQL 租约 Worker 和 `generateProjectQaWithSkill` 执行分支承载；统一接入验收通过。
- [x] `MIG-0606` 自定义模板文档接入统一 `ai_task` 服务。自定义模板按用户/项目/会话绑定并使用动态 `Skill 版本 + 模板分析版本`，其余创建、持久化、租约和恢复链路与内置任务相同；统一接入验收及 7 项模板分析/可编辑产物回归通过。
- [x] `MIG-0607` Agent 可以通过受控工具创建和查询专业任务。新增 `create_ai_task` / `get_ai_task_status`；启用用户、项目和会话由服务端绑定，支持五类内置任务及当前项目会话已授权自定义模板，参数/格式/幂等键由宿主收敛，状态查询拒绝跨用户、跨项目和跨会话。9 项定向验收通过。
- [x] `MIG-0608` 实现任务幂等、取消、重试和恢复。（P0）用户级唯一幂等键在正常与并发唯一键竞争路径均核对规范请求哈希，同键异参返回 `IDEMPOTENCY_CONFLICT`；取消请求阻止领取、阻止成功态竞态覆盖并写审计，停机/重启不会重新排队已取消任务；失败持久化 `error_code`/`retryable`，仅可重试错误创建带 `retry_of_task_id` 和进度断点的新任务；过期租约恢复为 pending，模板准备中断明确要求重新上传。`accept:ai-task-lifecycle` 14 项通过。
- [x] `MIG-0609` 任务、来源、产物、模板和质量结果写入 MySQL。`ai_tasks` 保存状态/进度/结果/模板/错误与租约，`ai_task_sources` 保存任务/产物来源定位，`ai_artifacts` 保存用户/项目/任务/版本/私有路径、`quality_status` 和完整质量 metadata，内置/上传模板分别由 `ai_task_templates`/`ai_custom_templates` 管理；11 项持久化验收确认关联无孤儿且私有路径不对外暴露。
- [x] `MIG-0610` 恢复任务卡、产物中心、预览和下载。任务详情和产物中心只展示 `quality_status=passed` 的正式产物，失败质量记录留库审计；预览/下载同时校验用户、质量状态、归档状态和受管文件路径，跨用户统一不可见。React 任务卡/产物中心复用该 MySQL API，构建与持久化隔离验收通过。
- [x] `MIG-0611` AI 任务创建前校验 MySQL 用户、项目、会话、模板和文件引用均存在，不允许孤儿任务。（P0）新增 `ai_task_templates` 注册五类内置模板版本/Skill/格式/状态；自定义模板使用现有 MySQL 记录。服务层在任务 INSERT 前重新加载启用用户、复核项目和会话精确归属，严格校验附件 UUID/项目/存在性/失败状态；12 项验收确认失败路径不增加任务行。
- [ ] `MIG-0612` 六类任务执行内容质量、来源完整性、逐页渲染、字体和 Office/WPS 金样回归。（P0）目标 `gpt-5.6-sol` 网关已按 Responses API 实跑六类任务：合规说明、项目 Q&A、投资建议书、自定义模板和 11 页商业尽调的真实 Cookie/CSRF API 验收通过；14 页投资建议 PPT 已完成原图、逐页文字契约、图片稿/PDF、四层可编辑稿、元素级可编辑 PPTX、无头 LibreOffice 渲染、水印/结构检查和自动 Reviewer，封面遮挡通过断点仅重做失败页。PPT 主任务成功后发现图片高保真版缺少统一 Skill 身份元数据，现已补齐并由定向回归覆盖；2026-08-11 曾启动独立完整 API 复验并实证中断后由唯一主服务按 MySQL 租约恢复、复用 14/14 页检查点，但按用户要求停止 PPT 生成板块测试，任务已取消且隔离项目/账号/文件清零。因此本轮不再执行 PPT 完整重放，同时仍缺目标 Office/WPS 人工打开/编辑/保存及批准金样对比，本项保持未勾选。
- [ ] `MIG-0613` 验证文档生成所需 Python、LibreOffice、Poppler、Tesseract、字体和原生模块在干净环境可重建。（P0）本机已通过正式 `setup:pdf-to-ppt` 建立 `server/.venv`，现又将 11 个直接/传递 Python 包精确锁定并绑定 SHA-256，部署后只读核验 Python、LibreOffice、Poppler、Tesseract、OCR 语言和 CJK 字体版本契约；本机 live 证据确认 Python 环境 11/11 一致及四项 macOS 必需原生依赖兼容。此前 PyMuPDF/Pillow/OpenCV/NumPy/pypdf/reportlab/python-pptx、LibreOffice、Poppler 和 Apple Vision OCR 预检均 ready；Q&A 渲染已去除开发机 `/Users/...` 硬编码。首次安装因 Python CA 链缺失失败，指定可信 CA 后成功。仍缺独立干净 Linux 节点、精确 apt snapshot/镜像 digest、Linux Tesseract `chi_sim`/`eng`、Noto CJK 字体和离线/受控依赖源复验，暂不勾选。
- [ ] `GATE-M6-01` 六类任务均通过端到端验收。（P0）
- [x] `GATE-M6-02` Worker 异常后任务可恢复或明确失败。（P0）`accept:ai-task-unified` 将五类内置任务和自定义模板任务全部置为过期 Worker 租约，六类均原子恢复为 `pending/等待恢复`、保留进度并释放租约；不可安全续跑的 PPT 模板准备中断明确失败为 `TEMPLATE_REUPLOAD_REQUIRED/retryable=false`。生命周期验收另覆盖取消不复活、优雅停机释放和可/不可重试分类。
- [ ] `GATE-M6-03` 六类产物质量和渲染不低于批准基线，项目对话可通过组合门禁进入全量灰度。（P0）

## 10. 阶段 7：投资业务数据迁移到 MySQL

### 10.1 迁移程序

- [x] `MIG-0701` 实现 PostgreSQL → MySQL 全量迁移。在线库与 `cybernaut_mvp_dump.sql` 均已完成事务迁移；隔离空 Schema 全量验收发现历史 `audit_logs` 缺少后加的非空 `request_id`，现由在线/dump 两条迁移路径共用确定性演进规则，按迁移 `0027` 生成 `result=success`、`request_id=legacy-<源ID>`。全新 MySQL Schema 的 16 表/16,574 行应用及逐表哈希已通过，不再只依赖已回填目标库的基线对账。
- [ ] `MIG-0702` 实现 PostgreSQL → MySQL 增量迁移。已新增 `install:postgres-cdc[:preview]`、`migrate:postgres-cdc[:preview]`、MySQL 检查点/事件账本和操作手册；目标端增量应用已通过，真实 PostgreSQL 源端未安装/未追平，保持未完成。
- [x] `MIG-0703` 仅实现迁移白名单内 JW Agent Runtime SQLite → MySQL 迁移。`migrate:jw-sqlite:preview` / `migrate:jw-sqlite` 将批准的 `sessions.db` 绑定到固定 SHA-256、必需表、完整性和显式来源白名单；当前经评审的通用 JW 会话/消息白名单均为 0，37 个 `aipin-data-processing` 会话及 2,168 条所属消息只做聚合分类，不读取正文、不建立映射、不写 Agent 业务表。真实 MySQL 预演及两次应用确认会话、消息和两类来源映射均零变化，只保留 1 条幂等成功 Run 和 1 条聚合排除 Issue；源哈希、表、数量或来源集合变化均失败关闭。生产源完备性仍由 `MIG-0017~0019/PRE-012` 跟踪。（P0）
- [x] `MIG-0704` 实现 Flue SQLite → MySQL 会话迁移或归档。`migrate:flue:preview` / `migrate:flue` 已完成并通过隔离冒烟；实际生产历史待源库就位后应用。
- [x] `MIG-0705` 迁移程序支持 `dry-run`、断点、批次和幂等。（P0）`accept:migration-execution-contract` 在每次自动删除的隔离 MySQL Schema 中验证：预演对 16 表/16,574 行及迁移账本零写入；批大小 13/7 均可完成；后段坏 JSON 使默认全事务模式业务写入全部回滚并留下失败 Run/Issue；显式 `migrate:dump:checkpointed` 以同源 SHA-256 advisory lock 串行执行，将逐表完成前缀持久化到 MySQL `migration_runs.report`，在第 8 表中断时保留前 7 表、后 9 表零泄漏，第二次复用同一 Run ID、attempt 2 从断点完成 16/16；重复应用的业务行数、内容哈希和 16,574 条实体映射数量保持不变。测试中断开关仅允许 `sbl_migration_contract_*` 隔离库。
- [x] `MIG-0706` 失败记录进入隔离表并生成报告。新增 `migration_runs`、`migration_issues`，应用模式遇阻断问题时拒绝写会话并持久化问题；预览模式输出同结构机器报告。PostgreSQL dump 与 Flue 导入器现共用 `MIGRATION_INVALID_JSON` 类型化契约，坏 JSON 的失败运行和问题同事务写入，只留源定位与列名、不复制原始坏正文；真实目标 JSON 全列扫描和恶意夹具通过。（P0）
- [x] `MIG-0707` 迁移程序以来源白名单过滤数据，发现 Aipin 表、目录或记录时跳过并写入排除报告。（P0）在线 PostgreSQL 仅遍历 17 张批准表，dump 仅解析 16 张批准表，Flue 仅读取固定 Canonical 表；`accept:migration-source-allowlist` 绑定成功对账的 dump SHA-256，核对其中 16 个 COPY 表且排除身份表/记录命中均为 0。恶意 Flue 路径与恶意表夹具分别稳定产生 `AIPIN_SOURCE_REJECTED`/`AIPIN_TABLE_REJECTED`，目标迁移台账及 Agent 表哨兵零变化；夹具失败报告汇总到专用 0600 报告后清理，不污染生产来源就绪判断。发布门禁内部强制执行严格源/代码/环境/目标排除审计。
- [ ] `MIG-0708` 增量迁移支持插入、更新、物理删除、级联删除、tombstone、源/目标 watermark 和延迟报告。（P0）实现已覆盖上述事件、source safe/observed watermark、target last sequence、活动事务阻挡数、复制延迟、重放及各操作计数；隔离目标验收通过。当前源 PostgreSQL 离线且无生产延迟门槛/最终追平报告，故不勾选。
- [x] `MIG-0709` 迁移程序对关键业务字段生成规范化 checksum，并验证孤儿外键、状态机和跨表业务不变量。（P0）`accept:migration-business-invariants` 绑定 checksum 锁定 dump 及其成功对账 Run，逐表核验 16/16 个源/目标规范化 SHA-256；目标 82/82 张物理表均生成稳定唯一键 checksum，133 个外键孤儿为 0。24 项目标跨表业务不变量及 19 项状态机/绑定不变量均为 0。1 条孤立 `ready` Pipeline 验收残留已沿 `ready→review→rejected` 合法路径隔离，原始事件/决策/迁移台账/审计完整保留、物理删除 0。外部源资产缺口现为 97 条原详情、0 条未处置项目原件和 7 个 AI 产物；17 个项目原件的批准缺失逐项台账已由审计器识别，不再作为违规。

### 10.2 数据域迁移

- [x] `MIG-0710` 迁移当前项目的用户、部门、角色和权限；仅按批准的身份映射保留非 Aipin JW Runtime 历史归属，不迁移 Aipin 专用角色和用户项目关系。当前源中的 5 个用户已迁移并建立双来源映射。
- [x] `MIG-0711` 迁移当前项目的项目、成员和权限关系，不迁移 Aipin 项目及用户项目关系。已迁移 15 个项目；源库无独立项目成员表。
- [x] `MIG-0712` 迁移线索、来源、雷达画像、评分和同步游标。已迁移 892 条线索和 10,000 条 `lead_reserve`。
- [x] `MIG-0713` 迁移会议、待办、风险和流程。已按源基线迁移 1 条会议、8 条待办、0 条风险。
- [x] `MIG-0714` 迁移文件元数据、知识库切片和解析状态。已迁移 18 条文件、53 条文件分块、4,781 条知识分块。
- [ ] `MIG-0715` 迁移 Agent 会话、消息和工具历史。部分完成：PostgreSQL dump 的 13 个会话索引已形成 13 个只读 Agent 索引且源 `messages` 均为空；当前两份 Flue 候选为 0 内容库和已批准排除的固定验收 fixture，JW 白名单为 0、拒绝 37 会话/2,168 条 Aipin 消息。Flue 迁移器已动态验证可见索引、主/子会话、消息/Part、附件/工具/中断状态、重复合并和两次幂等；跨源只读报告确认当前授权业务消息数为 0、目标内部零违规，但生产资产盘点未批准且没有生产业务正文可对账，所以本项保持未完成。
- [ ] `MIG-0716` 迁移 AI 任务、产物、来源和模板。
- [ ] `MIG-0717` 迁移白名单内的 Provider、Profile、Skills、MCP、插件和通用定时任务，不迁移 Aipin 配置和任务。
- [ ] `MIG-0718` 迁移审计日志和运行状态。部分完成：现有审计日志已在迁移 `0027_add_audit_request_result` 中补齐非空结果与请求 ID，历史记录确定性回填，新增 HTTP/非 HTTP 记录均可关联；旧生产源审计与运行状态的全量源清单、逐表对账及签字仍未取得，因此保持未完成。
- [ ] `MIG-0719` 按批准结论迁移/归档 OA 审批、流程日志、投后更新、通知已读、旧材料、组织字典、模板、Radar 非库资产和 `lead_reserve`。（P0）部分完成：OA/流程日志与组织/角色/权限/字典已正式化到 MySQL，材料能力并入 AI 任务，模板保留只读/受控自定义链，旧投后和通知退场；当前本机 Radar 数据已归档恢复，10,000 条 `lead_reserve` 全部保留且 9,903 条进入不可变事件。专项门禁给出 `localTechnicalReady=true`、`productionAssetReady=false`；97 条缺详情、406 条 imported 时间未知及生产 Radar/群聊/公众号原资产清单、权限、保留期和恢复签字仍未完成，因此不勾选。

### 10.3 数据核验

- [x] `MIG-0720` 核对每张表读取、写入、跳过和失败数量。（P0）在线与 dump 迁移器均会在成功事务内原子保存逐表数量、哈希和 `migration_runs`。针对已演进的当前 MySQL，本次使用 `migrate:dump:reconcile-existing` 在 REPEATABLE READ 事务内读取 checksum 锁定 dump 的 16 张表/16,574 行，写入 0、跳过 16,574、失败 0，并核验源 ID 覆盖和目标演进白名单。二次执行复用同一运行 ID，54 张非迁移台账表零变化。台账明确标记为当前基线核验，不伪造原始全量导入的历史写入数。
- [ ] `MIG-0721` 核对主外键、用户项目权限和会话消息关联。（P0）部分通过：81 张业务表与代码 Schema 一致，另有 1 张内部迁移台账表；133 个外键和全部关键跨表关联均 0 孤儿/违规，系统组织/角色/权限/字典、模型、能力、IM、配置历史及迁移实体映射引用也通过；项目权限隔离门禁通过。源 dump 中 4 个本就不存在的会话引用已置空并保留原 ID/dump 哈希问题台账，不制造假会话；但生产源会话消息语义对账未完成，不能勾选。
- [x] `MIG-0722` 核对 JSON、时间、枚举、布尔和唯一约束转换。`accept:migration-json-safety` 持续动态扫描目标 JSON 列和源端坏 JSON 隔离路径；`accept:timezone` 完成真实 MySQL 指定时刻、数据库默认值、API UTC ISO 和页面北京时间验收。最新 `accept:migration-scalar-constraints` 核验 63 个应用闭合枚举契约，其中 21 个按 checksum 锁定 PostgreSQL dump 与目标库逐值对账；17 个布尔列均为 `tinyint(1)` 且仅含 0/1/NULL，150 个 `varchar(36)` UUID 列物理类型与值格式正确，33 个代码唯一索引在 MySQL 中名称、列顺序完全一致且无重复组。报告写入受限迁移证据目录并加入发布门禁。线索有效名称唯一规则尚未启用是已知业务裁决项，继续由 `DB-005/MIG-0125` 跟踪，不冒充现存约束。
- [ ] `MIG-0723` 核对文件存在率、容量和 SHA-256。（P0）已实现 `inventory:files` / `check:file-manifest`、项目原件发现/回填、AI 产物强身份恢复及缺失资产隔离报告。17 个缺失项目原件已由用户明确批准忽略并逐项落账。剩余 7 个 AI 产物现有精确 0600 决策底稿：4 个合规性说明、3 个投资提案，均为已排除生成测试的类别，但工具明确拒绝把测试排除当作 `approved-permanent-archive`；当前仍 pending，另有生产文件根批准未闭环，因此不勾选。
- [x] `MIG-0724` 抽样打开 PDF、DOCX、PPTX、XLSX 和图片。`accept:migration-file-samples` 使用 5 份受版本控制的真实代表文件，先经项目上传同源的扩展名/MIME/签名与 OOXML 路径、条目数、解压容量安全检查，再分别验证 PDF 页和文本层、DOCX 正文、PPTX 幻灯片/可编辑文本、XLSX 工作表/单元格及图片尺寸可读。XLSX 首次暴露 ExcelJS 无法打开的 WPS/OOXML 兼容差异，已按正式解析链改用 SheetJS 回退后通过。5/5 样本签名安全和结构可读；0600 证据只保存哈希、容量和结构计数，不保存路径、文件名或正文。本抽样不代替 `MIG-0723/FILE-012/014` 的生产全量补源与 manifest 对账。
- [x] `MIG-0725` 生成机器可读和人工可读迁移报告。（P0）已生成 `.runtime/migration-evidence/mysql-reconciliation/report.json` 与 `summary.md`；报告明确区分 Schema、外键、跨表业务关系、源端执行证据和全量就绪结论，不以目标当前数冒充本次写入数。`check:migration-integrity` 仅验证目标结构，`check:migration-reconciliation` 在源对账和待处置项未清零时严格失败。`accept:migration-evidence-safety` 同时扫描报告/manifest/隔离报告的完整环境密钥、通用凭据格式和非必要正文，并强制全部证据文件为仅所有者可读、禁止符号链接。
- [x] `MIG-0726` 生成 Aipin 排除报告，证明未读取、映射或写入 Aipin 业务数据。（P0）严格审计扫描 161 个活动运行时/配置文件、63 张目标表和 557 个文本/JSON 列，环境变量名、活动代码、目标表/值均 0 命中；三份 JW SQLite 备份 SHA 与评审基线一致且 integrity_check=ok，37 个 `aipin-data-processing` 会话及所属 2,168 条消息全部列入拒绝集，0 条写入目标。JSON/Markdown 报告位于 `.runtime/migration-evidence/aipin-exclusion/`。
- [ ] `MIG-0727` 核对 CDC watermark、复制延迟、物理删除和级联删除应用完整率。（P0）测试源范围已核对到 sequence 6、删除 2/2、级联 1/1、重放 3 且业务零重复；生产源 watermark 与延迟尚不可用。
- [ ] `MIG-0728` 核对 OA/投后/通知/材料/字典/模板覆盖率及所有非 ORM 表、Radar 文件资产和浏览器遗留状态处置结果。（P0）《附属业务域迁移与退场报告》已逐域裁决：OA 与组织/角色/权限/字典已迁移到受审计 MySQL API，材料能力并入 AI 任务；旧材料/投后页面源码和浏览器本地状态已删除，通知入口隐藏；本机 Radar 根已归档并恢复。仍受生产 Radar/文件资产清单、97 条储备详情、正式恢复演练和业务/数据签字阻断。
- [x] `MIG-0729` 核对姓名到用户 ID 的映射，所有重名、离职、缺失和孤儿记录均有人工结论。（P0）当前库项目负责人 15/15、会议主持人 1/1、待办负责人 8/8 已映射；唯一 `missing_user` 依据锁定源 dump 哈希、项目创建者与审计、2 个附件上传者、1 场会议主持人、7 个待办负责人一致证据绑定到“林知远”。裁决文件、事务锁、审计、幂等预览和重同步防回退均已验收，未决身份问题 0。

### 10.4 业务切换

- [x] `MIG-0730` 项目、线索、会议、风险等服务切换到 MySQL Repository。业务运行时已无 PostgreSQL Repository；仅迁移/盘点脚本保留白名单读取。
- [x] `MIG-0731` 保留旧 API URL 兼容层。以迁移前提交 `0a43c7d2d7eca0c55630a77c1ae29b02cf0d367d` 动态提取 88 条路由，80 条正式业务路由在当前源码逐条存在；8 条固定密钥绕过、Flue localhost 回调、伪解析/伪任务和元数据伪上传接口已依批准矩阵明确退场。`accept:legacy-api-compatibility` 在真实 3100 单服务中验证未登录 401、旧登录路径与 18 类关键响应形状，以及 8 条退场路由统一返回带 `requestId` 的 JSON 404；合成身份、项目、会话和审计残留为 0。
- [x] `MIG-0732` 所有保留业务页面只读写 MySQL 即可工作。（P0）Zustand 初始业务集合为空并由 MySQL-backed API 水合；OA 已迁移，旧材料/投后页面重定向，未持久化通知入口隐藏，系统页只读真实用户/模板/审计，不再暴露浏览器内存写入。
- [ ] `MIG-0733` 每个保留页面在清空 localStorage/sessionStorage 后仍能从 MySQL/目标文件存储恢复真实状态，不依赖 Mock 初始数据。（P0）24 项代码/Store 门禁及本地 `SMOKE-014` 浏览器验收通过；会议、线索转项目和风险事务验收分别 4/5/4 项通过，知识库使用真实原字节上传且不伪造解析成功，旧材料/投后本地状态和模拟导入/导出已删除。真实浏览器已证明项目原件解析、线索筛选/详情/转项目、项目评分、风险新增/处置、知识文件解析/筛选/视图和会议真实模型生成均能刷新恢复；会议明确负责人/期限现结构化保留，风险 Hydration/PATCH 默认值和知识库横向溢出已修复。本次不调用专业报告或 PPT 生成。AI 完整矩阵及生产 TLS 多角色/真实数据仍待人工验收，因此不整项勾选。
- [ ] `MIG-0734` 若线索池需要恢复 BP/批量导入，建立正式“原件安全上传 → 文件版本/SHA → MySQL 解析任务与租约 → 证据片段 → 人工复核 → 线索入池”契约，并覆盖权限、幂等、失败/重启恢复和禁止企业自述冒充核验事实。（P0）原定时器模拟进度、固定评分和虚构字段实现及固定成功 API 已删除；正式契约完成前入口保持退场。
- [ ] `GATE-M7-01` PostgreSQL 停止写入后核心业务仍可用。（P0）
- [ ] `GATE-M7-02` 数据数量、关联、权限和抽样核验通过。（P0）

## 11. 阶段 8：统一鉴权与系统管理入口

### 11.1 统一鉴权

- [x] `MIG-0801` `iam_users` 成为唯一用户身份源。按 `ADR-013`，`iam_users` 是概念域名，现有物理 `users` 表为唯一身份权威，不复制同义表。只读 `accept:identity-authority` 实库确认当前 5 个正式账号的规范邮箱、稳定 UUID/状态有效，跨域用户外键全部指向它且孤儿为 0，禁用用户无活动会话，项目 owner 成员关系一致。登录、Cookie、旧 JWT 迁移窗口、REST、Socket、项目权限和管理员接口均通过同一 `IdentityRepository` 重新加载用户；浏览器只从 `/api/auth/me` 恢复，不持久化本地用户库，活动运行时 Mock/直连用户表均为 0。
- [x] `MIG-0802` 实现 HttpOnly Cookie 会话。MySQL `auth_sessions` 仅保存会话与 CSRF 哈希，前端不再持久化 Bearer Token，新页面通过 `/api/auth/me` 恢复会话。
- [x] `MIG-0803` REST 与 Socket.io 共享身份和权限判断。（P0）两者共用 `auth_sessions` 及 MySQL 用户启用/项目权限复核。
- [x] `MIG-0804` 实现旧 JWT 兼容和退出计划。旧 JWT 默认关闭且生产配置禁止开启；仅迁移环境可在最长 30 天的 UTC 截止窗口内，对 1～100 个稳定用户 UUID 白名单启用。窗口到期后 Cookie 会话继续工作，旧 JWT 明确返回 `AUTH_LEGACY_EXPIRED`；退出方案由数据库全局失效水位和显式管理员命令收口。
- [x] `MIG-0805` 禁用用户后现有 REST/Socket 会话失效。（P0）`accept:socket` 验证 REST 立即 401，已连接 Socket 在重验周期内断开。
- [ ] `MIG-0806` 实现 CSRF Token 或严格 Origin/Referer 防护，并配置 `SameSite`、`Secure`、Domain、Path 和 CORS credentials。（P0）代码与部署已强制 CSRF/Origin、HTTPS、Secure Cookie、TLS 1.2+ 和 HSTS，`accept:runtime-config` 15 项通过；待目标证书和真实浏览器取证后勾选。
- [x] `MIG-0807` 实现登录后会话轮换、TTL/续期、并发会话策略、服务端吊销和 Cookie 密钥轮换。（P0）每次登录创建随机 Token/CSRF；MySQL 用户行锁串行限制最多 5 个活跃会话（可配置），新会话保留、超额旧会话吊销并通知 Socket；临近到期或使用旧 HMAC 密钥的会话原子轮换 Token/CSRF 并续期。`AUTH_SESSION_PREVIOUS_SECRETS` 支持平滑密钥轮换，移除旧密钥后未续期 Cookie 失效。5 项策略验收、14 项真实 HTTP 鉴权及 15 项运行配置验收通过，生产发布强制执行策略门禁。
- [ ] `MIG-0808` 确认旧 bcrypt 密码哈希兼容或制定强制重置方案，验证不存在明文密码迁移。（P0）`audit:password-hashes` 已对账源、稳定映射和目标各 5 条：均为合法 bcrypt cost 10、无明文/无效哈希且解析兼容；但 5/5 目标账号命中已知演示弱密码。隐藏二次输入、禁止密码 argv/env、cost 12、事务吊销会话和无密钥审计的轮换工具已通过 7 项验收；新增 0600 私有作业清单，当前目标/迁移/弱口令 5/5/5、就绪 0，文件不含密码或完整 bcrypt，严格命令退出 2、数据库写入 0。真实账号逐一轮换并复验前不勾选。
- [x] `MIG-0809` 定义旧 JWT 接受范围、截止时间、审计和强制失效命令。（P0）迁移 `0032` 新增单例 `auth_legacy_bearer_policy`，JWT 必须包含签发时间、用户位于稳定 UUID 白名单、当前时间早于精确 UTC 截止时间且签发时间晚于数据库 `revoked_before`。REST/Socket 首次接受分别写入不含 Token 的安全审计；`invalidate:legacy-bearer` 仅接受启用的系统管理员、0600 非符号链接批准理由文件，并在同一事务推进全局失效水位和写审计。7 项策略验收与随机独立 Schema 的单服务运行验收通过：REST/Socket 各成功一次并各有一条审计，推进水位后 REST 立即 401，已连接 Socket 在 1 秒重验周期内断开，隔离服务/Schema/端口全部清理。

### 11.2 系统组织、角色、权限与字典

- [x] `MIG-0840` 系统用户、组织、角色、权限和字典使用 MySQL 唯一权威。迁移 `0036/0037` 建立 8 张业务表及初始权限绑定；用户角色/部门绑定与身份创建、修改在同一事务提交，系统管理服务在事务内重新锁定并校验当前管理员。
- [x] `MIG-0841` 系统管理授权以数据库权限码 `system.manage` 为准，不再按角色中文名称回退。专项验收覆盖数据库授权即时生效、撤权即时拒绝、非管理员拒绝、组织环和乐观版本冲突、字典更新、无秘密请求关联审计及夹具清理。

### 11.3 模型设置

- [x] `MIG-0810` 在左侧导航增加“模型设置”。仅系统管理员和 AI 平台管理员可见。
- [x] `MIG-0811` 实现 React 路由 `/system/ai/models`。页面复用当前中台组件与 Tailwind 视觉体系。
- [x] `MIG-0812` 实现 Provider、模型、Profile 和任务模型路由管理。支持编辑、启停、版本冲突、角色白名单、默认模型及七类主备路由。
- [x] `MIG-0813` 实现服务端模型连接测试。保存状态、延时、时间和 Trace ID，错误脱敏且测试不触发正常计费生成。
- [x] `MIG-0814` 实现密钥加密、脱敏和替换写入。（P0）AES-256-GCM + Provider AAD；接口仅返回末四位，生产强制环境主密钥和 Provider 主机白名单。
- [x] `MIG-0815` AI 助手只展示已启用且已授权模型。新会话服务端复核并持久化 modelId，停用/失权后按当前角色回退管理员路由。

### 11.4 能力管理

- [x] `MIG-0820` 在左侧导航增加“能力管理”。仅系统管理员和 AI 平台管理员可见。
- [x] `MIG-0821` 实现 React 路由 `/system/ai/capabilities`。复用现有中台组件和 Tailwind 视觉体系。
- [ ] `MIG-0822` 实现 Skills、Agents、MCP、插件管理。已完成批准目录的同步、版本/来源/工具展示、启停和服务端测试；Agent 已提供模型路由、批准工具、轮数、预算、超时、角色和全局/部门/项目作用域的结构化配置，运行时按环境上限与管理员策略取更严格值，目录同步不会覆盖策略。Plugin 页现显示数据库记录、代码批准、安装、运行启用和动态安装策略，逐项展示版本、来源和依赖；未批准 Plugin 即使被旁路写入 MySQL 也只显示为未安装，不能启用、测试、绑定或进入用户运行能力。当前真实库 Plugin 记录为 0，不能虚构实例验证完整管理生命周期；任意外部 Skill/远程 MCP/插件安装执行仍保持白名单拒绝，因此本聚合项不整项勾选。
- [x] `MIG-0823` 实现全局、部门、项目和会话能力作用域。授权与会话选择分表，选择只能收窄既有授权。
- [x] `MIG-0824` 实现项目能力绑定和权限校验。稳定项目成员关系在列表、选择和 Runtime 三处复核。
- [x] `MIG-0825` AI 助手能力按钮只展示当前作用域授权项。Runtime 同时校验 Agent、MCP 及文档任务所需 Skill。

### 11.5 IM 机器人

- [x] `MIG-0830` 在左侧导航增加“IM 机器人”。仅系统管理员、运营管理员可见。
- [x] `MIG-0831` 实现 React 路由 `/system/integrations/im-bots`。已完成真实浏览器管理页、窄权限导航和普通用户深链回退取证。
- [ ] `MIG-0832` 接入钉钉配置、连接、入站和出站能力。通用钉钉文本 Webhook 出站、加密配置、启停/测试、Outbox 和授权入站路由已完成；尚缺真实钉钉租户凭据、原生回调签名/事件结构和生产收发联调，故不勾选。
- [ ] `MIG-0833` 接入飞书配置、连接、入站和出站能力。通用飞书文本 Webhook 出站、加密配置、启停/测试、Outbox 和授权入站路由已完成；尚缺真实飞书租户凭据、原生回调验签/事件结构和生产收发联调，故不勾选。
- [ ] `MIG-0834` 接入微信通知配置和发送能力。企业微信兼容文本 Webhook 出站和安全目标绑定已完成；微信登录/授权、真实目标发现和生产发送回执尚未验收，故不勾选。
- [x] `MIG-0835` 实现 IM 路由、用户/部门/项目/群聊绑定。绑定使用稳定用户、项目、Agent 会话和外部群聊 ID，服务端在创建和入站时二次校验授权关系。
- [x] `MIG-0836` 实现 Outbox、失败重试、发送日志和速率限制。MySQL 租约、过期回收、指数退避、有限重试、死信、幂等、每机器人限速和投递日志均由单一业务服务的进程内 Job 执行。
- [x] `MIG-0837` 实现机器人密钥加密、脱敏和审计。（P0）AES-256-GCM + Bot ID AAD，主密钥只由环境注入；列表、线索池、审计和错误均不返回密文或完整凭据。
- [x] `MIG-0838` 在线索池增加“渠道与推送配置”。管理员可按已授权目标、状态、项目、最低评分和模板保存规则，并将匹配线索加入 Outbox。
- [x] `MIG-0839` 线索池只引用授权机器人，不能读取完整密钥。（P0）规则以外键引用启用 Bot/Binding，安全接口只返回目标元数据；10 项真实 MySQL 验收和浏览器字段扫描通过。

### 11.6 阶段门禁

- [x] `GATE-M8-01` 三个入口均为当前中台风格的 React 页面。（P0）模型设置、能力管理和 IM 机器人页面均已实现并完成本地浏览器验收。
- [x] `GATE-M8-02` 普通用户不能访问管理路由或写接口。（P0）前端导航/路由守卫、Router 中间件和服务层三层限制均通过。
- [x] `GATE-M8-03` 模型、能力和 IM 变更均可审计和回滚。（P0）迁移 `0035` 新增统一配置版本表；Provider/Model/Route、Capability/Binding、IM Bot/Binding/线索推送规则在原业务事务中保存 AES-256-GCM 加密的变更前快照、AAD 和 SHA-256。管理页只展示脱敏版本元数据并以 `expectedVersion` 恢复；创建回滚安全停用、删除可重建、IM 影响需确认。活动资源回滚前的当前状态继续形成可逆版本；删除恢复复用原删除快照并追加审计，之后再次删除会按恢复后的新版本正常留痕。真实 MySQL 10 项覆盖凭据、修改/删除恢复、冲突、影响确认、完整性及 API/审计无秘密，夹具残留 0；未调用模型或任何专业报告/PPT 生成。
- [x] `GATE-M8-04` 密钥保护和权限测试通过。（P0）模型和 IM 凭据分别使用环境主密钥加密，响应/审计脱敏，普通用户服务层拒绝通过。
- [ ] `GATE-M8-05` Cookie/CSRF、会话固定、吊销、密码兼容、旧 JWT 退出和密钥轮换验收通过。（P0）
- [x] `GATE-M8-06` IM/能力扩展具备独立功能开关；若非迁移硬依赖，可书面批准延期且不阻塞核心切换。`AI_CAPABILITIES_ENABLED` 与 `IM_INTEGRATIONS_ENABLED` 为严格、互相独立的布尔开关；关闭能力扩展时核心聊天降级为无 MCP/Skill/项目工具的最小互动 Agent，关闭 IM 时管理、入站、线索推送和 Outbox 同时停止。9 项专项验收、生产配置门禁和发布流程均已接入，不回退旧 Flue。

## 12. 阶段 9：预生产、切换与旧底座下线

### 12.1 切换前

- [ ] `MIG-0901` 预生产全量迁移演练完成。（P0）
- [ ] `MIG-0902` 预生产增量迁移演练完成。（P0）
- [ ] `MIG-0903` 完整验收清单通过。（P0）
- [ ] `MIG-0904` 性能、稳定性、安全和恢复测试通过。（P0）
- [ ] `MIG-0905` 正式切换时间、人员、沟通和维护窗口确认。（P0）技术前置现可用`audit:cutover-readiness`查看脱敏聚合结论，并在窗口前以`check:cutover-readiness`严格失败关闭。清单范围裁决后，聚合器除原7类外又识别8个“已勾选但仍阻断生产”的延期P0/安全冒烟、9组未正式批准例外、6个未完成生产冒烟和13个未完成最终确认，当前共11类稳定阻断码；范围缩减或核心数量下降不会被误报为生产安全验收通过，因此仍不得安排正式切换。
- [ ] `MIG-0906` 回滚脚本、开关、备份和负责人确认。（P0）只读冻结开关现有 preview/apply 原子命令，拒绝宽权限、符号链接、重复键和并发漂移；解除冻结必须绑定五类不同负责人、watermark/sequence、commit、对账/manifest SHA 的 PONR 审批文件。8 项隔离验收通过；生产备份位置和真实负责人仍未确认。
- [ ] `MIG-0907` 旧系统到新系统增量追平。
- [ ] `MIG-0908` 未完成任务和会话处理方案确认。
- [ ] `MIG-0909` 明确最后安全回滚点、Point of No Return、超过该点后的前向修复策略和逐域写入冻结规则。（P0）技术规则已落入 CDC 切换手册与机器阈值契约；PONR 前统一服务三层写冻结、本地真实 MySQL 零写入已通过。仍缺生产 watermark/sequence 和业务、技术、数据、安全、运维联合签字，故不勾选。
- [ ] `MIG-0925` 切换前确认源/目标 CDC watermark、删除事件、文件 manifest 和线索/Radar 游标已追平。（P0）唯一服务的管理员只读页面已能联合查看四类状态并准确失败关闭；当前生产 CDC 无源 watermark、文件 manifest 有 7 个阻断且未批准、Radar 生产原资产未批准，因此仍不得切换。

### 12.2 正式切换

- [ ] `MIG-0910` 进入维护窗口并限制高风险写操作。
- [ ] `MIG-0911` 暂停旧 Worker、定时任务、Flue 评分和直接 LLM 审查。
- [ ] `MIG-0912` 执行最后一次增量同步。（P0）
- [ ] `MIG-0913` 核对关键表数量、更新时间和任务状态。（P0）
- [ ] `MIG-0914` 将旧数据库设置为只读。
- [ ] `MIG-0915` 将应用全部连接切换到 MySQL。
- [ ] `MIG-0916` 启动 JW Runtime、Claude Agent SDK Worker 和业务服务，并确认未注册或启动任何 Aipin 服务、路由和 Worker。（P0）本地 `accept:single-service-runtime` 已验证 1 个 `cybernaut-app` 同时承载 Web/API、JW Runtime、Socket、调度器和 Worker 管理，静态门禁无 Aipin；仍待正式切换窗口在目标机取证。
- [ ] `MIG-0929` 以 `cybernaut-app.service` 作为唯一项目业务部署单元启动；确认受监督子进程均在同一 cgroup 内。（P0）2026-08-11 获用户授权后的最新完整启停验收再次确认只产生1个`cybernaut-app`业务进程，Web/API与11个进程内组件健康且只监听3100，3584/8121关闭；验收后SIGTERM自动停机，主进程、Radar/Python/旧Assistant均无残留，三个端口释放。`capture:target-single-service-evidence`已接入部署启动后失败关闭：目标Linux现场只读核验唯一active/enabled单元、MainPID/cgroup、KillMode/MemoryMax/CPUQuota/TasksMax、3100 loopback监听归属、3584/8121、Nginx TLS与`.env`权限，并全量扫描service/timer、进程、cron和容器。当前macOS实启不能冒充目标Linux systemd/cgroup报告，一次性验收也已停止，因此本项继续未完成。
- [ ] `MIG-0917` 执行生产冒烟测试。（P0）
- [ ] `MIG-0918` 恢复用户访问。
- [ ] `MIG-0919` 观察错误率、延迟、Socket、慢查询、队列和 Agent 成本。
- [ ] `MIG-0926` 轮换并吊销旧 INTERNAL_SECRET、Cookie、模型、OSS、GSData 和 IM 密钥；验证旧值不可用。（P0）

### 12.3 回滚准备与判定

- [ ] `MIG-0920` 明确登录、权限、数据、AI、线索和 MySQL 回滚阈值。（P0）六域 13 个阈值已进入 `cutover-rollback-thresholds.v1.json` 并通过机器校验；生产状态仍为 `pending-production-window-approval`，待五类负责人签署后才能关闭。
- [ ] `MIG-0921` 切换窗口内的新数据可以反向导出或已停止相关写入。（P0）项目没有反向 CDC；本地只读实例已从 HTTP、启动恢复/Worker、认证续期和 MySQL 会话四层证明写入 0。仍待目标生产入口和六域窗口取证。
- [ ] `MIG-0922` 回滚时停止新系统 Worker 和写入的命令已验证。本地 `cutover:freeze-writes` 已在私有临时 `.env` 验证预览零写、原子应用、幂等、秘密不输出、重复键/符号链接拒绝；冻结后的隔离实启确认五类写组件不启动、DML 被 MySQL 拒绝且停机无租约写回。生产 systemd 重启和流量编排尚未演练。
- [ ] `MIG-0923` 旧数据库恢复可写和旧流量恢复步骤已验证。
- [ ] `MIG-0924` 回滚后核心数据和任务核对步骤已验证。
- [ ] `MIG-0927` 按身份权限、项目、线索、会话、AI 任务和文件逐域验证反向变更可被旧系统读取；无反向能力的域必须保持只读。（P0）当前明确六域均无已验收反向同步，本地统一写冻结通过；旧系统逐域读取和生产零增量证据仍未完成。
- [ ] `MIG-0928` 已验证 Point of No Return 后不执行不完整回切，而使用批准的前向修复流程。（P0）机器契约已强制任一目标写入即禁止自动回切、PONR 后仅前向修复；仍缺预生产/生产桌面演练与联合批准。

### 12.4 旧底座下线

- [ ] `MIG-0930` 观察期结束并获得业务、技术、数据和安全批准。（P0）
- [ ] `MIG-0931` 删除 Flue SDK、Runtime 和 `/ai/api` 代理。部分完成：活动前端、根依赖、构建、Nginx 和生产启动链已删除；旧 `cybernaut-assistant` 的 package/direct 脚本均硬禁用并返回 78，仅因生产 `flue.db` 尚未完成迁移核对而保留旧源码和依赖清单作为恢复证据。
- [x] `MIG-0932` 删除线上 PostgreSQL 写入依赖。`pg` 仅保留在离线盘点/迁移工具中，业务启动和运行不读取 `DATABASE_URL`。
- [x] `MIG-0933` 删除线上 SQLite 写入依赖。根生产依赖、统一 Node 入口和活动服务代码均不加载 SQLite；旧 Flue 目录启动入口已硬禁用，SQLite 只由离线迁移脚本只读访问。
- [ ] `MIG-0934` 更新部署、启动、备份、恢复、监控和故障手册。单服务部署/启动/故障手册、CDC 切换手册、Schema 变更/种子/回退手册、MySQL 备份/库存/恢复手册及《单服务运维指标与告警手册》均已同步到当前方案；生产告警责任链、异地介质和目标机现场命令证据未完成，故不整项勾选。
- [ ] `MIG-0935` 归档旧数据库和旧文件映射，不立即销毁恢复材料。
- [ ] `MIG-0936` 删除 `cybernaut-flue.service`、`cybernaut-radar-sync.service/.timer`、旧 `daily_intake` cron 和对应脚本入口。（P0）代码入口已退役；部署脚本会先停用六类已知旧单元，将 `/etc/systemd/system` unit 文件备份到私有迁移目录后移除，并清理 root/运行用户及全部 cron.d 中的旧任务。未知改名单元由全量 systemd/进程门禁失败关闭。等待目标生产机执行并取得成功报告后关闭。
- [ ] `MIG-0937` 删除 3584 端口、Nginx `/ai/api` 代理、`FLUE_BASE_URL`、`FLUE_DB_PATH`、`FLUE_AGENT_NAME` 和旧 Flue 包依赖。（P0）部分完成：活动代码/配置、根包和部署入口已清零，`check:single-service` 持续扫描；旧目录依赖清单仍作为未完成生产历史迁移的恢复证据保留，故不整项勾选。
- [x] `MIG-0938` 将 Flue→API 的 `/api/internal/*` Tool 回调改为进程内授权接口，删除仅为本机互调使用的固定 `INTERNAL_SECRET`。（P0）旧路由、材料内部端点、JWT 密钥旁路和部署变量均已删除；旧密钥回归请求返回 401。
- [x] `MIG-0939` Radar Job 化门禁通过后删除 8121 端口、`RADAR_BASE_URL` 和独立 Radar systemd 单元；否则建立有负责人和日期的限期例外。（P0）Job/Lease、在线事实源、进程内同步、端口和旧单元退场均已验证；原始文件归档继续由 `MIG-0507` 跟踪。
- [ ] `GATE-M9-01` 生产运行不再需要 PostgreSQL、SQLite 或 Flue。（P0）本地活动业务链已满足，旧依赖只留在离线迁移/恢复材料；待生产停库与进程清单证明。
- [ ] `GATE-M9-02` 完整重启后全部核心功能可用。（P0）本地冷启动验收和已运行服务只读观察均确认唯一 `cybernaut-app` 提供 Web/API/11 个必需组件，项目评分任务可从 MySQL 恢复过期租约；生产全功能冒烟、用户明确延期的专业报告/PPT范围及观察期未完成。
- [ ] `GATE-M9-03` 生产构建、配置、Schema 和进程清单通过 Aipin 排除核验。（P0）生产构建、本地 54 项静态门禁及源/目标严格排除报告通过；目标机进程、外部密钥库和部署配置取证待做。
- [ ] `GATE-M9-04` `systemctl`/容器清单中只有一个本项目业务服务，且无遗留项目 cron/timer、3584/8121 端口或 localhost 业务自调用。（P0）本地运行验收仅启动 `cybernaut-app`、只监听 3100，3584/8121 关闭；部署现强制运行 `capture:target-single-service-evidence`，自动固化全量项目 service/timer unit file、项目进程 cgroup 归属、端口、cron、容器和 Nginx TLS 脱敏证据，不再只检查已知旧名称或监听进程。尚缺在预生产和生产 Linux 各执行一次的成功报告，故不勾选。

## 13. 监控与运维清单

- [x] `OPS-001` HTTP 请求量、错误率和 P95/P99 延迟监控。唯一 Node 服务维护有界、无路径标签的 5/15 分钟滚动窗口，管理员 `/api/operations/metrics` 返回请求量、并发、2xx～5xx、错误率、P50/P95/P99/max；低样本不判阈值，20 个合成请求的状态和分位数动态验收通过。
- [ ] `OPS-002` Socket 在线连接、失败、重连和断开监控。当前快照已有在线数、累计连接/断开、握手/重认证/订阅失败、权限失效和 DB 并发等待；新增 5 分钟有界断线候选、认证重连量、待恢复断线和恢复率，接口只输出汇总且显式排除身份。真实验收以 12 个并发连接、6 个会话执行 3 轮全量重连，服务端精确识别 36 次重连，恢复率快照约 97.30%，确认消息丢失/重复均为 0、跨用户访问为 0、随机身份残留为 0。尚缺生产观察期断线恢复趋势和告警责任链，故不勾选。
- [ ] `OPS-003` AI 首 Token、总耗时、错误和取消监控。唯一服务新增 24 小时/最多 5,000 条的有界进程内 AI Runtime 遥测：JW 对话和主体、评分、研究、初筛、补全五类 Claude Agent SDK Profile 启用 partial message，只在首个非空文本/思考 delta 记录真实首 Token，并按 15 分钟/24 小时汇总成功、失败、取消、活动请求、首 Token P50/P95/P99/max、总耗时及观测覆盖率；Responses/视觉网关保持非流式时只计为 `firstTokenUnavailable`，不以完整响应时间冒充首 Token。P95 超阈值和观测覆盖不足已进入统一 Outbox 告警。21 项专项验收及主体 11 项、评分 10 项、工作流 14 项夹具确认首个 delta 只记一次、非流式缺口可见、零残留且快照不含提示词、输出、模型、密钥或用户/项目/会话身份。当前窗口无请求、无新增告警；专业文档网关仍非流式且进程重启会清零窗口，生产观察期与告警实收也未完成，故不勾选。
- [ ] `OPS-004` 线索 Agent 吞吐、时长、Token、成本、复核和死信监控。24 小时 Run/失败、输入/输出 Token、缺 Token、工具数、平均耗时和成本，评分队列/死信均已汇总；人工复核新增当前积压、24 小时新增/完成量、平均处理时长和最老待办年龄，并以 `LEAD_REVIEW_BACKLOG`/`LEAD_REVIEW_STALE` 接入统一 Outbox 告警，9 项真实 MySQL 验收确认创建、完成和零残留，当前实库积压为 0。输入 Token 解析虽已覆盖 SDK 顶层与按模型字段，但当前网关在线探针仍无正值，因此整项保持未完成。
- [ ] `OPS-005` MySQL 连接池、慢查询、锁、死锁和复制延迟监控。管理员快照已有 Pool 上限、总/空闲连接与等待请求、CDC 最大延迟；新增 Runtime 最小权限可读的连接/运行线程、历史连接峰值、慢查询累计数、当前/累计 InnoDB 行锁等待和累计等待毫秒，当前行锁等待达到阈值即告警。死锁与复制状态分别带观测可用性，缺少变量/权限时产生 `MYSQL_DEADLOCK_OBSERVATION_UNAVAILABLE`、`MYSQL_REPLICATION_OBSERVATION_UNAVAILABLE`，绝不以 0 冒充健康；可观测 Replica 的线程停止与延迟也已有告警。14 项真实只读验收确认当前行锁等待为 0、计数单调且输出不含主机/库名/账号/密码。当前实例 `performance_schema=0`，DML-only Runtime 无 `REPLICATION CLIENT`；生产仍须由数据库监控账号/基础设施采集器补齐死锁和复制观测及真实告警责任链，且不得放宽 Runtime 权限，故不勾选。
- [x] `OPS-006` Worker、队列积压、租约、超时和重试监控。Runtime Job、线索/项目评分和 AI Task 已汇总排队、运行、重试、失败、死信、活/过期租约与进程内活动数；新增 24 小时生命周期、失败、死信、取消、重试记录、明确超时、租约回收证据和当前过期租约聚合，六类阈值告警进入统一 Outbox。Runtime Job 使用逐次历史，其他三类按最近更新的生命周期记录计数，口径已在手册明确。
- [ ] `OPS-007` 文件上传、解析、下载、哈希和磁盘监控。当前快照已有文件数、字节、解析中/失败、缺内容身份、15 分钟成功下载/预览量；唯一服务以 5 分钟缓存只读探测两个必需和两个可选文件根的可读写性、最小剩余字节和最大使用率，并由现有 MySQL Runtime Job 每小时按“根配置 SHA-256 + 小时桶”幂等记录脱敏快照。快照只含可访问根数、缺失必需根、最小剩余字节、最大使用率和 `pathsExcluded=true`，不保存路径；24～72 小时前的同系列样本用于计算基线年龄、剩余空间下降和使用率增长，历史不可用、基线未形成及跨日增长均有稳定告警。14 项隔离验收确认 25 小时基线、1 GiB 下降、10 个百分点增长、同小时幂等和零残留；当前真实首条样本已写入，尚未满 24 小时。仍缺生产卷连续观察期和真实告警实收证据，故不勾选。
- [ ] `OPS-008` 登录失败、越权、密钥修改和高风险工具监控。当前汇总 15 分钟审计、拒绝、认证/登录/会话/CSRF 拒绝，并独立统计模型/IM 凭据替换和 Agent Runtime 高风险越界拒绝；`SECURITY_CREDENTIAL_CHANGED` 与 `SECURITY_HIGH_RISK_TOOL_DENIED` 已进入统一告警。尚缺生产责任人确认和真实安全事件收件/处置演练，故不勾选。
- [ ] `OPS-009` IM 连接、发送成功率、失败重试和 Outbox 积压监控。Outbox 排队/发送/失败/死信及 15 分钟投递量、失败量和平均耗时已汇总；真实钉钉/飞书/微信连接与回执尚未联调，故不勾选。
- [ ] `OPS-010` 关键告警已配置责任人、通知渠道和升级路径。已在唯一服务现有 `im-outbox-dispatch` Job 内完成告警/恢复通知入队、持久化指纹去重、60 分钟默认提醒、租约、限速、有限重试、dead-letter、投递日志和审计；16 项隔离验收通过且零残留，不新增服务、端口或 timer。当前 `alertRoutingConfigured=false`，尚未填写真实启用的 IM Binding UUID、外部升级策略并取得真实租户收件/确认记录，故不勾选。
- [ ] `OPS-011` CDC watermark、复制延迟、删除积压、漂移和重放失败监控。MySQL 检查点的源状态、最大延迟、watermark gap、删除/级联删除已汇总；生产 PostgreSQL 源离线，漂移/重放失败告警未实证，故不勾选。
- [ ] `OPS-012` Radar/`lead_reserve` 游标、采集状态、同步重复和漏采监控。Radar MySQL 事实源组件及储备池总量/已导入/缺详情/待处理已汇总；生产原始资产、逐源游标漂移、重复/漏采指标未完成，故不勾选。
- [ ] `OPS-013` 文档生成原生依赖、字体缺失、渲染失败和产物质量告警。唯一服务现已每 5 分钟无子进程探测 Python、LibreOffice、Poppler rasterizer/font audit、Tesseract 和 Fontconfig 的可执行状态，并从 MySQL 汇总 24 小时六类文档任务、原生依赖/渲染/字体失败及产物质量失败/未检查数量；四类稳定告警已进入同一 Outbox 路由且验收不启动 Office/Python/OCR、不生成 PPT。仍缺目标 Linux 干净节点和真实 Office/WPS 观察期数据，故不勾选。
- [ ] `OPS-014` Cookie 会话、CSRF 拒绝、旧 JWT 使用和密钥轮换状态监控。会话活动/吊销/过期、Cookie 策略、旧 Bearer 开关/截止/白名单数量及认证拒绝已汇总；新增当前密钥显式配置、历史密钥数量、兼容窗口、轮换开始配置、观察时长、最长会话寿命、24 小时/轮换开始后历史密钥命中、窗口逾期、可移除历史密钥和完成状态。历史密钥命中以空系统 Actor、`session:SHA-256;day=上海日期` 每 Session 每日幂等记录，不保存用户、Session、Cookie、Token、CSRF 或密钥；未配置当前密钥、轮换未跟踪、旧密钥仍活跃和窗口逾期均有稳定告警。14 项真实 MySQL 验收确认旧密钥命中精确 +1、重复不放大、续期转当前密钥、四类告警和零残留。当前实库为活动会话 1、历史密钥 0、24 小时命中 0、`complete=true`；仍缺目标 TLS 浏览器 CSRF 趋势和真实生产密钥轮换操作取证，故不勾选。
- [ ] `OPS-015` 主进程、Node Worker、Python 子进程的存活、退出码、资源使用、孤儿进程和优雅停机监控。已有主进程 CPU/内存/Event Loop/运行时间及当前受监督子进程 PID/耗时；新增 24 小时成功、失败、非零退出、超时、取消、停机排空、缓冲区超限、强制终止和平均耗时聚合，六类真实子进程路径以系统审计持久化并精确清理，目标只含执行键/可执行文件 SHA-256、原因、退出码、信号、耗时和强杀标志，不保存参数、路径或输出。三类阈值告警已接入统一 Outbox，当前清理后无子进程告警；停机/孤儿专项同样通过。生产 cgroup 资源序列、限额生效和真实观察期仍未取证，故不勾选。
- [x] `OPS-016` 调度 Leader Lease、Job Lease 争抢、重复执行、过期回收和多实例唯一执行监控。当前快照已有启用/租约/活动/死信、四类任务当前过期租约和 24 小时回收证据；Runtime/评分/AI Task 在实际领取、入队、恢复和完成条件失败路径追加统一协调事件，覆盖租约争抢、重复入队抑制、过期回收和旧执行结果拒绝。事件目标只保留域名与实体 ID 的 SHA-256，一分钟争抢去重，三类阈值告警复用统一 Outbox；9 项隔离验收及既有四类租约/多实例专项均通过并零残留。

## 14. 最终交付物核对

- [x] `DEL-001` MySQL Schema、迁移文件和 ER 说明。`server/src/db/schema.ts` 当前定义 81 张业务表，`server/drizzle/0000～0039_*.sql` 共 40 个只前进迁移，目标 MySQL 另含 `__drizzle_migrations` 台账表；《MySQL Schema 与 ER 说明》按领域列全表目录、核心关系、关键约束/删除规则和变更验收流程。静态门禁逐表比对文档目录与 Schema，并绑定迁移首尾、结构证据和未关闭的生产源/在线 PostgreSQL 阻塞项。
- [x] `DEL-002` MySQL Repository 接口、实现和测试。身份、系统组织/角色/权限/字典、Agent 会话、AI Task、Provider/Model/Route/Capability 与 IM 均具备独立契约、MySQL 实现和组合根；对应运行态领域表直连归零。配置版本另由统一 Repository 加密保存并回滚。来源账号绑定安全轮换后，82 表/133 外键、系统管理 11 项、严格目标结构与静态依赖门禁全部通过。
- [x] `DEL-003` PostgreSQL/SQLite/Flue 数据迁移程序和报告。《异构源数据迁移程序与执行报告》绑定在线/dump/CDC PostgreSQL、JW SQLite、Flue SQLite 的预览/应用入口、白名单、断点/幂等、内容校验和当前机器报告：dump 16 表/16,574 行基线已对账，JW 批准投影 0、拒绝 37/2,168，两个 Flue 候选业务写入 0。在线生产源、真实 Flue 业务/附件和最终追平仍缺，`fullMigrationReady=false`，不提前关闭数据迁移项。
- [x] `DEL-004` 模块化 JW Runtime。Runtime、事件投影、MySQL 会话服务和路由已模块化，同一 Node 服务内完成消息/Part/Snapshot、Socket/REST 恢复、工具/预算/环境边界和优雅停机；专项 Runtime、重启、工具生命周期和单服务实启验收均已接入。
- [x] `DEL-005` React `useJwAgent` 和消息转换层。阶段计划最终采用 `MIG-0301` 的正式名称 `useJwAgent`，不另建重复的旧名 `useJediAgent`；Hook 已实现 Socket、REST 补偿、发送/停止/交互，`aiMessageSafety.ts` 负责不可信 Snapshot 到安全 React 消息模型转换。
- [x] `DEL-006` Claude Agent SDK 线索 Pipeline 和五类 Agent Profile。主体、研究、初筛、评分、补全五类版本化 Profile、结构化输出、证据绑定、决策/复核/实体匹配落库和全局并发/速率/预算/熔断门禁已交付；生产源缺口和指标未完成项继续由 M5 数据/性能门禁跟踪。
- [x] `DEL-007` 项目知识库、线索研究和 AI 专业任务工具。三个宿主工具服务均以稳定用户/项目/会话绑定权限、网络/类型白名单和确定性幂等键执行，模型不能自报项目 ID 扩权；项目知识、公开情报、专业任务引用验收已接入。
- [x] `DEL-008` 模型设置、能力管理、IM 机器人 React 页面。三个当前中台路由均已交付；外部 IM 原生渠道的生产联调仍由 `MIG-0832～0834` 独立跟踪。
- [x] `DEL-009` 统一鉴权、权限、密钥和审计模块。MySQL 会话、REST/Socket 同源身份、管理员/项目成员权限、模型/IM AES-256-GCM 凭据、集中脱敏和不可变审计模块已交付；5 个弱密码及生产密钥真实轮换仍单独阻断发布，不以模块交付替代现场操作。
- [x] `DEL-010` 文件工作区安全模块。专用文件根、内容/档案检查、路径与符号链接拒绝、SHA/版本/配额/去重、跨用户隔离和受保护下载审计已交付；17 个项目原件已获精确批准，剩余 7 个 AI 产物和生产文件根仍阻断全量 manifest，并未因模块交付而关闭。
- [ ] `DEL-011` 自动化测试、金标集和端到端验收报告。
- [ ] `DEL-012` 切换、回滚、备份恢复、监控和故障手册。切换/PONR、Schema 回退、MySQL 备份库存与恢复、单服务启动故障及运维指标/告警手册已交付并有静态门禁；监控责任人/通知渠道、生产异地备份和现场恢复签字仍缺，故保持未完成。
- [x] `DEL-013` JW 迁移白名单、Aipin 拒绝清单、静态扫描结果和最终排除报告。《JW 迁移白名单与 Aipin 拒绝清单》与严格机器报告固定当前批准来源：214 个活动文件、82 张目标物理表、688 个文本/JSON 列均 0 Aipin 命中，37 会话/2,168 消息拒绝且目标写入 0；恶意路径/表夹具也零目标变化。该“最终”只针对当前批准基线，生产未知源盘点和销毁签字仍由 `MIG-0017～0019/PRE-012` 阻断。
- [ ] `DEL-014` 权威数据源矩阵、页面功能追踪矩阵、生产 Schema 漂移报告和全部文件 manifest。
- [x] `DEL-015` CDC/删除同步、watermark、漂移对账、反向变更和 Point of No Return 手册。《PostgreSQL 增量 CDC 与切换手册》绑定 17 表触发器、MySQL 检查点/事件账本、安全 watermark、删除/级联 tombstone、中断重放、三层漂移对账和六业务域回滚窗口；明确没有反向 CDC，回滚窗口必须保持写冻结，PONR 后只做前向修复。真实源追平和 `CUT-014/015/016` 仍未完成，不因文档交付而关闭。
- [x] `DEL-016` OA/投后/通知/材料/组织/角色/权限/字典/模板及 Radar/`lead_reserve` 的迁移或退场报告。《附属业务域迁移与退场报告》逐项绑定当前入口、MySQL/退场裁决、机器验收和删除禁令；组织/角色/权限/字典已转为受审计 MySQL 管理域，浏览器旧写入退场；9,903/10,000 条储备详情事件化、97 条缺源隔离、本机 Radar 根已归档恢复，但生产原资产/审批仍阻断 `MIG-0719/0728`。
- [x] `DEL-017` Cookie/CSRF/会话生命周期与密钥轮换设计及安全验收报告。《阶段性交付物实现证据索引》固化 HttpOnly/Secure/SameSite、双提交 CSRF + Origin、MySQL 会话并发/续期/旧密钥窗口、旧 JWT 有界迁移与 kill switch、离线密码轮换和对应六类专项验收；真实生产 Cookie/会话/外部密钥轮换仍由 `SEC-013` 跟踪。
- [ ] `DEL-018` 六类专业任务内容/来源/渲染金样及原生依赖/字体版本清单。
- [x] `DEL-019` 服务合并设计、迁移/最终拓扑、进程与端口退场报告、单一业务服务部署及故障手册。当前架构交接文档已纠正旧 Flue Agent、已删除服务文件、投后页和未实现 OSS 等过期描述；新增《单服务部署、启动与故障手册》，明确唯一 `cybernaut-app.service`、3100、外部基础设施、短时子进程、3584/8121 退场、启动/停止/健康取证、五类故障处置、扩展回滚和禁止恢复旧服务清单。静态门禁绑定文档与实际入口。

## 15. 阶段签字记录

| 阶段 | 结论 | 负责人 | 日期 | 证据/备注 |
|---|---|---|---|---|
| M0 基线完成 | 通过 / 不通过 |  |  |  |
| M1 MySQL 就绪 | 通过 / 不通过 |  |  |  |
| M2 JW Runtime 就绪 | 通过 / 不通过 |  |  |  |
| M3 AI 对话切换 | 通过 / 不通过 |  |  |  |
| M4 文件与知识库 | 通过 / 不通过 |  |  |  |
| M5 线索 Agent 切换 | 通过 / 不通过 |  |  |  |
| M6 专业 AI 任务 | 通过 / 不通过 |  |  |  |
| M7 业务数据切换 | 通过 / 不通过 |  |  |  |
| M8 管理入口切换 | 通过 / 不通过 |  |  |  |
| M9 统一底座上线 | 通过 / 不通过 |  |  |  |

## 16. 执行证据索引

| 清单 ID | 证据类型 | 路径或链接 | 说明 |
|---|---|---|---|
|  | 提交 / 日志 / 截图 / 报告 / 工单 |  |  |
|  |  |  |  |
|  |  |  |  |
