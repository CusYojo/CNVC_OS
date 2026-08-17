# JW 迁移白名单与 Aipin 拒绝清单

> 盘点日期：2026-08-08  
> JW 源：`/Users/hyw/Desktop/jw`，分支 `master`  
> 原则：只迁移通用 Agent Runtime 能力；Aipin 代码、数据、角色、项目、队列、推送和监控一律拒绝。

## 1. 结论

JW 的通用 Runtime 代码可作为目标 `cybernaut-app` 的能力来源，但本机 JW SQLite 中没有可迁移的通用会话数据。`sessions.db` 中 37 个 Agent 会话的 `source` 全部为 `aipin-data-processing`，对应 2,168 条消息全部列入拒绝集，不写入 MySQL。

`lead-memory.sqlite` 只有查询缓存，实体、证据、关系和快照均为 0；该缓存不构成业务事实源，直接退场。`project-master.db` 为 0 行。当前已发现的两个 Flue 候选都有一致性备份：一个为空库，另一个仅含 checksum 锁定且获批排除的网关验收 fixture；仍必须在实际部署机证明不存在其他 `FLUE_DB_PATH`/`flue.db`。

## 2. 代码迁移白名单

以下仅表示允许按目标接口重构或移植，不允许原样携带 SQLite、Electron、Vue 或 Aipin 耦合：

| 能力 | JW 来源 | 目标处理 |
|---|---|---|
| Express + Socket.io 单入口 | `server/index.js` 的非 Aipin 部分 | 拆为可挂载模块，接入现有 Express HTTP Server |
| AgentSessionCore | `src/main/agent-session.js`、`agent-session-manager.js` | 去 Electron/SQLite/Aipin 依赖，状态写入 MySQL `agent_*` |
| Claude Agent SDK Runner | `src/main/runners/claude-code-runner.js` | 改为受监督 Worker/子进程，补超时、取消和退出码契约 |
| Provider / API 配置 | `config-manager.js`、`config/api-config.js`、`config/provider-config.js` | 密钥进入环境/密钥管理，非密钥配置进入 MySQL |
| Skills / Agents 扫描与管理 | `skill-scanner.js`、`agent-scanner.js`、`managers/skills/**`、`managers/agents/**` | 保留白名单目录与路径边界，不迁移 Aipin 内置组件 |
| MCP / Plugin / Capability | `mcp-manager.js`、`plugin-manager.js`、`plugin-runtime/**`、`capability-manager.js` | 建立加载 allowlist、依赖闭包与审计后再启用 |
| Hooks / Settings / Background Task | 对应 `managers/**` | 任务事实源改 MySQL，禁止仅内存状态 |
| Project Agent Profile | `project-agent-profile-manager.js` | 对接当前项目 UUID 与权限模型 |
| 通用文件与预览工具 | `agent-upload-utils.js`、`pdf-text-extractor.js` 等 | 复用现有文件根和权限校验，不复制旧路径假设 |

## 3. 明确不迁移

- 所有文件名或导出名匹配 `aipin-*`、`Aipin*`、`test-aipin-*` 的模块、脚本、文档和测试数据。
- `server/index.js` 中 Aipin Route、Project Service、Processing Queue/Scheduler、Sync、Feishu Pusher、Interaction、身份转换和监控初始化。
- Aipin 专用角色、用户项目关系、项目、任务、队列、推送模板、互动数据、报告和运行状态。
- JW Vue 渲染端；目标继续使用当前 React UI。
- JW SQLite 作为线上持久层；只允许离线迁移器读取批准的数据源。
- `qingbo-wechat-search` 和旧微信采集常驻链路；由 Radar Job 化阶段单独评估，不借 JW Runtime 迁入。

## 4. 数据拒绝证据

| SQLite | 表/域 | 行数 | 处置 |
|---|---|---:|---|
| `sessions.db` | `agent_conversations` | 37 | `source=aipin-data-processing`，全部拒绝 |
| `sessions.db` | `agent_messages` | 2,168 | 随所属 Aipin 会话全部拒绝；0 孤儿、0 重复消息 ID |
| `sessions.db` | 其他通用会话/项目/调度表 | 0 | 无数据可迁 |
| `project-master.db` | `project_master_records` | 0 | 无数据可迁 |
| `lead-memory.sqlite` | `lead_queries` | 100 | 无实体命中和快照的查询缓存，退场 |
| `lead-memory.sqlite` | 实体/证据/关系/快照 | 0 | 无数据可迁 |

## 5. 备份与恢复证据

一致性备份位于 `/Users/hyw/Desktop/sbl_jedi-migration-backup-20260808/jw-runtime`，目录权限已限制为当前用户。`sessions.db` 的 `PRAGMA integrity_check` 为 `ok`，备份中仍为 37 个会话、2,168 条消息。

| 文件 | SHA-256 |
|---|---|
| `sessions.db` | `f7b4df01f3e04481860cd4d7d1c94a3ac18ec1bba5dfbecbb4541494fbbe8163` |
| `project-master.db` | `26659c5e74c1f277daa93a59c30716f05d2c20ec3cca70ee9064b2755e3bd77f` |
| `lead-memory.sqlite` | `a7892beaf3dadcf859370ce086c70fc9cbf854747dd1ab011943f880bf236ccb` |

备份保存 Aipin 原始数据仅用于回滚；MySQL 迁移命令只可读取表结构、会话 `source` 和聚合数量来生成排除报告，不得读取或投影其消息正文。后续 JW 迁移器必须先按 `source` 和代码拒绝模式生成排除报告，再处理白名单数据。

2026-08-10 已实现 `migrate:jw-sqlite:preview` / `migrate:jw-sqlite` 和 `accept:jw-sqlite-migration`。迁移器只读取通用会话表的结构、来源字段和聚合数量，不读取拒绝会话的消息正文；当前显式批准的来源值集合为空，因此目标业务投影严格为 0。应用模式仅保存 checksum 绑定的成功迁移 Run 与聚合排除 Issue，重复应用保持单条台账；任何源 SHA-256、必需表、来源集合或 37/2,168 基线变化都必须重新评审，不会自动扩张白名单。

## 6. 当前缺口

1. 实际部署机仍需搜索全部 JW/Flue SQLite 和 `FLUE_DB_PATH`；如发现当前批准哈希之外的文件，必须重新建立 Schema、数量、来源和一致性备份基线。
2. JW 批准业务 `source` 集合当前为空。任何新增来源不得自动进入白名单，必须重新评审并绑定源哈希、数量和目标归属。
3. 生产 PostgreSQL 会话索引与新发现 Flue canonical stream 的消息级归属、附件字节、文件 manifest 和恢复尚未验证。
4. 当前严格排除审计只覆盖已批准源、当前活动代码/配置和当前目标 MySQL；生产资产清单未批准前，不能宣称全环境不存在其他 Aipin 源。
5. 源备份保留期、访问权限和最终销毁仍需业务、数据、安全与运维共同签字。

## 7. 当前严格排除结果

最新 `check:aipin-exclusion` 严格通过：扫描 214 个活动运行时/配置文件、82 张目标表和 688 个文本/JSON 列，活动代码、环境键、目标值和写入目标的拒绝源记录均为 0；JW 37 个拒绝会话/2,168 条消息仍完整落在拒绝集。`accept:migration-source-allowlist` 另以恶意路径/恶意表夹具证明拒绝会产生类型化问题且目标哨兵不变。

该结果是当前批准来源基线的最终排除报告，不替代尚未完成的生产源资产盘点。
