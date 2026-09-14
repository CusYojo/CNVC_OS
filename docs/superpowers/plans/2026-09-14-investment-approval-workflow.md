# 投资项目审批流程调整实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 FDE 投资项目流程改为项目组制定尽调计划、普通董事长/总裁或签、内核三类串行审批、投决双领导必签及打款财务审批。

**架构：** 保持 FDE 八阶段、OA 审批快照和治理职责表不变。在工作流策略契约中引入逻辑“老板”审批节点，并在服务端将其解析成项目配置的董事长/总裁人员。现有 OA 节点顺序继续表达跨职责串行，节点 `mode` 表达同职责内的或签/会签。

**技术栈：** React 18、TypeScript、Express 5、Drizzle ORM、MySQL、Node `tsx` 测试。

---

## 文件职责

- 修改：`server/src/contracts/fdeWorkflowPolicyContract.ts` — 定义八阶段的不可移除审批顺序与默认策略。
- 修改：`server/src/contracts/fdeGovernanceContract.ts` — 为策略层定义逻辑老板职责并保持项目治理持久化职责不变。
- 修改：`server/src/services/fdeGovernanceService.ts` — 将逻辑老板节点解析为启用的项目董事长/总裁，处理投决单角色必签与资格错误。
- 修改：`server/src/services/oaWorkflowService.ts` — 放开尽调计划阶段的项目组成员发起/重提权限，保留其他阶段负责人边界。
- 修改：`server/drizzle/0053_add_fde_workflow_policies.sql` — 使初始数据库策略与契约默认值一致；另新增迁移发布修订版策略供新项目采用。
- 创建：`server/drizzle/0114_update_investment_approval_workflow.sql` — 发布新版 FDE 策略版本，并将现有 FDE 投资项目切换到该版本；进行中的审批快照不变。
- 修改：`src/pages/WorkflowPage.tsx` — 显示真实审批链与“董事长/总裁或签”“投决两人必签”文案。
- 修改：`server/tests/fdeWorkflowPolicy.test.ts` — 锁定策略职责顺序、节点模式及不可变规则。
- 创建：`server/tests/fdeGovernanceApprovalNodes.test.ts` — 覆盖职责解析、普通老板或签和投决双角色节点。
- 创建：`server/tests/fdePlanTeamAccess.test.ts` — 覆盖项目组成员在尽调计划制定/提交阶段的访问规则。
- 修改：`server/src/scripts/oaWorkflowAcceptance.ts` — 增加真实服务端流程验收：串行节点、或签待办关闭、投决双签及项目组提交。

### 任务 1：锁定新版策略契约

**文件：**

- 修改：`server/tests/fdeWorkflowPolicy.test.ts`
- 修改：`server/src/contracts/fdeWorkflowPolicyContract.ts`

- [ ] **步骤 1：编写失败的默认策略测试**

在 `server/tests/fdeWorkflowPolicy.test.ts` 添加断言，要求审批职责和模式为：

```ts
assert.deepEqual(DEFAULT_FDE_WORKFLOW_POLICY.stages[1].approvals.map(node => [node.duty, node.mode]), [['boss', '或签']])
assert.deepEqual(DEFAULT_FDE_WORKFLOW_POLICY.stages[2].approvals, [])
assert.deepEqual(DEFAULT_FDE_WORKFLOW_POLICY.stages[3].approvals.map(node => [node.duty, node.mode]), [['boss', '或签']])
assert.deepEqual(DEFAULT_FDE_WORKFLOW_POLICY.stages[4].approvals.map(node => [node.duty, node.mode]), [['boss', '或签']])
assert.deepEqual(DEFAULT_FDE_WORKFLOW_POLICY.stages[5].approvals.map(node => [node.duty, node.mode]), [['finance', '或签'], ['legal', '或签'], ['boss', '或签']])
assert.deepEqual(DEFAULT_FDE_WORKFLOW_POLICY.stages[6].approvals.map(node => [node.duty, node.mode]), [['chairman', '会签'], ['president', '会签']])
assert.deepEqual(DEFAULT_FDE_WORKFLOW_POLICY.stages[7].approvals.map(node => [node.duty, node.mode]), [['finance', '或签']])
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --import tsx --test server/tests/fdeWorkflowPolicy.test.ts`

预期：FAIL，因当前策略仍使用 `concerned_leader`、`finance/legal` 等旧职责顺序。

- [ ] **步骤 3：实现最小策略类型与基线调整**

在 `fdeGovernanceContract.ts` 增加仅用于审批策略的联合类型，例如：

```ts
export type FdeApprovalDuty = FdeProjectDuty | 'boss'
```

将 `stageDuties` 改为：

```ts
const stageDuties: Record<string, FdeApprovalDuty[]> = {
  立项: ['boss'], 尽调计划制定: [], 尽调计划审核: ['boss'],
  启动尽调: ['boss'], 内核: ['finance', 'legal', 'boss'],
  投决: ['chairman', 'president'], 打款: ['finance'],
}
```

令 Zod 策略字段接收 `FdeApprovalDuty`；默认模式通过阶段/职责映射生成，`boss`、`finance`、`legal` 使用 `或签`，投决两个节点使用 `会签`。不要把 `boss` 写入 `project_duty_assignments`。

- [ ] **步骤 4：运行测试确认通过**

运行：`node --import tsx --test server/tests/fdeWorkflowPolicy.test.ts`

预期：PASS。

- [ ] **步骤 5：提交策略契约**

```bash
git add server/src/contracts/fdeGovernanceContract.ts server/src/contracts/fdeWorkflowPolicyContract.ts server/tests/fdeWorkflowPolicy.test.ts
git commit -m "feat: align investment approval policy"
```

### 任务 2：解析董事长/总裁或签与投决必签节点

**文件：**

- 创建：`server/tests/fdeGovernanceApprovalNodes.test.ts`
- 修改：`server/src/services/fdeGovernanceService.ts`

- [ ] **步骤 1：编写失败的节点解析测试**

使用事务测试夹具构造项目、董事长、总裁、财务和法务职责，测试：

```ts
const nodes = await resolveFdeApprovalNodes(tx, project, '内核', applicantId)
assert.deepEqual(nodes.map(node => [node.roleLabel, node.mode]), [
  ['财务复核', '或签'], ['法务/风控复核', '或签'], ['董事长/总裁审批', '或签'],
])
assert.deepEqual(nodes[2].approverUserIds.sort(), [chairmanId, presidentId].sort())

const decision = await resolveFdeApprovalNodes(tx, project, '投决', applicantId)
assert.deepEqual(decision.map(node => [node.roleLabel, node.mode, node.approverUserIds]), [
  ['董事长审批职责', '会签', [chairmanId]], ['总裁/计划审核职责', '会签', [presidentId]],
])
```

再断言：投决缺失董事长或总裁时抛出 `FDE_APPROVER_NOT_CONFIGURED`；普通 `boss` 节点缺失两者时同样失败；排除申请人后无审批人时失败。

- [ ] **步骤 2：运行测试确认失败**

运行：`node --env-file-if-exists=.env --import tsx --test server/tests/fdeGovernanceApprovalNodes.test.ts`

预期：FAIL，当前解析器无法识别 `boss`。

- [ ] **步骤 3：实现逻辑老板解析器**

在 `resolveFdeApprovalNodes` 中分支处理 `duty === 'boss'`：读取项目 `chairman` 与 `president` 绑定（按现有角色代码回退），合并、去重、排除申请人后返回：

```ts
{ name, mode: '或签', roleLabel: '董事长/总裁审批', roles: ['boss'], approverUserIds, approverNames }
```

保留 `chairman` 与 `president` 的既有独立解析，让投决仍生成两个串行节点。错误信息须显示“董事长/总裁审批”而非内部 `boss`。继续校验人员启用状态、FDE 类别和回退角色代码。

- [ ] **步骤 4：运行测试确认通过**

运行：`node --env-file-if-exists=.env --import tsx --test server/tests/fdeGovernanceApprovalNodes.test.ts`

预期：PASS。

- [ ] **步骤 5：提交节点解析**

```bash
git add server/src/services/fdeGovernanceService.ts server/tests/fdeGovernanceApprovalNodes.test.ts
git commit -m "feat: resolve investment leadership approval nodes"
```

### 任务 3：允许项目组成员制定与提交尽调计划

**文件：**

- 创建：`server/tests/fdePlanTeamAccess.test.ts`
- 修改：`server/src/services/oaWorkflowService.ts`
- 修改：`server/src/services/fdeWorkflowService.ts`（如计划保存入口也限制负责人）

- [ ] **步骤 1：编写失败的项目组访问测试**

创建一位不是 `ownerUserId` 的启用项目成员，并覆盖：

```ts
await assert.doesNotReject(() => createOaApprovalRequest({
  userId: memberId, projectId, targetStage: '尽调计划审核', reason: '计划已完整填写',
}))
await assert.rejects(
  () => createOaApprovalRequest({ userId: outsiderId, projectId, targetStage: '尽调计划审核', reason: '无项目关系' }),
  { code: 'FDE_PROJECT_TEAM_REQUIRED' },
)
```

另测试项目组成员在 `尽调计划制定` 阶段可以保存计划，非成员被拒绝；其他阶段的 OA 发起仍只允许负责人。

- [ ] **步骤 2：运行测试确认失败**

运行：`node --env-file-if-exists=.env --import tsx --test server/tests/fdePlanTeamAccess.test.ts`

预期：FAIL，当前 `project.ownerUserId !== actor.id` 会拒绝项目成员。

- [ ] **步骤 3：实现按阶段的团队授权**

在 `createOaApprovalRequest` 中保留默认负责人限制，仅对 `workflowModel === 'fde-v1' && fromStage === '尽调计划制定'` 改为确认项目成员关系或负责人身份。向 `oaWorkflowService.ts` 的 schema 导入加入 `projectMembers`，以数据库成员关系判断，不能用前端人员名称判断：

```ts
const [membership] = await tx.select({ userId: projectMembers.userId }).from(projectMembers)
  .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, actor.id))).limit(1)
const canSubmitPlan = project.ownerUserId === actor.id || Boolean(membership)
if (isPlanSubmission && !canSubmitPlan) throw workflowError(403, 'FDE_PROJECT_TEAM_REQUIRED', '尽调计划仅限投资项目组成员提交')
if (!isPlanSubmission && project.ownerUserId !== actor.id) throw workflowError(403, 'FDE_OWNER_REQUIRED', 'FDE 阶段申请必须由项目负责人提交')
```

对计划保存服务采用同一判断；保留计划材料、行动、日期、版本和申请人不可自审校验。

- [ ] **步骤 4：运行测试确认通过**

运行：`node --env-file-if-exists=.env --import tsx --test server/tests/fdePlanTeamAccess.test.ts`

预期：PASS。

- [ ] **步骤 5：提交项目组权限**

```bash
git add server/src/services/oaWorkflowService.ts server/src/services/fdeWorkflowService.ts server/tests/fdePlanTeamAccess.test.ts
git commit -m "feat: allow project team due diligence planning"
```

### 任务 4：发布新版策略并保持历史快照

**文件：**

- 修改：`server/drizzle/0053_add_fde_workflow_policies.sql`
- 创建：`server/drizzle/0114_update_investment_approval_workflow.sql`
- 修改：`server/src/scripts/oaWorkflowAcceptance.ts`

- [ ] **步骤 1：编写失败的迁移/验收断言**

在 `oaWorkflowAcceptance.ts` 断言新建 FDE 项目使用的策略配置满足：

```ts
assert.deepEqual(policy.configuration.stages.find(stage => stage.stage === '内核')!.approvals.map(node => node.duty), ['finance', 'legal', 'boss'])
assert.deepEqual(policy.configuration.stages.find(stage => stage.stage === '投决')!.approvals.map(node => node.duty), ['chairman', 'president'])
```

并断言审批请求创建后内核节点顺序为财务、法务、董事长/总裁；首位审批人通过后只开放下一节点，投决须两个节点均通过才更新阶段。

- [ ] **步骤 2：运行验收确认失败**

运行：`npm run accept:oa-workflow`

预期：FAIL，初始/活动策略仍为旧节点组合。

- [ ] **步骤 3：新增策略版本迁移**

为新策略创建一个新 `fde_workflow_policy_versions` 版本，配置与 `DEFAULT_FDE_WORKFLOW_POLICY` 完全相同，并将投资策略的 `active_version_id` 指向新版本。更新所有 `workflow_model='fde-v1' AND project_type='投资项目'` 项目的 `workflow_policy_version_id`；不修改 `oa_approval_requests` 或 `oa_approval_nodes`，确保已发起请求保留审批快照。更新 `0053` 初始 JSON，使全新数据库从一开始就是新版策略。

- [ ] **步骤 4：运行验收确认通过**

运行：`npm run accept:oa-workflow`

预期：PASS，输出包含 OA 流程验收成功；数据库测试数据在脚本结束时清理。

- [ ] **步骤 5：提交迁移与验收**

```bash
git add server/drizzle/0053_add_fde_workflow_policies.sql server/drizzle/0114_update_investment_approval_workflow.sql server/src/scripts/oaWorkflowAcceptance.ts
git commit -m "feat: publish revised investment approval workflow"
```

### 任务 5：同步审批链界面与回归验证

**文件：**

- 修改：`src/pages/WorkflowPage.tsx`
- 修改：`server/tests/fdeWorkflowPolicy.test.ts`
- 修改：`server/tests/fdeWorkspaceStep3.test.ts`

- [ ] **步骤 1：编写失败的页面文本测试**

在 `fdeWorkspaceStep3.test.ts` 或现有适用页面测试中断言：

```ts
assert.match(workflowPage, /立项 → 尽调计划制定[\s\S]*董事长\/总裁审批（任意一人）/)
assert.match(workflowPage, /内核 → 投决[\s\S]*财务.*法务.*董事长\/总裁/)
assert.match(workflowPage, /投决 → 打款[\s\S]*董事长.*总裁.*均需通过/)
assert.match(workflowPage, /打款 → 完成交割[\s\S]*财务审批/)
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --import tsx --test server/tests/fdeWorkspaceStep3.test.ts server/tests/fdeWorkflowPolicy.test.ts`

预期：FAIL，当前页面仍展示旧的关注领导、财务法务及双老板范围。

- [ ] **步骤 3：更新审批链文本**

替换 `WorkflowPage.tsx` 中静态 `workflowChain` 描述为：

```ts
['入库 → 立项', '董事长/总裁审批（任意一人）'],
['立项 → 计划制定', '投资项目组任意成员制定计划（无审批）'],
['计划审核 → 启动尽调', '董事长/总裁审批（任意一人）'],
['启动尽调 → 内核', '董事长/总裁审批（任意一人）'],
['内核 → 投决', '财务审批 → 法务审批 → 董事长/总裁审批（任意一人）'],
['投决 → 打款', '董事长审批 → 总裁审批（两人均需通过）'],
['打款 → 完成交割', '财务审批'],
```

保持审批详情从服务端节点快照渲染，不在前端自行计算审批人。

- [ ] **步骤 4：运行页面与类型检查**

运行：`node --import tsx --test server/tests/fdeWorkspaceStep3.test.ts server/tests/fdeWorkflowPolicy.test.ts && npm run check:types`

预期：全部通过，TypeScript 不报错。

- [ ] **步骤 5：运行构建与差异检查**

运行：`npm run build && git diff --check`

预期：构建成功且无空白错误。

- [ ] **步骤 6：提交界面与最终回归**

```bash
git add src/pages/WorkflowPage.tsx server/tests/fdeWorkspaceStep3.test.ts server/tests/fdeWorkflowPolicy.test.ts
git commit -m "feat: present revised investment approval chain"
```

## 最终验证清单

- [ ] `node --import tsx --test server/tests/fdeWorkflowPolicy.test.ts server/tests/fdeGovernanceApprovalNodes.test.ts server/tests/fdePlanTeamAccess.test.ts`
- [ ] `npm run accept:oa-workflow`
- [ ] `npm run check:types`
- [ ] `npm run build`
- [ ] `git diff --check`
- [ ] 手工验证：用项目组非负责人成员保存并提交尽调计划；用董事长或总裁任一人完成普通老板节点；用董事长、总裁分别完成投决两个节点；确认节点待办与项目阶段变化正确。
