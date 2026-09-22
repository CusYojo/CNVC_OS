# 系统管理员项目文件治理验收实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修正 FDE 治理验收中的过期权限断言，证明启用的系统管理员可以查看项目文件，同时项目业务域和普通非成员仍保持隔离。

**架构：** 生产权限实现保持不变，只调整现有随机隔离数据验收脚本。验收先固定旧契约的失败证据，再用一个管理员正向断言、一个普通非成员反向断言和原有业务域反向断言表达准确边界，最后通过完整 FDE 编排验证迁移、流程与清理生命周期。

**技术栈：** TypeScript、Node.js 22、tsx、Drizzle ORM、MySQL、Node `assert/strict`。

---

## 文件结构

- 修改：`server/src/scripts/fdeGovernanceAcceptance.ts:63-72` — 定义管理员文件域例外、普通非成员文件隔离以及其他项目业务域隔离的验收契约。
- 修改：`server/src/scripts/fdeFileAcceptance.ts:72-78` — 定义管理员可读取文件，时间协调人和普通非成员仍被拒绝的文件访问契约。
- 修改：`server/src/scripts/fdeOfficeAcceptance.ts:26-29` — 让创建关联项目的合成负责人满足投资部资格，不改变生产校验。
- 参考：`server/src/scripts/fdeMigrationAcceptance.ts:13-58,116-139` — 创建随机表前缀、调度治理验收并核验业务表集合与清理生命周期；不修改。
- 参考：`docs/superpowers/specs/2026-09-22-admin-file-governance-acceptance-design.md` — 已批准的权限边界；不修改。

### 任务 1：记录旧治理契约的失败基线

**文件：**
- 测试：`server/src/scripts/fdeGovernanceAcceptance.ts:63-72`

- [ ] **步骤 1：确认验收数据库配置指向隔离库**

运行：

```powershell
$env:DB_DATABASE = 'sbl_jedi_acceptance_20260828'
node --version
```

预期：Node 主版本为 `v22`，后续命令只连接 `sbl_jedi_acceptance_20260828`，不连接生产库。

- [ ] **步骤 2：运行现有完整 FDE 验收并记录失败**

运行：

```powershell
$env:DB_DATABASE = 'sbl_jedi_acceptance_20260828'
npm run accept:fde-migration
```

预期：退出码非 0；`fdeGovernanceAcceptance.ts` 在旧的管理员文件不可见断言处失败，前置项目池、线索转换、身份映射、OA 和工作流验收正常完成；输出仍显示随机 `fde_accept_<10位十六进制>_` 前缀的清理已执行。

### 任务 2：用最小变更表达文件域例外

**文件：**
- 修改：`server/src/scripts/fdeGovernanceAcceptance.ts:63-72`

- [ ] **步骤 1：替换管理员文件反向断言并增加普通非成员反向断言**

将原有第 67-72 行权限断言区块改为：

```ts
  assert.ok(!(await listProjects({ page: 1, pageSize: 100 }, accounts.admin.id)).list.some((item) => item.id === project.id))
  assert.ok((await listAllFiles(accounts.admin.id)).some((item) => item.projectId === project.id))
  assert.ok(!(await listAllFiles(accounts.outsider.id)).some((item) => item.projectId === project.id))
  assert.equal((await listMeetings(project.id, actor('admin'))).length, 0)
  assert.ok(!(await listTodos(undefined, undefined, actor('admin'))).some((item) => item.projectId === project.id))
  assert.equal((await listRisks(project.id, undefined, actor('admin'))).length, 0)
  checks.push(
    'system-admin-project-file-access-is-an-explicit-exception',
    'ordinary-outsider-cannot-read-project-files',
    'project-meetings-todos-risks-remain-fde-scoped',
  )
```

该代码必须保留后续第 79 行管理员 OA 审批不可见断言，不改变生产服务、接口、数据库结构或前端。

- [ ] **步骤 2：运行 TypeScript 类型检查**

运行：

```powershell
npm run check:types
```

预期：退出码为 0，不出现 TypeScript 编译错误。

- [ ] **步骤 3：检查变更范围**

运行：

```powershell
git diff --check
git diff -- server/src/scripts/fdeGovernanceAcceptance.ts server/src/scripts/fdeFileAcceptance.ts
```

预期：`git diff --check` 无输出；代码差异只包含上述治理验收断言与 checks 名称。

### 任务 2B：同步文件访问验收契约

**文件：**
- 修改：`server/src/scripts/fdeFileAcceptance.ts:72-78`

- [ ] **步骤 1：将管理员从统一拒绝名单移到允许访问断言**

将第 75 行改为：

```ts
  await requireProjectFileAccess(db, file.id, admin.id)
  for (const person of [coordinator, outsider]) await code(requireProjectFileAccess(db, file.id, person.id), 'PROJECT_FILE_FORBIDDEN')
```

不得改变成员下载权限、显式授权、协调人隔离或普通非成员隔离的其他断言。

- [ ] **步骤 2：运行 TypeScript 类型检查与差异检查**

运行：

```powershell
npm run check:types
git diff --check
git diff -- server/src/scripts/fdeGovernanceAcceptance.ts server/src/scripts/fdeFileAcceptance.ts
```

预期：类型检查和差异检查退出码均为 0；代码差异只包含两处过期验收契约。

### 任务 2C：修正办公验收的项目负责人夹具

**文件：**
- 修改：`server/src/scripts/fdeOfficeAcceptance.ts:26-29`

- [ ] **步骤 1：只给合成 author 设置投资部**

将 people 映射中的 `department` 属性改为：

```ts
department: i === 0 ? '投资部' : `OA验收-${marker}`,
```

其中索引 0 是创建关联项目的 `author`。不得更改 `createProject` 的生产校验或其他合成账号的隔离部门。

- [ ] **步骤 2：运行类型与差异检查**

运行：

```powershell
npm run check:types
git diff --check
git diff -- server/src/scripts/fdeGovernanceAcceptance.ts server/src/scripts/fdeFileAcceptance.ts server/src/scripts/fdeOfficeAcceptance.ts
```

预期：退出码均为 0；办公验收差异只有合成账号部门选择表达式。

### 任务 3：运行完整 FDE 验收并提交

**文件：**
- 测试：`server/src/scripts/fdeMigrationAcceptance.ts`
- 测试：`server/src/scripts/fdeGovernanceAcceptance.ts`

- [ ] **步骤 1：在隔离库运行完整 FDE 验收**

运行：

```powershell
$env:DB_DATABASE = 'sbl_jedi_acceptance_20260828'
npm run accept:fde-migration
```

预期：退出码为 0；输出包含 `fdeGovernanceAcceptance.ts` 的 `exitCode: 0`，治理检查包含：

```text
system-admin-project-file-access-is-an-explicit-exception
ordinary-outsider-cannot-read-project-files
project-meetings-todos-risks-remain-fde-scoped
```

最终输出同时确认完整 FDE 验收成功、业务表集合未改变、随机验收前缀已清理。

- [ ] **步骤 2：确认没有遗留的随机验收表**

使用当前隔离库连接执行：

```sql
SELECT COUNT(*) AS remaining
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'sbl_jedi_acceptance_20260828'
  AND TABLE_NAME REGEXP '^fde_accept_[0-9a-f]{10}_';
```

预期：`remaining = 0`。不得删除或修改业务前缀表。

- [ ] **步骤 3：复核最终差异**

运行：

```powershell
git status --short
git diff --check
git diff -- server/src/scripts/fdeGovernanceAcceptance.ts server/src/scripts/fdeFileAcceptance.ts server/src/scripts/fdeOfficeAcceptance.ts
```

预期：除实现计划文档外，待提交代码只有 `server/src/scripts/fdeGovernanceAcceptance.ts`、`server/src/scripts/fdeFileAcceptance.ts` 和 `server/src/scripts/fdeOfficeAcceptance.ts`；无生产代码、数据库、API 或 UI 变更。

- [ ] **步骤 4：提交验收契约修正**

运行：

```powershell
git add -- server/src/scripts/fdeGovernanceAcceptance.ts server/src/scripts/fdeFileAcceptance.ts server/src/scripts/fdeOfficeAcceptance.ts
git commit -m "test: align admin project file governance acceptance"
```

预期：提交成功，提交内容只包含治理验收脚本的断言修正。
