import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import bcrypt from 'bcryptjs'
import { and, asc, eq, sql } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { auditLogs, fdeTypeInstances, fdeTypeExecutionReviews, fdeTypeExecutionEvents, fdeTypeExecutionCommands, fdeWorkflowPolicies, fdeWorkflowPolicyVersions, leads, projectDutyAssignments, projectFiles, projectFileVersions, projectMembers, projectPlanActions, projectPlans, projects, todoFeedbacks, todos, users } from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'
import { executeTypePolicy, getTypePolicy, listTypePolicies } from '../services/fdeTypePolicyService.js'
import { executeTypeRuntime, getTypeRuntime, recoverTypeRuntime } from '../services/fdeTypeRuntimeService.js'
import { feedbackFdeTask, decideFdeTask } from '../services/fdeTaskService.js'
import { fileDeletionBlockers } from '../services/fdeFileService.js'
import { saveProjectFile } from '../services/projectFileStorageService.js'
import { typePolicyFixture } from './fdeTypePolicyFixture.js'
import { policyHash } from '../services/fdeWorkflowPolicyService.js'
import { listApprovalCenter } from '../services/fdeApprovalCenterService.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
assert.ok(process.env.PROJECT_FILE_ROOT)
const checks: string[] = [], mark = randomUUID().slice(0, 8)
const password = `Isolated-${randomUUID()}!`, passwordHash = await bcrypt.hash(password, 10)
let server: Server | undefined
const actors = ['系统管理员', '投资经理', '投资经理', '董事长', '投资经理'].map((role, i) => ({ id: randomUUID(), email: `type-runtime-${mark}-${i}@accept.invalid`, name: `执行实例-${i}-${mark}`, role, department: '隔离验收', passwordHash }))
const [admin, owner, secretary, leader, outsider] = actors
const reject = (p: Promise<unknown>, code: string) => assert.rejects(p, e => (e as { code?: string }).code === code)
try {
  const oldProjects = await db.select().from(projects).orderBy(asc(projects.id)), oldTasks = await db.select().from(todos).orderBy(asc(todos.id)), oldLeads = await db.select().from(leads).orderBy(asc(leads.id))
  await db.insert(users).values(actors)
  for (const actor of actors) await identityRepositories.users.synchronizeAdministrationBindings(actor.id, actor.role, actor.department)
  const config = typePolicyFixture(); config.planApprovals = [{ duty: 'owner', name: '负责人核对计划', mode: '会签' }, { duty: 'concerned_leader', name: '独立领导审核计划', mode: '会签' }]
  config.stages[0].key = 's' + 'x'.repeat(47); config.actions[0].stageKey = config.stages[0].key
  config.actions.forEach(a => { a.needLeader = false; a.deliverable = '验'.repeat(2000) })
  const head = (await listTypePolicies(admin.id)).policies.find(p => p.code === 'noninvestment:fundraising')
  const created = await executeTypePolicy(admin.id, { action: 'create', commandId: randomUUID(), expectedPolicyVersion: head?.version ?? 0, configuration: config, reason: '隔离合成执行模板，不用于业务环境' })
  const approved = await executeTypePolicy(leader.id, { action: 'approve', commandId: randomUUID(), policyId: created.policyId, versionId: created.versionId, expectedVersion: created.version, reason: '隔离独立复核模板定义' })
  const published = await executeTypePolicy(admin.id, { action: 'publish', commandId: randomUUID(), policyId: created.policyId, versionId: created.versionId, expectedVersion: approved.version, expectedPolicyVersion: approved.policyVersion, reason: '隔离发布版本，正式规则仍未启用' })
  const definition = (await getTypePolicy(admin.id, created.policyId)).versions.find(v => v.id === created.versionId)!
  const projectId = randomUUID()
  // Already-bound synthetic project only, not a production registration path.
  await db.insert(projects).values({ id: projectId, name: `隔离执行实例-${mark}`, owner: owner.name, ownerUserId: owner.id, createdBy: owner.id, workflowModel: 'fde-v1', projectType: '基金募资项目', workflowPolicyVersionId: definition.id, stage: config.stages[0].name, classification: 'normal', lifecycle: 'active', targetDate: '2026-10-30', cycleDays: 50 })
  await db.insert(projectMembers).values([owner, secretary, leader].map(p => ({ projectId, userId: p.id, memberRole: p === owner ? 'owner' : 'member', sourceName: p.name })))
  await db.insert(projectDutyAssignments).values([{ projectId, userId: secretary.id, duty: 'secretary', assignedBy: owner.id }, { projectId, userId: leader.id, duty: 'concerned_leader', assignedBy: owner.id }])
  const plan = { expectedProjectVersion: 1, expectedGovernanceVersion: 1, expectedPolicyVersionId: definition.id, expectedPolicySha256: definition.sha256, cycleDays: 50, targetDate: '2026-10-30', selections: [{ actionKey: config.actions[0].key, userId: secretary.id, dueTime: '18:07' }, { actionKey: config.actions[1].key, userId: owner.id, dueTime: '19:13' }] }
  const command = (action: string, expectedVersion: number, rest: object = {}) => ({ action, commandId: randomUUID(), expectedVersion, reason: '隔离业务状态核对与办理', ...rest })
  const get = () => getTypeRuntime(projectId, secretary.id)
  const countTasks = () => db.select().from(todos).where(eq(todos.projectId, projectId))
  const saved = command('save_plan', 0, { plan })
  await reject(executeTypeRuntime(projectId, admin.id, saved), 'TYPE_RUNTIME_FORBIDDEN')
  await reject(getTypeRuntime(projectId, outsider.id), 'TYPE_RUNTIME_FORBIDDEN')
  assert.equal((await get()).instance, null)
  const race = await Promise.allSettled([executeTypeRuntime(projectId, secretary.id, saved), executeTypeRuntime(projectId, secretary.id, command('save_plan', 0, { plan }))])
  assert.equal(race.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal((await get()).instance!.version, 1); assert.equal((await countTasks()).length, 0)
  checks.push('project-first-lock:concurrent-initialization-one-instance:no-draft-tasks:admin-outsider-denied')
  // Use a deterministic committed command for recovery regardless of race winner.
  const { requireAuth } = await import('../middleware/requireAuth.js'), { errorHandler } = await import('../middleware/errorHandler.js'), { authRouter } = await import('../routes/auth.js'), { projectsRouter } = await import('../routes/projects.js')
  const app = express(); app.use(express.json()); app.use('/api', (req, res, next) => req.path === '/auth/login' ? next() : requireAuth(req, res, next)); app.use('/api/auth', authRouter)
  let loseResponse = false
  app.use(`/api/projects/${projectId}/type-execution/commands`, (req, res, next) => { if (req.path === '/' && loseResponse) { loseResponse = false; res.json = (() => { res.destroy(); return res }) as typeof res.json }; next() })
  const { oaRouter } = await import('../routes/oa.js')
  let loseNoticeResponse = false
  app.use('/api/oa/type-notices', (req, res, next) => { if (req.method === 'POST' && loseNoticeResponse) { loseNoticeResponse = false; res.json = (() => { res.destroy(); return res }) as typeof res.json }; next() })
  app.use('/api/projects', projectsRouter); app.use('/api/oa', oaRouter); app.use(errorHandler)
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server!.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, url = `${base}/api/projects/${projectId}/type-execution`; process.env.AUTH_ALLOWED_ORIGINS = base
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: secretary.email, password }) }); assert.equal(login.status, 200)
  const cookies = login.headers.getSetCookie(), csrf = decodeURIComponent(cookies.find(s => s.startsWith('cybernaut_csrf='))!.split(';')[0].slice('cybernaut_csrf='.length))
  const headers = { Cookie: cookies.map(s => s.split(';')[0]).join('; '), 'X-CSRF-Token': csrf, 'Content-Type': 'application/json', Origin: base }
  const post = (path: string, body: unknown, extra = {}) => fetch(`${url}${path}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) })
  assert.equal((await fetch(url)).status, 401)
  const read = await fetch(url, { headers }); assert.equal(read.status, 200); assert.equal(read.headers.get('cache-control'), 'private, no-store'); assert.equal(read.headers.get('x-content-type-options'), 'nosniff'); await read.json()
  const resave = command('save_plan', 1, { plan })
  assert.equal((await post('/commands', resave, { 'X-CSRF-Token': '' })).status, 403)
  assert.equal((await post('/commands', resave, { Origin: 'https://invalid.example' })).status, 403)
  assert.equal((await post('/commands', { ...resave, actorId: owner.id })).status, 400)
  assert.equal((await get()).instance!.version, 1)
  loseResponse = true; await assert.rejects(post('/commands', resave))
  const recovered = await post('/commands/recover', { commandId: resave.commandId }); assert.equal(recovered.status, 200)
  const recovery = await recovered.json(); assert.equal(recovery.state, 'committed'); const receipt = recovery.receipt
  const replayResponse = await post('/commands', resave); assert.equal(replayResponse.status, 200); assert.deepEqual(await replayResponse.json(), receipt)
  checks.push('authenticated-runtime-HTTP:session-CSRF-Origin-strict-body:no-store-nosniff:commit-response-loss-recovery-and-replay')
  assert.deepEqual(await executeTypeRuntime(projectId, secretary.id, resave), receipt)
  assert.deepEqual(await recoverTypeRuntime(projectId, secretary.id, { commandId: resave.commandId }), { state: 'committed', receipt })
  await reject(executeTypeRuntime(projectId, secretary.id, { ...resave, reason: '同编号更换内容不得执行' }), 'TYPE_RUNTIME_COMMAND_REUSED')
  const late = command('save_plan', 2, { plan }); assert.equal((await recoverTypeRuntime(projectId, secretary.id, { commandId: late.commandId })).state, 'not_committed')
  await reject(executeTypeRuntime(projectId, secretary.id, late), 'TYPE_RUNTIME_COMMAND_CLOSED')
  checks.push('same-command-replay:minimal-receipt-recovery:late-command-fence:different-payload-rejected')

  const submit = await executeTypeRuntime(projectId, secretary.id, command('submit_plan', 2))
  let view = await get(), review = view.reviews[0]
  const ownerLogin = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ email: owner.email, password }) }); assert.equal(ownerLogin.status, 200)
  const ownerCookies = ownerLogin.headers.getSetCookie(), ownerCsrf = decodeURIComponent(ownerCookies.find(s => s.startsWith('cybernaut_csrf='))!.split(';')[0].slice('cybernaut_csrf='.length))
  const ownerHeaders = { Cookie: ownerCookies.map(s => s.split(';')[0]).join('; '), 'X-CSRF-Token': ownerCsrf, 'Content-Type': 'application/json', Origin: base }
  const inboxUrl = `${base}/api/oa/center?view=pending&q=${encodeURIComponent(`隔离执行实例-${mark}`)}`
  assert.equal((await fetch(inboxUrl)).status, 401)
  const inboxResponse = await fetch(inboxUrl, { headers: ownerHeaders }); assert.equal(inboxResponse.status, 200)
  assert.equal(inboxResponse.headers.get('cache-control'), 'private, no-store'); assert.equal(inboxResponse.headers.get('x-content-type-options'), 'nosniff')
  const inbox = await inboxResponse.json(); assert.equal(inbox.total, 1); assert.equal(inbox.list[0].id, review.id)
  const noticeId = inbox.list[0].notice.id, readNoticeUrl = `${base}/api/oa/type-notices/${noticeId}/read`
  const noticePost = (body = {}, overrides = {}) => fetch(readNoticeUrl, { method: 'POST', headers: { ...ownerHeaders, ...overrides }, body: JSON.stringify(body) })
  assert.equal((await noticePost({}, { 'X-CSRF-Token': '' })).status, 403)
  assert.equal((await noticePost({}, { Origin: 'https://invalid.example' })).status, 403)
  assert.equal((await noticePost({ actorId: owner.id })).status, 400)
  assert.equal((await fetch(readNoticeUrl, { method: 'POST', headers, body: '{}' })).status, 403)
  loseNoticeResponse = true; await assert.rejects(noticePost())
  const retryRead = await noticePost(); assert.equal(retryRead.status, 200); assert.equal(retryRead.headers.get('cache-control'), 'private, no-store')
  assert.ok((await retryRead.json()).readAt); assert.equal((await listApprovalCenter(owner.id, { view: 'pending', q: `隔离执行实例-${mark}` })).total, 1)
  assert.equal((await get()).instance!.version, view.instance!.version)
  const exact = await fetch(`${url}?review=${review.id}`, { headers: ownerHeaders }); assert.equal(exact.status, 200); assert.equal((await exact.json()).reviews[0].id, review.id)
  checks.push('type-inbox-authenticated-HTTP:CSRF-Origin-actor-body-no-store:read-response-loss-idempotent:exact-review-deep-link')
  await reject(executeTypeRuntime(projectId, secretary.id, command('decide', submit.version, { requestId: review.id, expectedReviewVersion: review.version, decision: 'approve' })), 'TYPE_EXECUTION_REVIEW_FORBIDDEN')
  await executeTypeRuntime(projectId, owner.id, command('decide', view.instance!.version, { requestId: review.id, expectedReviewVersion: review.version, decision: 'approve' }))
  view = await get(); review = view.reviews[0]
  assert.equal(view.instance!.status, 'plan_review'); assert.equal((await countTasks()).length, 0)
  await reject(executeTypeRuntime(projectId, leader.id, command('decide', view.instance!.version, { requestId: review.id, expectedReviewVersion: review.version, decision: 'approve' })), 'TYPE_RUNTIME_POLICY_DISABLED')
  assert.equal((await get()).instance!.version, view.instance!.version)
  checks.push('explicit-plan-policy:sequential-review:no-self-approval:disabled-policy-cannot-materialize')
  await assert.rejects(db.insert(projectPlans).values({ projectId, revision: 999, status: 'draft', cycleDays: 50, targetDate: '2026-10-30', createdBy: owner.id }), e => String((e as { cause?: { message?: string } }).cause?.message).includes('ck_fde_plan_cycle'))
  checks.push('database-investment-cycle-guard-retained:default-investment-plan-still-rejects-50-days')

  // This fixture enables only its synthetic random-prefix definition. There is
  // deliberately no production activation API or business prefix write here.
  await db.update(fdeWorkflowPolicies).set({ enabled: true }).where(eq(fdeWorkflowPolicies.id, published.policyId))
  const publishCommand = command('decide', view.instance!.version, { requestId: review.id, expectedReviewVersion: review.version, decision: 'approve' })
  // Force a late audit insert failure, proving tasks/plan/review roll back.
  const eventId = randomUUID(), nextVersion = view.instance!.version + 1
  await db.insert(fdeTypeExecutionEvents).values({ id: eventId, projectId, actorId: secretary.id, commandId: randomUUID(), action: 'save_plan', version: nextVersion, reason: '仅隔离后段故障注入', snapshot: {} })
  await assert.rejects(executeTypeRuntime(projectId, leader.id, publishCommand))
  assert.equal((await countTasks()).length, 0)
  assert.equal((await db.select().from(projectPlans).where(eq(projectPlans.projectId, projectId))).length, 0)
  assert.equal((await get()).instance!.version, view.instance!.version)
  await db.delete(fdeTypeExecutionEvents).where(eq(fdeTypeExecutionEvents.id, eventId))
  await executeTypeRuntime(projectId, leader.id, publishCommand)
  await executeTypeRuntime(projectId, leader.id, publishCommand)
  view = await get()
  assert.equal(view.instance!.status, 'active'); assert.equal((await countTasks()).length, 2)
  const actions = await db.select().from(projectPlanActions).where(eq(projectPlanActions.planId, view.instance!.planId!))
  assert.ok(actions.every(a => a.deliverable.length === 2000))
  assert.equal(view.instance!.stageKey.length, 48)
  assert.deepEqual(new Set((await countTasks()).map(t => t.dueTime)), new Set(['18:07', '19:13']))
  checks.push('final-plan-approval-atomic:late-sql-failure-rolls-back:unique-real-tasks:2000-char-outcomes:48-char-stage:exact-time')

  const fileId = randomUUID(), bytes = Buffer.from(`真实隔离执行成果-${mark}`), sha256 = createHash('sha256').update(bytes).digest('hex')
  const storagePath = await saveProjectFile(projectId, fileId, bytes)
  await db.insert(projectFiles).values({ id: fileId, projectId, name: '隔离阶段成果.txt', type: 'TXT', category: '项目资料', uploader: secretary.name, uploadedBy: secretary.id, storagePath, byteSize: bytes.length, sha256 })
  await db.insert(projectFileVersions).values({ fileId, version: 1, storagePath, byteSize: bytes.length, sha256, createdBy: secretary.id })
  const stageSubmit = () => command('submit_stage', view.instance!.version, { stageKey: view.instance!.stageKey, expectedGovernanceVersion: view.governanceVersion, result: '当前阶段成果及原件已核对', materials: config.stages.find(s => s.key === view.instance!.stageKey)!.materials.map(m => ({ requirementKey: m.key, kind: 'file', fileId, version: 1 })) })
  await reject(executeTypeRuntime(projectId, secretary.id, stageSubmit()), 'TYPE_RUNTIME_TASK_INCOMPLETE')
  await assert.rejects(executeTypeRuntime(projectId, secretary.id, { ...stageSubmit(), tasks: [{ status: '已完成' }] }))
  async function completeTask(actionKey: string, performer: typeof owner, acceptor: typeof owner) {
    const [row] = await db.select({ task: todos }).from(todos).innerJoin(projectPlanActions, eq(projectPlanActions.id, todos.planActionId)).where(and(eq(todos.projectId, projectId), eq(projectPlanActions.actionKey, actionKey)))
    await feedbackFdeTask(projectId, row.task.id, performer.id, { expectedVersion: row.task.version, kind: 'submission', progress: 100, result: '真实成果提交并申请独立验收', evidence: [{ fileId, version: 1 }] })
    const [task] = await db.select().from(todos).where(eq(todos.id, row.task.id)), [feedback] = await db.select().from(todoFeedbacks).where(eq(todoFeedbacks.todoId, task.id)).orderBy(asc(todoFeedbacks.taskVersion))
    await reject(decideFdeTask(projectId, task.id, performer.id, { expectedVersion: task.version, feedbackId: feedback.id, action: 'accept', reason: '本人验收不得通过' }), 'FDE_TASK_SELF_ACCEPTANCE')
    await decideFdeTask(projectId, task.id, acceptor.id, { expectedVersion: task.version, feedbackId: feedback.id, action: 'accept', reason: '异人核对原始成果通过' })
  }
  await completeTask(config.actions[0].key, secretary, owner)
  await executeTypeRuntime(projectId, secretary.id, stageSubmit()); view = await get(); review = view.reviews[0]
  const stageInbox = await listApprovalCenter(owner.id, { view: 'pending', kind: '非投资阶段审核' })
  assert.ok(stageInbox.list.some(r => r.id === review.id && r.notice))
  assert.equal((await listApprovalCenter(secretary.id, { view: 'pending', kind: '非投资阶段审核' })).list.some(r => r.id === review.id), false)
  assert.ok((await db.transaction(tx => fileDeletionBlockers(tx, fileId))).some(s => s.includes('非投资')))
  await db.update(projectFiles).set({ version: 2 }).where(eq(projectFiles.id, fileId))
  await reject(executeTypeRuntime(projectId, owner.id, command('decide', view.instance!.version, { requestId: review.id, expectedReviewVersion: review.version, decision: 'approve' })), 'TYPE_RUNTIME_FILE_CHANGED')
  await db.update(projectFiles).set({ version: 1 }).where(eq(projectFiles.id, fileId))
  await executeTypeRuntime(projectId, owner.id, command('decide', view.instance!.version, { requestId: review.id, expectedReviewVersion: review.version, decision: 'return' }))
  view = await get(); assert.equal(view.instance!.status, 'active')
  await executeTypeRuntime(projectId, secretary.id, stageSubmit()); view = await get(); const replacement = view.reviews[0]
  assert.notEqual(replacement.id, review.id)
  await reject(executeTypeRuntime(projectId, owner.id, command('decide', view.instance!.version, { requestId: review.id, expectedReviewVersion: review.version + 1, decision: 'approve' })), 'TYPE_RUNTIME_REVIEW_CHANGED')
  await executeTypeRuntime(projectId, secretary.id, command('decide', view.instance!.version, { requestId: replacement.id, expectedReviewVersion: replacement.version, decision: 'withdraw' }))
  view = await get(); assert.equal(view.instance!.status, 'active')
  await executeTypeRuntime(projectId, secretary.id, stageSubmit()); view = await get(); review = view.reviews[0]
  await executeTypeRuntime(projectId, owner.id, command('decide', view.instance!.version, { requestId: review.id, expectedReviewVersion: review.version, decision: 'approve' }))
  view = await get(); assert.equal(view.instance!.stageKey, config.stages[1].key)
  checks.push('real-task-submission-independent-acceptance:material-version-guard:file-retention:return-withdraw-new-revision:stage-advance')

  await completeTask(config.actions[1].key, owner, leader)
  await executeTypeRuntime(projectId, secretary.id, stageSubmit()); view = await get(); review = view.reviews[0]
  await db.update(users).set({ status: '禁用' }).where(eq(users.id, leader.id))
  await reject(executeTypeRuntime(projectId, leader.id, command('decide', view.instance!.version, { requestId: review.id, expectedReviewVersion: review.version, decision: 'approve' })), 'TYPE_RUNTIME_FORBIDDEN')
  await db.update(users).set({ status: '启用' }).where(eq(users.id, leader.id))
  await executeTypeRuntime(projectId, leader.id, command('decide', view.instance!.version, { requestId: review.id, expectedReviewVersion: review.version, decision: 'approve' }))
  view = await get(); assert.equal(view.instance!.status, 'closed'); assert.equal(view.canWrite, false)
  const [closed] = await db.select().from(projects).where(eq(projects.id, projectId)); assert.equal(closed.lifecycle, 'closed')
  await reject(executeTypeRuntime(projectId, secretary.id, command('submit_plan', view.instance!.version)), 'TYPE_RUNTIME_INACTIVE')
  checks.push('disabled-actor-denied:final-independent-approval-closes-instance-and-project:closed-writes-denied')

  await db.delete(projectDutyAssignments).where(and(eq(projectDutyAssignments.projectId, projectId), eq(projectDutyAssignments.userId, secretary.id)))
  await db.delete(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, secretary.id)))
  await reject(get(), 'TYPE_RUNTIME_FORBIDDEN')
  assert.deepEqual((await recoverTypeRuntime(projectId, secretary.id, { commandId: resave.commandId })).receipt, receipt)
  await reject(recoverTypeRuntime(projectId, outsider.id, { commandId: resave.commandId }), 'TYPE_RUNTIME_FORBIDDEN')
  checks.push('revocation-hides-business-body:own-minimal-receipt-survives:no-cross-actor-recovery')
  await db.update(fdeWorkflowPolicies).set({ enabled: false }).where(eq(fdeWorkflowPolicies.id, published.policyId))
  assert.deepEqual((await db.select().from(projects).orderBy(asc(projects.id))).filter(p => p.id !== projectId), oldProjects)
  assert.deepEqual((await db.select().from(todos).orderBy(asc(todos.id))).filter(t => t.projectId !== projectId), oldTasks)
  assert.deepEqual(await db.select().from(leads).orderBy(asc(leads.id)), oldLeads)
  const eventRows = await db.select().from(fdeTypeExecutionEvents).where(eq(fdeTypeExecutionEvents.projectId, projectId))
  assert.equal(new Set(eventRows.map(e => e.version)).size, view.instance!.version)
  checks.push('original-projects-tasks-leads-preserved:versioned-events-receipts:mysql-only:synthetic-policy-left-disabled')
  console.log(JSON.stringify({ ok: true, passed: checks.length, checks, scope: 'isolated-type-runtime-not-production-activation-or-full-type-UAT', realModelCalls: 0 }))
} finally { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }; await pool.end() }
