# AI 助手项目权限过滤实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** AI 助手通过现有 `/projects` 接口分别拉取当前用户有权访问的全部活动普通项目和重点项目，合并后用于项目选择，并在创建会话时由服务端再次验证项目资格。

**架构：** 前端项目列表服务新增可注入请求函数的分页聚合器，并行拉取 `normal` 与 `key` 两类的所有分页，AI 助手将聚合结果作为新建与切换项目的唯一候选数据源。后端沿用 `requireAccessibleProject`，再检查生命周期和分类，仅在新建项目会话时执行增强校验；历史会话读取保持原逻辑。

**技术栈：** React 18、TypeScript、Zustand、Express 5、Drizzle ORM、Node.js test runner

---

## 文件结构

- 修改 `src/services/projectListApi.ts`：实现单分类全分页拉取及普通/重点项目并行合并。
- 修改 `src/pages/AIAssistantPage.tsx`：加载并使用 AI 可选项目状态，处理加载失败和空列表。
- 修改 `server/src/services/projectAccessService.ts`：增加新建 AI 项目会话的资格校验。
- 修改 `server/src/services/conversationService.ts`：新建项目会话改用增强资格校验。
- 创建 `server/tests/aiAssistantProjectSelection.test.ts`：验证分页、双分类参数、去重排序和服务端接线契约。

### 任务 1：建立前端双分类分页聚合器

**文件：**
- 修改：`src/services/projectListApi.ts`
- 创建：`server/tests/aiAssistantProjectSelection.test.ts`

- [ ] **步骤 1：编写失败的分页合并测试**

测试通过可注入的 `fetchPage` 记录查询参数：普通项目第一页返回 `total: 101`，重点项目第一页返回 `total: 1`，断言函数继续请求普通项目第二页；所有请求必须包含 `scope: 'all'`、`lifecycle: 'active'` 和单一 `classification`。

```ts
test('AI assistant fetches every authorized normal/key page', async () => {
  const calls: ProjectListQuery[] = []
  const fetchPage = async (query: ProjectListQuery): Promise<ProjectListResponse> => {
    calls.push(query)
    if (query.classification === 'normal' && query.page === 1) return response([project('n1')], 101, 1)
    if (query.classification === 'normal') return response([project('n2')], 101, 2)
    return response([project('k1', 'key', true)], 1, 1)
  }
  const rows = await fetchAiAssistantProjects(fetchPage)
  assert.deepEqual(rows.map(row => row.id), ['k1', 'n1', 'n2'])
  assert.equal(calls.length, 3)
  assert.ok(calls.every(call => call.scope === 'all' && call.lifecycle === 'active'))
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --import tsx --test server/tests/aiAssistantProjectSelection.test.ts`

预期：FAIL，`fetchAiAssistantProjects` 尚未导出。

- [ ] **步骤 3：实现最少分页聚合代码**

在 `src/services/projectListApi.ts` 增加：

```ts
type ProjectPageFetcher = (query: ProjectListQuery) => Promise<ProjectListResponse>

async function fetchClassificationPages(
  classification: Extract<ProjectClassification, 'normal' | 'key'>,
  fetchPage: ProjectPageFetcher,
) {
  const query = (page: number): ProjectListQuery => ({
    page, pageSize: 100, scope: 'all', classification, lifecycle: 'active',
  })
  const first = await fetchPage(query(1))
  const totalPages = Math.ceil(first.total / first.pageSize)
  const rest = await Promise.all(Array.from(
    { length: Math.max(0, totalPages - 1) },
    (_, index) => fetchPage(query(index + 2)),
  ))
  return [first, ...rest].flatMap(page => page.list)
}

export async function fetchAiAssistantProjects(fetchPage: ProjectPageFetcher = fetchProjectList) {
  const groups = await Promise.all([
    fetchClassificationPages('normal', fetchPage),
    fetchClassificationPages('key', fetchPage),
  ])
  const unique = new Map(groups.flat().map(project => [project.id, project]))
  return [...unique.values()].sort((left, right) =>
    Number(right.pinned) - Number(left.pinned)
      || right.updatedAt.localeCompare(left.updatedAt)
      || right.id.localeCompare(left.id))
}
```

- [ ] **步骤 4：增加重复 ID 去重和任一分页失败时整体拒绝的测试**

- [ ] **步骤 5：运行测试验证通过**

运行：`node --import tsx --test server/tests/aiAssistantProjectSelection.test.ts`

预期：分页、过滤参数、去重、排序和失败传播测试全部 PASS。

- [ ] **步骤 6：提交**

```powershell
git add src/services/projectListApi.ts server/tests/aiAssistantProjectSelection.test.ts
git commit -m "feat: merge authorized AI project lists"
```

### 任务 2：为新建 AI 项目会话增加服务端二次校验

**文件：**
- 修改：`server/src/services/projectAccessService.ts`
- 修改：`server/src/services/conversationService.ts`
- 修改：`server/tests/aiAssistantProjectSelection.test.ts`

- [ ] **步骤 1：编写失败的服务端接线契约测试**

测试读取源码并断言 `projectAccessService.ts` 导出 `requireAiAssistantProject`，它调用 `requireAccessibleProject` 并检查 `active`、`normal`、`key`；`conversationService.ts` 的 `createConversation` 调用新函数。

- [ ] **步骤 2：运行测试验证失败**

运行：`node --import tsx --test server/tests/aiAssistantProjectSelection.test.ts`

预期：FAIL，缺少 `requireAiAssistantProject`。

- [ ] **步骤 3：实现增强资格校验**

在 `server/src/services/projectAccessService.ts` 增加：

```ts
export async function requireAiAssistantProject(userId: string, projectId: string) {
  const project = await requireAccessibleProject(userId, projectId)
  if (project.lifecycle !== 'active'
    || (project.classification !== 'normal' && project.classification !== 'key')) {
    throw Object.assign(new Error('所选项目不是可用于 AI 助手的活动普通项目或重点项目'), {
      status: 403, code: 'AI_PROJECT_FORBIDDEN',
    })
  }
  return project
}
```

在 `server/src/services/conversationService.ts` 中将新建会话使用的 `requireAccessibleProject` 替换为 `requireAiAssistantProject`；保留 `getAccessibleProject` 给历史会话读取使用。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --import tsx --test server/tests/aiAssistantProjectSelection.test.ts`

预期：服务端接线契约 PASS。

- [ ] **步骤 5：提交**

```powershell
git add server/src/services/projectAccessService.ts server/src/services/conversationService.ts server/tests/aiAssistantProjectSelection.test.ts
git commit -m "fix: validate AI conversation project eligibility"
```

### 任务 3：AI 助手切换到合并后的候选列表

**文件：**
- 修改：`src/pages/AIAssistantPage.tsx`
- 修改：`server/tests/aiAssistantProjectSelection.test.ts`

- [ ] **步骤 1：编写失败的页面接线契约测试**

断言页面导入并调用 `fetchAiAssistantProjects`，维护独立的 `selectableProjects`、`projectsLoading`、`projectsLoadError`，且新建会话、项目切换选择器与按钮禁用条件使用 `selectableProjects`。

- [ ] **步骤 2：运行测试验证失败**

运行：`node --import tsx --test server/tests/aiAssistantProjectSelection.test.ts`

预期：FAIL，页面尚未接入候选列表。

- [ ] **步骤 3：增加候选项目加载状态**

在 `AIAssistantPage` 中增加：

```ts
const [selectableProjects, setSelectableProjects] = useState<Project[]>([])
const [projectsLoading, setProjectsLoading] = useState(true)
const [projectsLoadError, setProjectsLoadError] = useState('')
```

挂载时调用 `fetchAiAssistantProjects()`；成功保存完整列表，失败时清空列表并保存错误，组件卸载后不再更新状态。

- [ ] **步骤 4：替换项目选择入口的数据源**

将 `newSessionProject`、新建弹窗默认项目 effect、`openNewSessionDialog`、无会话首次默认候选、两个项目选择组件和新建按钮改用 `selectableProjects`。历史会话的 `currentProject`、`activateSession` 和服务端返回的 `projectName` 保持原逻辑，避免归档项目的历史会话无法读取。

- [ ] **步骤 5：补齐加载、失败和空列表状态**

加载时显示“正在加载可用项目…”并禁用确认；失败时显示具体错误并禁止创建，不回退到全局 `projects`；加载成功但为空时保留“当前账号暂无可用项目，暂时不能创建项目会话。”。

- [ ] **步骤 6：运行测试和类型检查**

运行：

```powershell
node --import tsx --test server/tests/aiAssistantProjectSelection.test.ts
npm run check:types
```

预期：测试全部 PASS，TypeScript 检查退出码为 0。

- [ ] **步骤 7：提交**

```powershell
git add src/pages/AIAssistantPage.tsx server/tests/aiAssistantProjectSelection.test.ts
git commit -m "fix: filter AI assistant project choices"
```

### 任务 4：回归验证

**文件：**
- 验证：上述五个实现与测试文件

- [ ] **步骤 1：运行目标测试**

运行：`node --import tsx --test server/tests/aiAssistantProjectSelection.test.ts server/tests/projectListPagination.test.ts`

预期：全部 PASS。

- [ ] **步骤 2：运行类型检查**

运行：`npm run check:types`

预期：退出码为 0。

- [ ] **步骤 3：检查补丁边界**

运行：`git diff --check`、`git status --short`、`git diff --stat`。

预期：没有空白错误；本任务不修改 `create_office_policies.mjs`、`server/src/scripts/dayanAiSkillE2eAcceptance.ts`、`server/tests/dayanAiSkillE2eContract.test.ts` 等并行工作文件。

- [ ] **步骤 4：人工验收**

使用两个权限范围不同的已启用测试账号检查：普通和重点项目均可选；项目池、关闭、归档、删除及无权项目不可见；超过一页的分类能完整搜索；任一列表请求失败时不能创建；既有归档项目会话仍可读取。没有隔离测试账号或测试库时记录未执行，不能对业务库造数。

- [ ] **步骤 5：仅在存在本任务未提交文件时提交**

```powershell
git add src/services/projectListApi.ts src/pages/AIAssistantPage.tsx server/src/services/projectAccessService.ts server/src/services/conversationService.ts server/tests/aiAssistantProjectSelection.test.ts
git commit -m "test: cover AI project permission filtering"
```
