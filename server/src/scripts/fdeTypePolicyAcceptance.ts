import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import express from 'express'
import bcrypt from 'bcryptjs'
import { and, asc, eq, like, sql } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { fdeWorkflowPolicies as heads, fdeWorkflowPolicyVersions as versions, fdeTypePolicyReviews as reviews, fdeTypePolicyCommands as commands, fdeTypePolicyEvents as events, auditLogs, projects, todos, users, userRoles } from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'
import { executeTypePolicy, getTypePolicy, listTypePolicies, previewTypePolicy, recoverTypePolicy } from '../services/fdeTypePolicyService.js'
import { createFdePolicyDraft, getProjectWorkflowPolicy, listFdeWorkflowPolicies, publishFdePolicyVersion, saveFdePolicyDraft, setFdePolicyEnabled } from '../services/fdeWorkflowPolicyService.js'
import { createProject } from '../services/projectService.js'
import { DEFAULT_FDE_WORKFLOW_POLICY } from '../contracts/fdeWorkflowPolicyContract.js'
import { FDE_NON_INVESTMENT_TYPES, typePolicyCode, type TypePolicyDefinition } from '../contracts/fdeTypePolicyContract.js'
import { typePolicyFixture } from './fdeTypePolicyFixture.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
const mark = randomUUID().slice(0, 8), password = `Isolated-${randomUUID()}!`, passwordHash = await bcrypt.hash(password, 10)
const actors = ['系统管理员', '系统管理员', '董事长', '投资经理'].map((role, i) => ({ id: randomUUID(), email: `type-${mark}-${i}@accept.invalid`, name: `隔离模板-${i}-${mark}`, role, department: '隔离验收', passwordHash }))
const [admin, mixed, leader, outsider] = actors, checks: string[] = []
const administrator = { userId: admin.id, userName: admin.name }
let server: Server | undefined
const reject = async (operation: Promise<unknown>, code: string) => assert.rejects(operation, e => (e as { code?: string }).code === code)
const snapshot = async () => JSON.stringify(await Promise.all([
  db.select().from(heads).orderBy(asc(heads.id)), db.select().from(versions).orderBy(asc(versions.id)), db.select().from(reviews).orderBy(asc(reviews.versionId)),
  db.select().from(commands).orderBy(asc(commands.id)), db.select().from(events).orderBy(asc(events.id)), db.select().from(auditLogs).orderBy(asc(auditLogs.id)),
]))
try {
  await db.insert(users).values(actors)
  for (const a of actors) await identityRepositories.users.synchronizeAdministrationBindings(a.id, a.role, a.department)
  const [leaderRole] = await db.select().from(userRoles).where(eq(userRoles.userId, leader.id))
  await db.insert(userRoles).values({ userId: mixed.id, roleId: leaderRole.roleId, isPrimary: false })
  const protectedBefore = JSON.stringify(await Promise.all([db.select().from(projects).orderBy(asc(projects.id)), db.select().from(todos).orderBy(asc(todos.id)), listFdeWorkflowPolicies()]))
  assert.equal((await listTypePolicies(admin.id)).policies.length, 0, 'No demo type policies may be seeded')
  const configuration = typePolicyFixture(), create = { commandId: randomUUID(), action: 'create', reason: '合成非投资规则，不是正式模板', expectedPolicyVersion: 0, configuration }
  const [first, replay] = await Promise.all([executeTypePolicy(admin.id, create), executeTypePolicy(admin.id, create)])
  assert.deepEqual(first, replay); assert.equal(first.status, 'draft')
  let view = await getTypePolicy(admin.id, first.policyId)
  assert.equal(view.versions.length, 1); assert.equal(view.policy.enabled, false); assert.equal(view.policy.activeVersionId, null)
  const code = typePolicyCode(configuration.type)
  assert.equal((await db.select().from(heads).where(eq(heads.code, code))).length, 1)
  checks.push('no-demo-seed:concurrent-create-and-replay-one-stable-disabled-head-and-version')

  for (const item of FDE_NON_INVESTMENT_TYPES.slice(1)) await executeTypePolicy(admin.id, { ...create, commandId: randomUUID(), configuration: typePolicyFixture(item.code) })
  const catalogue = await listTypePolicies(admin.id)
  assert.equal(catalogue.policies.length, 7); assert.equal(new Set(catalogue.policies.map(p => p.code)).size, 7); assert.ok(catalogue.policies.every(p => !p.enabled))
  assert.ok(catalogue.policies.some(p => p.code === 'noninvestment:government_industry')); assert.ok(catalogue.policies.some(p => p.code === 'noninvestment:fund_management'))
  const beforePreview = await snapshot()
  assert.equal((await previewTypePolicy(admin.id, { configuration, cycleDays: 50, targetDate: '2026-11-30' })).actions.at(-1)!.dueDate, '2026-11-30')
  const working: TypePolicyDefinition = { ...configuration, calendar: { basis: 'working', workingWeekdays: [1, 2, 3, 4, 5], holidays: ['2026-08-28'], extraWorkingDates: ['2026-08-29'] } }
  assert.equal((await previewTypePolicy(leader.id, { configuration: working, cycleDays: 15, targetDate: '2026-08-31' })).startDate, '2026-08-10')
  await reject(previewTypePolicy(admin.id, { configuration: working, cycleDays: 15, targetDate: '2026-08-30' }), 'TYPE_POLICY_PREVIEW_INVALID')
  assert.equal(await snapshot(), beforePreview)
  checks.push('seven-distinct-candidate-types:explicit-calendar-and-50-day-preview-read-only-no-project-or-task')

  const at = () => getTypePolicy(admin.id, first.policyId)
  const act = async (action: 'save' | 'approve' | 'publish', uid: string, extra: Record<string, unknown> = {}) => {
    const v = await at(), version = v.versions.find(r => r.id === first.versionId)!
    return executeTypePolicy(uid, { commandId: randomUUID(), action, policyId: first.policyId, versionId: first.versionId, expectedVersion: version.version, reason: '合成模板审核与发布动作', ...(action === 'publish' ? { expectedPolicyVersion: v.policy.version } : {}), ...extra })
  }
  const beforeDenied = await snapshot()
  await reject(act('approve', admin.id), 'TYPE_POLICY_ACTION_FORBIDDEN')
  await reject(act('save', leader.id, { configuration }), 'TYPE_POLICY_ACTION_FORBIDDEN')
  await reject(listTypePolicies(outsider.id), 'TYPE_POLICY_FORBIDDEN')
  await reject(act('publish', admin.id), 'TYPE_POLICY_APPROVAL_REQUIRED')
  assert.equal(await snapshot(), beforeDenied)
  await act('save', mixed.id, { configuration: { ...configuration, actions: configuration.actions.map(a => ({ ...a, deliverable: `${a.deliverable}，再次核对` })) } })
  await reject(act('approve', mixed.id), 'TYPE_POLICY_SELF_APPROVAL')
  await act('save', admin.id, { configuration }); await reject(act('approve', mixed.id), 'TYPE_POLICY_SELF_APPROVAL')
  await act('approve', leader.id)
  await reject(act('save', admin.id, { configuration }), 'TYPE_POLICY_IMMUTABLE')
  checks.push('independent-review:all-contributors-traced-no-self-approval-no-admin-business-bypass-approved-content-frozen')

  const leaderBindings = await db.select().from(userRoles).where(eq(userRoles.userId, leader.id))
  await db.delete(userRoles).where(eq(userRoles.userId, leader.id))
  try { const before = await snapshot(); await reject(act('publish', admin.id), 'TYPE_POLICY_APPROVER_CHANGED'); assert.equal(await snapshot(), before) }
  finally { await db.insert(userRoles).values(leaderBindings) }
  const table = quoteMysqlIdentifier(mysqlTableName('fde_type_policy_events')), constraint = quoteMysqlIdentifier(mysqlTableName('type_policy_publish_fail'))
  await db.execute(sql.raw(`ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK (action <> 'publish')`))
  try { const before = await snapshot(); await assert.rejects(act('publish', admin.id)); assert.equal(await snapshot(), before) }
  finally { await db.execute(sql.raw(`ALTER TABLE ${table} DROP CHECK ${constraint}`)) }
  const published = await act('publish', admin.id)
  view = await at(); assert.equal(view.policy.enabled, false); assert.equal(view.policy.activeVersionId, first.versionId); assert.equal(view.versions[0].status, 'published')
  checks.push('revoked-reviewer-rejected:real-late-SQL-failure-rolls-back-version-head-events-command-and-audit:publish-does-not-enable')

  const beforeBypass = await snapshot()
  await reject(setFdePolicyEnabled(first.policyId, { enabled: true, expectedVersion: view.policy.version, reason: '错误入口尝试启用' }, administrator), 'FDE_TYPE_POLICY_ENDPOINT_REQUIRED')
  await reject(publishFdePolicyVersion(first.policyId, { versionId: first.versionId, expectedPolicyVersion: view.policy.version, expectedDraftVersion: published.version, reason: '错误入口绕过审核' }, administrator), 'FDE_TYPE_POLICY_ENDPOINT_REQUIRED')
  await reject(createFdePolicyDraft(first.policyId, { sourceVersionId: first.versionId, expectedVersion: view.policy.version, reason: '错误入口新建修订' }, administrator), 'FDE_TYPE_POLICY_ENDPOINT_REQUIRED')
  await reject(saveFdePolicyDraft(first.versionId, { expectedVersion: published.version, configuration: DEFAULT_FDE_WORKFLOW_POLICY, reason: '错误入口覆盖类型' }, administrator), 'FDE_TYPE_POLICY_ENDPOINT_REQUIRED')
  await reject(createProject({ name: '禁止非投资套用投资', projectType: '基金募资项目' }, admin.id), 'FDE_TYPE_EXECUTION_REQUIRED')
  await reject(getProjectWorkflowPolicy(db, { workflowPolicyVersionId: first.versionId, projectType: '基金募资项目' }), 'FDE_TYPE_EXECUTION_REQUIRED')
  assert.equal(await snapshot(), beforeBypass)
  assert.equal(JSON.stringify(await Promise.all([db.select().from(projects).orderBy(asc(projects.id)), db.select().from(todos).orderBy(asc(todos.id)), listFdeWorkflowPolicies()])), protectedBefore)
  checks.push('legacy-investment-endpoints-cannot-edit-publish-enable-or-bind-noninvestment:original-projects-and-investment-rules-unchanged')

  const previous = await db.select().from(versions).where(eq(versions.id, first.versionId))
  const next = await executeTypePolicy(admin.id, { ...create, commandId: randomUUID(), expectedPolicyVersion: view.policy.version })
  await reject(executeTypePolicy(admin.id, { commandId: randomUUID(), action: 'save', policyId: first.policyId, versionId: next.versionId, expectedVersion: 1, reason: '不允许混用项目类型', configuration: typePolicyFixture('government_industry') }), 'TYPE_POLICY_TYPE_IMMUTABLE')
  assert.deepEqual(await db.select().from(versions).where(eq(versions.id, first.versionId)), previous)
  assert.equal((await at()).policy.activeVersionId, first.versionId)
  const other = catalogue.policies.find(p => p.id !== first.policyId)!
  await reject(executeTypePolicy(admin.id, { commandId: randomUUID(), action: 'approve', policyId: other.id, versionId: first.versionId, expectedVersion: 1, reason: '不允许串用其他模板' }), 'TYPE_POLICY_ACTION_FORBIDDEN')
  await reject(executeTypePolicy(leader.id, { commandId: randomUUID(), action: 'approve', policyId: other.id, versionId: first.versionId, expectedVersion: 1, reason: '不允许串用其他模板' }), 'TYPE_POLICY_VERSION_NOT_FOUND')
  checks.push('new-revision-retains-published-ID-content-and-selection:cross-policy-and-type-rebinding-denied')

  for (let i = 0; i < 20; i++) { const current = await at(); await executeTypePolicy(admin.id, { ...create, commandId: randomUUID(), expectedPolicyVersion: current.policy.version }) }
  const firstPage = await at(), secondPage = await getTypePolicy(admin.id, first.policyId, { page: 2, eventPage: 2 })
  assert.equal(firstPage.versions.length, 20); assert.equal(firstPage.hasMore, true); assert.equal(secondPage.versions.length, 2)
  assert.equal(new Set([...firstPage.versions, ...secondPage.versions].map(v => v.id)).size, 22)
  assert.equal(firstPage.events.length, 20); assert.equal(firstPage.eventsHaveMore, true); assert.ok(secondPage.events.length)
  checks.push('version-and-audit-history-independent-pagination-no-silent-20-item-truncation')

  const closedId = randomUUID(), recovered = await recoverTypePolicy(admin.id, { commandId: closedId }); assert.equal(recovered.state, 'not_committed')
  const beforeLate = await snapshot()
  await reject(executeTypePolicy(admin.id, { ...create, commandId: closedId, expectedPolicyVersion: (await at()).policy.version }), 'TYPE_POLICY_COMMAND_CLOSED')
  assert.equal(await snapshot(), beforeLate)
  const replayed = await recoverTypePolicy(admin.id, { commandId: create.commandId }); assert.equal(replayed.state, 'committed'); assert.doesNotMatch(JSON.stringify(replayed), /configuration|stages|outcome/)
  assert.equal((await recoverTypePolicy(outsider.id, { commandId: create.commandId })).state, 'not_committed')
  const bindings = await db.select().from(userRoles).where(eq(userRoles.userId, admin.id))
  await db.delete(userRoles).where(eq(userRoles.userId, admin.id))
  try { await reject(listTypePolicies(admin.id), 'TYPE_POLICY_FORBIDDEN'); assert.equal((await recoverTypePolicy(admin.id, { commandId: create.commandId })).state, 'committed') }
  finally { await db.insert(userRoles).values(bindings) }
  await db.update(users).set({ status: '禁用' }).where(eq(users.id, outsider.id))
  try { await reject(recoverTypePolicy(outsider.id, { commandId: randomUUID() }), 'TYPE_POLICY_ACTOR_FORBIDDEN') }
  finally { await db.update(users).set({ status: '启用' }).where(eq(users.id, outsider.id)) }
  checks.push('recovery-seals-late-commands:cross-actor-isolation:revoked-role-minimal-own-receipt-only:disabled-actor-denied')

  const { requireAuth } = await import('../middleware/requireAuth.js'), { errorHandler } = await import('../middleware/errorHandler.js'), { authRouter } = await import('../routes/auth.js'), { fdeTypePoliciesRouter } = await import('../routes/fdeTypePolicies.js')
  const app = express(); app.use(express.json()); app.use('/api', (req, res, next) => req.path === '/auth/login' ? next() : requireAuth(req, res, next)); app.use('/api/auth', authRouter)
  let loseResponse = false
  app.use('/api/fde-type-policies/commands', (req, res, next) => { if (req.path === '/' && loseResponse) { loseResponse = false; res.json = (() => { res.destroy(); return res }) as typeof res.json }; next() })
  app.use('/api/fde-type-policies', fdeTypePoliciesRouter); app.use(errorHandler)
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server!.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, url = `${base}/api/fde-type-policies`; process.env.AUTH_ALLOWED_ORIGINS = base
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: admin.email, password }) }); assert.equal(login.status, 200)
  const cookies = login.headers.getSetCookie(), cookie = cookies.map(s => s.split(';')[0]).join('; '), csrf = decodeURIComponent(cookies.find(s => s.startsWith('cybernaut_csrf='))!.split(';')[0].slice('cybernaut_csrf='.length))
  const headers = { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json', Origin: base }
  assert.equal((await fetch(url)).status, 401)
  const read = await fetch(url, { headers }); assert.equal(read.status, 200); assert.equal(read.headers.get('cache-control'), 'private, no-store'); await read.json()
  const http = { ...create, commandId: randomUUID(), expectedPolicyVersion: (await at()).policy.version }
  const post = (path: string, body: unknown, extra = {}) => fetch(`${url}${path}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) })
  const beforeHttp = await snapshot()
  assert.equal((await post('/commands', http, { 'X-CSRF-Token': '' })).status, 403)
  assert.equal((await post('/commands', http, { Origin: 'https://invalid.example' })).status, 403)
  assert.equal((await post('/commands', { ...http, approvedBy: leader.id })).status, 400)
  assert.equal(await snapshot(), beforeHttp)
  loseResponse = true; await assert.rejects(post('/commands', http))
  const afterLost = await snapshot(), recoveredHttp = await post('/commands/recover', { commandId: http.commandId }); assert.equal(recoveredHttp.status, 200); assert.equal((await recoveredHttp.json()).state, 'committed')
  const replayHttp = await post('/commands', http); assert.equal(replayHttp.status, 200); await replayHttp.json(); assert.equal(await snapshot(), afterLost)
  checks.push('real-session-CSRF-Origin-strict-input-private-cache:committed-response-loss-recovery-replay-no-duplicate')
  const leaderLogin = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: leader.email, password }) }); assert.equal(leaderLogin.status, 200)
  const leaderCookies = leaderLogin.headers.getSetCookie(), leaderCookie = leaderCookies.map(s => s.split(';')[0]).join('; '), leaderCsrf = decodeURIComponent(leaderCookies.find(s => s.startsWith('cybernaut_csrf='))!.split(';')[0].slice('cybernaut_csrf='.length))
  const httpVersion = (await recoverTypePolicy(admin.id, { commandId: http.commandId })).receipt!
  let httpVersionNumber = httpVersion.version
  for (const action of ['save', 'approve', 'publish'] as const) {
    const command = { commandId: randomUUID(), action, policyId: first.policyId, versionId: httpVersion.versionId, expectedVersion: httpVersionNumber, reason: '真实接口提交后丢响应恢复', ...(action === 'save' ? { configuration } : {}), ...(action === 'publish' ? { expectedPolicyVersion: (await at()).policy.version } : {}) }
    const auth = action === 'approve' ? { Cookie: leaderCookie, 'X-CSRF-Token': leaderCsrf } : {}
    loseResponse = true; await assert.rejects(post('/commands', command, auth))
    const after = await snapshot(), recovered = await post('/commands/recover', { commandId: command.commandId }, auth)
    assert.equal(recovered.status, 200); const resolved = await recovered.json(); assert.equal(resolved.state, 'committed'); assert.equal(resolved.receipt.action, action)
    httpVersionNumber = resolved.receipt.version
    const duplicate = await post('/commands', command, auth); assert.equal(duplicate.status, 200); await duplicate.json(); assert.equal(await snapshot(), after)
  }
  const late = { ...create, commandId: randomUUID(), expectedPolicyVersion: (await at()).policy.version }, sealed = await post('/commands/recover', { commandId: late.commandId })
  assert.equal(sealed.status, 200); assert.equal((await sealed.json()).state, 'not_committed')
  const beforeLateHttp = await snapshot(); assert.equal((await post('/commands', late)).status, 409); assert.equal(await snapshot(), beforeLateHttp)
  checks.push('all-four-authenticated-write-actions-survive-postcommit-response-loss:precommit-seal-rejects-late-HTTP-command')
  assert.equal(JSON.stringify(await Promise.all([db.select().from(projects).orderBy(asc(projects.id)), db.select().from(todos).orderBy(asc(todos.id)), listFdeWorkflowPolicies()])), protectedBefore)
  assert.equal((await db.select().from(heads).where(and(like(heads.code, 'noninvestment:%'), eq(heads.enabled, true)))).length, 0)
  checks.push('all-fixture-type-policies-disabled:no-activation-no-existing-project-task-investment-or-lead-mutation')
  console.log(JSON.stringify({ ok: true, checks, passed: checks.length, scope: 'non-investment-template-review-not-project-execution', productionPolicyApproved: false, realModelCalls: 0 }))
} finally { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }; await pool.end() }
