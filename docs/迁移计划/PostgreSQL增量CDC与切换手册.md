# PostgreSQL 增量 CDC 与切换手册

## 当前结论

代码已具备 PostgreSQL 触发器变更日志、MySQL 检查点/事件账本和单向增量应用能力；目标端隔离演练已覆盖新增、更新、物理删除、级联删除、乱序输入、重复事件和中断续跑。

当前 `.env` 指向的旧 PostgreSQL `127.0.0.1:5432` 不可连接，因此尚未在真实源库安装触发器，也没有生产源 watermark、复制延迟或最终追平证据。不得据此宣布 `MIG-0702/0708`、`DB-016`、`DATA-013/017` 或切流门禁完成。

## 数据流与唯一写入所有者

迁移窗口内只允许以下单向链路：

```text
旧业务写入 PostgreSQL（唯一写入所有者）
        ↓ 触发器
sbl_migration.change_log
        ↓ migrate:postgres-cdc
MySQL 影子库（不得由新业务同时修改同一实体）
```

前向应用必须显式设置：

```bash
PG_CDC_AUTHORITY_MODE=legacy-postgres-authoritative npm run migrate:postgres-cdc
```

缺少该值时应用器失败关闭。MySQL 接管写入后必须停止前向 CDC，不得让旧 PostgreSQL 再覆盖新数据。本项目没有实现 MySQL→PostgreSQL 反向 CDC；到达 Point of No Return 后只能前向修复，不能假设可以无损回切。

## 源端安装

前置条件：

1. 对旧 PostgreSQL 完成可恢复备份。
2. 确认 17 张批准表及其 `id` 列存在，不包含 Aipin 表。
3. 确认安装账号可创建 Schema、表、函数和触发器。
4. 确认旧业务仍是这些实体的唯一写入所有者。

先预览契约：

```bash
npm run install:postgres-cdc:preview
```

再在批准维护窗口安装：

```bash
npm run install:postgres-cdc
```

安装器在单事务和 PostgreSQL advisory lock 下创建：

- `sbl_migration.change_log`
- `sbl_migration.capture_config`
- `sbl_migration.capture_change()`
- 17 个 `AFTER INSERT OR UPDATE OR DELETE` 行级触发器

删除事件保存实体类型、旧 ID、旧行 tombstone、时间、数据库会话操作者、迁移批次和级联标记。触发器函数使用受限的 `SECURITY DEFINER`，避免旧业务账号需要直接修改变更日志。

## 安全 watermark

不能直接把 `MAX(sequence)` 当作可提交 watermark：并发长事务可能先取得较小 sequence、后提交，简单推进会永久漏事件。

应用器只读取：

```sql
txid < txid_snapshot_xmin(txid_current_snapshot())
```

该安全事务边界之前的事务已经提交或回滚。应用器同时记录：

- `last_sequence`：MySQL 已提交位置；
- `source_safe_watermark`：当前可安全读取的源位置；
- `source_observed_watermark`：源端已观测最大位置；
- `unsafeOpenTransactionEvents`：仍受活动事务阻挡的事件数；
- `replication_lag_ms`、应用/重放/新增/更新/删除/级联删除计数。

同一 PostgreSQL 事务的事件不会拆开提交；sequence 区间相互交错的事务会合并为同一目标事务组件，避免检查点越过未应用事件。

## 全量与增量顺序

1. 安装 CDC，记录 capture contract SHA-256。
2. 保持 PostgreSQL 为唯一写入所有者。
3. 执行全量迁移或锁定全量快照。
4. 反复执行增量预览：

   ```bash
   npm run migrate:postgres-cdc:preview
   ```

5. 在明确的 PostgreSQL 权威模式下应用：

   ```bash
   PG_CDC_AUTHORITY_MODE=legacy-postgres-authoritative npm run migrate:postgres-cdc
   ```

6. 直到 `result.caughtUp=true`、`pendingSafeEvents=0`，且活动长事务事件归零。
7. 执行目标 checksum、外键、状态机、业务不变量和文件 manifest 对账。
8. 冻结旧库业务写入，再执行最后一轮 CDC。
9. 保存源/目标 watermark、删除计数、复制延迟、检查点 ID、对账报告和责任人签字。
10. 切换 MySQL 为唯一写入所有者，立即停止前向 CDC。

## 中断与重放

`migration_cdc_checkpoints` 保存稳定 source instance、源指纹、capture version、watermark 和累计计数；`migration_cdc_events` 以 `(checkpoint_id, source_sequence)` 唯一记录事件 checksum 与应用结果。

进程中断后重新执行同一命令即可续跑。已应用 sequence 必须具有相同 checksum；相同 sequence 内容不同会失败关闭。父记录删除已由 MySQL 外键级联移除子记录时，随后到达的子 tombstone 记为 `noop`，但不会从审计账本消失。

## 切换门禁

以下条件必须同时满足：

- 真实 PostgreSQL 源端触发器安装和四类写入动态验收通过；
- 源安全 watermark 与目标 `last_sequence` 追平；
- 活动长事务事件为 0，删除积压为 0；
- 新增、更新、物理删除和级联删除数量与事件账本一致；
- 目标当前 81 张业务表加 1 张内部迁移表、133 个外键、状态机和业务不变量通过；后续 Schema 增长时以现场门禁输出为准，不使用固定旧数字放行；
- 17 个缺失项目文件已按精确清单批准处置；97 条缺失详情和 7 个 AI 产物文件仍须补源或另行获批；
- 生产源资产清单和唯一写入所有者由数据负责人签字；
- 最后安全回滚点和 Point of No Return 已记录。

## 漂移对账与现场证据

每轮增量应用后都必须同时保存“源位置、目标位置、业务对账”三类证据，不能只看应用命令退出码：

1. 保存 `migrate:postgres-cdc:preview` 输出中的 safe/observed watermark、`last_sequence`、活动长事务事件数、待应用安全事件数和复制延迟。
2. 执行 `npm run check:migration-integrity`，确认目标 Schema、外键、状态机、业务不变量和隔离台账仍通过。
3. 在真实生产源清单已经批准后执行 `npm run check:migration-reconciliation`；该命令在源资产、文件原件或待处置项未闭环时必须非零退出。
4. 对新增、更新、物理删除、级联删除分别核对源 `change_log`、MySQL `migration_cdc_events` 和目标业务行，不允许用目标总行数抵消删除漏同步。
5. 文件字节不属于行级 CDC。项目文件、AI 产物、Radar 原文和模板原件必须另行以 manifest、SHA-256 和恢复演练核对。

现场证据至少保留：执行时间、源实例指纹、capture contract SHA-256、最后安全/观测 watermark、目标 sequence、各操作计数、延迟、检查点 ID、完整性报告路径、执行人和复核人。

## 反向变更与回滚窗口矩阵

本项目没有 MySQL→PostgreSQL 反向 CDC，也没有文件字节反向复制器。所以下表中的“回滚窗口”是旧 PostgreSQL 仍可恢复、但新系统只做只读冒烟的受控窗口，不是允许双写的业务窗口。

| 业务域 | PostgreSQL 权威期 | MySQL 接管后的回滚窗口 | 允许回切的必要条件 | Point of No Return 后 |
|---|---|---|---|---|
| 身份与权限 | 旧库唯一写入；MySQL 仅同步 | 登录/权限只读验证，禁止创建用户、改角色、成员或密码 | 确认 MySQL 没有身份写入，会话作废策略已记录 | MySQL 前向修复；不得把新会话或权限猜写回旧库 |
| 项目与 OA | 旧库项目为唯一写入；MySQL 影子核对 | 禁止项目编辑、成员变更、阶段推进和 OA 动作 | 项目/OA 写入计数为 0，watermark 和 checksum 追平 | 在 MySQL 修复项目、审批和审计链 |
| 线索与 Radar | 旧链路唯一写入；CDC/批迁移追平 | 暂停 Radar 摄入、公开情报提交、人工复核、评分和转项目 | MySQL 新原始事件、决策、评分和正式线索写入为 0 | 只在 MySQL 重放不可变事件并修复投影 |
| 会话与消息 | 旧 Runtime 仍是写入所有者 | 只允许读取历史，不允许新会话、发消息、工具交互或模型切换 | MySQL 新会话/消息/Part/交互写入为 0 | 保留 MySQL 消息顺序和审计，前向修复 Runtime |
| AI 任务与模板 | 旧链路唯一写入 | 禁止创建/取消/重试任务、模板分析和产物生成 | MySQL 新任务、运行、来源、产物和模板版本写入为 0 | 在 MySQL 恢复租约、重试或显式失败，不回写旧库 |
| 文件与产物 | 旧文件根唯一写入 | 禁止上传、删除、生成和模板原件替换 | MySQL 文件元数据零新增，两个文件根 manifest/SHA 一致 | 依 MySQL 元数据和受保护文件根前向恢复 |

如果任何一域在回滚窗口产生 MySQL 新写入，由于没有经过验收的反向导出/重放工具，该域立即失去自动回切资格；必须停止流量、登记差异，并由数据负责人决定人工回放还是把该域提前越过 Point of No Return。不得复制生产表或文件目录后宣称完成反向验证。

## 切换、回切与 Point of No Return

### 接管前

1. PostgreSQL 保持唯一写入，MySQL 不承接生产写请求。
2. 追平安全 watermark，核对活动长事务、删除积压、结构/业务 checksum 和文件 manifest。
3. 冻结 PostgreSQL 写入，执行最后一轮 CDC 并保存完整证据。
4. 记录最后安全回滚点，但此时仍未越过 Point of No Return。

### 只读回滚窗口

1. 停止前向 CDC，切换读取流量到 MySQL。
2. 对上表六域执行只读冒烟；写 API、后台摄入和任务调度必须保持冻结。
3. 若冒烟失败且六域 MySQL 新写入均为 0，可把读取流量切回旧系统并重新开放 PostgreSQL 写入。
4. 若发现任一新写入，不得直接回切，先按域登记差异并取得数据负责人决定。

### Point of No Return

只有业务、技术、数据、安全和运维负责人共同批准后，才能解除 MySQL 写冻结并记录 Point of No Return。解除后：

- MySQL 成为唯一写入所有者；旧 PostgreSQL 保持只读归档。
- 不再启动前向 CDC，也不再承诺回切到旧库。
- 数据缺陷按 MySQL 迁移台账、不可变事件、审计记录和文件 manifest 做前向修复。
- 旧库、旧文件根、Flue/Radar 恢复材料在保留期和销毁审批完成前不得删除。

审批记录至少包含：环境、版本/commit、时间、最后安全 watermark、目标 sequence、全量对账报告、文件 manifest、六域写冻结证明、回滚触发条件、批准人、PONR 时间和后续前向修复负责人。

## 已实现的回滚观察窗写冻结

统一服务新增成对配置：

```dotenv
MIGRATION_WRITE_FREEZE=true
MIGRATION_WRITE_FREEZE_MODE=rollback-window
```

两项缺一、模式拼错或关闭时残留模式值，生产配置均拒绝启动。启用并重启唯一的 `cybernaut-app.service` 后同时执行三层冻结：

1. MySQL 连接创建时先执行 `SET SESSION TRANSACTION READ ONLY`，即使遗漏应用路由也由数据库拒绝 DML。
2. HTTP 的 `POST/PUT/PATCH/DELETE` 在解析正文和鉴权前统一返回 `503/MIGRATION_WRITE_FROZEN`；`GET/HEAD/OPTIONS` 和静态页面继续用于只读冒烟。
3. 启动时跳过临时文件清理、种子、恢复、回填、Radar 摄入、AI/评分 Worker 和周期调度；健康页将这些组件标记为 `intentionally-disabled`，停机也不执行任务租约写回。

会话只读校验在此模式下不更新 `last_seen_at`、不续期 Cookie，也不写旧密钥命中遥测。既有会话可用于只读冒烟；登录是 POST 且会创建新会话，因此按设计被阻断。切流前必须先准备仍在有效期内的受控多角色会话，不能在观察窗内临时登录并据此误报登录故障。

本地真实 MySQL 验收 `npm run accept:migration-write-freeze` 已证明：SELECT 和服务健康成功、MySQL 会话默认只读、测试 INSERT 返回 `ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION`、目标写入 0、静态 Web 返回 200、写请求返回 503，隔离实例干净停机。证据位于 `.runtime/migration-evidence/migration-write-freeze/report.json`。该结果不替代目标生产机逐域冒烟和窗口签字。

不得用文本编辑器直接修改生产 `.env`。进入观察窗先预览，再原子应用：

```bash
npm run cutover:freeze-writes:preview -- --env-file /受控绝对路径/.env
npm run cutover:freeze-writes -- --env-file /受控绝对路径/.env
sudo systemctl restart cybernaut-app.service
```

命令要求 `.env` 是 0600 或更严格的普通文件，拒绝符号链接和重复键；写入前后二次校验文件 SHA-256，防止并发覆盖，并且输出不包含路径或环境值。重启后必须用健康页、写 API 503 和 MySQL 会话只读三项共同确认。

解除冻结就是 Point of No Return 操作。必须提供 0600、非符号链接的 JSON 审批文件，绑定生产环境、版本 commit、源安全 watermark、目标 sequence、全量对账报告 SHA-256、文件 manifest SHA-256、阈值契约版本，并包含业务、技术、数据、安全、运维五个不同稳定身份及各自审批时间。然后执行：

```bash
npm run cutover:cross-ponr:preview -- \
  --env-file /受控绝对路径/.env \
  --ponr-approval-file /受控绝对路径/ponr-approval.json
npm run cutover:cross-ponr -- \
  --env-file /受控绝对路径/.env \
  --ponr-approval-file /受控绝对路径/ponr-approval.json
sudo systemctl restart cybernaut-app.service
```

审批文件禁止包含密码、Token、Cookie、API Key 或其他凭据字段。命令没有审批文件、少任一角色、审批身份重复、哈希/watermark/commit 格式不合法、文件权限过宽或基线并发变化时均失败关闭。未获批准不得解除；解除后不再回切 PostgreSQL，只执行前向修复。

## 六域回滚阈值契约

机器契约为 `server/migration/cutover-rollback-thresholds.v1.json`，由 `npm run accept:cutover-rollback-thresholds` 校验并接入发布门禁。核心判定不是“出错即盲目回切”，而是：

- 登录、权限、数据、AI、线索或 MySQL 达到失败阈值，且六域目标写入增量全部为 0，才具备安全回切资格。
- 任一身份/权限/项目/OA/会话/文件/AI/线索/任务表写入增量大于 0，立即停止流量并登记差异，禁止自动回切。
- 权限越权、数据 checksum/孤儿/状态机差异和线索身份错配阈值均为 0；有效会话、AI 既有任务读取或 MySQL 健康连续失败 3 次触发判定。
- MySQL 连接未进入只读模式的容忍数为 0；5 分钟至少 20 个样本时查询 P95 达到 2 秒触发判定。
- PPT、尽调、提案、Q&A、合规性说明的生成不属于本次只读冒烟；AI 域只核对既有任务、来源、产物和模板状态读取及写入增量为 0。

契约当前状态是 `pending-production-window-approval`。阈值覆盖已经机器校验，不等于五类负责人已批准，也不关闭 `MIG-0920/CUT-006`。

## 当前已完成的技术验收

`npm run accept:postgres-cdc` 在随机隔离 MySQL Schema 中验证：

- 17 表源端 DDL 含新增、更新、删除、操作者、批次和级联 tombstone 契约；
- 6 个乱序事件按 4 个源事务组件重排；
- sequence 3 后中断，前两组件持久化；
- 续跑重放 3 条事件但不重复业务记录；
- 3 个新增、1 个更新、2 个删除、1 个级联删除计数准确；
- 父项目删除级联移除文件，子 tombstone 形成已审计 `noop`；
- 最终目标 sequence 6 与测试安全 watermark 追平。

这份隔离结果证明目标应用器，不替代真实 PostgreSQL 源端、预生产压力和生产切换验收。

## 当前未关闭项

- `CUT-014`：尚无生产最后安全回滚点和 Point of No Return 联合签字。
- `CUT-015`：六业务域尚未在预生产/生产验证反向变更可被旧系统读取；当前实现明确没有反向 CDC。
- `CUT-016`：本地真实 MySQL、HTTP、启动/停机与后台组件写冻结已经联合取证；目标生产入口、Nginx、systemd 和六域业务账号现场取证仍缺失。
- `MIG-0702/0708/0727`：旧 PostgreSQL 当前不可连接，真实源触发器、watermark、延迟和删除追平证据缺失。

因此，本手册作为 `DEL-015` 的技术交付物可以交接，但不能作为生产切换批准书。
