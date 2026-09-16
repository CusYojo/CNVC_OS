# 系统管理员尽调计划闭环实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让启用的系统管理员无需加入项目组即可配置活动项目的尽调草稿计划，并让流程页在计划有效前准确阻止审批、提供直达配置入口。

**架构：** 把管理员身份判定从文件权限服务抽成独立服务，供文件与尽调计划共同复用。后端工作流响应增加由现有计划校验规则计算的提交就绪状态；前端使用纯展示契约计算阻塞项和跳转动作，不再自行猜测计划是否必需。

**技术栈：** TypeScript、React 18、Drizzle ORM、Node.js test runner、tsx、Vite。

---

## 文件结构

- 创建 `server/src/services/systemAdminAccessService.ts`：统一启用系统管理员 SQL 条件和运行时查询。
- 修改 `server/src/services/projectFileAccessService.ts`：改用统一管理员条件，保持现有文件权限不变。
- 修改 `server/src/services/fdeWorkflowService.ts`：管理员草稿计划授权、计划就绪计算和 API 能力返回。
- 创建 `src/lib/fdePlanReadinessPresentation.ts`：根据阶段、加载状态和后端就绪状态生成前端阻塞与 CTA。
- 修改 `src/components/FdeWorkflowPanel.tsx`：准确显示计划门禁并跳转到项目任务。
- 创建 `server/tests/systemAdminPlanClosure.test.ts`：锁定管理员授权、计划就绪和页面接线边界。
- 修改 `server/tests/systemAdminProjectFileAccess.test.ts`：确认文件服务继续复用统一管理员定义。

### 任务 1：统一系统管理员身份判定

**文件：**
- 创建：`server/src/services/systemAdminAccessService.ts`
- 修改：`server/src/services/projectFileAccessService.ts`
- 修改：`server/tests/systemAdminProjectFileAccess.test.ts`

- [ ] **步骤 1：修改源码契约测试并确认失败**

将文件权限测试改为断言 `projectFileAccessService.ts` 从 `systemAdminAccessService` 导入 `enabledSystemAdminCondition`，并断言新服务同时支持账号主角色和职责分类：

```ts
assert.match(fileAccess, /import \{ enabledSystemAdminCondition \} from '\.\/systemAdminAccessService\.js'/)
assert.match(fileAccess, /enabledSystemAdminCondition\(userId\)/)
assert.match(systemAdminAccess, /system_admin_actor\.role='系统管理员'/)
assert.match(systemAdminAccess, /system_admin_role\.fde_category='system_admin'/)
assert.match(systemAdminAccess, /system_admin_actor\.status='启用'/)
```

运行：

```powershell
.\.runtime\node22\node.exe --import tsx --test server/tests/systemAdminProjectFileAccess.test.ts
```

预期：FAIL，因为统一服务尚不存在。

- [ ] **步骤 2：实现统一管理员服务**

创建以下接口：

```ts
export function enabledSystemAdminCondition(userId: string | SQL): SQL<boolean>

export async function isEnabledSystemAdmin(
  executor: Pick<FileExecutor, 'select'>,
  userId: string,
): Promise<boolean>
```

SQL 条件必须要求用户启用，并允许以下任一身份来源：

```sql
system_admin_actor.role='系统管理员'
OR EXISTS (... enabled role with fde_category='system_admin')
```

运行时查询使用同一 `enabledSystemAdminCondition(userId)`，不得重新实现另一套角色规则。

- [ ] **步骤 3：文件权限服务切换到统一条件**

删除 `projectFileAccessService.ts` 内部的 `enabledSystemAdmin`，将两个调用点替换为：

```ts
enabledSystemAdminCondition(userId)
```

- [ ] **步骤 4：运行文件权限回归测试**

```powershell
.\.runtime\node22\node.exe --import tsx --test server/tests/systemAdminProjectFileAccess.test.ts server/tests/projectFileListReliability.test.ts server/tests/fdeFileContract.test.ts
```

预期：全部 PASS。

- [ ] **步骤 5：提交统一身份服务**

```powershell
git add server/src/services/systemAdminAccessService.ts server/src/services/projectFileAccessService.ts server/tests/systemAdminProjectFileAccess.test.ts
git commit -m "refactor: centralize system admin access"
```

### 任务 2：开放管理员草稿计划编辑并返回真实就绪状态

**文件：**
- 修改：`server/src/services/fdeWorkflowService.ts`
- 创建：`server/tests/systemAdminPlanClosure.test.ts`

- [ ] **步骤 1：编写失败的后端闭环契约测试**

测试读取工作流服务源码并锁定以下行为：

```ts
test('admin plan editing uses the shared enabled-admin identity', async () => {
  const source = await workflowSource()
  assert.match(source, /isEnabledSystemAdmin/)
  assert.match(source, /if \(await isEnabledSystemAdmin\(tx, userId\)\) return actor/)
  assert.match(source, /canEditDraftPlan/)
})

test('workflow exposes backend-computed plan review readiness', async () => {
  const source = await workflowSource()
  assert.match(source, /planReadiness/)
  assert.match(source, /validForReview/)
  assert.match(source, /validateFdePlan/)
})
```

运行并预期 FAIL：

```powershell
.\.runtime\node22\node.exe --import tsx --test server/tests/systemAdminPlanClosure.test.ts
```

- [ ] **步骤 2：管理员进入草稿计划编辑授权**

在 `requirePlanEditor` 中确认账号启用后，先执行：

```ts
if (await isEnabledSystemAdmin(tx, userId)) return actor
```

增加 `canEditDraftPlan(reader, project, userId)`，返回以下任一条件：启用系统管理员、项目负责人、项目成员。`getFdeWorkflow` 的 `canEditPlan` 在计划未锁定时使用该函数；计划锁定后仍只使用原有 `canAmendApprovedPlan`，防止管理员越过已审批计划修订边界。

- [ ] **步骤 3：抽取计划提交就绪检查**

新增内部函数：

```ts
async function inspectPlanReadiness(
  reader: FileExecutor,
  project: ProjectRow,
  policy: Awaited<ReturnType<typeof getProjectWorkflowPolicy>>,
  plan: typeof projectPlans.$inferSelect | undefined,
  actions: Array<typeof projectPlanActions.$inferSelect>,
): Promise<{ validForReview: boolean; reason: string }>
```

规则必须复用 `validateFdePlan`，检查周期在项目绑定策略中、负责人和参与人均属于负责人或项目组、相关账号启用。无计划返回 `{ validForReview: false, reason: '尚未配置有效倒排计划' }`；校验失败返回 `{ validForReview: false, reason: '倒排计划尚未完整保存' }`；成功返回 `{ validForReview: true, reason: '计划已配置，可提交审核' }`。

- [ ] **步骤 4：API 与阶段门禁复用就绪检查**

`getFdeWorkflow` 返回：

```ts
capabilities: { canEditPlan },
planReadiness,
```

`inspectFdeStageGate` 在项目处于“尽调计划制定”或“尽调计划审核”时调用同一函数，并以 `validForReview` 设置“完整且有效的倒排计划”检查项，避免 API 提示和提交门禁漂移。

- [ ] **步骤 5：运行后端测试和类型检查**

```powershell
.\.runtime\node22\node.exe --import tsx --test server/tests/systemAdminPlanClosure.test.ts server/tests/systemAdminProjectFileAccess.test.ts server/tests/projectFileListReliability.test.ts
npm run check:types
```

预期：全部 PASS，类型检查退出码为 0。

- [ ] **步骤 6：提交后端闭环实现**

```powershell
git add server/src/services/fdeWorkflowService.ts server/tests/systemAdminPlanClosure.test.ts
git commit -m "feat: let admins configure draft diligence plans"
```

### 任务 3：修复流程页计划门禁状态与入口

**文件：**
- 创建：`src/lib/fdePlanReadinessPresentation.ts`
- 修改：`src/components/FdeWorkflowPanel.tsx`
- 修改：`server/tests/systemAdminPlanClosure.test.ts`

- [ ] **步骤 1：编写失败的纯展示测试**

在 `systemAdminPlanClosure.test.ts` 导入并测试：

```ts
import { presentFdePlanReadiness } from '../../src/lib/fdePlanReadinessPresentation.js'

assert.deepEqual(
  presentFdePlanReadiness({ stage: '尽调计划制定', loaded: true, validForReview: false, reason: '尚未配置有效倒排计划' }),
  { required: true, blocked: true, label: '尚未配置有效倒排计划', action: 'configure' },
)
assert.equal(presentFdePlanReadiness({ stage: '尽调计划制定', loaded: true, validForReview: true, reason: '计划已配置，可提交审核' }).blocked, false)
assert.equal(presentFdePlanReadiness({ stage: '尽调计划制定', loaded: false, validForReview: false, reason: '' }).blocked, true)
```

运行并预期 FAIL，因为模块尚不存在。

- [ ] **步骤 2：实现纯展示契约**

创建：

```ts
export function presentFdePlanReadiness(input: {
  stage: string
  loaded: boolean
  validForReview: boolean
  reason: string
}): { required: boolean; blocked: boolean; label: string; action: 'configure' | null }
```

“尽调计划制定”和“尽调计划审核”均为计划必需阶段；未加载或无效时阻塞。其他阶段沿用已锁定计划要求，不改变既有规则。

- [ ] **步骤 3：工作流响应类型接入就绪状态**

在 `Workflow` 类型中增加：

```ts
planReadiness: { validForReview: boolean; reason: string }
```

页面通过 `presentFdePlanReadiness` 获取当前计划状态，不再用 `['尽调计划审核', '尽调', ...]` 漏掉“尽调计划制定”。

- [ ] **步骤 4：更新阻塞提示和跳转**

当当前阶段为“尽调计划制定”且计划无效时：

- `canStartApproval` 必须为 `false`；
- 状态条显示后端 `reason`；
- 阻塞区显示同一原因；
- 按钮文案为“去配置计划”；
- 点击执行：

```ts
navigate(`/projects/${project.id}?tab=tasks`)
```

有效草稿显示“计划已配置，可提交审核”。后续阶段继续显示现有“计划已确认/计划待确认”。

- [ ] **步骤 5：增加页面源码接线断言**

```ts
assert.match(panel, /presentFdePlanReadiness/)
assert.match(panel, /尚未配置有效倒排计划|planReadiness\.label/)
assert.match(panel, /\?tab=tasks/)
assert.doesNotMatch(panel, /const planRequired = \['尽调计划审核'/)
```

- [ ] **步骤 6：运行展示测试和类型检查**

```powershell
.\.runtime\node22\node.exe --import tsx --test server/tests/systemAdminPlanClosure.test.ts
npm run check:types
```

预期：全部 PASS，类型检查退出码为 0。

- [ ] **步骤 7：提交前端门禁修复**

```powershell
git add src/lib/fdePlanReadinessPresentation.ts src/components/FdeWorkflowPanel.tsx server/tests/systemAdminPlanClosure.test.ts
git commit -m "fix: block plan review until schedule is ready"
```

### 任务 4：整体验证、合并与本地启用

**文件：**
- 验证：`server/src/services/systemAdminAccessService.ts`
- 验证：`server/src/services/fdeWorkflowService.ts`
- 验证：`src/components/FdeWorkflowPanel.tsx`

- [ ] **步骤 1：运行针对性测试**

```powershell
.\.runtime\node22\node.exe --import tsx --test server/tests/systemAdminPlanClosure.test.ts server/tests/systemAdminProjectFileAccess.test.ts server/tests/projectFileListReliability.test.ts server/tests/fdeFileContract.test.ts
```

预期：0 个失败。

- [ ] **步骤 2：运行类型检查和生产构建**

```powershell
npm run check:types
npm run build
```

预期：两条命令退出码均为 0。

- [ ] **步骤 3：检查分支状态**

```powershell
git status --short
git diff main...HEAD --check
git log --oneline main..HEAD
```

预期：工作树为空，差异检查无输出。

- [ ] **步骤 4：合并回本地 main**

```powershell
git merge --no-ff feature/admin-plan-closure -m "merge: admin plan closure"
```

- [ ] **步骤 5：构建并恢复 4100 服务**

在主 worktree 执行生产构建，停止旧 4100 监听进程，启用新候选并用项目 Node 22 后台启动 `server-dist/index.js`。Windows 原子重命名若再次返回 `EPERM`，先复制当前 `dist`、`server-dist` 到该 release 的回滚目录，再覆盖候选文件；不得删除业务数据或改变端口。

- [ ] **步骤 6：健康检查与浏览器验收**

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:4100/api/health'
```

预期状态为 `ready`。使用系统管理员打开截图中的测试项目：流程页先显示“尚未配置有效倒排计划”，点击“去配置计划”进入项目任务；看到“配置计划”，设置最终日期、生成并保存；返回流程页后显示“计划已配置，可提交审核”，提交管理员自确认审批不再报缺少排期。
