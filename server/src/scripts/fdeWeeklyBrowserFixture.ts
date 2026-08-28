// 只能由 fdeMigrationAcceptance 的随机前缀容器启动；无业务 workers、模型调用或 IM 外发。
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import express from 'express'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { assertIsolatedMysqlAcceptanceDatabase } from './mysqlAcceptanceSafety.js'

assertIsolatedMysqlAcceptanceDatabase('fdeWeeklyBrowserFixture')
assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.DB_FREFIX, process.env.FDE_ACCEPTANCE_PREFIX)
assert.ok(process.env.PROJECT_FILE_ROOT, '隔离浏览器必须使用父进程临时文件目录')
process.env.AUTH_COOKIE_SECURE = 'false'
process.env.AUTH_COOKIE_DOMAIN = ''
process.env.JWT_SECRET = randomUUID() + randomUUID()
// Terminal SIGINT plus the parent's forwarded SIGTERM may both arrive. Retain
// handlers through HTTP/Vite/pool drain, including repeated shutdown signals.
let stopFixture!: () => void
const fixtureStopped = new Promise<void>(resolve => { stopFixture = resolve })
process.on('SIGTERM', stopFixture); process.on('SIGINT', stopFixture)
const { db, pool } = await import('../db/client.js')
const { users, todos, projectFiles, projectFileVersions } = await import('../db/schema.js')
const { hashNewPassword } = await import('../security/passwordPolicy.js')
const { identityRepositories } = await import('../repositories/index.js')
const { createProject, classifyProject } = await import('../services/projectService.js')
const { proposeFdeGovernance } = await import('../services/fdeGovernanceService.js')
const { shanghaiToday, shiftDate, weekStartFor } = await import('../contracts/fdeWeeklyPlanContract.js')
const week = weekStartFor(shanghaiToday())
// 此口令仅用于已授权专用测试库的合成账户，夹具终止后随整前缀清理，不用于业务账号。
const passwordHash = await hashNewPassword('Fde-Browser-Fixture-Only-9!')
const actors = ['owner', 'secretary', 'member', 'leader', 'outsider', 'coordinator'].map((kind, i) => ({ id: randomUUID(), email: `${kind}@fde-browser.invalid`, name: ['验收项目负责人', '验收推进秘书', '验收执行成员', '验收批示领导', '验收其他成员', '验收时间协调人'][i], role: kind === 'leader' ? '董事长' : kind === 'coordinator' ? '时间协调人' : '投资经理', department: '临时浏览器验收', passwordHash }))
await db.insert(users).values(actors)
for (const actor of actors) await identityRepositories.users.synchronizeAdministrationBindings(actor.id, actor.role, actor.department)
let project = await createProject({ name: '周计划真实页面验收', owner: actors[0].name, ownerUserId: actors[0].id, collaborators: [], targetDate: shiftDate(week, 60) }, actors[0].id)
project = await classifyProject({ projectId: project.id, userId: actors[0].id, expectedVersion: project.version, toClassification: 'normal', reason: '浏览器隔离夹具初筛完成' })
await proposeFdeGovernance({ projectId: project.id, userId: actors[0].id, ownerUserId: actors[0].id, expectedVersion: project.governanceVersion, reason: '配置页面验收秘书和执行人', assignments: [{ duty: 'secretary', userId: actors[1].id }, { duty: 'member', userId: actors[2].id }, { duty: 'concerned_leader', userId: actors[3].id }, { duty: 'member', userId: actors[4].id }] })
await db.insert(todos).values({ projectId: project.id, projectName: project.name, title: '复用已存在的材料核对任务', owner: actors[2].name, ownerUserId: actors[2].id, dueDate: shiftDate(week, 3), deliverable: '材料核对清单', executionModel: 'fde-v1', createdBy: actors[0].id })
const { saveProjectFile } = await import('../services/projectFileStorageService.js')
const evidenceId = randomUUID(), evidenceBytes = Buffer.from('合成浏览器验收成果：已完成材料逐项核对。'), evidenceSha = createHash('sha256').update(evidenceBytes).digest('hex')
const evidencePath = await saveProjectFile(project.id, evidenceId, evidenceBytes)
await db.insert(projectFiles).values({ id: evidenceId, projectId: project.id, name: '隔离验收成果.txt', type: 'TXT', category: '项目资料', uploader: actors[2].name, uploadedBy: actors[2].id, storagePath: evidencePath, byteSize: evidenceBytes.length, sha256: evidenceSha })
await db.insert(projectFileVersions).values({ fileId: evidenceId, version: 1, storagePath: evidencePath, byteSize: evidenceBytes.length, sha256: evidenceSha, createdBy: actors[2].id })

if (process.env.FDE_TIMELINE_TIME_BROWSER_FIXTURE === '1') {
  const { leaderTimeRequests } = await import('../db/schema.js'), { eq } = await import('drizzle-orm')
  const { actOnLeaderTime } = await import('../services/fdeLeaderTimeService.js')
  const { saveFdePlan } = await import('../services/fdeWorkflowService.js')
  const { timeLocal } = await import('../contracts/fdeTimeContract.js')
  const [request] = await db.select().from(leaderTimeRequests).where(eq(leaderTimeRequests.projectId, project.id))
  assert.ok(request?.sourceTimelineTaskId, '浏览器夹具必须由真实流程生成领导时间')
  await actOnLeaderTime(request.id, actors[3].id, { clientRequestId: randomUUID(), expectedVersion: request.version, action: 'confirm', reason: '指定领导确认隔离流程时间需求' })
  await saveFdePlan({ projectId: project.id, userId: actors[0].id, cycleDays: project.cycleDays, targetDate: shiftDate(project.targetDate!, 1) })
  console.log(JSON.stringify({ timelineTimeFixture: request.id, weekStart: weekStartFor(timeLocal(request.preferredStart).slice(0, 10)) }))
}

if (process.env.FDE_TIMELINE_BROWSER_FIXTURE === '1') {
  const { userRoles } = await import('../db/schema.js'), { eq } = await import('drizzle-orm')
  const { bindFdeMaterial } = await import('../services/fdeWorkflowService.js')
  const savedRoles = await db.select().from(userRoles).where(eq(userRoles.userId, actors[1].id))
  await db.delete(userRoles).where(eq(userRoles.userId, actors[1].id))
  try { await bindFdeMaterial({ projectId: project.id, userId: actors[0].id, stage: '立项', requirementKey: 'business_plan', waiverReason: '隔离页面：源材料已保存，缺岗联动等待恢复' }) }
  finally { await db.insert(userRoles).values(savedRoles) }
}

if (process.env.FDE_AGENT_SCHEDULE_BROWSER_FIXTURE === '1' || process.env.FDE_MILESTONE_BROWSER_FIXTURE === '1') {
  const { projects, projectDutyAssignments, projectMembers } = await import('../db/schema.js'), { eq } = await import('drizzle-orm')
  const reviewer = { id: randomUUID(), email: 'president@fde-browser.invalid', name: '验收改期总裁', role: '总裁', department: '临时浏览器验收', passwordHash }
  await db.insert(users).values(reviewer)
  await identityRepositories.users.synchronizeAdministrationBindings(reviewer.id, reviewer.role, reviewer.department)
  await db.insert(projectDutyAssignments).values({ projectId: project.id, duty: 'president', userId: reviewer.id, assignedBy: actors[0].id })
  await db.insert(projectMembers).values({ projectId: project.id, userId: reviewer.id, memberRole: 'member', sourceName: reviewer.name })
  actors.push(reviewer)
  // Only the isolated fixture is adjusted: use a clean intake-stage date case.
  await db.update(projects).set({ name: '节点改期真实页面验收', stage: '入库', targetDate: shiftDate(shanghaiToday(), 80), cycleDays: 40 }).where(eq(projects.id, project.id))
  await db.update(todos).set({ dueDate: shiftDate(shanghaiToday(), 60) }).where(eq(todos.projectId, project.id))
  if (process.env.FDE_MILESTONE_BROWSER_FIXTURE === '1') {
    const { runProjectAgent, getProjectAgent, decideProjectAgent } = await import('../services/fdeProjectAgentService.js')
    const { submitAgentSchedule, actAgentSchedule } = await import('../services/fdeAgentScheduleService.js')
    await runProjectAgent(project.id, actors[0].id, { clientRequestId: randomUUID(), expectedConfigVersion: 0 })
    const rec = (await getProjectAgent(project.id, actors[0].id)).runs[0].recommendation!
    assert.ok(rec.suggestedDate)
    await decideProjectAgent(project.id, rec.id, actors[1].id, { clientRequestId: randomUUID(), expectedVersion: 1, decision: 'accepted' })
    const requestedDate = shiftDate(shanghaiToday(), 20)
    const approval = await submitAgentSchedule(project.id, rec.id, actors[0].id, { clientRequestId: randomUUID(), expectedVersion: 2, requestedDate, reason: '隔离页面验证已批准节点日期独立来源' })
    await actAgentSchedule(project.id, approval.id, reviewer.id, { clientRequestId: randomUUID(), expectedVersion: 1, action: 'approve', reason: '独立总裁批准隔离来源日期' })
    console.log(JSON.stringify({ milestoneBrowserProject: project.id, approvalId: approval.id, date: requestedDate, weekStart: weekStartFor(requestedDate), reportWeek: week }))
  }
}

if (process.env.FDE_MATERIAL_BROWSER_FIXTURE === '1') {
  const { setFdeFilePermissions } = await import('../services/fdeFileService.js')
  await setFdeFilePermissions(evidenceId, actors[0].id, { clientRequestId: randomUUID(), expectedVersion: 1, reason: '材料送审隔离页面验收', grants: [{ userId: actors[2].id, canView: true, canDownload: false }] })
}

if (process.env.FDE_KNOWLEDGE_BROWSER_FIXTURE === '1') {
  const { setFdeFilePermissions } = await import('../services/fdeFileService.js')
  await setFdeFilePermissions(evidenceId, actors[0].id, { clientRequestId: randomUUID(), expectedVersion: 1, reason: '公司知识隔离页面授权夹具', grants: [
    { userId: actors[0].id, canView: true, canDownload: true },
    { userId: actors[2].id, canView: true, canDownload: true },
    { userId: actors[1].id, canView: true, canDownload: false },
  ] })
}

if (process.env.FDE_ARCHIVE_BROWSER_FIXTURE === '1') {
  const { roles, userRoles } = await import('../db/schema.js')
  const extra = ['admin', 'mixed', 'empty'].map((kind, i) => ({ id: randomUUID(), email: `${kind}@fde-browser.invalid`, name: ['验收纯系统管理员', '验收协调兼业务', '验收无文件业务人员'][i], role: i === 0 ? '系统管理员' : i === 1 ? '时间协调人' : '投资经理', department: '临时浏览器验收', passwordHash }))
  await db.insert(users).values(extra)
  for (const actor of extra.slice(0, 2)) await identityRepositories.users.synchronizeAdministrationBindings(actor.id, actor.role, actor.department)
  const secondaryRole = randomUUID()
  await db.insert(roles).values({ id: secondaryRole, code: `archive-browser-${secondaryRole}`, name: `档案业务-${secondaryRole}`, fdeCategory: 'member', dataScope: 'self' })
  await db.insert(userRoles).values([{ userId: extra[1].id, roleId: secondaryRole, isPrimary: false }, { userId: extra[2].id, roleId: secondaryRole }])
  actors.push(...extra)
  const { addFile, setFileStoragePath } = await import('../services/projectService.js')
  const { saveProjectFileRevision } = await import('../services/projectFileStorageService.js')
  const { setFdeFilePermissions } = await import('../services/fdeFileService.js')
  await setFdeFilePermissions(evidenceId, actors[0].id, { clientRequestId: randomUUID(), expectedVersion: 1, reason: '档案只看与下载权限夹具', grants: [{ userId: actors[0].id, canView: true, canDownload: true }, { userId: actors[2].id, canView: true, canDownload: false }] })
  const archiveIds: string[] = []
  for (let i = 1; i <= 13; i++) {
    const bytes = Buffer.from(`档案合成原件第 ${i} 份，不包含真实业务数据。`)
    const file = await addFile({ projectId: project.id, name: `档案验收-${String(i).padStart(2, '0')}.txt`, type: 'TXT', category: i % 2 ? '业务尽调' : '财务尽调', uploader: actors[0].name, byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, actors[0].id)
    await setFileStoragePath(file.id, await saveProjectFileRevision(project.id, file.id, bytes), actors[0].id)
    await setFdeFilePermissions(file.id, actors[0].id, { clientRequestId: randomUUID(), expectedVersion: 1, reason: '档案页面授权及审计夹具', grants: [{ userId: actors[0].id, canView: true, canDownload: true }, ...(i % 3 === 0 ? [] : [{ userId: actors[2].id, canView: true, canDownload: i % 3 === 1 }])] })
    archiveIds.push(file.id)
  }
  console.log(JSON.stringify({ archiveFixture: true, projectId: project.id, fileIds: archiveIds, viewOnlyFileId: evidenceId }))
}

if (process.env.FDE_OFFICE_BROWSER_FIXTURE === '1') {
  const { userRoles } = await import('../db/schema.js'), { eq } = await import('drizzle-orm')
  const { saveOfficePolicy, publishOfficePolicy, listOfficePolicies } = await import('../services/fdeOfficePolicyService.js')
  const { officeKinds } = await import('../contracts/fdeOfficeContract.js')
  const officeActors = ['admin', 'finance', ...(process.env.FDE_OFFICE_INBOX_BROWSER_FIXTURE === '1' ? ['finance2'] : [])].map((kind, i) => ({ id: randomUUID(), email: `${kind}@fde-browser.invalid`, name: ['验收办公规则管理员', '验收财务审批人', '验收第二会签人'][i], role: i ? '财务' : '系统管理员', department: '临时浏览器验收', passwordHash }))
  await db.insert(users).values(officeActors)
  for (const actor of officeActors) await identityRepositories.users.synchronizeAdministrationBindings(actor.id, actor.role, actor.department)
  actors.push(...officeActors)
  const reviewer = officeActors[1], roleId = (await db.select().from(userRoles).where(eq(userRoles.userId, reviewer.id)))[0].roleId
  for (const kind of officeKinds) {
    const id = randomUUID(), configuration = { kind, requiredFields: [], attachmentRequired: false, rejectResubmission: false, routes: [{ key: 'default', when: {}, nodes: [{ key: 'review', name: '隔离财务审核', roleIds: [roleId], scope: 'institution', mode: '或签', fixedUserIds: [reviewer.id], allowTransfer: true }] }] }
    if (process.env.FDE_OFFICE_INBOX_BROWSER_FIXTURE === '1') {
      configuration.routes[0].nodes[0].mode = '会签'
      configuration.routes[0].nodes[0].fixedUserIds.push(officeActors[2].id)
      const leaderRole = (await db.select().from(userRoles).where(eq(userRoles.userId, actors[3].id)))[0].roleId
      configuration.routes[0].nodes.push({ key: 'leader', name: '会签后领导审核', roleIds: [leaderRole], scope: 'institution', mode: '或签', fixedUserIds: [actors[3].id], allowTransfer: false })
    }
    await saveOfficePolicy(id, officeActors[0].id, { clientRequestId: randomUUID(), expectedVersion: 0, configuration, reason: '合成浏览器规则，不代表生产政策' })
    const head = (await listOfficePolicies(officeActors[0].id)).find(p => p.kind === kind)!
    await publishOfficePolicy(id, officeActors[0].id, { clientRequestId: randomUUID(), expectedVersion: 1, expectedPolicyVersion: head.version, reason: '隔离浏览器演练明确发布' })
  }
  if (process.env.FDE_OFFICE_INBOX_BROWSER_FIXTURE === '1') {
    const { officeDefinition } = await import('../contracts/fdeOfficeContract.js')
    const { saveOfficeRequest, previewOfficeRequest, actOnOfficeRequest } = await import('../services/fdeOfficeService.js')
    const id = randomUUID(), definition = officeDefinition.parse({ title: '会签中间态工作台验收合同', reason: '合成合同，验证第二会签人仍有当前待办', projectId: null, priority: '普通', details: { kind: '合同' }, attachmentIds: [] })
    await saveOfficeRequest(id, actors[0].id, { clientRequestId: randomUUID(), expectedVersion: 0, definition })
    const preview = await previewOfficeRequest(id, actors[0].id)
    await actOnOfficeRequest(id, actors[0].id, { clientRequestId: randomUUID(), expectedVersion: 1, action: 'submit', reason: '提交隔离会签浏览器验收', expectedPolicyVersionId: preview.policyVersionId, expectedRouteHash: preview.routeHash, confirmAttachmentSharing: true })
    await actOnOfficeRequest(id, reviewer.id, { clientRequestId: randomUUID(), expectedVersion: 2, action: 'approve', reason: '首位会签人已完成，第二人须继续可见' })
    console.log(JSON.stringify({ officeInboxRequestId: id, remainingApprover: officeActors[2].email }))
  }
  if (process.env.FDE_APPROVAL_CENTER_BROWSER_FIXTURE === '1') {
    const { seedApprovalCenterFixture } = await import('./fdeApprovalCenterFixture.js')
    const fixture = await seedApprovalCenterFixture(actors[0], reviewer, roleId)
    console.log(JSON.stringify({ approvalCenterFixture: fixture.marker, rows: fixture.rows.length, projectId: fixture.projectId }))
  }
  if (process.env.FDE_OFFICE_SOURCES_BROWSER_FIXTURE === '1') {
    const { saveOfficeRequest, previewOfficeRequest, actOnOfficeRequest } = await import('../services/fdeOfficeService.js')
    const sourceIds: string[] = []
    for (const [title, details] of [
      ['获批出差日历来源验收', { kind: '出差', travelerIds: [actors[0].id], startDate: week, endDate: shiftDate(week, 1) }],
      ['获批请假日历来源验收', { kind: '请假', startAt: `${shiftDate(week, 3)}T09:00`, endAt: `${shiftDate(week, 3)}T10:30` }],
    ] as const) {
      const id = randomUUID()
      await saveOfficeRequest(id, actors[0].id, { clientRequestId: randomUUID(), expectedVersion: 0, definition: { title, reason: '合成办公安排，审批不代表实际执行完成', projectId: null, priority: '普通', details, attachmentIds: [] } })
      const preview = await previewOfficeRequest(id, actors[0].id)
      await actOnOfficeRequest(id, actors[0].id, { clientRequestId: randomUUID(), expectedVersion: 1, action: 'submit', reason: '提交隔离来源验收申请', expectedPolicyVersionId: preview.policyVersionId, expectedRouteHash: preview.routeHash, confirmAttachmentSharing: true })
      await actOnOfficeRequest(id, reviewer.id, { clientRequestId: randomUUID(), expectedVersion: 2, action: 'approve', reason: '独立财务确认隔离申请' })
      sourceIds.push(id)
    }
    console.log(JSON.stringify({ officeSources: sourceIds, weekStart: week }))
  }
}

// Optional synthetic confirmed-time fixture for final-render regressions; never enabled in the app.
if (process.env.FDE_TIME_BROWSER_FIXTURE === '1') {
  const { createLeaderTime, actOnLeaderTime } = await import('../services/fdeLeaderTimeService.js')
  const { previewAutoSchedule, applyAutoSchedule } = await import('../services/fdeAutoScheduleService.js')
  const { writeCalendarEvent } = await import('../services/fdeCalendarService.js')
  const day = shiftDate(shanghaiToday(), 1), targetWeek = weekStartFor(day)
  const request = await createLeaderTime(actors[0].id, { clientRequestId: randomUUID(), projectId: project.id, leaderId: actors[3].id, title: '确认态与日历回归夹具', reason: '需要领导确认真实沟通方向', outcome: '明确下一步工作', impact: '延后影响项目沟通', priority: 'P0', latestFinish: `${day}T18:00`, preferredStart: `${day}T10:00`, alternativeStart: `${day}T14:00`, durationMinutes: 60, location: '线上会议' })
  await actOnLeaderTime(request.id, actors[0].id, { clientRequestId: randomUUID(), expectedVersion: 1, action: 'submit', reason: '提交隔离时间需求' })
  const selection = { weekStart: targetWeek, requests: [{ id: request.id, expectedVersion: 2 }] }, preview = await previewAutoSchedule(actors[5].id, selection)
  await applyAutoSchedule(actors[5].id, { clientRequestId: randomUUID(), selection, fingerprint: preview.fingerprint })
  await actOnLeaderTime(request.id, actors[3].id, { clientRequestId: randomUUID(), expectedVersion: 3, action: 'confirm', reason: '指定领导确认夹具排期' })
  await writeCalendarEvent(actors[3].id, { clientRequestId: randomUUID(), definition: { title: '不能向其他人展示的私密安排', detail: '隔离隐私正文', startsAt: `${day}T16:00`, endsAt: `${day}T17:00`, visibility: 'private' } })
}

const { authRouter } = await import('../routes/auth.js')
if (process.env.FDE_COMMITTEE_BROWSER_FIXTURE === '1') {
  const { seedCommitteeBrowser } = await import('./fdeCommitteeBrowserFixture.js')
  console.log(JSON.stringify({ committeeBrowser: await seedCommitteeBrowser(actors[0], actors[2], actors[4]) }))
}
if (process.env.FDE_RESPONSIBILITY_BROWSER_FIXTURE === '1' || process.env.FDE_RESPONSIBILITY_POLICY_BROWSER_FIXTURE === '1' || process.env.FDE_TYPE_POLICY_BROWSER_FIXTURE === '1' || process.env.FDE_TYPE_RUNTIME_BROWSER_FIXTURE === '1') {
  let admin = actors.find(actor => actor.email === 'admin@fde-browser.invalid')
  if (!admin) {
    admin = { id: randomUUID(), email: 'admin@fde-browser.invalid', name: '验收责任规则管理员', role: '系统管理员', department: '临时浏览器验收', passwordHash }
    await db.insert(users).values(admin)
    await identityRepositories.users.synchronizeAdministrationBindings(admin.id, admin.role, admin.department)
    actors.push(admin)
  }
  if (process.env.FDE_TYPE_RUNTIME_BROWSER_FIXTURE === '1') {
    const { seedTypeRuntimeBrowser } = await import('./fdeTypeRuntimeBrowserFixture.js')
    console.log(JSON.stringify({ typeRuntimeBrowser: await seedTypeRuntimeBrowser(actors[0], actors[1], actors[3], admin.id) }))
  }
  if (process.env.FDE_RESPONSIBILITY_BROWSER_FIXTURE === '1') {
    const { seedResponsibilityBrowser } = await import('./fdeResponsibilityBrowserFixture.js')
    await seedResponsibilityBrowser(project.id, actors[0].id, actors[2].id, actors[3].id, admin.id, evidenceId)
  }
  if (process.env.FDE_RESPONSIBILITY_POLICY_BROWSER_FIXTURE === '1') {
    const { userRoles } = await import('../db/schema.js'), { eq } = await import('drizzle-orm')
    const mixed = { id: randomUUID(), email: 'mixed@fde-browser.invalid', name: '验收配置兼业务领导', role: '系统管理员', department: '临时浏览器验收', passwordHash }
    await db.insert(users).values(mixed); await identityRepositories.users.synchronizeAdministrationBindings(mixed.id, mixed.role, mixed.department)
    const leaderRole = (await db.select().from(userRoles).where(eq(userRoles.userId, actors[3].id)))[0].roleId
    await db.insert(userRoles).values({ userId: mixed.id, roleId: leaderRole, isPrimary: false }); actors.push(mixed)
  }
}
const { responsibilityRouter } = await import('../routes/responsibility.js')
const { responsibilityPoliciesRouter } = await import('../routes/responsibilityPolicies.js')
const { fdeTypePoliciesRouter } = await import('../routes/fdeTypePolicies.js')
const { committeeRouter } = await import('../routes/committee.js')
const { projectsRouter } = await import('../routes/projects.js')
const { weeklyReportsRouter } = await import('../routes/weeklyReports.js')
const { companyKnowledgeRouter } = await import('../routes/companyKnowledge.js')
const { projectArchivesRouter } = await import('../routes/projectArchives.js')
const { dataKnowledgeRouter } = await import('../routes/dataKnowledge.js')
const { leaderTimeRouter, calendarRouter } = await import('../routes/fdeTime.js')
const { meetingsRouter, todosRouter } = await import('../routes/meetings.js')
const { oaRouter } = await import('../routes/oa.js')
const { systemAdministrationRouter } = await import('../routes/systemAdministration.js')
const { risksRouter } = await import('../routes/risks.js')
const { metaRouter } = await import('../routes/meta.js')
const { requireAuth } = await import('../middleware/requireAuth.js')
const { errorHandler } = await import('../middleware/errorHandler.js')
const app = express()
app.use(express.json({ limit: '2mb' }))
app.use('/api', (req, res, next) => req.path === '/auth/login' ? next() : requireAuth(req, res, next))
app.use('/api/auth', authRouter)
if (process.env.FDE_RESPONSIBILITY_RESPONSE_LOSS_FIXTURE === '1') {
  const { responsibilityResponseLossFixture } = await import('./fdeResponsibilityResponseLossFixture.js')
  app.use(responsibilityResponseLossFixture(['after-commit', 'before-commit']))
}
app.use('/api/responsibility', responsibilityRouter)
if (process.env.FDE_RESPONSIBILITY_POLICY_RESPONSE_LOSS_FIXTURE === '1') {
  const { responsibilityPolicyResponseLossFixture } = await import('./fdeResponsibilityPolicyResponseLossFixture.js')
  app.use(responsibilityPolicyResponseLossFixture(['after-commit', 'before-commit']))
}
app.use('/api/responsibility-policies', responsibilityPoliciesRouter)
app.use('/api/fde-type-policies', fdeTypePoliciesRouter)
app.use('/api/committee', committeeRouter)
if (process.env.FDE_MATERIAL_RESPONSE_LOSS_FIXTURE === '1') {
  const { materialResponseLossFixture } = await import('./fdeMaterialResponseLossFixture.js')
  app.use(materialResponseLossFixture(['after-commit', 'before-commit']))
  console.log('隔离材料响应故障夹具：首笔提交后丢响应，第二笔提交前丢响应；不用于业务服务。')
}
if (process.env.FDE_OFFICE_RESPONSE_LOSS_FIXTURE === '1') {
  const { officeResponseLossFixture } = await import('./fdeOfficeResponseLossFixture.js')
  app.use(officeResponseLossFixture(['after-commit', 'before-commit'], false))
  console.log('隔离办公响应故障夹具：首笔业务写入提交后丢响应，第二笔提交前丢响应；恢复请求不注入故障，不用于业务服务。')
}
if (process.env.FDE_OFFICE_POLICY_RESPONSE_LOSS_FIXTURE === '1') {
  const { officePolicyResponseLossFixture } = await import('./fdeOfficeResponseLossFixture.js')
  app.use(officePolicyResponseLossFixture(['after-commit', 'before-commit']))
  console.log('隔离规则故障夹具：首笔提交后丢响应，第二笔提交前丢响应；核对不注入故障。')
}
app.use('/api/projects', projectsRouter)
app.use('/api/weekly-reports', weeklyReportsRouter)
if (process.env.FDE_KNOWLEDGE_RESPONSE_LOSS_FIXTURE === '1') {
  const { knowledgeResponseLossFixture } = await import('./fdeKnowledgeResponseLossFixture.js')
  app.use(knowledgeResponseLossFixture(['after-commit', 'before-commit']))
  console.log('隔离知识故障夹具：首笔提交后丢响应，第二笔提交前丢响应；核对不注入故障。')
}
app.use('/api/company-knowledge', companyKnowledgeRouter)
app.use('/api/project-archives', projectArchivesRouter)
app.use('/api/data-knowledge', dataKnowledgeRouter)
app.use('/api/leader-time', leaderTimeRouter)
app.use('/api/calendar', calendarRouter)
app.use('/api/meetings', meetingsRouter)
app.use('/api/todos', todosRouter)
app.use('/api/oa', oaRouter)
app.use('/api/system-administration', systemAdministrationRouter)
app.use('/api/risks', risksRouter)
app.use('/api', metaRouter)
app.use('/api', (_req, res) => { res.status(404).json({ code: 'FIXTURE_ROUTE_NOT_ENABLED', message: '该路由不属于本次隔离验收范围' }) })
app.use(errorHandler)
const vite = await createServer({ configFile: false, cacheDir: path.resolve(process.env.PROJECT_FILE_ROOT!, '..', 'vite-cache'), plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false }, appType: 'spa' })
app.use(vite.middlewares)
const server = app.listen(0, '127.0.0.1')
await new Promise<void>((resolve) => server.once('listening', resolve))
const port = (server.address() as AddressInfo).port
process.env.AUTH_ALLOWED_ORIGINS = `http://127.0.0.1:${port}`
console.log(JSON.stringify({ fixture: 'fde-weekly-browser', prefix: process.env.DB_FREFIX, url: `http://127.0.0.1:${port}/collaboration?project=${project.id}`, projectId: project.id, actors: actors.map(({ email, name }) => ({ email, name })), autoStopMinutes: 20 }))
const exitFixture = process.env.FDE_ACCEPTANCE_FIXTURE_EXIT
assert.ok(!exitFixture || ['normal', 'failure'].includes(exitFixture), '未知隔离退出演练模式')
if (exitFixture) { if (exitFixture === 'failure') process.exitCode = 1; stopFixture() }
const fixtureTimer = setTimeout(stopFixture, 20 * 60 * 1000)
await fixtureStopped
clearTimeout(fixtureTimer)
// Stop accepting requests first, close Vite's long-lived connections before waiting
// for HTTP drain, then bound fixture-only active connections. Otherwise one browser
// request can prevent the parent's isolated-table cleanup forever.
const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
const forceFixtureConnections = setTimeout(() => server.closeAllConnections(), 1500)
try { await vite.close(); await closed }
finally { clearTimeout(forceFixtureConnections) }
await pool.end()
console.log(JSON.stringify({ fixtureDrainResources: process.getActiveResourcesInfo() }))
console.log('隔离浏览器服务已停止；父进程将清理该随机前缀。')
process.removeListener('SIGTERM', stopFixture); process.removeListener('SIGINT', stopFixture)
