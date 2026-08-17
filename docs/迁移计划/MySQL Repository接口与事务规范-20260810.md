# MySQL Repository 接口与事务规范（2026-08-10）

## 1. 目的与当前范围

本规范把业务规则与 MySQL/Drizzle 查询分离。已实现并接入身份、Agent 会话、AI Task、AI 配置和 IM Repository，覆盖运行态用户访问、会话/消息、任务/产物/模板、Provider/Model/Capability 及 Bot/Binding/Outbox/Inbound。模型、能力和 IM 配置另由统一的加密版本 Repository 保存变更前快照并执行受审计回滚。来源账号绑定完成安全轮换后，五组真实 MySQL 专项共 31 项、配置回滚 10 项、178 项服务测试、账号最小权限、目标结构及静态依赖门禁全部通过。

这些证据已关闭 `MIG-0130/0131/0133/0134/0136/0139` 和 `GATE-M1-03`，`DEL-002` 已完成。生产源对账、文件原件、真实渠道与目标机切换仍由其他清单项独立跟踪，不因 Repository 完成而关闭。

## 2. 目录与依赖方向

```text
server/src/repositories/
├── contracts.ts                         # 稳定错误码及 MySQL 驱动错误映射
├── identityRepository.ts                # 与 Drizzle 无关的领域类型和接口
├── agentConversationRepository.ts       # Agent 会话、消息和 Part 领域接口
├── aiTaskRepository.ts                  # AI Task、产物、来源和模板领域接口
├── aiConfigurationRepository.ts         # Provider、Model、Route 和 Capability 接口
├── imIntegrationRepository.ts           # Bot、Binding、Outbox、Delivery 和 Inbound 接口
├── adminConfigurationRevisionRepository.ts # 模型、能力、IM 加密历史和回滚接口
├── index.ts                             # 进程组合根，选择 MySQL Provider
└── mysql/
    ├── mysqlIdentityRepository.ts       # 身份域 MySQL/Drizzle 实现
    ├── mysqlAgentConversationRepository.ts # Agent 会话域 MySQL/Drizzle 实现
    ├── mysqlAiTaskRepository.ts          # AI Task MySQL 实现
    ├── mysqlAiConfigurationRepository.ts # AI 配置 MySQL 实现
    ├── mysqlImIntegrationRepository.ts   # IM MySQL 实现
    ├── mysqlAdminConfigurationRevisionRepository.ts # 版本查询、恢复和审计事务
    └── configurationRevision.ts          # 变更前快照与版本摘要构造
```

依赖方向固定为：`Route → Service → Repository 接口/组合根 → MySQL 实现 → db/schema`。身份管理 Service 不得导入 `drizzle-orm`、`db/client` 或 `db/schema`。验收与迁移脚本允许为夹具和结果核验直接访问数据库，但不能作为业务运行路径。

项目权限查询仍保留 `projectAccessCondition` 这一可组合 Drizzle SQL 条件，供会议、待办、风险等领域在本域查询中复用；其中启用用户读取已经切换到 `UserRepository`。该 SQL 条件属于后续全域 Repository 收口范围，当前不伪装为已经消除。

## 3. 接口与数据约定

- Repository 只返回显式领域记录；Service 对外返回用户时必须移除 `passwordHash`。
- `find*` 未命中返回 `null`，不把正常未命中当数据库异常。
- 创建/更新/行锁、活动会话撤销、项目成员稳定 ID 绑定和审计追加均由接口显式表达。
- Service 依赖 `IdentityRepositoryProvider`；MySQL Provider 只在组合根选定，避免业务规则绑定具体查询语句。
- 批量 ID 空集合返回空结果，不生成非法 `IN ()`。
- Provider、Model、Route、Capability、Capability Binding、IM Bot、IM Binding 和线索推送规则的创建、修改、删除均在原业务事务中追加 `admin_configuration_revisions`；审计失败或业务回滚时不得留下孤立版本。
- 完整快照使用 AES-256-GCM、资源身份/源版本 AAD 和规范化明文 SHA-256；Provider/Bot 历史凭据仍只以密文存在，列表 API 只返回版本、操作、操作者、时间、摘要和快照可用性。
- 回滚必须锁定当前资源并核对 `expectedVersion`。创建回滚采取安全停用而非物理删除；Binding/推送规则删除可从加密快照重建；IM Bot 有启用绑定或待投递任务时必须二次确认。
- 活动资源回滚前的当前状态会作为新版本保存，回滚动作本身追加审计，因此可再次恢复。已删除 Binding/规则的重建复用原删除快照并追加审计；恢复后若再次删除，会以恢复后的新版本继续保存前态，不形成不可追踪的状态跳跃。

## 4. 错误约定

Repository 基础错误为 `RepositoryError`，稳定码如下：

| 错误码 | 语义 | 典型 MySQL 原因 | Service 处理 |
| --- | --- | --- | --- |
| `NOT_FOUND` | 需要存在的记录未找到 | 显式 Repository 判定 | 转为领域 404/拒绝 |
| `CONFLICT` | 唯一键或并发冲突 | 1062 / `ER_DUP_ENTRY` | 转为领域 409 或幂等结果 |
| `INTEGRITY` | 外键/关联完整性失败 | 1451、1452 | 拒绝写入并保留事务原状 |
| `TRANSIENT` | 可重试事务失败 | 1205、1213 | 由有界重试/上层任务处理 |
| `UNKNOWN` | 已确认是数据库错误但未分类 | 其他驱动错误 | 记录脱敏错误并失败关闭 |

Drizzle 可能把真实 MySQL 错误放入多层 `cause`；映射器必须向内查找驱动 `errno/code`。业务校验异常不得被包装为 Repository 错误，否则会破坏既有 HTTP 错误契约。

## 5. 事务与并发规则

- 多表业务写入必须使用 `IdentityRepositoryProvider.transaction()`，回调内获得同一数据库事务绑定的 `users/permissions/audits`。
- 管理操作先 `lockById(actor)` 重新核对当前管理员，不相信请求中携带的角色；用户修改再锁目标用户。
- 项目成员替换先锁项目，校验所有成员存在且启用，再在同一事务更新项目展示字段、删除旧稳定绑定、插入新绑定并追加审计。
- 身份变化与活动会话撤销在同一事务提交；提交后才广播进程内失效事件。
- 用户邮箱并发创建以数据库唯一键为最终裁决，Repository 统一映射为 `CONFLICT`，不能只依赖写入前查询。
- Service 抛错、约束失败或进程中断导致事务失败时，不得留下用户、成员或审计半写入。

认证会话表和旧 Bearer 策略仍由认证 Service 直接管理；其中涉及用户行与审计的操作使用绑定到同一 Drizzle 事务的身份 Repository Context，保证没有跨连接的假事务。

## 6. 已接入运行路径

| 运行路径 | Repository 使用 | 当前结果 |
| --- | --- | --- |
| 创建/修改用户 | 管理员行锁、邮箱查询、用户写入、会话撤销、审计 | Service 无 Drizzle/Schema 依赖 |
| 项目成员管理 | 项目行锁、用户批量读取、成员原子替换、审计 | 稳定用户 ID 为授权事实源 |
| Cookie/旧 JWT 登录认证 | 用户 ID/邮箱读取、最后登录时间、管理员复核、审计 | 用户表不再由认证 Service 直连 |
| 会话创建 | 同一认证事务内通过 Repository 锁用户 | 会话上限与用户存在性同锁保护 |
| 项目访问入口 | Repository 读取启用用户 | 项目可组合 SQL 暂保留 |

系统用户列表/状态切换、密码轮换、OA 审批人解析、项目/线索、AI 任务、IM、身份映射和宿主工具中的用户访问也已切换；静态门禁禁止运行态 Route/Service/Runtime/Middleware 再直接导入 `users` 表。Agent Runtime、会话 Service 及 Capability/IM/AI Task 的会话查询已改走 `AgentConversationRepository`，运行态 Route/Service/Runtime/Middleware 直接导入 Agent 会话、消息和 Part 表的数量为 0。AI Task、Provider/Model/Route/Capability 与 IM 均已完成本领域代码迁移；五组专项真实 MySQL 验收共 31 项全部通过，`DEL-002` 和全域 Repository 门禁已经关闭。

AI Task 的任务幂等、租约领取/续租、取消、失败、自动恢复、停机释放、产物、来源、系统模板、自定义模板和分析进度均已进入 MySQL Repository。主产物、预览、来源与任务完成态在同一事务提交；若租约、取消或状态条件不再满足则全部回滚。运行态 Route/Service/Runtime/Middleware 对 `ai_tasks/ai_artifacts/ai_task_sources/ai_task_templates/ai_custom_templates/ai_template_analysis_progress` 的直接导入为 0，6 项真实 MySQL 专项已通过。

## 7. 验收与发布门禁

```bash
npm run accept:identity-repository
npm run accept:agent-conversation-repository
npm run accept:ai-task-repository
npm run accept:ai-configuration-repository
npm run accept:im-integration-repository
npm run accept:admin-configuration-rollback
npm run accept:identity-administration
npm run check:platform
```

`accept:identity-repository` 使用真实 MySQL 验证：Repository 事务提交、同邮箱并发单胜者与稳定 `CONFLICT`、用户失败回滚、项目成员原子替换、成员失败回滚、活动会话撤销。夹具使用随机标识并精确清理。

`accept:agent-conversation-repository` 使用真实 MySQL 验证：会话对原子提交和失败回滚、12 路并发消息序号无重复、并发追加无丢失、外部消息 ID 幂等、终态不被重放降级、并发元数据合并无覆盖、运行中工具消息与 Part 原子中断；7 项均已通过并精确清理夹具。

`accept:ai-task-repository` 使用真实 MySQL 验证：并发幂等键单胜者与稳定 `CONFLICT`、12 路租约领取单胜者、产物/来源/完成态原子提交、完成条件冲突全量回滚、过期运行任务恢复、停机时取消与释放同事务；6 项均已通过并精确清理夹具。

`accept:ai-configuration-repository` 使用真实 MySQL 验证：Provider 审计失败全回滚、并发默认模型唯一状态、无效路由零写入、能力/授权乐观锁与审计事务、会话能力原子替换。`accept:im-integration-repository` 验证：Bot 审计失败回滚、绑定稳定引用、Outbox 并发幂等、双 Worker 单领取、投递日志/终态原子完成和入站并发去重；两组各 6 项均已通过并精确清理夹具。

`accept:admin-configuration-rollback` 使用真实 MySQL 随机夹具验证 Provider 凭据、Model/Route、Capability/Binding、IM Bot 凭据、IM Binding 和线索推送规则的加密历史与精确恢复；同时覆盖删除后重建、过期版本拒绝、IM 影响确认、AES-GCM/SHA 完整性、API/审计不含密文和明文秘密。10 项通过且历史、业务、审计夹具精确清理为 0；该验收不调用模型，不生成 PPT、尽调、提案、Q&A 或合规性说明。

`check:single-service` 强制接口、错误码、MySQL 实现、行锁、事务 Provider、加密历史、管理端历史入口、Service 依赖方向、认证/项目访问接入、专项验收脚本和部署门禁同时存在。`deploy.sh` 在发布阶段运行 Repository 及配置回滚专项验收。

## 8. DEL-002 完成盘点

以下计数来自 2026-08-10 对运行态 Route/Service/Runtime 的静态扫描，并由真实 MySQL 专项支撑完成结论：

| 完成项 | 当前直接字段引用 | 实现与验收 | 持续保持的边界 |
| --- | ---: | --- | --- |
| `MIG-0133` Agent 会话/消息/Part | 0（运行态直连） | 接口、MySQL 实现、调用迁移及 7 项真实专项通过 | 消息序号、Part 幂等、工具三态（工具调用存于 Part）、Snapshot、停止/重启恢复、跨用户/项目隔离 |
| `MIG-0134` AI Task/Artifact/Source/Template | 0（运行态直连） | 接口、MySQL 实现、调用迁移及 6 项真实专项通过 | 领取租约、续租、取消、幂等键、断点重试、产物可见性、来源与质量记录同事务 |
| `MIG-0136` Provider/Model/Capability | 0（运行态直连） | 接口、MySQL 实现、调用迁移及 6 项真实专项通过 | 凭据密文/AAD、默认模型并发串行化、乐观锁、业务写入与审计同事务、作用域与会话选择原子替换 |
| `MIG-0136` IM | 0（运行态直连） | 接口、MySQL 实现、调用迁移及 6 项真实专项通过 | Bot/绑定/规则/审计同事务，Outbox 并发幂等、`SKIP LOCKED` 租约、投递日志与终态原子提交、入站唯一键去重 |

后续维护要求：任何 Repository 变更都必须继续运行五组专项、完整服务测试、MySQL 结构/外键、账号最小权限和静态依赖门禁。生产源对账、文件字节恢复和真实 IM 渠道验收不得用本交付物替代。
