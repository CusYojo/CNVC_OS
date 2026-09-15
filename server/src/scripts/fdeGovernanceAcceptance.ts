import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { auditLogs, authSessions, meetings, permissions, projectFiles, roles, risks, todos, userRoles, users } from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'
import { createProject, classifyProject, getProject, listAllFiles, listProjects } from '../services/projectService.js'
import { getAccessibleProject, requireAccessibleProject } from '../services/projectAccessService.js'
import { decideFdeGovernance, getFdeGovernance, proposeFdeGovernance } from '../services/fdeGovernanceService.js'
import { bindFdeMaterial, saveFdePlan } from '../services/fdeWorkflowService.js'
import { createRole, updateRole, updateUserRoleBindings } from '../services/systemAdministrationService.js'
import { replaceProjectMembers, updateManagedUser } from '../services/identityAdministrationService.js'
import { actOnOaApprovalRequest, createOaApprovalRequest, listOaApprovalRequests } from '../services/oaWorkflowService.js'
import { listMeetings, listTodos } from '../services/meetingService.js'
import { listRisks } from '../services/riskService.js'
import type { FdeDutyAssignment } from '../contracts/fdeGovernanceContract.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
const marker = randomUUID().slice(0, 8)
const checks: string[] = []
const definitions = [
  ['owner', '投资经理', 'A'], ['otherOwner', '投资经理', 'B'], ['director', '投资总监', 'A'],
  ['chairman', '董事长', '领导'], ['president', '总裁', '领导'], ['secretary', '推进秘书', 'A'],
  ['member', '投资经理', 'B'], ['finance', '财务', 'B'], ['legal', '风控与法务', 'C'],
  ['coordinator', '时间协调人', 'A'], ['admin', '系统管理员', '运维'], ['outsider', '投资经理', 'B'],
] as const
const accounts = Object.fromEntries(definitions.map(([key, role, department]) => [key, { id: randomUUID(), name: `FDE治理-${key === 'outsider' ? 'owner' : key}-${marker}`, role, department: `${department}-${marker}`, email: `fde-gov-${key}-${marker}@example.invalid`, passwordHash: 'not-for-login' }]))
const expectCode = async (promise: Promise<unknown>, code: string) => { const result = await promise.then(() => null, (cause) => cause as { code: string }); assert.equal(result?.code, code) }
const actor = (key: string) => ({ uid: accounts[key].id, name: accounts[key].name, role: accounts[key].role })

try {
  await db.insert(users).values(Object.values(accounts))
  for (const account of Object.values(accounts)) await identityRepositories.users.synchronizeAdministrationBindings(account.id, account.role, account.department)
  let project = await createProject({ name: `治理项目-${marker}` }, accounts.owner.id)
  const other = await createProject({ name: `隔离项目-${marker}` }, accounts.otherOwner.id)
  assert.equal(project.ownerUserId, accounts.owner.id)
  assert.equal(await getAccessibleProject(accounts.outsider.id, project.id), null)
  checks.push('duplicate-name-does-not-grant-fde-project-access')
  assert.equal(await getAccessibleProject(accounts.admin.id, project.id), null)
  assert.ok(await getAccessibleProject(accounts.chairman.id, project.id))
  assert.ok(await getAccessibleProject(accounts.chairman.id, other.id))
  assert.ok(await getAccessibleProject(accounts.director.id, project.id))
  assert.equal(await getAccessibleProject(accounts.director.id, other.id), null)
  checks.push('system-administration-separated-from-business', 'institution-and-department-scopes-use-stable-role-bindings')

  const assignments: FdeDutyAssignment[] = [
    { duty: 'concerned_leader', userId: accounts.chairman.id }, { duty: 'chairman', userId: accounts.chairman.id }, { duty: 'secretary', userId: accounts.secretary.id },
    { duty: 'member', userId: accounts.member.id }, { duty: 'finance', userId: accounts.finance.id },
    { duty: 'legal', userId: accounts.legal.id }, { duty: 'coordinator', userId: accounts.coordinator.id },
  ]
  await expectCode(proposeFdeGovernance({ projectId: project.id, userId: accounts.owner.id, ownerUserId: accounts.owner.id, expectedVersion: 1, reason: '管理员不能被伪装为业务成员', assignments: [{ duty: 'member', userId: accounts.admin.id }] }), 'FDE_DUTY_PERSON_INVALID')
  const first = await proposeFdeGovernance({ projectId: project.id, userId: accounts.owner.id, ownerUserId: accounts.owner.id, expectedVersion: 1, reason: '配置项目职责和专业条线', assignments })
  assert.equal(first.status, 'applied')
  assert.ok(await getAccessibleProject(accounts.member.id, project.id))
  assert.ok(await getAccessibleProject(accounts.finance.id, project.id))
  assert.equal(await getAccessibleProject(accounts.finance.id, other.id), null)
  assert.equal(await getAccessibleProject(accounts.coordinator.id, project.id), null)
  checks.push('explicit-project-duties-isolate-members-and-specialists', 'time-coordinator-does-not-inherit-project-content')
  await expectCode(proposeFdeGovernance({ projectId: project.id, userId: accounts.member.id, ownerUserId: accounts.member.id, expectedVersion: 2, reason: '普通成员不得修改项目治理', assignments }), 'FDE_GOVERNANCE_FORBIDDEN')
  await expectCode(proposeFdeGovernance({ projectId: project.id, userId: accounts.owner.id, ownerUserId: accounts.owner.id, expectedVersion: 1, reason: '过期配置不得覆盖当前治理', assignments }), 'FDE_GOVERNANCE_VERSION_CONFLICT')

  await db.insert(projectFiles).values({ projectId: project.id, name: '隔离材料', type: 'TXT', category: '项目资料', uploader: accounts.owner.name })
  await db.insert(meetings).values({ projectId: project.id, projectName: project.name, title: '隔离会议', host: accounts.owner.name, hostUserId: accounts.owner.id, createdBy: accounts.owner.id })
  await db.insert(todos).values({ projectId: project.id, projectName: project.name, title: '隔离任务', owner: accounts.owner.name, ownerUserId: accounts.owner.id, dueDate: '2027-01-01', createdBy: accounts.owner.id })
  await db.insert(risks).values({ projectId: project.id, projectName: project.name, type: '合规', title: '隔离风险', createdBy: accounts.owner.id })
  assert.ok(!(await listProjects({ page: 1, pageSize: 100 }, accounts.admin.id)).list.some((item) => item.id === project.id))
  assert.ok(!(await listAllFiles(accounts.admin.id)).some((item) => item.projectId === project.id))
  assert.equal((await listMeetings(project.id, actor('admin'))).length, 0)
  assert.ok(!(await listTodos(undefined, undefined, actor('admin'))).some((item) => item.projectId === project.id))
  assert.equal((await listRisks(project.id, undefined, actor('admin'))).length, 0)
  checks.push('project-files-meetings-todos-risks-share-one-fde-scope')

  project = (await getProject(project.id))!
  project = await classifyProject({ projectId: project.id, userId: accounts.owner.id, toClassification: 'normal', expectedVersion: project.version, reason: '入库职责配置完备' })
  for (const requirementKey of ['business_plan', 'initial_meeting']) await bindFdeMaterial({ projectId: project.id, userId: accounts.owner.id, stage: '立项', requirementKey, waiverReason: '隔离验收替代证据已说明' })
  const request = await createOaApprovalRequest({ projectId: project.id, userId: accounts.owner.id, targetStage: '尽调计划制定', reason: '验证活动审批人员快照冻结' })
  assert.deepEqual(request.nodes[1].approverUserIds, [accounts.chairman.id])
  assert.ok(!(await listOaApprovalRequests(accounts.admin.id)).some((item) => item.id === request.id))
  const nextAssignments = assignments.map((assignment) => assignment.duty === 'concerned_leader'
    ? { ...assignment, userId: accounts.president.id }
    : assignment.duty === 'chairman' ? { duty: 'president' as const, userId: accounts.president.id } : assignment)
  const pending = await proposeFdeGovernance({ projectId: project.id, userId: accounts.owner.id, ownerUserId: accounts.owner.id, expectedVersion: 2, reason: '调整关注领导需要原领导确认', assignments: nextAssignments })
  assert.equal(pending.status, 'awaiting_confirmation')
  assert.deepEqual(pending.requiredConfirmers, [accounts.chairman.id])
  const beforeConfirmation = await getFdeGovernance(project.id, accounts.owner.id)
  assert.ok(beforeConfirmation.assignments.some((item) => item.duty === 'concerned_leader' && item.userId === accounts.chairman.id))
  await expectCode(decideFdeGovernance({ projectId: project.id, changeId: pending.id, userId: accounts.member.id, decision: 'confirm', comment: '无权代替领导确认', expectedVersion: pending.version }), 'FDE_GOVERNANCE_CONFIRM_FORBIDDEN')
  await decideFdeGovernance({ projectId: project.id, changeId: pending.id, userId: accounts.chairman.id, decision: 'confirm', comment: '同意调整参与规则', expectedVersion: pending.version })
  const afterConfirmation = await getFdeGovernance(project.id, accounts.owner.id)
  assert.equal(afterConfirmation.version, 3)
  assert.ok(afterConfirmation.assignments.some((item) => item.duty === 'concerned_leader' && item.userId === accounts.president.id))
  const frozen = (await listOaApprovalRequests(accounts.owner.id)).find((item) => item.id === request.id)!
  assert.deepEqual(frozen.nodes[1].approverUserIds, [accounts.chairman.id])
  await actOnOaApprovalRequest({ requestId: request.id, userId: accounts.chairman.id, action: 'approve', comment: '按原冻结审批职责完成', expectedVersion: request.lockVersion })
  checks.push('removed-leader-must-confirm-before-rules-change', 'governance-change-does-not-rewrite-active-approval-snapshot')
  await expectCode(decideFdeGovernance({ projectId: project.id, changeId: pending.id, userId: accounts.chairman.id, decision: 'confirm', comment: '重复确认必须被拒绝', expectedVersion: pending.version }), 'FDE_GOVERNANCE_CHANGE_CONFLICT')

  await proposeFdeGovernance({ projectId: project.id, userId: accounts.owner.id, ownerUserId: accounts.otherOwner.id, expectedVersion: 3, reason: '负责人交接并移除原负责人职责', assignments: nextAssignments })
  assert.equal(await getAccessibleProject(accounts.owner.id, project.id), null)
  assert.ok(await getAccessibleProject(accounts.otherOwner.id, project.id))
  checks.push('former-creator-loses-access-after-explicit-owner-transfer')
  await proposeFdeGovernance({ projectId: project.id, userId: accounts.otherOwner.id, ownerUserId: accounts.otherOwner.id, expectedVersion: 4, reason: '原负责人仅作为普通成员参与', assignments: [...nextAssignments, { duty: 'member', userId: accounts.owner.id }] })
  assert.ok(await getAccessibleProject(accounts.owner.id, project.id))
  await expectCode(saveFdePlan({ projectId: project.id, userId: accounts.owner.id, cycleDays: 30, targetDate: '2027-01-01' }), 'FDE_OWNER_REQUIRED')
  await expectCode(bindFdeMaterial({ projectId: project.id, userId: accounts.owner.id, stage: '尽调', requirementKey: 'business_dd', waiverReason: '原创建者不再具有免传权限' }), 'FDE_OWNER_REQUIRED')
  checks.push('former-owner-as-member-cannot-edit-plan-or-waive-materials')

  const administrator = { userId: accounts.admin.id, userName: accounts.admin.name }
  await expectCode(replaceProjectMembers({ projectId: project.id, ownerUserId: accounts.admin.id, collaboratorUserIds: [] }, administrator), 'FDE_GOVERNANCE_ENDPOINT_REQUIRED')
  const [readPermission] = await db.select().from(permissions).where(eq(permissions.code, 'fde.project.read'))
  const extra = await createRole({ code: `FDE_TEST_${marker}`, name: `附加业务角色-${marker}`, fdeCategory: 'project_lead', dataScope: 'all', permissionIds: [readPermission.id] }, administrator)
  const bindings = await db.select().from(userRoles).where(eq(userRoles.userId, accounts.outsider.id))
  const primaryRoleId = bindings.find((binding) => binding.isPrimary)!.roleId
  const bindingInput = { primaryRoleId, roleIds: [...bindings.map((binding) => binding.roleId), extra.id], expectedRoleIds: bindings.map((binding) => binding.roleId), expectedPrimaryRoleId: primaryRoleId }
  const sessionId = randomUUID()
  await db.insert(authSessions).values({ id: sessionId, userId: accounts.outsider.id, tokenHash: randomUUID().replaceAll('-', '').repeat(2), csrfHash: randomUUID().replaceAll('-', '').repeat(2), expiresAt: new Date(Date.now() + 60_000) })
  await updateUserRoleBindings(accounts.outsider.id, bindingInput, administrator)
  assert.ok(await getAccessibleProject(accounts.outsider.id, project.id))
  assert.ok((await db.select().from(authSessions).where(eq(authSessions.id, sessionId)))[0].revokedAt)
  await expectCode(updateUserRoleBindings(accounts.outsider.id, bindingInput, administrator), 'VERSION_CONFLICT')
  await updateManagedUser(accounts.outsider.id, { department: accounts.owner.department }, administrator)
  assert.ok((await db.select().from(userRoles).where(eq(userRoles.userId, accounts.outsider.id))).some((binding) => binding.roleId === extra.id))
  await updateRole(extra.id, { dataScope: 'self', expectedVersion: extra.version }, administrator)
  assert.equal(await getAccessibleProject(accounts.outsider.id, project.id), null)
  const [adminRole] = await db.select().from(roles).where(eq(roles.code, 'SYSTEM_ADMIN'))
  await expectCode(updateRole(adminRole.id, { fdeCategory: 'member', expectedVersion: adminRole.version }, administrator), 'FDE_ADMIN_CATEGORY_REQUIRED')
  await expectCode(updateRole(adminRole.id, { permissionIds: [], expectedVersion: adminRole.version }, administrator), 'SYSTEM_ADMIN_ROLE_REQUIRED')
  checks.push('multi-role-binding-is-stable-audited-and-revokes-sessions', 'legacy-department-edit-preserves-additional-role-bindings', 'role-scope-changes-apply-immediately-and-admin-lockout-is-blocked')
  await db.update(users).set({ status: '禁用' }).where(eq(users.id, accounts.member.id))
  assert.equal(await getAccessibleProject(accounts.member.id, project.id), null)
  await expectCode(requireAccessibleProject(accounts.admin.id, project.id), 'PROJECT_FORBIDDEN')
  await expectCode(requireAccessibleProject(accounts.admin.id, randomUUID()), 'PROJECT_NOT_FOUND')
  const denied = await db.select().from(auditLogs).where(eq(auditLogs.userId, accounts.admin.id))
  assert.ok(denied.some((log) => log.action === '拒绝访问' && log.target === project.id))
  checks.push('disabled-identities-rejected', '403-404-and-nonsensitive-denial-audit')
  console.log(JSON.stringify({ ok: true, checks }))
} finally { await pool.end() }
