# 系统组件与最终服务拓扑

> 项目：浙江赛智伯乐投资中台
> 复核日期：2026-08-09

## 最终结论

项目最终只保留 **1 个业务服务**：`cybernaut-app.service`。它直接启动 `server-dist/index.js`，统一监听 `127.0.0.1:4100`。

MySQL、Nginx 和外部 LLM Gateway 是基础设施/外部依赖，不计入项目业务服务数量，也不能被误解为可省略。Python、Office/PDF 和 Skill 命令是由主服务按任务启动并监督的短时子进程，不是独立常驻服务。

## 组件归属

| 能力 | 运行归属 | 状态/权威源 |
|---|---|---|
| React Web、Express REST、健康检查 | `cybernaut-app` / 4100 | 同一构建和 HTTP Server |
| Socket.io、JW/Claude Agent Runtime | `cybernaut-app` 进程内 | MySQL 会话/消息；Socket 实时推送 |
| 项目、线索、会议、待办、风险、文件、知识库 | `cybernaut-app` 领域服务 | MySQL + 私有文件存储 |
| OA 申请、节点、意见、待办和阶段流转 | `cybernaut-app` 领域服务 | MySQL 事务状态机；稳定用户 ID |
| AI Task、线索评分、项目评分、模板分析 | `cybernaut-app` Worker | MySQL 任务/租约/失败与恢复状态 |
| Radar、36氪摄入与同步 | `cybernaut-app` 进程内 TypeScript 采集与调度 | MySQL 原始事件、候选投影、来源、状态和 Job |
| 文档/PPT/PDF/Office 处理 | 主服务监督的短时子进程 | 状态与产物索引回写 MySQL |
| 模型设置与调用 | `cybernaut-app` 管理 API/React 页面；Runtime/Worker 调用外部网关 | Provider/模型/7 类 Profile 路由在 MySQL；API Key 以环境主密钥 AES-256-GCM 加密，列表只返回掩码 |

## 已合并或去除的旧服务

| 旧单元 | 裁决 |
|---|---|
| `cybernaut-api.service` | 合并/更名为唯一 `cybernaut-app.service` |
| Flue / `cybernaut-assistant` 常驻服务（3584/历史 8791） | 去除运行依赖；启动入口已硬禁用，源码暂作历史迁移恢复材料 |
| Radar FastAPI / project-discovery（8121） | 功能与数据并入主服务后退役；不保留运行或代码依赖 |
| Radar Sync service/timer | 去除；改为 MySQL 持久化调度 |
| `daily_intake` cron/脚本服务 | 去除；改为 MySQL Runtime Job |
| API↔Flue、timer→API localhost 回调 | 去除；改为进程内领域接口 |
| 旧材料页、浏览器投后更新、通知已读、组织/角色/字典假写入 | 从正式入口退场；旧材料/投后页面源码及 Store 本地状态已删除，取得 MySQL 契约和验收前不得恢复 |

## 端口和启动

```text
Internet
   │
Nginx / TLS                     外部 LLM Gateway
   │                                   ▲
   ▼                                   │
cybernaut-app.service ────────────────┘
127.0.0.1:4100
   ├─ Web / REST / Socket / JW Runtime
   ├─ MySQL 租约 Worker 与调度器 ─── MySQL 8.x
   └─ 按需监督子进程（Python/Office/PDF）
```

生产业务启动只需：

```bash
systemctl start cybernaut-app
```

前提是 MySQL、Nginx/TLS（对外访问时）和所需的外部 LLM Gateway 已可用。不得再启动 3584、8121、旧 Flue、Radar Sync timer 或项目 cron。

## 复验证据

- `accept:single-service-runtime`：仅启动 1 个业务进程，只监听 4100；3584/8121 关闭。
- `check:single-service`：72 项边界检查，扫描 252 个活动文件；含真实 HTTP SQL 注入/路径/越权/任意读取门禁、审计日志只读追加及请求关联、迁移证据脱敏、MySQL JSON 合法性/坏源数据隔离、JW Runtime 五类越界拒绝/审计及宿主密钥隔离、模型配置加密、能力作用域/会话防提权、源证据身份裁决、多实例调度单租约、MySQL 网络故障恢复、备份恢复及 Runtime 收窄边界。
- `check:mysql`：62 张表、96 条外键、MySQL 8.0.36 契约通过。
- `accept:migration-idempotency`：28 个 Schema 迁移、62 张表/48,122 行连续重复迁移无变化。
- `accept:security-boundary`：以生产配置自启动 1 个编译后的统一服务，在随机本地端口完成 55 项真实 HTTP 验收；SQL 注入、路径穿越、符号链接、跨用户/项目越权、任意文件读取、错误泄露和审计日志篡改均被阻止，高风险操作审计与响应请求 ID 可关联，异步知识分块及其他夹具残留为 0。
- `accept:migration-evidence-safety`：扫描 30 个迁移证据文件和其中 27 个 JSON/Markdown 报告；当前配置密钥、常见凭据格式、非必要消息/文件正文、非 0600 文件和符号链接命中均为 0。
- `accept:jw-runtime-boundary`：文件、子进程、网络、数据库和动态加载五类非白名单工具全部拒绝并写不可变审计；SDK 子进程环境不继承 MySQL/内部密钥，会话目录穿越和非白名单网关均被拒绝。
- `accept:migration-json-safety`：扫描 60 个 MySQL JSON 列、48,724 个列值，非法目标值为 0；坏源 JSON 以失败运行和 `MIGRATION_INVALID_JSON` 问题同事务隔离且不保存原始正文。
- `accept:mysql-backup-restore`：62 张表/48,101 行从 0600 一致性备份恢复到隔离 Schema，DDL/行数/内容哈希一致，RPO 0，隔离 Schema 已清理。
- `check:migration-integrity`：61/61 张业务表无 Schema 漂移，96 条外键和关键业务关联通过；完整源端对账门禁仍主动阻断。
- `accept:ai-model-settings`：12 项通过；覆盖 AES-256-GCM/AAD、生产 HTTPS/主机白名单、密钥不回显、乐观锁、管理员权限、角色过滤、主备路由、运行时调用、连接测试和无密钥审计。
- 当前模型配置：1 个加密 Provider、1 个启用模型 `gpt-5.6-sol`、7/7 Profile 路由已写入 MySQL；非计费连接探针通过，凭据不进入代码、文档或接口响应。
- `accept:ai-capabilities`：11 项通过；覆盖批准目录幂等同步、管理员边界、全局/部门/项目隔离、会话防提权、Runtime 代码白名单、文档 Skill 二次校验、停用生效、服务端测试与无敏感审计。
- `accept:oa-workflow`：12 项 OA 生命周期、权限、并发和恢复验收通过。
- `accept:client-state-authority`：20 项通过；浏览器核心五页刷新恢复且无控制台错误，模拟 BP 导入、项目导入/导出假成功、旧材料/投后本地状态和固定成功任务 API 已退场；项目编辑等待 MySQL 成功，模型健康探针与运行时共用鉴权网关配置。
- `accept:meeting-persistence`：4 项通过；会议、关联待办和操作者审计同事务提交，字段映射、刷新和失败回滚通过。
- `accept:lead-conversion`：5 项通过；线索转项目并发单胜者，项目/负责人/线索关联/实际操作者审计同事务提交且不制造摘要或文件。
- `accept:risk-persistence`：4 项通过；风险页面契约、稳定负责人、实际操作者审计、刷新恢复和事务回滚通过。
- `accept:auth-session-policy`：5 项通过；MySQL 用户锁限制并发会话，超额旧会话吊销，临期续期与当前/旧会话 HMAC 密钥平滑轮换通过；真实 HTTP 鉴权 14 项通过。
- `check:aipin-exclusion`：严格通过；159 个活动运行时/配置文件、环境变量名、62 张目标表和 546 个文本/JSON 列均无 Aipin 身份，JW 备份中的 37 个会话/2,168 条消息全部拒绝且目标写入为 0。
- `inventory:files` / `discover:project-file-sources`：本地 238 个文件完成盘点；17 个项目原件和 7 个 AI 产物源文件未找到。7 个不可下载产物已从在线列表隐藏并写入隔离台账，但严格源资产门禁继续阻断。
- `migrate:identity-resolutions` / `accept:identity-mapping`：唯一未决项目负责人依据锁定源 dump 哈希、项目 `created_by`、创建审计、2 个附件上传者、1 场会议主持人和 7 个待办负责人绑定到同一稳定用户；当前 15/15 个项目负责人已映射、未决身份问题 0，10 项身份验收通过。
- `accept:runtime-job-leader`：两个不同实例并发争抢同一到期周期任务只生成 1 个租约/运行记录；活动周期拒绝重复领取，过期租约标记 abandoned，另一实例以新运行记录接管。
- `accept:mysql-resilience`：有界连接池、排队恢复、TCP 断链失败关闭、同池自动重连、已确认提交保留及未提交事务回滚共 6 项通过；不停止真实 MySQL，也不依赖高权限 `KILL CONNECTION`。
- `test:server`：149/149；生产构建通过。
