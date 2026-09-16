# 系统管理员投资基金维护实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 允许启用的系统管理员修改活动 FDE 项目的投资基金，同时保持项目要求负责人专属和审批中冻结规则。

**架构：** `projectService.updateProject` 使用统一的 `isEnabledSystemAdmin` 判定，将投资基金与项目要求的真实变更分别授权。测试以源码契约锁定权限拆分、冻结和审计内容，再通过类型检查和生产构建验证集成。

**技术栈：** TypeScript、Drizzle ORM、Node.js test runner、tsx、Vite。

---

## 文件结构

- 修改 `server/src/services/projectService.ts`：拆分字段变化，应用管理员基金权限并记录基金审计摘要。
- 创建 `server/tests/systemAdminInvestmentFund.test.ts`：锁定权限、冻结、真实变化与审计边界。

### 任务 1：投资基金权限拆分

**文件：**
- 修改：`server/src/services/projectService.ts`
- 创建：`server/tests/systemAdminInvestmentFund.test.ts`

- [ ] **步骤 1：编写失败的权限契约测试**

```ts
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = () => readFile(new URL('../src/services/projectService.ts', import.meta.url), 'utf8')

test('system admins may change only the investment fund owner field', async () => {
  const implementation = await source()
  assert.match(implementation, /isEnabledSystemAdmin/)
  assert.match(implementation, /investmentFundChanged/)
  assert.match(implementation, /requirementsChanged/)
  assert.match(implementation, /requirementsChanged && locked\.ownerUserId !== userId/)
  assert.match(implementation, /investmentFundChanged && locked\.ownerUserId !== userId && !await isEnabledSystemAdmin/)
})

test('controlled fields remain frozen during approval and fund changes are audited', async () => {
  const implementation = await source()
  assert.match(implementation, /investmentFundChanged \|\| requirementsChanged/)
  assert.match(implementation, /FDE_APPROVAL_ACTIVE/)
  assert.match(implementation, /投资基金变更/)
  assert.match(implementation, /locked\.investmentFund/)
  assert.match(implementation, /fdePatch\.investmentFund/)
})
```

- [ ] **步骤 2：运行测试并确认失败**

```powershell
.\.runtime\node22\node.exe --import tsx --test server/tests/systemAdminInvestmentFund.test.ts
```

预期：FAIL，因为字段变化尚未拆分，也未使用统一管理员判定。

- [ ] **步骤 3：实现独立授权与真实变化判断**

在 `projectService.ts` 导入：

```ts
import { isEnabledSystemAdmin } from './systemAdminAccessService.js'
```

锁定项目行后计算：

```ts
const investmentFundChanged = 'investmentFund' in fdePatch && fdePatch.investmentFund !== locked.investmentFund
const requirementsChanged = 'requirements' in fdePatch && fdePatch.requirements !== locked.requirements
```

应用规则：

```ts
if (requirementsChanged && locked.ownerUserId !== userId) {
  throw projectClassificationError(403, 'FDE_OWNER_REQUIRED', '项目要求只能由负责人修改')
}
if (investmentFundChanged && locked.ownerUserId !== userId && !await isEnabledSystemAdmin(tx, userId)) {
  throw projectClassificationError(403, 'FDE_OWNER_REQUIRED', '投资基金只能由负责人或系统管理员修改')
}
if (investmentFundChanged || requirementsChanged) {
  const [active] = await tx.select({ id: oaApprovalRequests.id }).from(oaApprovalRequests)
    .where(and(eq(oaApprovalRequests.projectId, id), eq(oaApprovalRequests.status, '审批中'))).limit(1)
  if (active) throw projectClassificationError(409, 'FDE_APPROVAL_ACTIVE', '审批期间不能修改项目要求或投资基金，请先撤回修订')
}
```

- [ ] **步骤 4：补充基金审计摘要**

审计 `target` 在基金发生变化时使用 JSON 摘要：

```ts
const auditTarget = investmentFundChanged
  ? JSON.stringify({ projectId: locked.id, projectName: locked.name, change: '投资基金变更', from: locked.investmentFund ?? '', to: fdePatch.investmentFund ?? '' })
  : locked.name
```

将现有审计调用的 `target` 替换为 `auditTarget`。

- [ ] **步骤 5：运行测试和类型检查**

```powershell
.\.runtime\node22\node.exe --import tsx --test server/tests/systemAdminInvestmentFund.test.ts server/tests/systemAdminPlanClosure.test.ts server/tests/systemAdminProjectFileAccess.test.ts
npm run check:types
```

预期：全部 PASS，类型检查退出码为 0。

- [ ] **步骤 6：提交权限变更**

```powershell
git add server/src/services/projectService.ts server/tests/systemAdminInvestmentFund.test.ts
git commit -m "feat: let admins maintain investment funds"
```

### 任务 2：整体验证、合并与本地启用

**文件：**
- 验证：`server/src/services/projectService.ts`

- [ ] **步骤 1：运行针对性回归测试**

```powershell
.\.runtime\node22\node.exe --import tsx --test server/tests/systemAdminInvestmentFund.test.ts server/tests/systemAdminPlanClosure.test.ts server/tests/systemAdminProjectFileAccess.test.ts server/tests/projectFileListReliability.test.ts
```

预期：0 个失败。

- [ ] **步骤 2：运行类型检查和生产构建**

```powershell
npm run check:types
npm run build
```

预期：退出码均为 0。

- [ ] **步骤 3：检查分支状态并合并**

```powershell
git status --short
git diff main...HEAD --check
git log --oneline main..HEAD
```

工作树为空后，在主 worktree 执行：

```powershell
git merge --no-ff feature/admin-investment-fund -m "merge: admin investment fund maintenance"
```

- [ ] **步骤 4：重建并恢复 4100 服务**

在主 worktree 生成候选构建，停止旧 4100 进程并启用候选。若 Windows 原子重命名继续返回 `EPERM`，先备份现有 `dist/server-dist` 到该 release 的回滚目录，再覆盖候选并校验清单哈希；端口保持 4100。

- [ ] **步骤 5：健康检查与浏览器验收**

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:4100/api/health'
```

预期为 `ready`。系统管理员在测试项目的“项目概况 → 编辑项目”填写投资基金并保存，刷新后值仍存在；不改变负责人“余勤”；内核阶段“明确投资基金”门禁通过。
