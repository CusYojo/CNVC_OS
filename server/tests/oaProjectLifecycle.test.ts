import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { projectApprovalActionBlockedReason, projectApprovalCanClose, officeBlocksProjectDeletion } from '../src/contracts/oaProjectLifecycleContract.js'

const stageRequest = { businessType: 'project_stage', type: '尽调计划审核', status: '审批中', fromStage: '尽调计划审核' }
const active = { lifecycle: 'active', stage: '尽调计划审核', workflowModel: 'fde-v1' }

test('deleted, missing and inactive projects have a stable read-only reason, never an actionable pending request', () => {
  assert.equal(projectApprovalActionBlockedReason(stageRequest, active), undefined)
  assert.equal(projectApprovalActionBlockedReason(stageRequest, { ...active, lifecycle: 'deleted' }), '所属项目已删除，此审批仅供查阅')
  assert.equal(projectApprovalActionBlockedReason(stageRequest, undefined), '所属项目不存在，此审批仅供查阅')
  for (const lifecycle of ['archived', 'closed']) assert.equal(projectApprovalActionBlockedReason(stageRequest, { ...active, lifecycle }), '所属项目已结束，此审批仅供查阅')
  assert.equal(projectApprovalActionBlockedReason(stageRequest, { ...active, stage: '内核' }), '项目已进入其他阶段，此审批仅供查阅')
})

test('returned plan reviews may resume only from plan preparation; other business approvals do not compare project stage', () => {
  const returned = { ...stageRequest, status: '已退回' }
  assert.equal(projectApprovalActionBlockedReason(returned, { ...active, stage: '尽调计划制定' }), undefined)
  assert.ok(projectApprovalActionBlockedReason(returned, active))
  assert.equal(projectApprovalActionBlockedReason({ ...returned, type: '立项审批' }, active), undefined)
  assert.equal(projectApprovalActionBlockedReason({ ...returned, type: '立项审批' }, { ...active, stage: '内核' }), '项目已进入其他阶段，此审批仅供查阅')
  assert.equal(projectApprovalActionBlockedReason({ ...stageRequest, status: '已通过' }, { ...active, stage: '尽调' }), undefined)
  for (const businessType of ['task_extension', 'agent_schedule', 'project_replan']) {
    assert.equal(projectApprovalActionBlockedReason({ ...stageRequest, businessType }, { ...active, stage: '内核' }), undefined)
    assert.ok(projectApprovalActionBlockedReason({ ...stageRequest, businessType }, { ...active, lifecycle: 'deleted' }))
  }
  assert.equal(projectApprovalActionBlockedReason({ ...stageRequest, businessType: 'office' }, undefined), undefined)
})

test('deletion closes only unresolved project workflows and never approved decisions or office obligations', () => {
  for (const businessType of ['project_stage', 'task_extension', 'agent_schedule', 'project_replan']) {
    for (const status of ['审批中', '已退回']) assert.equal(projectApprovalCanClose({ businessType, status }), true)
    for (const status of ['已通过', '已拒绝', '已撤回', '已删除']) assert.equal(projectApprovalCanClose({ businessType, status }), false)
  }
  assert.equal(projectApprovalCanClose({ businessType: 'office', status: '审批中' }), false)
  assert.equal(projectApprovalCanClose({ businessType: 'unknown', status: '审批中' }), false)
  assert.equal(officeBlocksProjectDeletion({ status: '审批中' }), true)
  assert.equal(officeBlocksProjectDeletion({ status: '已退回' }), true)
  assert.equal(officeBlocksProjectDeletion({ status: '已通过', executionEnabled: true }), true)
  assert.equal(officeBlocksProjectDeletion({ status: '已通过', executionEnabled: true, latestExecutionOutcome: 'failed' }), true)
  assert.equal(officeBlocksProjectDeletion({ status: '已通过', executionEnabled: true, latestExecutionOutcome: 'succeeded' }), false)
  assert.equal(officeBlocksProjectDeletion({ status: '已通过', executionEnabled: false }), false)
  assert.equal(officeBlocksProjectDeletion({ status: '已撤回', executionEnabled: true }), false)
})

test('stage actions validate project before branching; deleted history is readable with a reason', () => {
  const source = readFileSync(new URL('../src/services/oaWorkflowService.ts', import.meta.url), 'utf8')
  const action = source.slice(source.indexOf('export async function actOnOaApprovalRequest'))
  assert.ok(action.indexOf('projectApprovalActionBlockedReason(request, project)') > 0)
  assert.ok(action.indexOf('projectApprovalActionBlockedReason(request, project)') < action.indexOf("if (input.action === 'resubmit')"))
  assert.match(source, /actionBlockedReason: projectApprovalActionBlockedReason\(request, project\)/)
  assert.match(source, /projectLifecycle: project\?\.lifecycle/)
})

test('pending rows, counts and notice receipts share project state and dedicated admin node checks', () => {
  const source = readFileSync(new URL('../src/services/fdeApprovalCenterService.ts', import.meta.url), 'utf8')
  assert.match(source, /projectApprovalOperableCondition\(\)/)
  assert.match(source, /ADMIN_SELF_APPROVAL_NODE_NAME/)
  assert.match(source, /JSON_LENGTH\(current_node.approver_user_ids\)=1/)
  assert.match(source, /current_actor.role='系统管理员'/)
})

test('project deletion closes approvals inside its existing transaction before hiding the project', () => {
  const source = readFileSync(new URL('../src/services/projectService.ts', import.meta.url), 'utf8')
  const branch = source.slice(source.indexOf('if (canDeleteWithHistory)'))
  assert.ok(branch.indexOf('closeDeletedProjectApprovals(tx, project.id, actor)') >= 0)
  assert.ok(branch.indexOf('closeDeletedProjectApprovals(tx, project.id, actor)') < branch.indexOf("lifecycle: 'deleted'"))
})

test('project delete and every stage action including resubmit share project-first request-second lock order', () => {
  const source = readFileSync(new URL('../src/services/oaWorkflowService.ts', import.meta.url), 'utf8')
  const action = source.slice(source.indexOf('export async function actOnOaApprovalRequest'))
  const projectLock = action.indexOf('WHERE ${projects.id}=${initialRequest.projectId} FOR UPDATE')
  const requestLock = action.indexOf('WHERE ${oaApprovalRequests.id}=${input.requestId} FOR UPDATE')
  const guard = action.indexOf('projectApprovalActionBlockedReason(request, project)')
  const resubmit = action.indexOf("if (input.action === 'resubmit')")
  assert.ok(projectLock > 0 && projectLock < requestLock && requestLock < guard && guard < resubmit)
  const deletion = readFileSync(new URL('../src/services/projectService.ts', import.meta.url), 'utf8').split('export async function deleteProject')[1]
  assert.ok(deletion.indexOf('WHERE ${projects.id}=${id} FOR UPDATE') < deletion.indexOf('closeDeletedProjectApprovals(tx, project.id, actor)'))
})

test('task extension resubmit locks the project and checks its active lifecycle before request and task writes', () => {
  const source = readFileSync(new URL('../src/services/fdeTaskService.ts', import.meta.url), 'utf8')
  const context = source.slice(source.indexOf('async function context'), source.indexOf('async function lockTask'))
  assert.match(context, /WHERE \$\{projects.id\}=\$\{projectId\} FOR UPDATE/)
  assert.match(context, /writable && project.lifecycle !== 'active'/)
  const action = source.slice(source.indexOf('export async function actOnFdeTaskExtension'), source.indexOf('export async function closeTaskExtensions'))
  assert.ok(action.indexOf('await context(tx, projectId, input.userId)') < action.indexOf('WHERE ${oaApprovalRequests.id}=${input.requestId} FOR UPDATE'))
  assert.ok(action.indexOf('await context(tx, projectId, input.userId)') < action.indexOf("if (input.action === 'resubmit')"))
})

test('schedule and replan use project-first lock wrappers and reject deleted project scope', () => {
  const agent = readFileSync(new URL('../src/services/fdeProjectAgentService.ts', import.meta.url), 'utf8')
  const wrapper = agent.slice(agent.indexOf('export async function agentTransaction'), agent.indexOf('const transaction = agentTransaction'))
  assert.ok(wrapper.indexOf('WHERE ${projects.id}=${projectId} FOR UPDATE') < wrapper.indexOf('return operation'))
  const scope = readFileSync(new URL('../src/services/fdeProjectAgentFactsService.ts', import.meta.url), 'utf8')
  assert.match(scope, /project.lifecycle === 'deleted'/)
  const replan = readFileSync(new URL('../src/services/fdeProjectReplanService.ts', import.meta.url), 'utf8')
  const replanWrapper = replan.slice(replan.indexOf('async function transaction'), replan.indexOf('async function configuredPolicy'))
  assert.ok(replanWrapper.indexOf('WHERE ${projects.id}=${projectId} FOR UPDATE') < replanWrapper.indexOf('return operation'))
  assert.match(replan, /return transaction\(projectId, userId, async \(tx, scope\) =>/)
  const schedule = readFileSync(new URL('../src/services/fdeAgentScheduleService.ts', import.meta.url), 'utf8')
  assert.match(schedule, /return agentTransaction\(projectId, userId, async \(tx, scope\) =>/)
  assert.match(schedule, /scope.project.lifecycle !== 'active'/)
})
