import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { approvalTarget, approvalTargetFromPath, nextApproval } from '../../src/lib/approvalWorkspace'
import type { ApprovalCenterRow } from '../src/contracts/fdeApprovalCenterContract'
import { taskTargetFromPath } from '../../src/lib/taskWorkspace'

const id = '00000000-0000-4000-8000-000000000001', projectId = '00000000-0000-4000-8000-000000000002'
test('every approval family resolves in place, including legacy project and office links', () => {
  assert.deepEqual(approvalTargetFromPath(`/workflow?request=${id}`), { id, kind: 'project', projectId: undefined })
  assert.deepEqual(approvalTargetFromPath(`/workflow?office=${id}`), { id, kind: 'office', projectId: undefined })
  for (const [query, kind] of [['typeReview', 'type_execution'], ['replan', 'project_replan'], ['schedule', 'agent_schedule']]) {
    assert.deepEqual(approvalTargetFromPath(`/projects/${projectId}?${query}=${id}`), { id, kind, projectId })
  }
  assert.equal(approvalTargetFromPath('/workflow?view=pending'), 'inbox')
})
test('ordinary navigation, request creation, invalid identifiers and external links stay untouched', () => {
  for (const path of ['/workflow', '/workflow?view=processed', `/workflow?view=project&project=${projectId}`, '/workflow?request=invalid', '/projects', 'https://external.invalid/workflow?view=pending', `//external.invalid/workflow?request=${id}`]) assert.equal(approvalTargetFromPath(path), null)
})
test('generic rows retain their actual approval family and stable identifiers', () => {
  for (const businessType of ['office', 'type_execution', 'project_replan', 'agent_schedule']) assert.deepEqual(approvalTarget({ id, businessType, projectId }), { id, kind: businessType, projectId })
  assert.equal(approvalTarget({ id, businessType: 'task_extension', projectId }).kind, 'project')
})
test('after handling a request the next item comes from a fresh server queue, not a shifted index', () => {
  const second = { id: projectId, businessType: 'office' } as ApprovalCenterRow
  assert.equal(nextApproval([second], { id, kind: 'project' }), second)
  assert.equal(nextApproval([{ id } as ApprovalCenterRow, second], { id, kind: 'project' }), second)
  assert.equal(nextApproval([{ id } as ApprovalCenterRow], { id, kind: 'project' }), null)
  assert.equal(nextApproval([], { id, kind: 'project' }), null)
})
test('task detail and actions resolve in place without intercepting normal project navigation', () => {
  assert.deepEqual(taskTargetFromPath(`/projects/${projectId}?tab=tasks&task=${id}`), { projectId, taskId: id, action: 'view' })
  for (const action of ['start', 'progress', 'submission', 'accept', 'extension', 'cancel']) {
    assert.deepEqual(taskTargetFromPath(`/projects/${projectId}?task=${id}&action=${action}`), { projectId, taskId: id, action })
  }
  for (const path of [`/projects/${projectId}`, `/projects/${projectId}?task=invalid`, `https://external.invalid/projects/${projectId}?task=${id}`, `/projects/${projectId}?task=${id}&action=unknown`]) assert.equal(taskTargetFromPath(path), null)
})

test('historical blocked approvals remain readable without offering mutation controls', async () => {
  const source = await readFile(new URL('../../src/pages/WorkflowPage.tsx', import.meta.url), 'utf8')
  assert.match(source, /if \(request.actionBlockedReason\) return false/)
  assert.match(source, /canWithdrawSelected = !!selected && !selected.actionBlockedReason/)
  assert.match(source, /canResubmitSelected = !!selected && !selected.actionBlockedReason/)
  assert.match(source, /selected\?\.actionBlockedReason &&/)
  assert.match(source, /if \(!selected \|\| selected.actionBlockedReason \|\| actingRef.current/)
})
