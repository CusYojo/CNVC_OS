# 系统管理员项目材料完整管理与上传状态修复实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让所有启用的系统管理员完整管理项目中心全部项目材料，并让上传结果以准确的颜色、标题和错误信息呈现。

**架构：** 后端在项目文件访问服务内增加专用的启用系统管理员 SQL 谓词，并只注入文件工作区与单文件权限，避免修改通用业务角色。前端把上传结果与批次展示抽成纯函数契约，页面仅负责调用上传接口、保存逐文件结果并渲染统一汇总。

**技术栈：** TypeScript、React 18、Drizzle ORM、Node.js test runner、tsx、Tailwind CSS。

---

## 文件结构

- 创建 `server/tests/systemAdminProjectFileAccess.test.ts`：锁定管理员文件权限 SQL 边界，防止权限扩散至通用业务角色。
- 修改 `server/src/services/projectFileAccessService.ts`：提供启用系统管理员谓词，并接入工作区与全部单文件操作。
- 创建 `src/lib/projectFileUploadPresentation.ts`：定义逐文件上传结果、批次汇总、颜色及标题的纯函数。
- 创建 `server/tests/projectFileUploadPresentation.test.ts`：覆盖成功、失败、解析异常、混合和重复文件批次。
- 修改 `src/pages/ProjectDetailPage.tsx`：保留真实错误信息、使用结构化结果并按汇总样式渲染。

### 任务 1：系统管理员完整项目文件权限

**文件：**
- 创建：`server/tests/systemAdminProjectFileAccess.test.ts`
- 修改：`server/src/services/projectFileAccessService.ts`

- [ ] **步骤 1：编写失败的权限边界测试**

创建源码契约测试，明确管理员谓词必须检查账号启用状态和 `system_admin` 角色，且同时进入工作区和单文件访问，但不能进入 `businessRole`：

```ts
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = () => readFile(new URL('../src/services/projectFileAccessService.ts', import.meta.url), 'utf8')

test('enabled system administrators receive file-domain access only', async () => {
  const implementation = await source()
  const adminStart = implementation.indexOf('function enabledSystemAdmin')
  const adminEnd = implementation.indexOf('function currentProjectScope', adminStart)
  const adminScope = implementation.slice(adminStart, adminEnd)
  assert.match(adminScope, /status='启用'/)
  assert.match(adminScope, /fde_category='system_admin'/)

  const businessStart = implementation.indexOf('function businessRole')
  const businessEnd = implementation.indexOf('function manager', businessStart)
  assert.match(implementation.slice(businessStart, businessEnd), /NOT IN \('system_admin','coordinator'\)/)
  assert.match(implementation, /or\(enabledSystemAdmin\(userId\), projectScope\)/)
  assert.match(implementation, /or\(enabledSystemAdmin\(userId\), standardWorkspaceScope\)/)
})
```

- [ ] **步骤 2：运行测试并确认失败**

运行：

```powershell
.\.runtime\node22\node.exe --import tsx --test server/tests/systemAdminProjectFileAccess.test.ts
```

预期：FAIL，因为 `enabledSystemAdmin` 尚不存在。

- [ ] **步骤 3：实现专用管理员文件权限谓词**

在 `projectFileAccessService.ts` 中新增：

```ts
function enabledSystemAdmin(userId: string | SQL) {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM ${users} system_admin_actor
    WHERE system_admin_actor.id=${userId}
      AND system_admin_actor.status='启用'
      AND EXISTS (
        SELECT 1 FROM ${userRoles} system_admin_user_role
        JOIN ${roles} system_admin_role ON system_admin_role.id=system_admin_user_role.role_id
        WHERE system_admin_user_role.user_id=system_admin_actor.id
          AND system_admin_role.status='启用'
          AND system_admin_role.fde_category='system_admin'
      )
  )`
}
```

将 `projectFileAccessCondition` 中现有的标准 `projectScope` 保留为普通用户路径，并把最终项目过滤改为：

```ts
const projectScope = and(currentProjectScope(userId), or(ne(projects.workflowModel, 'fde-v1'), and(businessRole(userId), fdeOperation)))
return and(
  sql`EXISTS (SELECT 1 FROM ${users} enabled_file_actor WHERE enabled_file_actor.id=${userId} AND enabled_file_actor.status='启用')`,
  includeDeleted ? undefined : eq(projectFiles.lifecycle, 'active'),
  inArray(projectFiles.projectId, db.select({ id: projects.id }).from(projects).where(or(enabledSystemAdmin(userId), projectScope))),
)!
```

为保证管理员可管理回收站文件，调用方在 `includeDeleted=true` 时继续沿用现有生命周期逻辑。将 `projectFileWorkspaceCondition` 的普通用户表达式命名为 `standardWorkspaceScope`，并返回：

```ts
const standardWorkspaceScope = and(
  currentProjectScope(userId),
  or(ne(projects.workflowModel, 'fde-v1'), and(businessRole(userId), operation === 'upload' ? eq(projects.lifecycle, 'active') : undefined)),
)
return and(
  sql`EXISTS (SELECT 1 FROM ${users} workspace_actor WHERE workspace_actor.id=${userId} AND workspace_actor.status='启用')`,
  or(enabledSystemAdmin(userId), standardWorkspaceScope),
)!
```

- [ ] **步骤 4：运行权限测试与既有文件可靠性测试**

运行：

```powershell
.\.runtime\node22\node.exe --import tsx --test server/tests/systemAdminProjectFileAccess.test.ts server/tests/projectFileListReliability.test.ts server/tests/fdeFileContract.test.ts
```

预期：全部 PASS。

- [ ] **步骤 5：提交后端权限变更**

```powershell
git add server/src/services/projectFileAccessService.ts server/tests/systemAdminProjectFileAccess.test.ts
git commit -m "feat: grant admins full project file access"
```

### 任务 2：上传结果展示纯函数

**文件：**
- 创建：`src/lib/projectFileUploadPresentation.ts`
- 创建：`server/tests/projectFileUploadPresentation.test.ts`

- [ ] **步骤 1：编写失败的批次展示测试**

测试必须覆盖五类汇总，并验证服务器错误信息被保留：

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeProjectFileUpload } from '../../src/lib/projectFileUploadPresentation.js'

test('upload batches expose accurate tone and title', () => {
  assert.deepEqual(summarizeProjectFileUpload([{ fileName: 'a.pdf', kind: 'success', message: '上传成功' }]).tone, 'success')
  assert.equal(summarizeProjectFileUpload([{ fileName: 'a.pdf', kind: 'error', message: '没有上传权限' }]).title, '上传失败')
  assert.equal(summarizeProjectFileUpload([{ fileName: 'a.pdf', kind: 'parse_warning', message: '文件已保存，内容解析失败' }]).tone, 'warning')
  assert.equal(summarizeProjectFileUpload([
    { fileName: 'a.pdf', kind: 'success', message: '上传成功' },
    { fileName: 'b.pdf', kind: 'error', message: '服务不可用' },
  ]).title, '部分文件处理异常')
  assert.equal(summarizeProjectFileUpload([{ fileName: 'a.pdf', kind: 'duplicate', message: '文件已存在' }]).title, '未上传新文件')
  assert.match(summarizeProjectFileUpload([{ fileName: 'a.pdf', kind: 'error', message: '没有上传权限' }]).details[0], /没有上传权限/)
})
```

- [ ] **步骤 2：运行测试并确认失败**

运行：

```powershell
.\.runtime\node22\node.exe --import tsx --test server/tests/projectFileUploadPresentation.test.ts
```

预期：FAIL，模块 `projectFileUploadPresentation` 不存在。

- [ ] **步骤 3：实现结构化结果与汇总函数**

创建模块并导出稳定类型：

```ts
export type ProjectFileUploadResultKind = 'success' | 'parse_warning' | 'duplicate' | 'error'
export interface ProjectFileUploadResult {
  fileName: string
  kind: ProjectFileUploadResultKind
  message: string
}
export interface ProjectFileUploadSummary {
  tone: 'success' | 'warning' | 'error' | 'info'
  title: '上传成功' | '部分文件处理异常' | '上传失败' | '未上传新文件'
  text: string
  details: string[]
}
```

`summarizeProjectFileUpload(results)` 统计四种结果：全部 `error` 为红色；存在 `error` 或 `parse_warning` 且不是全失败为橙色；仅 `duplicate` 为信息色；其余为绿色。`details` 格式统一为 `${fileName}：${message}`，`text` 由各结果数量拼接，供 Toast 和弹窗共用。

- [ ] **步骤 4：运行展示测试并确认通过**

运行：

```powershell
.\.runtime\node22\node.exe --import tsx --test server/tests/projectFileUploadPresentation.test.ts
```

预期：PASS。

- [ ] **步骤 5：提交展示契约**

```powershell
git add src/lib/projectFileUploadPresentation.ts server/tests/projectFileUploadPresentation.test.ts
git commit -m "feat: model project file upload outcomes"
```

### 任务 3：项目详情页接入真实上传状态

**文件：**
- 修改：`src/pages/ProjectDetailPage.tsx`
- 修改：`server/tests/projectFileUploadPresentation.test.ts`

- [ ] **步骤 1：扩展页面接线契约测试**

在展示测试中读取页面源码，并断言页面使用统一汇总函数、保留 `ApiError.message`，且移除固定绿色标题：

```ts
import { readFile } from 'node:fs/promises'

test('project detail renders structured upload summaries without fixed success styling', async () => {
  const page = await readFile(new URL('../../src/pages/ProjectDetailPage.tsx', import.meta.url), 'utf8')
  assert.match(page, /summarizeProjectFileUpload/)
  assert.match(page, /err instanceof ApiError \? err\.message/)
  assert.match(page, /summary\.title/)
  assert.doesNotMatch(page, />已完成上传，窗口将保持打开</)
})
```

- [ ] **步骤 2：运行测试并确认失败**

运行：

```powershell
.\.runtime\node22\node.exe --import tsx --test server/tests/projectFileUploadPresentation.test.ts
```

预期：FAIL，因为页面仍使用字符串结果和固定绿色容器。

- [ ] **步骤 3：让 `uploadOne` 返回逐文件结构化结果**

把返回类型改为 `Promise<ProjectFileUploadResult>`。成功返回 `success`；`ingest.ok === false` 返回 `parse_warning` 并优先使用 `ingest.error`；重复返回 `duplicate`；异常返回 `error`，其中 `ApiError` 使用其 `message`，普通异常使用 `(err as Error).message || '上传失败，请重试'`。FileReader 阶段的异常也由 `handleUploadFiles` 捕获并转换成带文件名的 `error`。

- [ ] **步骤 4：让批次逻辑只使用统一汇总**

将 `uploadSummaries` 改为 `ProjectFileUploadSummary[]`。`Promise.allSettled` 中收集每个文件的 `ProjectFileUploadResult`，结束后执行：

```ts
const summary = summarizeProjectFileUpload(results)
setUploadSummaries(current => [...current, summary])
showToast(`${summary.title}（${summary.text}）`, summary.tone === 'success' ? undefined : summary.tone === 'warning' ? 'error' : summary.tone)
```

由于现有 Toast 不支持 warning，橙色批次的 Toast 暂用 error 图标；弹窗必须使用真正的橙色样式。

- [ ] **步骤 5：按汇总状态渲染弹窗**

为四种 `tone` 建立 Tailwind 样式映射：

```ts
const uploadSummaryToneClass = {
  success: 'border-emerald-200 bg-emerald-50/60 text-emerald-800',
  warning: 'border-amber-200 bg-amber-50/70 text-amber-800',
  error: 'border-rose-200 bg-rose-50/70 text-rose-800',
  info: 'border-sky-200 bg-sky-50/70 text-sky-800',
} as const
```

每一批独立渲染 `summary.title`、`summary.text` 和 `summary.details`，不要再用包裹全部批次的固定绿色容器，也不要出现“已完成上传”。

- [ ] **步骤 6：运行页面契约测试与类型检查**

运行：

```powershell
.\.runtime\node22\node.exe --import tsx --test server/tests/projectFileUploadPresentation.test.ts
npm run check:types
```

预期：测试 PASS，TypeScript 无错误。

- [ ] **步骤 7：提交前端修复**

```powershell
git add src/pages/ProjectDetailPage.tsx server/tests/projectFileUploadPresentation.test.ts
git commit -m "fix: show accurate project upload status"
```

### 任务 4：整体验证、合并与本地启用

**文件：**
- 验证：`server/src/services/projectFileAccessService.ts`
- 验证：`src/lib/projectFileUploadPresentation.ts`
- 验证：`src/pages/ProjectDetailPage.tsx`

- [ ] **步骤 1：运行所有针对性测试**

```powershell
.\.runtime\node22\node.exe --import tsx --test server/tests/systemAdminProjectFileAccess.test.ts server/tests/projectFileUploadPresentation.test.ts server/tests/projectFileListReliability.test.ts server/tests/fdeFileContract.test.ts
```

预期：全部 PASS。

- [ ] **步骤 2：运行静态检查与生产构建**

```powershell
npm run check:types
npm run build
```

预期：两条命令退出码均为 0。

- [ ] **步骤 3：检查分支差异与工作树**

```powershell
git status --short
git diff main...HEAD --check
git log --oneline main..HEAD
```

预期：工作树为空，`git diff --check` 无输出，日志包含权限、展示契约和页面修复提交。

- [ ] **步骤 4：合并回本地 `main`**

在主 worktree 执行：

```powershell
git merge --no-ff feature/admin-file-management -m "merge: admin project file management"
```

预期：合并成功且无冲突。

- [ ] **步骤 5：重新构建并重启本地 4100 服务**

使用项目既有单服务构建与启动流程生成 `dist`、`server-dist`，停止旧的 4100 监听进程后启动新构建。不得改变端口；前端仍通过 `http://127.0.0.1:4100` 访问。

- [ ] **步骤 6：执行本地健康检查**

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:4100/api/health'
```

预期：返回 `ready`。若组件健康接口仍仅报告既有 `mysql-runtime-jobs` dead letter，不把它误报为本次回归。

- [ ] **步骤 7：浏览器验收**

用启用的系统管理员账号打开一个自己不是成员的项目，验证上传、查看、下载、绑定、替换和删除；再触发 403/网络错误与解析异常，确认完全失败为红色、解析异常和混合结果为橙色、成功为绿色、仅重复为信息色，并显示具体文件名与错误原因。
