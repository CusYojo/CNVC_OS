import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db } from '../db/client.js'
import { oaApprovalNodes, oaApprovalRecords, oaApprovalRequests, oaOfficePolicies, projects, todos } from '../db/schema.js'
import { officeDefinition, officeKinds } from '../contracts/fdeOfficeContract.js'

type Person = { id: string; name: string; department: string }
// Synthetic persisted states test query behavior, not the workflow transitions.
// Only the isolated harness/browser fixture may call this helper.
export async function seedApprovalCenterFixture(author: Person, reviewer: Person, financeRoleId: string) {
  assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
  assert.equal(process.env.DB_FREFIX, process.env.FDE_ACCEPTANCE_PREFIX)
  const marker = `统一审批-${randomUUID().slice(0, 8)}`, projectId = randomUUID()
  await db.insert(projects).values({ id: projectId, name: `${marker}关联项目`, owner: author.name, ownerUserId: author.id, createdBy: author.id, stage: '线索' })
  const policyRows = await db.select().from(oaOfficePolicies)
  const kinds = ['立项审批', '任务延期', ...officeKinds], states = ['审批中', '已通过', '已退回', '已拒绝', '已撤回', '草稿']
  const rows: Array<{ id: string; kind: string; status: string; businessType: string; updatedAt: Date; processed: boolean }> = []
  const base = Date.now()
  for (let i = 0; i < 42; i++) {
    const id = randomUUID(), nodeId = randomUUID(), kind = kinds[i % kinds.length]
    const office = officeKinds.includes(kind as typeof officeKinds[number]), businessType = office ? 'office' : kind === '任务延期' ? 'task_extension' : 'project_stage'
    const selectedStatus = states[i % states.length], status = !office && selectedStatus === '草稿' ? '审批中' : selectedStatus
    const taskId = businessType === 'task_extension' ? randomUUID() : null
    if (taskId) await db.insert(todos).values({ id: taskId, projectId, projectName: `${marker}关联项目`, title: `${marker}延期任务-${i}`, owner: author.name, ownerUserId: author.id, createdBy: author.id })
    const title = `${marker}-${String(i + 1).padStart(2, '0')}-${kind}`
    const definition = office ? officeDefinition.parse({ title, reason: '隔离分页验收合成记录，不是实际申请', projectId: null, priority: '普通', details: { kind }, attachmentIds: [] }) : null
    const updatedAt = new Date(base - Math.floor(i / 2) * 1000), processed = ['已通过', '已退回', '已拒绝'].includes(status)
    await db.insert(oaApprovalRequests).values({
      id, requestNo: `UC-${id}`, projectId: office ? null : projectId, projectName: office ? '' : `${marker}关联项目`, title, type: kind, businessType, taskId,
      fromStage: office ? '' : '线索', targetStage: office ? '' : '初筛', status, applicantUserId: author.id, applicantName: author.name, department: author.department,
      currentNodeId: status === '草稿' ? null : nodeId, currentNodeName: status === '草稿' ? '' : '隔离当前审核', reason: '隔离列表查询合成状态',
      officeRevision: office && status !== '草稿' ? 1 : 0, officePolicyVersionId: office ? policyRows.find(p => p.kind === kind)?.activeVersionId : null,
      businessPayload: office ? { definition, departmentIds: [] } : {}, updatedAt, submittedAt: updatedAt,
    })
    await db.insert(oaApprovalNodes).values({ id: nodeId, requestId: id, name: '隔离当前审核', approverRole: '财务', mode: '或签', sequence: 1,
      status: status === '审批中' ? '待审批' : status, approverUserIds: [reviewer.id], approverNames: [reviewer.name],
      approvedByUserIds: status === '已通过' ? [reviewer.id] : [], approvedByNames: status === '已通过' ? [reviewer.name] : [],
      officeRevision: office && status !== '草稿' ? 1 : null,
      officeRule: office ? { key: 'review', name: '隔离当前审核', roleIds: [financeRoleId], scope: 'institution', mode: '或签', fixedUserIds: [reviewer.id], allowTransfer: true } : {},
    })
    if (processed) await db.insert(oaApprovalRecords).values({ requestId: id, nodeId, nodeName: '隔离当前审核', operatorUserId: reviewer.id, operatorName: reviewer.name,
      action: status === '已通过' ? '同意' : status === '已退回' ? '退回' : '拒绝', comment: '仅用于隔离查询验收的历史状态' })
    rows.push({ id, kind, status, businessType, updatedAt, processed })
  }
  rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.id.localeCompare(b.id))
  return { marker, projectId, rows }
}
