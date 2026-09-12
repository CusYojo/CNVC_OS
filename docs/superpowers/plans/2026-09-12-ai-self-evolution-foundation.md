# AI 自进化基础闭环实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 在现有智能助手中实现可持久化、可恢复、可审阅的代码进化候选闭环，并安全兼容服务器残留表。

**架构：** 浏览器通过共享契约调用受鉴权的 Express 路由；业务服务通过 MySQL repository 保存提案、运行、事件、候选和评估；宿主协调器用租约领取运行并调用受限代码执行适配器。候选构建只写入任务专属输出目录，不触碰正式构建指针。

**技术栈：** React 18、TypeScript、Express 5、Drizzle ORM、MySQL、Node test runner、Vite。

---

## 文件结构

- 创建 `server/src/contracts/aiEvolutionContract.ts`：共享枚举、DTO、状态迁移和输入限制。
- 创建 `server/tests/aiEvolutionContract.test.ts`：状态机和不可信输入契约测试。
- 修改 `server/src/db/schema.ts`：导出进化领域表模型。
- 创建 `server/drizzle/0111_add_ai_evolution_foundation.sql`：当前分支上的追加迁移。
- 修改 `server/drizzle/meta/_journal.json`：登记 0111 迁移。
- 创建 `server/src/scripts/auditAiEvolutionSchema.ts`：残留表只读结构审计。
- 创建 `server/tests/aiEvolutionSchemaAudit.test.ts`：一致、可补齐、阻塞三类审计测试。
- 创建 `server/src/repositories/mysql/mysqlAiEvolutionRepository.ts`：提案、运行、事件、租约和候选事务。
- 创建 `server/tests/mysqlAiEvolutionRepository.test.ts`：SQL 边界、幂等和租约令牌测试。
- 创建 `server/src/services/aiEvolutionPolicyService.ts`：身份、对象范围、预算和仓库授权策略。
- 创建 `server/src/services/aiEvolutionService.ts`：提案编辑、冻结执行、取消和读取编排。
- 创建 `server/tests/aiEvolutionService.test.ts`：业务状态与权限测试。
- 创建 `server/src/routes/aiEvolution.ts`：HTTP API。
- 修改 `server/src/index.ts`：挂载路由并启动协调器。
- 创建 `server/tests/aiEvolutionRoutes.test.ts`：会话、Origin、CSRF、幂等和越权测试。
- 创建 `server/src/runtime/evolution/evolutionCoordinator.ts`：租约、心跳、恢复和结果接收。
- 创建 `server/src/runtime/evolution/codeEvolutionExecutor.ts`：受限源码任务执行接口。
- 创建 `server/src/runtime/evolution/candidateBuild.ts`：纯候选构建与清单哈希。
- 创建 `server/tests/aiEvolutionCoordinator.test.ts`：陈旧结果、重启、取消和预算测试。
- 创建 `server/tests/aiEvolutionCandidateBuild.test.ts`：输出路径与不激活测试。
- 创建 `src/hooks/useAiEvolution.ts`：请求、事件补拉和去重。
- 创建 `src/components/ai-evolution/AiEvolutionWorkbench.tsx`：工作台与筛选。
- 创建 `src/components/ai-evolution/EvolutionProposalCard.tsx`：聊天内提案卡。
- 创建 `src/components/ai-evolution/ai-evolution.css`：桌面和窄屏布局。
- 修改 `src/pages/AIAssistantPage.tsx`：挂载入口、卡片和右侧工作台。
- 创建 `server/tests/aiEvolutionUi.test.tsx`：UI 静态契约与恢复测试。
- 修改 `package.json`：增加只读审计和基础闭环验收脚本。

### 任务 1：共享契约和状态机

**文件：**
- 创建：`server/src/contracts/aiEvolutionContract.ts`
- 测试：`server/tests/aiEvolutionContract.test.ts`

- [ ] **步骤 1：编写失败的状态机测试**

```ts
assert.equal(canTransitionProposal('draft', 'ready'), true)
assert.equal(canTransitionProposal('approved', 'draft'), false)
assert.equal(canTransitionRun('executing', 'cancelled'), false)
assert.equal(canTransitionRun('executing', 'evaluating'), true)
assert.equal(canTransitionRelease('awaiting_approval', 'active'), false)
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --import tsx --test server/tests/aiEvolutionContract.test.ts`
预期：FAIL，模块 `aiEvolutionContract.js` 不存在。

- [ ] **步骤 3：实现最小共享契约**

```ts
export type EvolutionKind = 'experience' | 'skill' | 'code'
export type ProposalStatus = 'draft' | 'needs_input' | 'ready' | 'approved' | 'rejected' | 'superseded'
export type RunStatus = 'queued' | 'preparing' | 'executing' | 'evaluating' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
export type ReleaseStatus = 'candidate' | 'awaiting_approval' | 'approved' | 'activating' | 'active' | 'failed' | 'rolled_back' | 'retired'
export interface EvolutionProposalSpec {
  kind: EvolutionKind
  objective: string
  acceptanceCriteria: string[]
  businessProjectId?: string
  repositoryId?: string
  allowedPaths?: string[]
  budget: { maxSeconds: number; maxModelTokens: number; maxRepairRounds: number }
}
```

用常量映射实现三个 `canTransition*` 函数；执行状态不允许从执行中直接变为已取消，必须由停止确认路径完成。

- [ ] **步骤 4：运行契约测试**

运行：`node --import tsx --test server/tests/aiEvolutionContract.test.ts`
预期：PASS，全部状态和长度边界断言通过。

- [ ] **步骤 5：提交**

```bash
git add server/src/contracts/aiEvolutionContract.ts server/tests/aiEvolutionContract.test.ts
git commit -m "feat: define AI evolution contracts"
```

### 任务 2：模型、追加迁移和残留表审计

**文件：**
- 修改：`server/src/db/schema.ts`
- 创建：`server/drizzle/0111_add_ai_evolution_foundation.sql`
- 修改：`server/drizzle/meta/_journal.json`
- 创建：`server/src/scripts/auditAiEvolutionSchema.ts`
- 测试：`server/tests/aiEvolutionSchemaAudit.test.ts`
- 修改：`package.json`

- [ ] **步骤 1：编写失败的审计分类测试**

```ts
assert.equal(classifyEvolutionSchema(expected, expected).status, 'compatible')
assert.equal(classifyEvolutionSchema(expected, withoutOptionalIndex).status, 'repairable')
assert.equal(classifyEvolutionSchema(expected, withWrongPrimaryKey).status, 'blocked')
assert.equal(classifyEvolutionSchema(expected, withNarrowerColumn).status, 'blocked')
```

- [ ] **步骤 2：确认测试失败**

运行：`node --import tsx --test server/tests/aiEvolutionSchemaAudit.test.ts`
预期：FAIL，审计模块不存在。

- [ ] **步骤 3：定义当前基础表**

迁移创建 `ai_evolution_proposals`、`ai_evolution_runs`、`ai_evolution_events`、`ai_evolution_audits`、`ai_evolution_model_calls`、`ai_evolution_candidates`、`ai_evolution_evaluations` 和 `ai_evolution_approvals`。表名通过运行时前缀规则解析；SQL 不包含 `DROP`、`TRUNCATE`、业务数据 `DELETE` 或启动时自动迁移。

`runs` 必须包含 `attempt`、`lease_token`、`lease_owner`、`lease_expires_at`、`budget`、`checkpoint`、`cancel_requested_at` 和 `next_event_sequence`；结果关联字段必须能验证输入哈希和令牌。

- [ ] **步骤 4：实现只读审计**

```ts
export type SchemaAuditStatus = 'compatible' | 'repairable' | 'blocked'
export function classifyEvolutionSchema(expected: SchemaShape, actual: SchemaShape): SchemaAuditResult
```

脚本只查询 `information_schema.tables`、`columns`、`statistics` 和 `referential_constraints`，输出脱敏 JSON；缺表或缺少非破坏索引为 `repairable`，主键、类型收窄、外键目标冲突为 `blocked`。

- [ ] **步骤 5：运行迁移与审计测试**

运行：`node --import tsx --test server/tests/aiEvolutionSchemaAudit.test.ts`
预期：PASS，并断言迁移没有破坏性 SQL。

运行：`npm run check:migration-checklist-status`
预期：PASS，journal 文件与迁移文件一致。

- [ ] **步骤 6：提交**

```bash
git add server/src/db/schema.ts server/drizzle/0111_add_ai_evolution_foundation.sql server/drizzle/meta/_journal.json server/src/scripts/auditAiEvolutionSchema.ts server/tests/aiEvolutionSchemaAudit.test.ts package.json
git commit -m "feat: add non-destructive evolution schema migration"
```

### 任务 3：Repository 的幂等、乐观锁和租约

**文件：**
- 创建：`server/src/repositories/mysql/mysqlAiEvolutionRepository.ts`
- 测试：`server/tests/mysqlAiEvolutionRepository.test.ts`

- [ ] **步骤 1：编写失败的 repository 测试**

```ts
await repository.createProposal(owner, key, hash, spec)
await assert.rejects(() => repository.createProposal(owner, key, differentHash, otherSpec), IdempotencyConflictError)
const lease = await repository.claimNextRun('host-a', now, leaseUntil)
assert.equal(lease.leaseToken, 1)
assert.equal(await repository.acceptResult(lease.runId, lease.attempt, 0, lease.inputHash, result), false)
assert.equal(await repository.acceptResult(lease.runId, lease.attempt, 1, lease.inputHash, result), true)
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --import tsx --test server/tests/mysqlAiEvolutionRepository.test.ts`
预期：FAIL，repository 模块不存在。

- [ ] **步骤 3：实现事务边界**

实现：相同 owner/key/hash 返回原记录；相同 key 不同 hash 抛冲突；编辑使用 `WHERE id=? AND revision=?`；领取运行在事务内更新 lease token；事件序列在同一事务内递增；候选结果必须匹配 run、attempt、lease token 和 input hash。

- [ ] **步骤 4：运行 repository 测试**

运行：`node --import tsx --test server/tests/mysqlAiEvolutionRepository.test.ts`
预期：PASS，且测试验证所有值通过参数绑定，不拼接用户输入。

- [ ] **步骤 5：提交**

```bash
git add server/src/repositories/mysql/mysqlAiEvolutionRepository.ts server/tests/mysqlAiEvolutionRepository.test.ts
git commit -m "feat: persist evolution runs with fencing leases"
```

### 任务 4：策略、业务服务和 HTTP API

**文件：**
- 创建：`server/src/services/aiEvolutionPolicyService.ts`
- 创建：`server/src/services/aiEvolutionService.ts`
- 创建：`server/src/routes/aiEvolution.ts`
- 修改：`server/src/index.ts`
- 测试：`server/tests/aiEvolutionService.test.ts`
- 测试：`server/tests/aiEvolutionRoutes.test.ts`

- [ ] **步骤 1：编写失败的权限和幂等 API 测试**

```ts
assert.equal(await policy.canReadProposal(ownerSession, ownerProposal), true)
assert.equal(await policy.canReadProposal(otherSession, ownerProposal), false)
assert.equal((await postProposal({ idempotencyKey: 'k1', body })).status, 201)
assert.equal((await postProposal({ idempotencyKey: 'k1', body })).status, 200)
assert.equal((await postProposal({ idempotencyKey: 'k1', body: changed })).status, 409)
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --import tsx --test server/tests/aiEvolutionService.test.ts server/tests/aiEvolutionRoutes.test.ts`
预期：FAIL，服务和路由不存在。

- [ ] **步骤 3：实现策略和服务**

策略从服务端 session、项目权限和登记仓库授权判定范围；代码任务无 `repositoryId` 或授权路径时进入 `needs_input`。服务实现创建、列表、expectedRevision 编辑、冻结执行、持久取消、运行和事件读取。冻结后保存不可变 spec 与 input hash。

- [ ] **步骤 4：实现路由**

实现计划文档中的 proposals、runs、events、cancel、candidates、approve 和 reject 路由。所有写请求沿用现有 CSRF/Origin 中间件，列表采用有界游标分页，错误返回现有 `{ code, message, details, requestId }` 契约。

- [ ] **步骤 5：运行服务和路由测试**

运行：`node --import tsx --test server/tests/aiEvolutionService.test.ts server/tests/aiEvolutionRoutes.test.ts`
预期：PASS，跨用户读取事件和候选均返回 403/404 的现有安全语义。

- [ ] **步骤 6：提交**

```bash
git add server/src/services/aiEvolutionPolicyService.ts server/src/services/aiEvolutionService.ts server/src/routes/aiEvolution.ts server/src/index.ts server/tests/aiEvolutionService.test.ts server/tests/aiEvolutionRoutes.test.ts
git commit -m "feat: add controlled evolution proposal API"
```

### 任务 5：协调器、取消、预算和陈旧结果拒收

**文件：**
- 创建：`server/src/runtime/evolution/evolutionCoordinator.ts`
- 创建：`server/src/runtime/evolution/codeEvolutionExecutor.ts`
- 测试：`server/tests/aiEvolutionCoordinator.test.ts`

- [ ] **步骤 1：编写失败的协调器测试**

```ts
await coordinator.tick()
assert.equal(executor.starts.length, 1)
clock.advance(leaseMs + 1)
await coordinator.recoverExpiredRuns()
assert.equal(await staleExecutor.submitResult(), 'rejected')
await service.requestCancel(runId, owner)
await coordinator.tick()
assert.equal(executor.abortSignals.at(-1)?.aborted, true)
assert.equal((await repository.getRun(runId)).status, 'cancelled')
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --import tsx --test server/tests/aiEvolutionCoordinator.test.ts`
预期：FAIL，协调器不存在。

- [ ] **步骤 3：实现执行协议和协调器**

`CodeEvolutionExecutor` 只接收授权源码快照、允许路径、任务目录、预算和 AbortSignal，返回补丁、日志摘要和产物引用。协调器领取、续租、按阶段持久化检查点，预算累计不随修复轮次归零；同一错误无有效变化时终止。

- [ ] **步骤 4：运行协调器测试**

运行：`node --import tsx --test server/tests/aiEvolutionCoordinator.test.ts`
预期：PASS，覆盖服务重启、租约过期、旧 token、取消宽限期和三轮修复上限。

- [ ] **步骤 5：提交**

```bash
git add server/src/runtime/evolution/evolutionCoordinator.ts server/src/runtime/evolution/codeEvolutionExecutor.ts server/tests/aiEvolutionCoordinator.test.ts
git commit -m "feat: coordinate recoverable evolution execution"
```

### 任务 6：纯候选构建、独立评估和产物清单

**文件：**
- 创建：`server/src/runtime/evolution/candidateBuild.ts`
- 创建：`server/src/services/aiEvolutionEvaluationService.ts`
- 测试：`server/tests/aiEvolutionCandidateBuild.test.ts`

- [ ] **步骤 1：编写失败的候选构建测试**

```ts
const before = await readActiveBuildPointer()
const result = await buildCandidate({ sourceRoot, outputRoot: taskOutput, baseCommit })
assert.equal(await readActiveBuildPointer(), before)
assert.equal(result.manifest.baseCommit, baseCommit)
assert.match(result.manifest.patchHash, /^[a-f0-9]{64}$/)
await assert.rejects(() => buildCandidate({ sourceRoot, outputRoot: activeRoot, baseCommit }))
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --import tsx --test server/tests/aiEvolutionCandidateBuild.test.ts`
预期：FAIL，候选构建模块不存在。

- [ ] **步骤 3：实现纯候选构建与评估**

输出根必须解析到任务工作区内部且不能等于正式或候选激活目录。清单记录 base commit、patch/candidate/lock/build 参数/Web/服务端产物哈希、测试报告和预览元数据。评估器从平台固定目录读取验收，不接受执行器传入测试路径。

- [ ] **步骤 4：运行构建测试**

运行：`node --import tsx --test server/tests/aiEvolutionCandidateBuild.test.ts`
预期：PASS，模拟正式端口空闲和占用时活动指针均不变化。

- [ ] **步骤 5：提交**

```bash
git add server/src/runtime/evolution/candidateBuild.ts server/src/services/aiEvolutionEvaluationService.ts server/tests/aiEvolutionCandidateBuild.test.ts
git commit -m "feat: build isolated evolution candidates"
```

### 任务 7：助手入口和自进化工作台

**文件：**
- 创建：`src/hooks/useAiEvolution.ts`
- 创建：`src/components/ai-evolution/AiEvolutionWorkbench.tsx`
- 创建：`src/components/ai-evolution/EvolutionProposalCard.tsx`
- 创建：`src/components/ai-evolution/ai-evolution.css`
- 修改：`src/pages/AIAssistantPage.tsx`
- 测试：`server/tests/aiEvolutionUi.test.tsx`

- [ ] **步骤 1：编写失败的 UI 契约测试**

```ts
assert.match(workbenchSource, /待处理/)
assert.match(workbenchSource, /进行中/)
assert.match(workbenchSource, /已生效/)
assert.match(workbenchSource, /历史/)
assert.match(hookSource, /afterSequence/)
assert.match(hookSource, /lastSequence/)
assert.match(styles, /@media.*max-width/s)
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --import tsx --test server/tests/aiEvolutionUi.test.tsx`
预期：FAIL，组件和 hook 不存在。

- [ ] **步骤 3：实现 hook 和 UI**

hook 首次加载运行快照，再用 `afterSequence` 补拉；按 sequence 去重且发现缺口时重新补拉。工作台提供交付物/自进化切换、状态和类型过滤、提案修改/执行/拒绝/稍后处理、候选差异和评估证据。小屏改为抽屉且不卸载聊天状态。

- [ ] **步骤 4：运行 UI 与类型检查**

运行：`node --import tsx --test server/tests/aiEvolutionUi.test.tsx`
预期：PASS。

运行：`npm run check:types`
预期：PASS，无 TypeScript 错误。

- [ ] **步骤 5：提交**

```bash
git add src/hooks/useAiEvolution.ts src/components/ai-evolution/AiEvolutionWorkbench.tsx src/components/ai-evolution/EvolutionProposalCard.tsx src/components/ai-evolution/ai-evolution.css src/pages/AIAssistantPage.tsx server/tests/aiEvolutionUi.test.tsx
git commit -m "feat: add AI evolution workbench"
```

### 任务 8：基础闭环验收与服务器迁移预检

**文件：**
- 创建：`server/src/scripts/aiEvolutionFoundationAcceptance.ts`
- 修改：`package.json`
- 创建：`docs/acceptance/ai-evolution-foundation.md`

- [ ] **步骤 1：实现聚合验收脚本**

脚本依次执行 AT-01～AT-10、AT-15 和 AT-18 的可自动化部分，输出每项 `PASS`、`FAIL`、`BLOCKED`、`NOT_RUN` 或 `SKIPPED` 及证据路径；任何 FAIL 以非零退出。

- [ ] **步骤 2：运行基础测试**

运行：`node --import tsx --test server/tests/aiEvolution*.test.ts server/tests/mysqlAiEvolutionRepository.test.ts`
预期：PASS，0 failures。

- [ ] **步骤 3：运行平台门禁**

运行：`npm run check:types`
预期：PASS。

运行：`npm run check:platform`
预期：PASS；若已有基线问题，必须记录完整命令、失败项和与本次补丁的关系，不能改弱门禁。

- [ ] **步骤 4：运行本地只读结构审计**

运行：`npm run audit:ai-evolution-schema`
预期：输出 `compatible` 或 `repairable`；`blocked` 时停止，不执行迁移。

- [ ] **步骤 5：生成服务器操作清单但不写库**

在验收文档记录目标库脱敏标识、`DB_FREFIX`、残留表分类、备份命令、迁移预览命令、回退依据和需要人工处理的差异。未获得部署授权时将服务器迁移标为 `NOT_RUN`。

- [ ] **步骤 6：提交**

```bash
git add server/src/scripts/aiEvolutionFoundationAcceptance.ts package.json docs/acceptance/ai-evolution-foundation.md
git commit -m "test: verify AI evolution foundation"
```

## 后续独立计划

基础闭环通过后，再分别编写并执行以下计划，以保持每个计划可独立交付：

1. 经验版本、冲突解析、聊天与专业任务快照（EVO-11/12，AT-11～13）。
2. 技能候选、基线对比、试用指针与回退（EVO-13，AT-14）。
3. 发布任务、回退、反馈观察、成本与清理（EVO-14～16，AT-16/17）。
