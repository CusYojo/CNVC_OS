# 投资流程“尽调”阶段统一命名实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 FDE 投资流程的正式阶段值“启动尽调”全量统一为“尽调”，并迁移测试库既有数据。

**架构：** 应用层以“尽调”作为 FDE 阶段唯一枚举值，流程服务据此计算相邻阶段、审批类型与进度。新增追加式 MySQL 迁移，发布替换了阶段名的策略版本，并同步 FDE 项目、审批请求、材料、阶段日期和时间线任务的精确阶段值，不修改审批状态、意见与审批人。

**技术栈：** React、TypeScript、Node.js、Drizzle ORM、MySQL、Node test runner。

---

## 文件结构

- 修改：`src/types/index.ts`、`src/pages/WorkflowPage.tsx`、`src/pages/ProjectsPage.tsx`、`src/components/FdeWorkflowPanel.tsx`、`src/components/ui.tsx` — 前端枚举和文案。
- 修改：`server/src/contracts/fdeWorkflowPolicyContract.ts`、`server/src/contracts/fdeAgentScheduleContract.ts`、`server/src/contracts/fdeProjectAgentContract.ts`、`server/src/contracts/fdeTimelineTimeContract.ts`、`server/src/contracts/fdeTimelineTaskContract.ts` — FDE 规则与时间线。
- 修改：`server/src/routes/oa.ts`、`server/src/services/oaWorkflowService.ts`、`server/src/services/fdeMaterialService.ts` — 请求校验、流转和材料权限。
- 修改：`server/tests/fdeWorkflowPolicy.test.ts`、`server/tests/fdeAgentScheduleContract.test.ts`、`server/tests/fdeTimelineTaskContract.test.ts`、`server/tests/fdeTimelineTimeContract.test.ts` 及 FDE 验收脚本 — 回归覆盖。
- 创建：`server/drizzle/0115_rename_fde_due_diligence_stage.sql`；修改：`server/drizzle/meta/_journal.json` — 数据迁移与登记。

### 任务 1：建立名称变更回归测试

**文件：**
- 修改：`server/tests/fdeWorkflowPolicy.test.ts`
- 修改：`server/tests/fdeAgentScheduleContract.test.ts`
- 修改：`server/tests/fdeTimelineTaskContract.test.ts`
- 修改：`server/tests/fdeTimelineTimeContract.test.ts`

- [ ] **步骤 1：将策略测试期望更新为“尽调”**

```ts
assert.deepEqual(policy.stages.map((item) => item.stage), [
  '入库', '立项', '尽调计划制定', '尽调计划审核', '尽调', '内核', '投决', '打款',
])
assert.equal(policy.stages.find((item) => item.stage === '尽调')?.approvals[0]?.duty, 'boss')
```

- [ ] **步骤 2：运行测试确认现有常量仍失败**

运行：`node --import tsx --test server/tests/fdeWorkflowPolicy.test.ts server/tests/fdeAgentScheduleContract.test.ts server/tests/fdeTimelineTaskContract.test.ts server/tests/fdeTimelineTimeContract.test.ts`

预期：FAIL，断言仍收到“启动尽调”。

- [ ] **步骤 3：将时间线测试输入改为“尽调”**

```ts
const items = timelineTaskProposals('尽调', '2026-09-10', materials, true)
for (const stage of ['尽调', '内核', '投决', '打款']) {
  assert.deepEqual(timelineLeaderDuties(stage), ['chairman', 'president'])
}
```

- [ ] **步骤 4：运行并记录失败位置**

运行：`node --import tsx --test server/tests/fdeWorkflowPolicy.test.ts server/tests/fdeAgentScheduleContract.test.ts server/tests/fdeTimelineTaskContract.test.ts server/tests/fdeTimelineTimeContract.test.ts`

预期：FAIL，仅因待替换的 FDE 阶段常量失败。

- [ ] **步骤 5：提交测试基线**

```bash
git add server/tests/fdeWorkflowPolicy.test.ts server/tests/fdeAgentScheduleContract.test.ts server/tests/fdeTimelineTaskContract.test.ts server/tests/fdeTimelineTimeContract.test.ts
git commit -m "test: cover FDE due diligence stage rename"
```

### 任务 2：统一前后端常量与审批路由

**文件：**
- 修改：`src/types/index.ts`、`src/pages/WorkflowPage.tsx`、`src/pages/ProjectsPage.tsx`、`src/components/FdeWorkflowPanel.tsx`、`src/components/ui.tsx`
- 修改：`server/src/contracts/fdeWorkflowPolicyContract.ts`、`server/src/contracts/fdeAgentScheduleContract.ts`、`server/src/contracts/fdeProjectAgentContract.ts`、`server/src/contracts/fdeTimelineTimeContract.ts`、`server/src/contracts/fdeTimelineTaskContract.ts`
- 修改：`server/src/routes/oa.ts`、`server/src/services/oaWorkflowService.ts`、`server/src/services/fdeMaterialService.ts`

- [ ] **步骤 1：把 FDE 阶段数组中的正式值替换为“尽调”**

```ts
const fdeProjectStages = ['入库', '立项', '尽调计划制定', '尽调计划审核', '尽调', '内核', '投决', '打款', '已 Close'] as const
const planRequired = ['尽调计划审核', '尽调', '内核', '投决', '打款'].includes(stage)
```

- [ ] **步骤 2：更新流程页面相邻阶段说明**

```ts
['计划审核 → 尽调', '董事长/总裁审批（任意一人）'],
['尽调 → 内核', '董事长/总裁审批（任意一人）'],
```

- [ ] **步骤 3：更新流转、提交目标和进度**

```ts
if (fromStage === '尽调计划审核' && targetStage === '尽调') return '尽调启动审批'
if (fromStage === '尽调' && targetStage === '内核') return '内核审批'
const targetStage = isPlanSubmission ? '尽调' : input.targetStage
const seniorStages = ['尽调', '内核', '投决', '打款']
```

- [ ] **步骤 4：更新材料策略、时间线和项目进度中的阶段键**

```ts
{ stage: '尽调', materials: [{ key: 'business_dd', label: '业务尽调材料' }] }
const positions: Record<string, number> = { 入库: 0, 立项: .10, 尽调计划制定: .18, 尽调计划审核: .22, 尽调: .58, 内核: .75, 投决: .90, 打款: 1 }
```

- [ ] **步骤 5：搜索确认流程引用均已替换**

运行：`rg -n "启动尽调" src server/src server/tests -g '*.{ts,tsx}'`

预期：FDE 流程、路由、服务和测试不再包含该阶段值；AI 语义过滤和提示词中的自然语言可保留。

- [ ] **步骤 6：运行任务 1 测试确认通过**

运行：`node --import tsx --test server/tests/fdeWorkflowPolicy.test.ts server/tests/fdeAgentScheduleContract.test.ts server/tests/fdeTimelineTaskContract.test.ts server/tests/fdeTimelineTimeContract.test.ts`

预期：PASS，所有子测试通过。

- [ ] **步骤 7：提交应用层重命名**

```bash
git add src server/src server/tests
git commit -m "feat: rename FDE due diligence stage"
```

### 任务 3：迁移策略版本与测试库数据

**文件：**
- 创建：`server/drizzle/0115_rename_fde_due_diligence_stage.sql`
- 修改：`server/drizzle/meta/_journal.json`

- [ ] **步骤 1：创建策略版本 0115**

```sql
INSERT INTO sbl_fde_workflow_policy_versions
  (id, policy_id, revision, status, configuration, sha256, reason, version, created_by, published_by, published_at)
SELECT 'b236f88b-7154-4551-a6f5-000000000115', policy_id, revision + 1, 'published',
  REPLACE(configuration, '启动尽调', '尽调'), SHA2(REPLACE(configuration, '启动尽调', '尽调'), 256),
  '统一 FDE 尽调阶段名称', version + 1, created_by, published_by, CURRENT_TIMESTAMP(3)
FROM sbl_fde_workflow_policy_versions WHERE id = 'b236f88b-7154-4551-a6f5-000000000114';
```

- [ ] **步骤 2：切换活跃策略和所有 FDE 投资项目的策略版本**

```sql
UPDATE sbl_fde_workflow_policies
SET active_version_id = 'b236f88b-7154-4551-a6f5-000000000115', next_revision = next_revision + 1
WHERE id = 'b236f88b-7154-4551-a6f5-000000000001';
--> statement-breakpoint
UPDATE sbl_projects SET workflow_policy_version_id = 'b236f88b-7154-4551-a6f5-000000000115'
WHERE workflow_model = 'fde-v1' AND project_type = '投资项目';
```

- [ ] **步骤 3：精确更新所有阶段字段**

```sql
UPDATE sbl_projects SET stage = '尽调' WHERE workflow_model = 'fde-v1' AND stage = '启动尽调';
--> statement-breakpoint
UPDATE sbl_oa_approval_requests SET from_stage = '尽调' WHERE from_stage = '启动尽调';
--> statement-breakpoint
UPDATE sbl_oa_approval_requests SET target_stage = '尽调' WHERE target_stage = '启动尽调';
```

对 `sbl_project_stage_materials`、`sbl_project_stage_dates`、`sbl_project_timeline_tasks`、`sbl_project_timeline_syncs` 采用相同的精确条件。每条 SQL 间写入 `--> statement-breakpoint`；不更新状态、意见、审批人或时间戳。

- [ ] **步骤 4：登记 0115 迁移**

```json
{ "idx": 103, "version": "7", "when": 1793346545000, "tag": "0115_rename_fde_due_diligence_stage", "breakpoints": true }
```

- [ ] **步骤 5：执行迁移并验证数据库**

运行：`node --env-file='C:\Users\21749\Desktop\project\conversation-experience-memory\.env' --import tsx server/src/scripts/migrateMySqlSchema.ts`

预期：exit 0，输出 `schema migrations ready`。以一次性只读查询验证活动版本为 `...000115`，并确认 FDE 项目及上述阶段数据表中 `启动尽调` 计数为 0。

- [ ] **步骤 6：提交迁移**

```bash
git add server/drizzle/0115_rename_fde_due_diligence_stage.sql server/drizzle/meta/_journal.json
git commit -m "feat: migrate FDE due diligence stage name"
```

### 任务 4：验收与交付验证

**文件：**
- 修改：`server/src/scripts/fdeWorkflowAcceptance.ts`、`server/src/scripts/fdeTimelineEventAcceptance.ts`、`server/src/scripts/fdeTimelineTaskAcceptance.ts`、`server/src/scripts/fdeTimelineTimeAcceptance.ts`

- [ ] **步骤 1：将验收脚本中的阶段值与断言改为“尽调”**

```ts
assert.equal(request.targetStage, '尽调')
assert.equal(project.stage, targetStage === '尽调计划审核' ? '尽调' : targetStage)
await db.update(projects).set({ stage: '尽调' }).where(eq(projects.id, project.id))
```

- [ ] **步骤 2：执行 FDE 流程和时间线验收**

运行：`node --env-file='C:\Users\21749\Desktop\project\conversation-experience-memory\.env' --import tsx server/src/scripts/fdeWorkflowAcceptance.ts; node --env-file='C:\Users\21749\Desktop\project\conversation-experience-memory\.env' --import tsx server/src/scripts/fdeTimelineEventAcceptance.ts; node --env-file='C:\Users\21749\Desktop\project\conversation-experience-memory\.env' --import tsx server/src/scripts/fdeTimelineTaskAcceptance.ts; node --env-file='C:\Users\21749\Desktop\project\conversation-experience-memory\.env' --import tsx server/src/scripts/fdeTimelineTimeAcceptance.ts`

预期：四个脚本均 exit 0，审批能从尽调计划审核进入尽调，并可由尽调进入内核。

- [ ] **步骤 3：执行类型检查与流程残留扫描**

运行：`npm run check:types; rg -n "启动尽调" src server/src server/tests server/drizzle -g '*.{ts,tsx,sql}'`

预期：类型检查 exit 0；仅保留 AI 自然语言提示/过滤，FDE 流程、迁移与测试中没有旧阶段值。

- [ ] **步骤 4：提交验收脚本更新**

```bash
git add server/src/scripts
git commit -m "test: verify renamed FDE due diligence flow"
```
