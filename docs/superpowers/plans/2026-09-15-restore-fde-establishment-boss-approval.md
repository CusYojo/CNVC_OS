# 恢复 FDE 立项后老板审批实施计划

> **执行要求：** 按 `executing-plans` 技能逐项实施，每个任务先写失败测试、再做最小实现，并在阶段检查点复核。

**目标：** 恢复“立项 → 尽调计划制定”的董事长/总裁或签审批，修复空审批节点导致的 HTTP 500，并通过版本化迁移让现有 FDE 投资项目采用新策略。

**架构：** 默认策略契约是新建环境和校验基线；数据库发布不可变的新策略版本并重绑项目；OA 服务继续从项目绑定策略解析审批人，同时在持久化前增加空节点防御。已存在的审批请求依旧使用自己的节点快照，不被迁移改写。

**技术栈：** TypeScript、Node.js test runner、Drizzle ORM、MySQL、React/Vite。

---

## 任务 1：锁定并恢复默认策略契约

**文件：**

- 修改：`server/tests/fdeWorkflowPolicy.test.ts:5-35`
- 修改：`server/src/contracts/fdeWorkflowPolicyContract.ts:45-80`

### 步骤 1：先写失败的契约测试

把职责期望中的“立项”从空数组改为：

```ts
[['boss', '或签']]
```

并增加一条断言：克隆默认策略后删除 `stages[1].approvals` 的老板节点，`fdeWorkflowPolicySchema.safeParse(...)` 必须失败。

### 步骤 2：运行测试并确认失败

```powershell
.\.runtime\node22\node.exe --import tsx --test server/tests/fdeWorkflowPolicy.test.ts
```

预期：职责快照和“不可删除基线审批职责”测试失败，证明当前默认策略仍允许空节点。

### 步骤 3：做最小实现

在 `stageDuties` 中把：

```ts
立项: [],
```

改为：

```ts
立项: ['boss'],
```

保留现有 `boss` 名称生成规则和“或签”模式，不改其他阶段。

### 步骤 4：运行测试并确认通过

```powershell
.\.runtime\node22\node.exe --import tsx --test server/tests/fdeWorkflowPolicy.test.ts server/tests/fdeTypePolicyContract.test.ts
```

预期：全部通过。

### 步骤 5：提交

```powershell
git add server/tests/fdeWorkflowPolicy.test.ts server/src/contracts/fdeWorkflowPolicyContract.ts
git commit -m "fix: restore FDE establishment boss approval"
```

## 任务 2：为 OA 空审批节点增加稳定的业务错误

**文件：**

- 修改：`server/src/services/oaWorkflowService.ts:127-135,439-475`
- 新增：`server/tests/oaWorkflowApprovalNodes.test.ts`

### 步骤 1：先写失败的单元测试

从 `oaWorkflowService.ts` 导出一个只负责断言非空的窄函数，例如：

```ts
export function requireOaApprovalNodes<T>(nodes: T[]): [T, ...T[]]
```

新测试覆盖：

```ts
assert.equal(requireOaApprovalNodes([{ id: 'node-1' }])[0].id, 'node-1')

const error = assert.throws(() => requireOaApprovalNodes([])) as Error & {
  status?: number
  code?: string
}
assert.equal(error.status, 409)
assert.equal(error.code, 'OA_APPROVAL_NODES_REQUIRED')
```

### 步骤 2：运行测试并确认失败

```powershell
.\.runtime\node22\node.exe --import tsx --test server/tests/oaWorkflowApprovalNodes.test.ts
```

预期：因导出函数不存在而失败。

### 步骤 3：做最小实现

用现有 `workflowError` 构造：

```ts
if (nodes.length === 0) {
  throw workflowError(409, 'OA_APPROVAL_NODES_REQUIRED', '当前阶段未配置审批节点，请联系管理员检查已发布流程策略')
}
return nodes as [T, ...T[]]
```

在 `resolveFdeApprovalNodes` / `resolveBlueprintNodes` 返回后、生成申请编号和写数据库之前调用该函数。后续从返回的非空元组构造 `approvalNodes`，使 `firstNode` 在类型和运行时都必然存在。

### 步骤 4：运行测试并确认通过

```powershell
.\.runtime\node22\node.exe --import tsx --test server/tests/oaWorkflowApprovalNodes.test.ts server/tests/fdeWorkflowPolicy.test.ts
```

预期：全部通过；空策略返回 409，不再出现 `undefined.id`。

### 步骤 5：提交

```powershell
git add server/src/services/oaWorkflowService.ts server/tests/oaWorkflowApprovalNodes.test.ts
git commit -m "fix: reject empty OA approval chains"
```

## 任务 3：发布新数据库策略版本

**文件：**

- 新增：`server/drizzle/0119_restore_fde_establishment_approval.sql`
- 参考：`server/drizzle/0114_update_investment_approval_workflow.sql`
- 参考：`server/drizzle/0115_rename_fde_due_diligence_stage.sql`
- 参考：`server/drizzle/0116_fix_fde_due_diligence_policy_hash.sql`
- 修改：`server/src/scripts/mysqlArchitectureContractAcceptance.ts:255`

### 步骤 1：先扩展迁移契约检查

把 `MIG-0119` 加入 `mysqlArchitectureContractAcceptance.ts` 的关键迁移 ID 集合，并增加静态检查，确认迁移文件：

- 新建 revision 4 的 published 策略版本；
- 将“立项”的 `approvals` 设为 `boss` 或签；
- 更新政策的 `active_version_id`；
- 只重绑 `workflow_model='fde-v1' AND project_type='投资项目'` 的项目；
- 不更新 `sbl_oa_approval_requests`、`sbl_oa_approval_nodes`、`sbl_oa_approval_records`。

### 步骤 2：运行检查并确认失败

```powershell
.\.runtime\node22\node.exe --env-file-if-exists=.env --import tsx server/src/scripts/mysqlArchitectureContractAcceptance.ts
```

预期：报告缺少 `MIG-0119` 或迁移内容。

### 步骤 3：编写 migration

新增 `0119_restore_fde_establishment_approval.sql`：

1. 从当前活动版本 `...000000000115` 复制配置，使用 JSON 函数把“立项”阶段审批恢复为：

   ```json
   [{"duty":"boss","name":"董事长/总裁审批 · 立项","mode":"或签"}]
   ```

2. 新版本 ID 使用 `b236f88b-7154-4551-a6f5-000000000119`，revision 为 4，状态为 `published`。
3. `sha256` 必须按应用的 canonical JSON 规则计算；不得直接使用 MySQL 原始 JSON 字符串哈希。先用项目内 `policyHash` 对最终配置生成确定值，再固化到 SQL。
4. 将 `sbl_fde_workflow_policies.active_version_id` 指向 0119，并把 `next_revision` 推进到 5。
5. 将现有 FDE 投资项目的 `workflow_policy_version_id` 重绑到 0119；不限制 lifecycle，以免归档项目后续审计读取旧的错误政策。
6. 不触碰任何现存 OA 请求及节点快照。
7. 依照迁移框架的一次性执行语义编写；如果仓库门禁要求 SQL 自身可重复执行，再使用 `INSERT ... SELECT ... WHERE NOT EXISTS` 和有条件 UPDATE。

### 步骤 4：在隔离数据库验证 migration

只使用专用测试库，不使用当前业务 `.env`：

```powershell
$env:DATABASE_URL='<isolated-test-database-url>'
.\.runtime\node22\npm.cmd run check:mysql-architecture
.\.runtime\node22\npm.cmd run accept:fde-policy
```

预期：迁移结构检查通过；活动版本为 0119；策略 canonical hash 一致；新项目绑定 0119。

### 步骤 5：提交

```powershell
git add server/drizzle/0119_restore_fde_establishment_approval.sql server/src/scripts/mysqlArchitectureContractAcceptance.ts
git commit -m "feat: publish restored FDE approval policy"
```

## 任务 4：补齐真实 FDE OA 生命周期验收

**文件：**

- 修改：`server/src/scripts/oaWorkflowAcceptance.ts`
- 如需独立隔离 fixture，修改：`server/src/scripts/fdeMigrationAcceptance.ts:80-120`

### 步骤 1：增加失败的验收场景

在隔离测试数据中创建：

- 一个处于“立项”的 `fde-v1` 投资项目；
- 黄昕等价的项目负责人/申请人；
- 项目职责中的董事长和总裁，两者均启用且申请人不兼任；
- 项目绑定活动政策版本 0119。

新增断言：

1. 申请 `targetStage: '尽调计划制定'` 后状态为“审批中”。
2. 审批链只有一个业务审批节点，职责为董事长/总裁，模式为或签，两名老板都在冻结名单中。
3. 创建请求后项目仍为“立项”。
4. 任一老板通过后请求完成，项目才变为“尽调计划制定”。
5. 另一个老板的待办被关闭。
6. 清理 fixture 时删除新增待办、节点、记录、职责绑定和项目，避免污染测试库。

### 步骤 2：运行场景并确认当前失败

```powershell
$env:DATABASE_URL='<isolated-test-database-url>'
.\.runtime\node22\npm.cmd run accept:oa-workflow
```

预期：在 migration/默认策略未完整恢复时，老板节点断言失败。

### 步骤 3：只修正 fixture 与必要集成点

复用 `resolveFdeApprovalNodes` 现有老板解析逻辑，不复制审批人选择规则。若验收暴露的是职责 fixture 缺失，只补 fixture；若暴露真实解析缺陷，另加针对性测试后做最小修复。

### 步骤 4：运行并确认通过

```powershell
$env:DATABASE_URL='<isolated-test-database-url>'
.\.runtime\node22\npm.cmd run accept:oa-workflow
```

预期：完整生命周期通过，且数据库清理成功。

### 步骤 5：提交

```powershell
git add server/src/scripts/oaWorkflowAcceptance.ts server/src/scripts/fdeMigrationAcceptance.ts
git commit -m "test: cover FDE establishment boss approval"
```

## 任务 5：同步审批中心说明

**文件：**

- 修改：`src/pages/WorkflowPage.tsx:39-44`
- 新增：`server/tests/fdeWorkflowPageContract.test.ts`

### 步骤 1：先写失败的展示契约测试

读取 `WorkflowPage.tsx` 源码并断言：

- 包含 `['立项 → 计划制定', '董事长/总裁审批（任意一人）']`；
- 仍包含 `['计划制定 → 计划审核', '投资项目组任意成员提交计划']`；
- 不再包含 `立项 → 计划制定` 对应的“无审批”描述。

### 步骤 2：运行测试并确认失败

```powershell
.\.runtime\node22\node.exe --import tsx --test server/tests/fdeWorkflowPageContract.test.ts
```

预期：当前页面仍显示“无审批”，测试失败。

### 步骤 3：修改静态审批链文案

只更新第二行：

```ts
['立项 → 计划制定', '董事长/总裁审批（任意一人）'],
```

保留下一行项目组成员提交计划的说明，避免把“制定/提交权限”和“进入制定阶段的审批”混淆。

### 步骤 4：运行测试并确认通过

```powershell
.\.runtime\node22\node.exe --import tsx --test server/tests/fdeWorkflowPageContract.test.ts
```

预期：全部通过。

### 步骤 5：提交

```powershell
git add src/pages/WorkflowPage.tsx server/tests/fdeWorkflowPageContract.test.ts
git commit -m "fix: show boss approval in FDE workflow chain"
```

## 任务 6：全量验证与本地人工验收

**文件：**

- 不新增业务代码；如验证发现缺陷，回到对应任务先补失败测试再修复。

### 步骤 1：运行无写入验证

```powershell
.\.runtime\node22\npm.cmd run check:types
.\.runtime\node22\node.exe --import tsx --test server/tests/fdeWorkflowPolicy.test.ts server/tests/fdeTypePolicyContract.test.ts server/tests/oaWorkflowApprovalNodes.test.ts server/tests/fdeWorkflowPageContract.test.ts
.\.runtime\node22\npm.cmd run check:single-service
.\.runtime\node22\npm.cmd run build:web
```

预期：退出码均为 0。

### 步骤 2：运行隔离数据库验收

```powershell
$env:DATABASE_URL='<isolated-test-database-url>'
.\.runtime\node22\npm.cmd run accept:fde-policy
.\.runtime\node22\npm.cmd run accept:oa-workflow
```

预期：策略、哈希、审批节点、审批前后阶段和清理断言全部通过。

### 步骤 3：检查改动范围

```powershell
git status --short
git diff --check
git log --oneline -6
```

预期：没有空白错误；没有无关文件；提交与上述任务一致。

### 步骤 4：获得部署授权后才应用业务库 migration

当前阿里云 RDS 属于现有业务数据。实施和验证阶段只生成 migration，不自动执行。待用户明确要求部署/应用迁移后：

1. 先备份或确认可回滚点；
2. 核对目标数据库主机与库名；
3. 执行 0119；
4. 查询活动策略版本和目标项目绑定；
5. 用黄昕账号发起审批，确认当前节点为老板审批；
6. 若异常，仅回滚策略活动指针和项目绑定，不删除历史审批数据。

### 步骤 5：最终提交（仅当验证产生必要修正）

```powershell
git add <verified-files>
git commit -m "test: verify restored FDE boss approval"
```

## 规格覆盖自检

- 老板或签：任务 1、3、4。
- 项目组仍可制定和提交计划：任务 4、5。
- 申请人排除与缺少审批人错误：复用现有解析逻辑，由任务 4 回归确认。
- 空节点稳定 409：任务 2。
- 现有项目绑定新政策、历史审批快照不变：任务 3、4。
- 页面展示一致：任务 5。
- 类型、构建、门禁和数据库验收：任务 6。
- 生产数据保护：任务 3、6 明确只在授权后应用业务库 migration。

