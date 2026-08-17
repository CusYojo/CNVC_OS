import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { and, count, eq, inArray } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { ensureSchema } from '../db/migrate.js'
import {
  auditLogs,
  oaApprovalNodes,
  oaApprovalRecords,
  oaApprovalRequests,
  oaWorkflowLogs,
  projectMembers,
  projects,
  todos,
  users,
} from '../db/schema.js'
import {
  actOnOaApprovalRequest,
  createOaApprovalRequest,
  listOaApprovalRequests,
} from '../services/oaWorkflowService.js'

const checks: string[] = []
function check(name: string, assertion: () => void) {
  assertion()
  checks.push(name)
}

await ensureSchema()
const marker = randomUUID().slice(0, 8)
const applicantId = randomUUID()
const directorId = randomUUID()
const secretaryId = randomUUID()
const riskId = randomUUID()
const viewerId = randomUUID()
const fixtureUserIds = [applicantId, directorId, secretaryId, riskId, viewerId]
const projectId = randomUUID()
const createdRequestIds: string[] = []

try {
  await db.insert(users).values([
    { id: applicantId, email: `oa-applicant-${marker}@example.com`, name: `OA发起人${marker}`, role: '投资经理', department: 'OA验收', passwordHash: 'not-used' },
    { id: directorId, email: `oa-director-${marker}@example.com`, name: `OA总监${marker}`, role: '投资总监', department: 'OA验收', passwordHash: 'not-used' },
    { id: secretaryId, email: `oa-secretary-${marker}@example.com`, name: `OA秘书${marker}`, role: '投委会秘书', department: 'OA验收', passwordHash: 'not-used' },
    { id: riskId, email: `oa-risk-${marker}@example.com`, name: `OA风控${marker}`, role: '风控与法务', department: 'OA验收', passwordHash: 'not-used' },
    { id: viewerId, email: `oa-viewer-${marker}@example.com`, name: `OA旁观者${marker}`, role: '分析师', department: 'OA验收', passwordHash: 'not-used' },
  ])
  await db.insert(projects).values({
    id: projectId,
    name: `OA MySQL 验收项目 ${marker}`,
    companyName: `OA验收公司${marker}`,
    stage: '线索',
    stageSource: '系统初始化',
    owner: `OA发起人${marker}`,
    ownerUserId: applicantId,
    createdBy: applicantId,
    progress: 12,
    riskLevel: '低',
  })
  await db.insert(projectMembers).values({
    projectId, userId: viewerId, memberRole: 'collaborator', sourceName: `OA旁观者${marker}`,
  })

  const first = await createOaApprovalRequest({
    userId: applicantId,
    projectId,
    targetStage: '初筛',
    reason: 'OA MySQL 权威源生命周期验收',
    priority: '紧急',
  })
  assert.ok(first)
  createdRequestIds.push(first.id)
  check('request-nodes-records-and-stable-approvers-persist-in-mysql', () => {
    assert.equal(first.status, '审批中')
    assert.equal(first.nodes[0]?.status, '已通过')
    assert.ok(first.nodes[1]?.approverUserIds?.includes(directorId))
    assert.equal(first.records[0]?.operatorUserId, applicantId)
    assert.equal(first.lockVersion, 1)
  })

  const duplicate = await createOaApprovalRequest({
    userId: applicantId,
    projectId,
    targetStage: '初筛',
    reason: '重复活动流程应被拒绝',
  }).then(() => null, (error: Error & { code?: string }) => error)
  check('one-project-allows-only-one-active-request', () => {
    assert.equal(duplicate?.code, 'OA_ACTIVE_REQUEST_EXISTS')
  })

  const assignedList = await listOaApprovalRequests(secretaryId)
  check('assigned-approver-can-list-request-without-project-membership', () => {
    assert.ok(assignedList.some((request) => request.id === first.id))
  })

  const forbidden = await actOnOaApprovalRequest({
    userId: viewerId,
    requestId: first.id,
    action: 'approve',
    comment: '项目协作者不等于当前节点审批人',
  }).then(() => null, (error: Error & { code?: string }) => error)
  check('project-access-does-not-grant-node-approval-authority', () => {
    assert.equal(forbidden?.code, 'OA_ACTION_FORBIDDEN')
  })

  const afterDirector = await actOnOaApprovalRequest({
    userId: directorId,
    requestId: first.id,
    action: 'approve',
    comment: '总监节点同意',
  })
  check('intermediate-approval-does-not-change-project-stage', () => {
    assert.equal(afterDirector.request.status, '审批中')
    assert.equal(afterDirector.request.nodes[1]?.status, '已通过')
    assert.equal(afterDirector.request.nodes[2]?.status, '待审批')
    assert.equal(afterDirector.project, undefined)
  })

  const concurrentFinal = await Promise.allSettled([
    actOnOaApprovalRequest({ userId: secretaryId, requestId: first.id, action: 'approve', comment: '秘书复核通过 A' }),
    actOnOaApprovalRequest({ userId: secretaryId, requestId: first.id, action: 'approve', comment: '秘书复核通过 B' }),
  ])
  const fulfilled = concurrentFinal.filter((result) => result.status === 'fulfilled')
  check('concurrent-final-action-has-one-transaction-winner', () => {
    assert.equal(fulfilled.length, 1)
  })
  const [projectAfterFirst] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  const [{ value: firstLogCount }] = await db.select({ value: count() }).from(oaWorkflowLogs)
    .where(eq(oaWorkflowLogs.requestId, first.id))
  check('final-approval-updates-project-and-appends-one-workflow-log-atomically', () => {
    assert.equal(projectAfterFirst.stage, '初筛')
    assert.equal(projectAfterFirst.stageSource, 'OA审批')
    assert.equal(projectAfterFirst.latestApprovalId, first.id)
    assert.equal(Number(firstLogCount), 1)
  })

  const persisted = (await listOaApprovalRequests(applicantId)).find((request) => request.id === first.id)
  check('refresh-reloads-complete-oa-history-from-mysql', () => {
    assert.equal(persisted?.status, '已通过')
    assert.ok((persisted?.records.length ?? 0) >= 3)
    assert.ok((persisted?.lockVersion ?? 0) >= 3)
  })

  const second = await createOaApprovalRequest({
    userId: applicantId,
    projectId,
    targetStage: '立项',
    reason: '退回和重新提交生命周期验收',
  })
  createdRequestIds.push(second.id)
  await actOnOaApprovalRequest({
    userId: directorId, requestId: second.id, action: 'return', comment: '请补充融资核验材料',
  })
  const invalidResubmit = await actOnOaApprovalRequest({
    userId: viewerId, requestId: second.id, action: 'resubmit', comment: '旁观者不能重提',
  }).then(() => null, (error: Error & { code?: string }) => error)
  assert.equal(invalidResubmit?.code, 'OA_ACTION_FORBIDDEN')
  const resubmitted = await actOnOaApprovalRequest({
    userId: applicantId, requestId: second.id, action: 'resubmit', comment: '已补充融资核验材料并重新提交',
  })
  check('returned-request-can-only-be-resubmitted-by-applicant', () => {
    assert.equal(resubmitted.request.status, '审批中')
    assert.equal(resubmitted.request.nodes[1]?.status, '待审批')
    assert.ok(resubmitted.request.records.some((record) => record.nodeName === '退回后重新提交'))
  })

  await actOnOaApprovalRequest({ userId: directorId, requestId: second.id, action: 'approve', comment: '补充后同意' })
  const rejected = await actOnOaApprovalRequest({ userId: riskId, requestId: second.id, action: 'reject', comment: '风控条件未满足' })
  const [projectAfterReject] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  check('rejection-is-terminal-and-does-not-change-project-stage', () => {
    assert.equal(rejected.request.status, '已拒绝')
    assert.equal(projectAfterReject.stage, '初筛')
  })

  const third = await createOaApprovalRequest({
    userId: applicantId,
    projectId,
    targetStage: '立项',
    reason: '活动键在终态后释放并允许新流程',
  })
  createdRequestIds.push(third.id)
  const withdrawn = await actOnOaApprovalRequest({
    userId: applicantId, requestId: third.id, action: 'withdraw', comment: '发起人主动撤回',
  })
  check('terminal-status-releases-active-key-and-applicant-can-withdraw', () => {
    assert.equal(withdrawn.request.status, '已撤回')
  })

  const deleteBlocked = await db.delete(projects).where(eq(projects.id, projectId))
    .then(() => null, (error: Error) => error)
  check('project-with-oa-history-cannot-silently-delete-audit-chain', () => {
    assert.ok(deleteBlocked)
  })
} finally {
  if (createdRequestIds.length) {
    await db.update(projects).set({ latestApprovalId: null }).where(eq(projects.id, projectId)).catch(() => undefined)
    await db.delete(oaWorkflowLogs).where(inArray(oaWorkflowLogs.requestId, createdRequestIds)).catch(() => undefined)
    await db.delete(todos).where(inArray(todos.approvalRequestId, createdRequestIds)).catch(() => undefined)
    await db.delete(oaApprovalRecords).where(inArray(oaApprovalRecords.requestId, createdRequestIds)).catch(() => undefined)
    await db.delete(oaApprovalNodes).where(inArray(oaApprovalNodes.requestId, createdRequestIds)).catch(() => undefined)
    await db.delete(oaApprovalRequests).where(inArray(oaApprovalRequests.id, createdRequestIds)).catch(() => undefined)
  }
  await db.delete(auditLogs).where(inArray(auditLogs.userId, fixtureUserIds)).catch(() => undefined)
  await db.delete(projectMembers).where(eq(projectMembers.projectId, projectId)).catch(() => undefined)
  await db.delete(projects).where(eq(projects.id, projectId)).catch(() => undefined)
  await db.delete(users).where(inArray(users.id, fixtureUserIds)).catch(() => undefined)
  await pool.end()
}

console.log(JSON.stringify({ ok: true, checks: checks.length, names: checks }))
