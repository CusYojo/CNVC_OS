import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ADMIN_SELF_APPROVAL_NODE_NAME,
  adminSelfApprovalActions,
  isAdminSelfApprovalNode,
  isAdminSelfApprovalSubmission,
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
  assert.equal(isAdminSelfApprovalNode({ actorRole: '系统管理员', actorId: 'admin', applicantUserId: 'other', nodeName: ADMIN_SELF_APPROVAL_NODE_NAME, approverUserIds: ['admin'] }), false)
})

test('dedicated node only exposes confirm and withdraw actions', () => {
  assert.deepEqual(adminSelfApprovalActions(true), { approve: true, withdraw: true, return: false, reject: false })
  assert.deepEqual(adminSelfApprovalActions(false), { approve: true, withdraw: false, return: true, reject: true })
})
