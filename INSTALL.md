# Cybernaut 单服务安装与迁移

本手册对应当前 MySQL、进程内 JW Runtime 与 MySQL 持久化 Job 架构。旧 Flue
3584、Radar 8121、`INTERNAL_SECRET`、`daily_intake` cron 和 localhost 业务回调
说明已归档到 `docs/archive/INSTALL-flue-legacy.md`，不得用于新部署。

## 1. 运行拓扑

- 项目业务单元：`cybernaut-app.service`，一个常驻 Node 进程。
- 业务端口：仅 `127.0.0.1:3100`。
- JW Agent Runtime：Express 进程内组件；Socket.io 与 API 共用 3100。
- Radar：MySQL Job 调度的单次 Python 子进程，无常驻端口。
- Web：生产由 Nginx 提供静态资源，Express 也保留同包 SPA fallback；二者不增加项目业务服务单元。
- 外部依赖：MySQL 8.x、LLM Gateway；GSData 仅公众号采集需要。

“单服务”仅指项目业务部署单元收敛为一个 `cybernaut-app.service`，不表示数据库、
反向代理和模型网关也被打进同一个进程。启动边界如下：

| 运行单元 | 是否项目业务服务 | 是否常驻 | 启动要求 |
|---|---|---|---|
| `cybernaut-app.service` | 是，唯一一个 | 是 | 必须启动；统一承载 Web fallback、API、Socket、JW Runtime、调度器和 Worker 管理 |
| MySQL 8.x | 否，基础设施 | 是 | 必须先可用，否则应用启动失败；可使用外部托管库或本机独立服务 |
| Nginx / Ingress | 否，基础设施 | 是 | 生产公网 HTTPS 必须；仅在本机通过 3100 调试时可不启用 |
| LLM Gateway | 否，外部模型基础设施 | 按部署方式 | 核心数据页面不依赖，但 JW 对话、评分和文档 AI 能力需要其可用 |
| Radar Python、Office/PDF 子进程 | 否，受监督执行单元 | 否 | 不单独启动，由 `cybernaut-app` 按任务拉起并在完成后退出 |

因此，在 MySQL、Nginx/Ingress 和 LLM Gateway 已由平台持续提供的前提下，版本发布或
业务应用重启只需执行 `systemctl restart cybernaut-app`。若是整机冷启动，必须同时确认
这些基础设施已就绪，不能只启动 Node 进程就宣称全部功能可用。

根目录的 `npm start`、`npm run start:app`、`npm run start:all` 和 `./start.sh` 均指向
同一个 `server-dist/index.js`，不是四套服务。生产统一使用 systemd 命令，其他入口仅用于
本地或诊断；`docker compose up` 当前只提供 MySQL，不会启动业务应用或 LLM Gateway。

## 2. 环境要求

- Node.js 20+、npm 10+
- MySQL 8.x，目标库字符集必须为 `utf8mb4`
- Python 3.10+，并能安装 `project-discovery/requirements.txt`
- 生产部署需要 systemd、Nginx 和 root 权限

## 3. 配置

```bash
cp .env.example .env
```

必须配置以下 MySQL 变量：

```dotenv
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=cybernaut_mvp
DB_USERNAME=cybernaut
DB_PASSWORD=change-me
DB_FREFIX=sbl_
DB_POOL_SIZE=10
DB_POOL_QUEUE_LIMIT=40
DB_CONNECT_TIMEOUT_MS=10000
PROJECT_FILE_MAX_BYTES=104857600
PROJECT_FILE_ARCHIVE_MAX_ENTRIES=5000
PROJECT_FILE_ARCHIVE_MAX_UNCOMPRESSED_BYTES=262144000
PROJECT_FILE_MAX_COUNT_PER_PROJECT=500
PROJECT_FILE_MAX_BYTES_PER_PROJECT=5368709120
PROJECT_FILE_MAX_BYTES_PER_USER=21474836480
```

`DB_FREFIX` 是现有部署契约中的历史拼写，不要改成 `DB_PREFIX`。迁移器会按该值
改写迁移 SQL 中的表名、外键引用和约束名，非 `sbl_` 前缀也可使用。
连接池默认最多 10 条连接、40 个排队请求和 10 秒建连超时；队列满会返回明确错误，
不会无限积压。可按目标 MySQL 容量调整三个 `DB_POOL_*`/`DB_CONNECT_TIMEOUT_MS` 参数。
Socket 握手、订阅、广播和周期重认证通过 `SOCKET_DB_CONCURRENCY=8` 共用进程内
MySQL 背压许可池；该值应小于连接池上限，为 HTTP、Worker 和停机流程保留连接容量。
Web 默认使用 MySQL `auth_sessions` + HttpOnly Cookie，旧 Bearer 由
`AUTH_ALLOW_LEGACY_BEARER=false` 关闭。生产配置会拒绝弱会话密钥、HTTP Origin、
非 Secure Cookie、旧 Bearer 和演示账号种子；部署脚本强制 HTTP→HTTPS、TLS 1.2/1.3
和 HSTS，并设置 `AUTH_COOKIE_SECURE=true`。
还需配置 `JWT_SECRET`、LLM 网关地址/密钥和 JW 模型。JW 对话 Runtime 强制
使用 `dontAsk`，关闭 Claude Code 内建工具、Skills 和文件设置源，只允许宿主绑定的
单一宿主 MCP Server 只暴露项目摘要、项目资料搜索、文件列表、文件片段读取、受控 AI 任务创建/查询和公开情报采集七个白名单工具；部署脚本会覆盖旧的
`JW_AGENT_PERMISSION_MODE=bypassPermissions`。

MySQL 模型设置还要求 `MODEL_CREDENTIAL_ENCRYPTION_KEY`（32 字节 Base64 或 64 位
Hex）和非空的 `MODEL_PROVIDER_ALLOWED_HOSTS`。生产启动会拒绝缺失/无效主密钥或空主机
白名单；Provider 默认必须使用 HTTPS。新部署由 `deploy.sh` 生成并以 0600 `.env`
保存加密主密钥，升级不会覆盖已有值。该主密钥不是模型 API Key，禁止随意轮换；如需轮换，
必须先实现并执行全部 Provider 密文重加密。系统管理员或 AI 平台管理员在
`/system/ai/models` 新增 Provider、替换 API Key、配置模型角色和七类 Profile 主备路由。
接口与页面均不会返回完整 API Key；曾外泄的模型 Key 必须在供应商侧吊销后再写入新值。

Radar 与储备池 Job 的默认参数见 `.env.example`。生产部署模板会开启 Radar
周期采集和 36氪储备池每日 09:00 摄入 50 条；公众号任务只有在凭据可用时才采集。
项目资料默认单文件上限 100 MiB、每项目 500 个文件/5 GiB、每用户 20 GiB；Office
OOXML 文件同时限制 5,000 个内部条目和 250 MiB 解压后容量。上传入口会核对规范
Base64/Data URL、文件名、扩展名、声明 MIME、内容签名和 Office 内部结构，并以
SHA-256 在项目内拒绝新重复内容；每次替换保留独立路径和不可变版本元数据。

## 4. 安装、迁移与验证

```bash
npm ci
python3 -m venv project-discovery/.venv
project-discovery/.venv/bin/python -m pip install -r project-discovery/requirements.txt
npm run db:migrate
npm run migrate:radar
npm run migrate:project-file-metadata
# 确认预览报告并挂载齐历史原文件后再执行：
npm run migrate:project-file-metadata:apply
# 从明确授权的源目录按精确名称、容量、签名和唯一 SHA 寻找旧原件：
npm run discover:project-file-sources -- --root /path/to/source-backup
# 人工审阅 source-discovery.json 后才执行：
npm run migrate:project-file-sources -- --root /path/to/source-backup
npm run inventory:files
npm run audit:mysql-normalization
npm run audit:password-hashes
npm run accept:password-rotation
npm run accept:demo-user-seed-retirement
npm run accept:system-administration
npm run check:mysql
npm run accept:migration-idempotency
npm run accept:mysql-backup-restore
npm run accept:mysql-resilience
npm run accept:structured-logs
npm run accept:project-files
npm run accept:project-file-integrity
npm run accept:project-knowledge-tools
npm run accept:agent-ai-task-tools
npm run accept:ai-task-references
npm run accept:ai-task-lifecycle
npm run accept:ai-task-persistence
npm run accept:ai-task-unified
npm run accept:ai-model-settings
npm run accept:ai-capabilities
npm run check:platform
npm run build
npm run accept:clean-build
npm run accept:single-service-runtime
# 若 3100 已由目标服务占用，使用只读观察模式，不停止或重启服务：
npm run accept:single-service-runtime:observe
```

PostgreSQL/Flue 历史迁移必须先做一致性备份和 preview，再执行 apply；具体命令与
证据要求见 `docs/迁移计划/`。没有取得生产 `flue.db` 时，不得删除历史恢复材料。
`inventory:files` 会只读扫描项目原文件、AI 产物、自定义模板、generated、Agent
workspace、Skill 和 Radar 文件，生成逐文件 SHA-256、稳定归属和隔离问题报告到
`.runtime/migration-evidence/file-assets/`。人工处置完全部阻断问题后，用
`npm run check:file-manifest` 作为严格门禁；工具不会跟随符号链接、猜测归属或删除文件。
`audit:mysql-normalization` 按 NFKC、空白折叠和小写比较扫描邮箱、项目/公司名与
线索/公司名；人工处置全部冲突后以 `npm run check:mysql-normalization` 严格复验。
`audit:password-hashes` 会把 PostgreSQL dump 用户、`iam_user_mappings` 和 MySQL 目标用户
逐一对账，拒绝明文/无效 bcrypt、缺失映射和已知弱密码。生产 `deploy.sh init` 已将它
列为发布阻断门禁；命中弱密码时必须先通过受控流程轮换，不能临时跳过审计。

弱密码账号使用离线隐藏输入逐个轮换：

```bash
# 生产维护窗口先停止业务服务，避免已连接 Socket 等待周期复核
sudo systemctl stop cybernaut-app
# 生成 0600 私有作业清单；控制台只输出数量，不输出账号
npm run prepare:weak-password-rotation-roster
npm run rotate:user-password -- --email user@example.com
# 每轮轮换后刷新；weakAccounts 必须最终归零
npm run check:weak-password-rotation-roster
npm run audit:password-hashes
```

轮换命令不接受密码 argv 或环境变量；交互终端不回显输入并要求二次确认，也支持从
受控密钥管理器向 stdin 提供两行相同密码。禁止使用 `echo`、命令行参数或 shell 环境
变量传递密码。新密码至少 14 位并含大小写、数字和符号，默认 bcrypt cost 12；成功后
事务性吊销该用户全部会话并写入不含密码的审计日志。必须完成全部弱账号轮换，直到
`audit:password-hashes` 返回 0，才能重新执行生产部署；不要在审计失败时手工绕过启动。
私有清单默认写入 `.runtime/migration-decisions/weak-password-rotation-roster.json`，只保存
账号、bcrypt cost、完整哈希的 SHA-256 指纹和审计状态，不保存密码或完整 bcrypt。该文件
含账号身份，只能由账号负责人和安全运维在受限主机查看，不得复制到聊天或工单。
历史固定演示账号生成逻辑已经永久退役；上述轮换只针对已经迁移存在的真实账号，
不会创建新账号。兼容入口即使收到 `SEED_DEMO_USERS=1` 也只返回跳过；生产配置门禁仍会
拒绝该遗留开关，要求配置保持为 `0`。
`accept:migration-idempotency` 先把活动前缀的一致性备份恢复到随机隔离前缀，再只在隔离
前缀连续运行两次 Schema 迁移，核对全部目标表的 DDL、行数与逐行内容 SHA-256 均不变化，
最后精确清理隔离表；活动前缀写入始终为 0。构建完成后，`accept:single-service-runtime` 会以生产
安全配置临时启动唯一业务进程，核对 Web/API/全部进程内组件、仅 3100 监听、旧端口
3584/8121 关闭、结构化请求日志以及优雅停机后端口完全释放。
若 3100 已经运行，`accept:single-service-runtime:observe` 只读核对同一服务身份、全部必需组件、
唯一监听进程和旧端口关闭，并保证不启停任何进程。
`accept:mysql-resilience` 验证连接耗尽时的有界队列错误、释放后的排队恢复和被终止
连接的自动替换；`accept:clean-build` 在不复制 `.env`、运行数据或现有依赖的临时目录
执行全新 `npm ci` 与生产构建，并在完成后删除临时目录。
`accept:project-files` 对 PDF、Word、Excel、PPT、图片和文本类共 22 种扩展名执行
原始 Base64/Data URL、私有存储回读及伪造签名/MIME、超限、非法名称、压缩包膨胀等验收。
`accept:project-file-integrity` 验证每项目/用户配额、并发串行化、SHA-256 内容去重和
不可变版本原件回读。`migrate:project-file-metadata` 只读扫描数据库引用的现存原件并把
精确字节、SHA、重复/缺失报告写入 `.runtime/migration-evidence/project-files/`；只有确认
源文件根完整后才执行 `:apply`，脚本不会为缺失原件编造哈希或自动删除重复文件。
源文件发现器只读取数据库中仍无原件的精确文件名；名称、历史容量、内容签名和唯一
SHA 全部满足才允许复制到私有版本目录。源文件保持原位，模糊匹配、不同内容候选、
缺少稳定上传人或版本冲突均只写报告，不会自动认领。

## 5. 启动与健康

```bash
npm run start:app
curl http://127.0.0.1:3100/api/health
curl http://127.0.0.1:3100/api/health/components
```

组件健康应包含 `jw-agent-runtime`、`agent-socket`、`project-discovery-radar`、
`radar-mysql-source`、`mysql-runtime-jobs`、`mysql-lead-score-jobs`、
`mysql-ai-tasks`、`supervised-child-processes` 和 `mysql-auth-sessions`。鉴权组件同时输出活动/吊销/过期会话数、
Cookie 属性、旧 Bearer 开关与生产就绪警告。不得出现 3584/8121 监听、
`cybernaut-assistant`、Radar FastAPI、旧同步脚本或外部项目 cron/timer。

## 6. 生产部署

```bash
bash deploy.sh init
# 后续版本
bash deploy.sh update
```

部署前必须准备证书。默认读取
`/etc/letsencrypt/live/cybernaut.newmin.cn/fullchain.pem` 和 `privkey.pem`；不同域名或
证书路径通过 `DOMAIN`、`PUBLIC_ORIGIN`、`TLS_CERT_FILE`、`TLS_KEY_FILE` 提供。
缺失证书或非 HTTPS Origin 会在 Nginx/应用启动前明确阻断。

部署脚本会安装 Python 运行时、应用 MySQL 迁移、注册唯一
`cybernaut-app.service`、停用旧 systemd/timer、清理明确匹配的旧项目 cron、
配置 Nginx 只反代 3100，并检查健康、Skill、端口和进程。应用以专用
`cybernaut` 非 root 用户运行；systemd 对整个 cgroup 统一停止并限制内存、CPU、
任务数和可写目录。可通过 `APP_MEMORY_MAX`、`APP_CPU_QUOTA`、`APP_TASKS_MAX`
覆盖部署默认值。

生产应把 DDL 迁移账号与 `.env` 的 DML 运行账号分开。运行服务只读取
`DB_HOST/DB_PORT/DB_DATABASE/DB_USERNAME/DB_PASSWORD/DB_FREFIX`；迁移账号通过
root 所有的 `DB_MIGRATION_ENV_FILE` 临时提供，格式与授权见
`docs/迁移计划/MySQL运行与迁移账号分离方案-20260808.md`。生产进程只读核验
Schema 版本，不会使用运行账号执行建表或 ALTER。

## 7. 当前未关闭的生产门禁

- 生产 `flue.db` 一致性备份、历史会话实迁与归档；
- 真实 LLM Gateway 多轮对话、停止、恢复和工具权限验收；
- 目标机 systemd 沙箱生效取证，以及宿主公开情报工具的网络目标 allowlist；
- Radar/微信群原始文件的不可变归档与生产恢复演练；
- 生产 systemd、Nginx、cgroup、cron/timer 和密钥轮换核验；
- 生产 HTTPS 及 `Secure` Cookie、会话密钥轮换与旧 JWT 使用审计；
- `pptxgenjs/image-size` 上游修复或 PPT 库替换；当前已禁用有漏洞的 ICNS/JXL/HEIF 解析并加入恶意文件回归，但扫描告警仍存在；
- 全量业务、压力、回滚及观察期批准。
