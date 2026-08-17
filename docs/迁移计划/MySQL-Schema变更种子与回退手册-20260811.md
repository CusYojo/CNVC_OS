# MySQL Schema 变更、种子与回退手册

## 1. 目标状态

MySQL Schema 继续采用只前进的编号迁移，不在活动库上倒序执行未经验证的 `DROP COLUMN/DROP TABLE`。每次发布按以下顺序执行：

1. 对当前 `DB_FREFIX` 表集创建一致性、0600 的逻辑备份；首次空前缀安装自动跳过。
2. 使用独立 Migration 账号运行编号 Schema 迁移。
3. 使用 DML-only Runtime 账号应用版本化系统种子。
4. 运行结构、业务、账号和单服务发布门禁。
5. 如需回退，将迁移前备份恢复到同一数据库的全新隔离前缀，校验 DDL/行数/逐行内容后，再经审批切换 `DB_FREFIX`；不覆盖当前活动前缀。

这种回退保留新旧两套表集，避免在未知提交状态下破坏当前数据。它只适用于切流前冻结或批准的只读回滚窗口；切流后产生新写入且没有反向 CDC 时，仍受 `ADR-007` 的 Point of No Return 约束。

## 2. 标准命令

```bash
# 迁移前一致性备份；默认写入 .runtime/mysql-backups/
npm run db:backup

# 核对备份/报告配对、0600 权限、SHA、时效、保留策略与最近恢复演练
npm run accept:mysql-backup-inventory

# 也可指定一个尚不存在的 .jsonl.gz 文件
npm run db:backup -- --output /approved/owner-only/mysql-pre-migration.jsonl.gz

# 只前进 Schema
npm run db:migrate:separated

# 预览和应用系统种子
npm run db:seed:preview
npm run db:seed

# 回退预览：目标前缀必须全新，格式 rollback_<8-16位小写字母数字>_
npm run db:rollback:preview -- \
  --backup /approved/owner-only/mysql-pre-migration.jsonl.gz \
  --target-prefix rollback_20260811a_

# 恢复到隔离前缀；不会修改 .env 或覆盖当前前缀
npm run db:rollback -- \
  --backup /approved/owner-only/mysql-pre-migration.jsonl.gz \
  --target-prefix rollback_20260811a_
```

`db:rollback` 成功后会验证备份清单中的全部表（当前 Schema 为 74 张物理表）的结构、行数和顺序无关逐行 SHA-256，并输出不含连接身份或业务正文的 0600 报告。只有在业务停写、备份时间点/CDC 边界、账号与配置审批完成后，才可把 `.env` 的 `DB_FREFIX` 改为恢复前缀并重启唯一 `cybernaut-app.service`。命令本身故意不修改 `.env`、systemd 或当前表。

## 3. 版本化种子

当前种子版本为 `mysql-core-seed-v1`，清单 SHA-256 由以下批准内容确定：

- 5 个系统 AI 任务模板及版本、Skill 和输出格式；
- 16 个内置 Skill/Agent/MCP 能力及全局 Binding；
- 8 个单服务周期任务定义及当前环境启用状态；
- 明确 0 个演示用户。

应用结果使用清单哈希派生的确定性 Run ID 写入 `migration_runs`，重复执行只更新同一条 `mysql-system-seed` 台账。系统模板按主键收敛到批准版本；能力只补缺失内置项和全局 Binding，不覆盖管理员已批准的策略；Runtime Job 保留既有 `next_run_at`、租约和运行历史，只同步定义字段。

任何清单语义变更必须提升 `SEED_VERSION`，不能在同一版本下静默改变内容。

## 4. 回退安全边界

- 备份只包含当前 `DB_FREFIX` 表，不把旧回退前缀再次打包。
- 备份文件和报告均为 0600；验收临时备份位于系统临时目录并在结束后删除。
- 最新正式备份必须通过 `accept:mysql-backup-inventory`；生产另外要求异地位置标识和静态加密确认，否则失败关闭。
- 目标回退前缀必须为空，命令拒绝覆盖任何已有表。
- 表名、外键名和自动索引名按目标前缀重写；超过 MySQL 64 字符的非表标识符使用稳定 SHA-256 截断。
- 恢复失败只清理本次严格校验的隔离前缀，不触碰活动前缀。
- 数据批次错误只报告表名和驱动错误码，不输出 SQL 或业务正文。
- 回退恢复成功不等于允许切流；必须另行确认停写、水位、文件字节、弱密码、TLS 和生产审批。

## 5. 机器验收

```bash
npm run accept:mysql-schema-lifecycle
npm run accept:mysql-backup-inventory
```

最新验收使用真实 MySQL 和随机 `rb_accept_<随机值>_` 前缀完成一致性备份、74 表/67,771 行恢复、DDL/行校验、恢复前缀 Schema 就绪、两次种子幂等和精确清理，并确认活动前缀表数始终不变。种子允许保留旧 manifest 的追加式台账，但当前 manifest 必须且只能有一条；重复执行不得增加任何台账或规范数据。它不启动业务服务、不调用模型，也不测试 PPT、尽调、提案、Q&A 或合规性说明生成。
