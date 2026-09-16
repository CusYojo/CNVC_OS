# 系统管理员单节点自助审批实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让系统管理员在材料门禁通过后发起仅含本人确认节点的项目阶段 OA，并在确认后直接推进项目阶段，同时保持普通账号审批规则不变。

**架构：** 在现有 OA 服务内增加一个小型、纯函数化的“管理员自助审批”策略，用它统一决定节点蓝图、自审例外和前端操作能力。沿用现有 OA 表、材料快照、乐观锁和阶段流转事务，不新增迁移。

**技术栈：** TypeScript、Express、Drizzle ORM、MySQL、React、Zustand、Node.js acceptance scripts。

---

## 文件结构

- 创建 `server/src/contracts/adminSelfApprovalContract.ts`：保存管理员自助审批节点常量及纯判定函数，供服务端和浏览器安全复用。
- 创建 `server/tests/adminSelfApprovalContract.test.ts`：验证特例边界，不连接业务数据库。
- 修改 `server/src/services/oaWorkflowService.ts`：创建单节点审批链，并仅在该节点允许本人确认。
- 修改 `src/pages/WorkflowPage.tsx`：为管理员本人确认节点隐藏退回、拒绝，只展示确认和撤回。
- 修改 `server/src/scripts/fdeWorkflowAcceptance.ts`：在隔离的 FDE 验收数据中覆盖完整管理员提交、确认、普通用户隔离与材料门禁。
- 修改 `package.json`：如现有服务端测试入口未自动包含新测试，则把契约测试加入对应测试命令。

### 任务 1：定义管理员自助审批契约

**文件：**
- 创建：`server/src/contracts/adminSelfApprovalContract.ts`
- 创建：`server/tests/adminSelfApprovalContract.test.ts`

- [ ] **步骤 1：编写失败的纯函数测试**

测试系统管理员项目阶段请求返回 `true`，普通用户、非 FDE、非项目阶段业务和非本人节点返回 `false`：

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ADMIN_SELF_APPROVAL_NODE_NAME,
  isAdminSelfApprovalSubmission,
  isAdminSelfApprovalNode,
} from '../src/contracts/adminSelfApprovalContract.js'

test('only FDE project-stage system administrators use self approval', () => {
  assert.equal(isAdminSelfApprovalSubmission({ role: '系统管理员', workflowModel: 'fde-v1', businessType: 'project_stage' }), true)
  assert.equal(isAdminSelfApprovalSubmission({ role: '投资经理', workflowModel: 'fde-v1', businessType: 'project_stage' }), false)
  assert.equal(isAdminSelfApprovalSubmission({ role: '系统管理员', workflowModel: 'legacy', businessType: 'project_stage' }), false)
  assert.equal(isAdminSelfApprovalSubmission({ role: '系统管理员', workflowModel: 'fde-v1', businessType: 'task_extension' }), false)
})

test('self approval exception requires the dedicated node and same applicant', () => {
  assert.equal(isAdminSelfApprovalNode({ actorRole: '系统管理员', actorId: 'admin', applicantUserId: 'admin', nodeName: ADMIN_SELF_APPROVAL_NODE_NAME, approverUserIds: ['admin'] }), true)
  assert.equal(isAdminSelfApprovalNode({ actorRole: '系统管理员', actorId: 'admin', applicantUserId: 'admin', nodeName: '董事长审批职责 · 投决', approverUserIds: ['admin'] }), false)
})
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`node --import tsx --test server/tests/adminSelfApprovalContract.test.ts`

预期：FAIL，提示找不到 `adminSelfApprovalContract.js`。

- [ ] **步骤 3：实现最小契约**

```ts
export const ADMIN_SELF_APPROVAL_NODE_NAME = '系统管理员确认'

export function isAdminSelfApprovalSubmission(input: { role: string; workflowModel: string; businessType: string }) {
  return input.role === '系统管理员'
    && input.workflowModel === 'fde-v1'
    && input.businessType === 'project_stage'
}

export function isAdminSelfApprovalNode(input: {
  actorRole: string
  actorId: string
  applicantUserId: string
  nodeName: string
  approverUserIds: string[]
}) {
  return input.actorRole === '系统管理员'
    && input.actorId === input.applicantUserId
    && input.nodeName === ADMIN_SELF_APPROVAL_NODE_NAME
    && input.approverUserIds.length === 1
    && input.approverUserIds[0] === input.actorId
}
```

- [ ] **步骤 4：运行契约测试**

运行：`node --import tsx --test server/tests/adminSelfApprovalContract.test.ts`

预期：2 个测试全部 PASS。

- [ ] **步骤 5：提交契约**

```bash
git add server/src/contracts/adminSelfApprovalContract.ts server/tests/adminSelfApprovalContract.test.ts
git commit -m "feat: define admin self approval contract"
```

### 任务 2：生成管理员单节点审批链并限制自审例外

**文件：**
- 修改：`server/src/services/oaWorkflowService.ts:180-215`
- 修改：`server/src/services/oaWorkflowService.ts:430-510`
- 修改：`server/src/services/oaWorkflowService.ts:645-685`
- 测试：`server/src/scripts/fdeWorkflowAcceptance.ts`

- [ ] **步骤 1：在 FDE 验收脚本中增加失败场景**

创建启用状态的系统管理员和材料完整项目，以管理员发起 OA；断言请求只有提交节点和管理员确认节点，并断言普通负责人仍因 `OA_SELF_APPROVAL_FORBIDDEN` 失败：

```ts
const adminRequest = await createOaApprovalRequest({
  userId: admin.id,
  projectId: project.id,
  targetStage: nextStage,
  reason: '管理员自助阶段推进',
})
assert.deepEqual(adminRequest.nodes.map(node => node.name), ['发起人提交', '系统管理员确认'])
assert.deepEqual(adminRequest.nodes[1].approverUserIds, [admin.id])
assert.equal(adminRequest.nodes[1].status, '待审批')
```

- [ ] **步骤 2：运行验收并确认失败**

运行：`npm run accept:fde-lifecycle`

预期：FAIL，管理员请求仍生成常规职责审批链或被“申请人不可兼任审批人”拦截。

- [ ] **步骤 3：在创建请求时选择节点策略**

在材料门禁成功、常规节点解析之前判断：

```ts
const adminSelfApproval = isAdminSelfApprovalSubmission({
  role: actor.role,
  workflowModel: project.workflowModel,
  businessType,
})
const resolvedNodes = adminSelfApproval
  ? [{
      name: ADMIN_SELF_APPROVAL_NODE_NAME,
      approverRole: '系统管理员',
      mode: '顺签' as const,
      approverUserIds: [actor.id],
      approverNames: [actor.name],
      officeRule: { kind: 'admin_self_confirmation' },
    }]
  : await resolveApprovalNodes(tx, project, actor, policy)
```

常规 FDE 继续执行职责配置与申请人冲突校验；管理员专用节点不要求董事长、财务、法务等职责人员。

- [ ] **步骤 4：把本人确认例外限制到专用节点**

将无条件自审禁止改为：

```ts
const adminSelfNode = isAdminSelfApprovalNode({
  actorRole: actor.role,
  actorId: actor.id,
  applicantUserId: request.applicantUserId,
  nodeName: currentNode.name,
  approverUserIds: currentNode.approverUserIds,
})
if (request.applicantUserId === actor.id && !adminSelfNode) {
  throw workflowError(403, 'OA_SELF_APPROVAL_FORBIDDEN', '申请人不能审批自己的申请')
}
```

- [ ] **步骤 5：只允许专用节点执行 approve 或 withdraw**

在动作校验中对 `adminSelfNode` 拒绝 `return` 和 `reject`，返回稳定错误码：

```ts
if (adminSelfNode && (input.action === 'return' || input.action === 'reject')) {
  throw workflowError(409, 'OA_ADMIN_SELF_ACTION_INVALID', '系统管理员本人确认节点只能确认或撤回')
}
```

- [ ] **步骤 6：运行 FDE 验收**

运行：`npm run accept:fde-lifecycle`

预期：管理员创建单节点 OA、本人确认并推进阶段；普通负责人自审仍被拒绝；材料不完整仍返回 `FDE_STAGE_GATE_FAILED`。

- [ ] **步骤 7：提交服务端实现**

```bash
git add server/src/services/oaWorkflowService.ts server/src/scripts/fdeWorkflowAcceptance.ts
git commit -m "feat: add admin self confirmation workflow"
```

### 任务 3：调整审批中心操作按钮

**文件：**
- 修改：`src/pages/WorkflowPage.tsx:120-170`
- 修改：`src/pages/WorkflowPage.tsx:295-330`
- 测试：`server/tests/adminSelfApprovalContract.test.ts`

- [ ] **步骤 1：增加前端能力判定测试**

扩展共享契约，增加 `adminSelfApprovalActions()`，并断言专用节点仅返回确认和撤回能力：

```ts
assert.deepEqual(adminSelfApprovalActions(true), {
  approve: true,
  withdraw: true,
  return: false,
  reject: false,
})
assert.deepEqual(adminSelfApprovalActions(false), {
  approve: true,
  withdraw: false,
  return: true,
  reject: true,
})
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`node --import tsx --test server/tests/adminSelfApprovalContract.test.ts`

预期：FAIL，`adminSelfApprovalActions` 尚未导出。

- [ ] **步骤 3：实现并使用操作能力判定**

在共享契约中实现：

```ts
export function adminSelfApprovalActions(enabled: boolean) {
  return enabled
    ? { approve: true, withdraw: true, return: false, reject: false }
    : { approve: true, withdraw: false, return: true, reject: true }
}
```

在 `WorkflowPage.tsx` 根据当前用户、申请人、节点名称和审批人计算 `selectedAdminSelfNode`，管理员专用节点页脚只渲染“撤回”和“确认并流转”，并展示说明：

```tsx
{selectedAdminSelfNode && (
  <p className="rounded-lg bg-brand-50 p-3 text-sm text-brand-700">
    本申请由系统管理员本人确认后直接流转。
  </p>
)}
```

- [ ] **步骤 4：运行契约测试和类型检查**

运行：

```bash
node --import tsx --test server/tests/adminSelfApprovalContract.test.ts
npm run check:types
```

预期：全部 PASS，无 TypeScript 错误。

- [ ] **步骤 5：提交前端行为**

```bash
git add server/src/contracts/adminSelfApprovalContract.ts server/tests/adminSelfApprovalContract.test.ts src/pages/WorkflowPage.tsx
git commit -m "feat: present admin self confirmation actions"
```

### 任务 4：完整回归与交付检查

**文件：**
- 修改：`package.json`（仅当测试入口需要显式登记）
- 检查：`docs/superpowers/specs/2026-09-16-admin-self-approval-design.md`

- [ ] **步骤 1：运行针对性测试**

运行：

```bash
node --import tsx --test server/tests/adminSelfApprovalContract.test.ts
npm run accept:fde-lifecycle
npm run accept:oa-workflow
```

预期：全部 PASS。

- [ ] **步骤 2：运行静态和平台门禁**

运行：

```bash
npm run check:types
npm run check:platform
```

预期：全部 PASS；若平台门禁报告既有环境问题，记录具体命令、错误和与本次改动的关系，不弱化测试。

- [ ] **步骤 3：检查补丁完整性**

运行：

```bash
git diff --check
git status --short
git log -5 --oneline
```

预期：无空白错误；仅包含本功能相关文件；功能提交和规格提交均可追溯。

- [ ] **步骤 4：提交测试入口调整（如有）**

```bash
git add package.json
git commit -m "test: cover admin self approval flow"
```

- [ ] **步骤 5：交付说明**

明确区分：源码实现、测试结果、本地运行是否生效、公网生产是否发布。未经额外授权，不重启服务、不发布公网、不修改生产业务数据。
