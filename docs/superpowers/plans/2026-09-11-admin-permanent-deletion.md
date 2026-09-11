# 管理后台数据彻底删除实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为系统管理员提供统一的数据彻底删除中心，通过三次确认永久删除项目池线索、正式项目或知识库条目及其专属关联数据。

**架构：** 新增浏览器安全契约、持久化确认令牌与审计表、单一管理员删除服务和系统管理路由。服务先生成受版本约束的影响预览，再在事务中锁定目标、复核确认内容并按显式关系清单清理；前端使用独立面板完成搜索、预览和三步确认。

**技术栈：** React 18、TypeScript、Express 5、Zod、Drizzle ORM、MySQL、Node test。

---

## 文件结构

- 创建 `server/src/contracts/adminPermanentDeletionContract.ts`：共享对象类型、固定风险文本、请求和响应 Schema。
- 创建 `server/drizzle/0113_add_admin_permanent_deletions.sql`：持久化预览令牌、最小审计和文件清理状态。
- 修改 `server/drizzle/meta/_journal.json`：登记 0113 迁移。
- 修改 `server/src/db/schema.ts`：映射管理员永久删除表。
- 创建 `server/src/services/adminPermanentDeletionService.ts`：搜索、影响预览、三类对象事务清理和幂等执行。
- 修改 `server/src/routes/systemAdministration.ts`：挂载管理员专属搜索、预览和执行接口。
- 创建 `src/components/AdminPermanentDeletionPanel.tsx`：后台删除中心和三步确认向导。
- 修改 `src/lib/systemWorkspaces.ts`：把删除中心加入后台工作区。
- 修改 `src/pages/SystemPage.tsx`：注册标签和渲染删除面板。
- 创建 `server/tests/adminPermanentDeletionContract.test.ts`：契约与确认文本单元测试。
- 创建 `server/tests/adminPermanentDeletionService.test.ts`：服务权限、预览绑定、清理边界、事务和幂等测试。
- 创建 `server/tests/adminPermanentDeletionUi.test.tsx`：管理员入口和三步交互测试。
- 修改 `server/src/scripts/checkSingleServiceBoundary.ts`：登记新迁移和管理接口的静态边界。

### 任务 1：建立共享契约和持久化结构

**文件：**
- 创建：`server/src/contracts/adminPermanentDeletionContract.ts`
- 创建：`server/tests/adminPermanentDeletionContract.test.ts`
- 创建：`server/drizzle/0113_add_admin_permanent_deletions.sql`
- 修改：`server/drizzle/meta/_journal.json`
- 修改：`server/src/db/schema.ts`

- [ ] **步骤 1：编写失败的契约测试**

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ADMIN_PERMANENT_DELETION_RISK_TEXT,
  permanentDeletionExecuteSchema,
} from '../src/contracts/adminPermanentDeletionContract.js'

test('permanent deletion requires the exact fixed risk statement', () => {
  const base = { resourceType: 'lead', resourceId: crypto.randomUUID(), previewToken: crypto.randomUUID(), resourceName: '星语智能' }
  assert.equal(permanentDeletionExecuteSchema.safeParse({ ...base, riskText: `${ADMIN_PERMANENT_DELETION_RISK_TEXT} ` }).success, false)
  assert.equal(permanentDeletionExecuteSchema.safeParse({ ...base, riskText: ADMIN_PERMANENT_DELETION_RISK_TEXT }).success, true)
})
```

- [ ] **步骤 2：运行测试并确认因模块不存在而失败**

运行：

```bash
node --import tsx --test server/tests/adminPermanentDeletionContract.test.ts
```

预期：FAIL，错误包含 `adminPermanentDeletionContract` 模块不存在。

- [ ] **步骤 3：实现浏览器安全契约**

```ts
import { z } from 'zod'

export const ADMIN_PERMANENT_DELETION_RISK_TEXT = '我已熟知删除项目的风险，我愿意承担责任。'
export const permanentDeletionResourceTypeSchema = z.enum(['lead', 'project', 'knowledge'])
export const permanentDeletionExecuteSchema = z.object({
  resourceType: permanentDeletionResourceTypeSchema,
  resourceId: z.string().uuid(),
  previewToken: z.string().uuid(),
  resourceName: z.string().min(1).max(255),
  riskText: z.literal(ADMIN_PERMANENT_DELETION_RISK_TEXT),
}).strict()
```

同时定义搜索结果、影响计数、预览响应和执行回执类型，保持该文件不导入数据库或 Node 专属模块。

- [ ] **步骤 4：增加迁移和 Drizzle 映射**

创建 `admin_permanent_deletions`，字段固定为：`id`、`token_hash`、`resource_type`、`resource_id`、`resource_name`、`resource_version`、`impact_hash`、`impact_counts`、`actor_id`、`actor_name`、`status`、`risk_confirmation_version`、`database_deleted_at`、`file_cleanup_status`、`file_cleanup_payload`、`file_cleanup_attempts`、`file_cleanup_error`、`expires_at`、`created_at`、`updated_at`。为 `token_hash` 建唯一索引，为 `(actor_id,status,expires_at)` 和 `(resource_type,resource_id,status)` 建索引。

外键只连接 `actor_id -> users.id ON DELETE RESTRICT`；被删除对象只保存类型和原 ID，不能建立会阻止删除的外键。`impact_counts` 和 `file_cleanup_payload` 使用 JSON，状态限定为 `preview|deleting|deleted|failed`，文件状态限定为 `none|pending|running|done|failed`。

- [ ] **步骤 5：运行契约测试和迁移静态检查**

运行：

```bash
node --import tsx --test server/tests/adminPermanentDeletionContract.test.ts
npm run check:migration-integrity
```

预期：契约测试 PASS；迁移完整性检查 PASS，最新迁移为 `0113_add_admin_permanent_deletions`。

- [ ] **步骤 6：提交契约和迁移**

```bash
git add server/src/contracts/adminPermanentDeletionContract.ts server/tests/adminPermanentDeletionContract.test.ts server/drizzle/0113_add_admin_permanent_deletions.sql server/drizzle/meta/_journal.json server/src/db/schema.ts
git commit -m "feat: add permanent deletion contract"
```

### 任务 2：实现只读搜索和影响预览

**文件：**
- 创建：`server/src/services/adminPermanentDeletionService.ts`
- 创建：`server/tests/adminPermanentDeletionService.test.ts`

- [ ] **步骤 1：编写失败的权限和预览绑定测试**

测试通过依赖注入的事务仓储构造管理员、停用管理员、普通用户和三个资源。断言：

```ts
await assert.rejects(() => service.search(disabledAdmin, { resourceType: 'lead', query: '星语' }), { code: 'ROLE_FORBIDDEN' })
await assert.rejects(() => service.preview(normalUser, { resourceType: 'project', resourceId }), { code: 'ROLE_FORBIDDEN' })
const preview = await service.preview(admin, { resourceType: 'knowledge', resourceId })
assert.equal(preview.resourceName, '测试知识')
assert.equal(preview.impact.comments, 2)
assert.match(preview.previewToken, /^[0-9a-f-]{36}$/)
```

- [ ] **步骤 2：运行服务测试并确认失败**

运行：

```bash
node --env-file-if-exists=.env --import tsx --test server/tests/adminPermanentDeletionService.test.ts
```

预期：FAIL，错误包含服务模块不存在。

- [ ] **步骤 3：实现管理员校验和搜索**

服务使用现有身份仓储锁定/读取用户，并要求账号状态为 `启用` 且权限码包含 `system.manage`。搜索查询最多 50 字，按类型分别读取 `leads.name`、`projects.name`、`companyKnowledge.title`，返回最多 20 条，包含 `id`、`name`、`status`、`createdAt`、`source`。

- [ ] **步骤 4：实现影响预览和令牌**

预览在只读事务中统计显式关联表，并生成规范 JSON 的 SHA-256 `impactHash`。令牌只把随机 UUID 的 SHA-256 写入数据库，明文只返回一次；有效期 10 分钟，记录当前资源版本或稳定指纹。

线索存在 `convertedProjectId` 时返回 `blockers: ['LEAD_CONVERTED_PROJECT_EXISTS']`。正式项目和知识条目列出共享文件引用数量，共享引用不能进入待删除文件列表。

- [ ] **步骤 5：运行服务测试确认通过**

运行：

```bash
node --env-file-if-exists=.env --import tsx --test server/tests/adminPermanentDeletionService.test.ts
```

预期：PASS，权限、搜索、影响计数、转换阻断和令牌绑定用例全部通过。

- [ ] **步骤 6：提交搜索与预览**

```bash
git add server/src/services/adminPermanentDeletionService.ts server/tests/adminPermanentDeletionService.test.ts
git commit -m "feat: preview admin permanent deletions"
```

### 任务 3：实现三类对象的事务物理删除

**文件：**
- 修改：`server/src/services/adminPermanentDeletionService.ts`
- 修改：`server/tests/adminPermanentDeletionService.test.ts`

- [ ] **步骤 1：编写失败的确认、事务和幂等测试**

覆盖精确名称、固定风险文本、过期令牌、跨管理员令牌、资源版本变化和重复提交。核心断言：

```ts
await assert.rejects(() => service.execute(admin, { ...request, resourceName: '错误名称' }), { code: 'PERMANENT_DELETE_NAME_MISMATCH' })
assert.equal(await fixtures.businessRowCount(), before)
const first = await service.execute(admin, request)
const replay = await service.execute(admin, request)
assert.equal(first.deletionId, replay.deletionId)
assert.equal(replay.alreadyDeleted, true)
```

注入中途失败后断言主记录和所有关联记录仍存在；事务提交前断言文件删除适配器从未被调用。

- [ ] **步骤 2：运行新增用例确认失败**

运行：

```bash
node --env-file-if-exists=.env --import tsx --test server/tests/adminPermanentDeletionService.test.ts
```

预期：FAIL，执行函数尚未实现。

- [ ] **步骤 3：实现线索物理删除**

锁定线索和预览记录；若 `convertedProjectId` 非空则返回 409。先删除/解除引用到线索的 `set null` 关系，再按外键从叶子表删除事实证据、冲突、来源文档、实体关系、专题运行、补全任务、评分历史、画像、评分任务、管线匹配/复核/决策/证据/迁移记录，最后删除 `leads` 主记录。

不可变的跨资源审计记录只把 `lead_id` 解除为 null，并清除业务正文快照；不能通过线索删除正式项目。

- [ ] **步骤 4：实现正式项目物理删除**

先收集没有任何其他引用的项目文件存储键，写入清理载荷；解除 `leads.converted_project_id`、公司级知识、共享 AI 产物等非从属关系。按外键从叶子表删除项目材料事件与接收人、文件授权/事件/版本、职责和治理记录、计划/时间线/周计划、会议项目关系、风险、Agent 配置/运行/命令、项目成员，最后删除 `projects`。

已有 `deleteProject()` 保持软删除语义，管理后台只调用新服务。

- [ ] **步骤 5：实现知识库物理删除**

删除 `companyKnowledgeGrants`、`companyKnowledgeComments`、`companyKnowledgeRatings`、`companyKnowledgeEvents`、`companyKnowledgeCommands`，把 `weixinLinkIntakes.knowledgeEntryId` 更新为 null 并清除 `articleBody`，最后删除 `companyKnowledge`。仅当 `fileId` 没有项目、材料、档案、AI 任务或其他知识条目引用时，才把存储键加入清理载荷。

- [ ] **步骤 6：写入最小审计和文件清理状态**

事务内把预览行更新为 `deleted`，只保存规格允许的元数据和计数。提交后调用现有文件存储删除适配器；成功更新为 `done`，失败更新为 `failed`、增加尝试次数并保存脱敏错误码。风险原文和业务正文不得写入审计。

- [ ] **步骤 7：运行服务测试确认通过**

运行：

```bash
node --env-file-if-exists=.env --import tsx --test server/tests/adminPermanentDeletionService.test.ts
```

预期：PASS，三类数据、共享引用、回滚、文件提交后清理和幂等用例全部通过。

- [ ] **步骤 8：提交物理删除实现**

```bash
git add server/src/services/adminPermanentDeletionService.ts server/tests/adminPermanentDeletionService.test.ts
git commit -m "feat: permanently delete admin-selected data"
```

### 任务 4：暴露系统管理 API

**文件：**
- 修改：`server/src/routes/systemAdministration.ts`
- 修改：`server/tests/adminPermanentDeletionService.test.ts`

- [ ] **步骤 1：编写失败的 HTTP 权限和校验测试**

用现有测试服务器工具验证：普通用户请求三个接口均为 403；管理员可搜索和预览；缺少字段、风险文本不一致、令牌不匹配均为 400/409 且零写入。

- [ ] **步骤 2：增加三个路由**

```ts
systemAdministrationRouter.get('/permanent-deletions/search', async (req, res, next) => {
  try { res.json(await searchPermanentDeletionTargets(actor(req), req.query)) } catch (error) { next(error) }
})
systemAdministrationRouter.post('/permanent-deletions/preview', async (req, res, next) => {
  try { res.json(await previewPermanentDeletion(actor(req), req.body)) } catch (error) { next(error) }
})
systemAdministrationRouter.post('/permanent-deletions/execute', async (req, res, next) => {
  try { res.json(await executePermanentDeletion(actor(req), req.body)) } catch (error) { next(error) }
})
```

路由位于 `systemAdministrationRouter.use(requireSystemAdmin)` 之后，设置 `Cache-Control: private, no-store`，所有 body/query 由共享 Zod Schema 严格解析。

- [ ] **步骤 3：运行 HTTP 测试确认通过**

运行：

```bash
node --env-file-if-exists=.env --import tsx --test server/tests/adminPermanentDeletionService.test.ts
```

预期：PASS，管理员权限和请求校验用例通过。

- [ ] **步骤 4：提交 API**

```bash
git add server/src/routes/systemAdministration.ts server/tests/adminPermanentDeletionService.test.ts
git commit -m "feat: expose admin permanent deletion api"
```

### 任务 5：实现后台三次确认界面

**文件：**
- 创建：`src/components/AdminPermanentDeletionPanel.tsx`
- 修改：`src/lib/systemWorkspaces.ts`
- 修改：`src/pages/SystemPage.tsx`
- 创建：`server/tests/adminPermanentDeletionUi.test.tsx`

- [ ] **步骤 1：编写失败的 UI 静态和交互测试**

测试断言系统工作区包含 `permanent-deletion`，面板导入固定风险文本，第一次确认前名称输入不可见，第二次名称匹配前风险输入不可见，第三次文本完全匹配前“永久删除”按钮禁用。

```ts
assert.match(source, /我确认继续/)
assert.match(source, /resourceName === selected\.name/)
assert.match(source, /riskText === ADMIN_PERMANENT_DELETION_RISK_TEXT/)
assert.match(source, /永久删除/)
```

- [ ] **步骤 2：运行 UI 测试并确认失败**

运行：

```bash
node --import tsx --test server/tests/adminPermanentDeletionUi.test.tsx
```

预期：FAIL，面板文件和工作区标签尚不存在。

- [ ] **步骤 3：实现删除中心列表和影响预览**

面板提供“项目池线索 / 正式项目 / 知识库”选择、名称或 ID 搜索、20 条以内结果和“查看删除影响”按钮。选中结果后调用预览接口，展示关联计数、共享文件说明和阻断原因；存在 blocker 时不显示确认入口。

- [ ] **步骤 4：实现三步确认向导**

第一步按钮只推进本地步骤；第二步输入完整名称并精确匹配；第三步输入固定风险文本。最终请求只由第三步触发，提交期间禁用关闭、返回和重复提交。成功后清空搜索、关闭向导并刷新结果；冲突或令牌过期时清除确认状态并要求重新预览。

- [ ] **步骤 5：接入系统管理页面**

在 `systemWorkspaces` 的独立 `danger-zone` 工作区中加入 `permanent-deletion`，标签显示“数据彻底删除”。`SystemPage` 只在该标签渲染面板，不把删除状态混入组织、规则或审计页面状态。

- [ ] **步骤 6：运行 UI 测试和类型检查**

运行：

```bash
node --import tsx --test server/tests/adminPermanentDeletionUi.test.tsx
npm run check:types
```

预期：UI 测试 PASS；TypeScript 零错误。

- [ ] **步骤 7：提交管理界面**

```bash
git add src/components/AdminPermanentDeletionPanel.tsx src/lib/systemWorkspaces.ts src/pages/SystemPage.tsx server/tests/adminPermanentDeletionUi.test.tsx
git commit -m "feat: add admin permanent deletion center"
```

### 任务 6：补齐迁移边界和整体验收

**文件：**
- 修改：`server/src/scripts/checkSingleServiceBoundary.ts`
- 修改：`server/tests/adminPermanentDeletionService.test.ts`

- [ ] **步骤 1：增加迁移与路由边界断言**

静态检查必须确认 0113 已进入迁移清单、永久删除路由位于 `requireSystemAdmin` 之后、服务使用参数化查询、风险确认常量只定义一次，以及旧的项目/线索软删除接口没有改成物理删除。

- [ ] **步骤 2：运行直接相关测试**

运行：

```bash
node --env-file-if-exists=.env --import tsx --test server/tests/adminPermanentDeletionContract.test.ts server/tests/adminPermanentDeletionService.test.ts server/tests/adminPermanentDeletionUi.test.tsx
```

预期：全部 PASS，零跳过、零失败。

- [ ] **步骤 3：运行类型、平台门禁和构建**

运行：

```bash
npm run check:types
npm run check:platform
npm run build
```

预期：三个命令退出码均为 0。若 4100 正在运行，构建可以报告候选构建已生成且活动服务被保留，这不等于本地已激活。

- [ ] **步骤 4：检查补丁和迁移范围**

运行：

```bash
git diff --check HEAD~5..HEAD
git status --short
```

预期：无空白错误；状态中不包含 `.env`、运行文件、用户材料或无关修改。

- [ ] **步骤 5：提交最终边界检查**

```bash
git add server/src/scripts/checkSingleServiceBoundary.ts server/tests/adminPermanentDeletionService.test.ts
git commit -m "test: verify permanent deletion boundaries"
```

### 任务 7：本地启用和真实浏览器验收

**文件：**
- 无源码修改。

- [ ] **步骤 1：在隔离测试库准备三类测试对象**

使用测试夹具创建一个未转换线索、一个带专属文件的正式项目、一个带评论和微信关联的知识条目。记录 ID 和关联计数，不使用现有业务对象。

- [ ] **步骤 2：启动本地 Node 22 开发服务**

运行：

```bash
npm run dev
```

预期：前端监听 `127.0.0.1:5173`，API 监听 `127.0.0.1:4100`，`/api/health/components` 返回 200。

- [ ] **步骤 3：使用系统管理员完成三类删除**

逐个验证第一次确认、名称确认和固定文本确认。确认删除后搜索结果消失、直接详情 URL 返回 404、专属关联数据归零、共享文件仍存在、删除审计可见。

- [ ] **步骤 4：验证普通用户不可访问**

普通用户看不到“数据彻底删除”入口；直接请求搜索、预览和执行接口均返回 403。

- [ ] **步骤 5：清理隔离夹具并记录验收结果**

只清理本任务创建的隔离数据和临时文件。不得对共享业务库执行真实永久删除。生产部署、迁移和真实数据删除必须另行获得用户授权。
