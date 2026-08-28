import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { and, eq, sql } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { users, userRoles, responsibilityPolicies as heads, responsibilityPolicyVersions as versions, responsibilityPolicyCommands as commands, responsibilityPolicyEvents as events, auditLogs } from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'
import { activeResponsibilityPolicy, executeResponsibilityPolicyCommand as execute, getCurrentResponsibilityPolicy, getResponsibilityPolicyVersion, listResponsibilityPolicies as list, recoverResponsibilityPolicyCommand as recover } from '../services/fdeResponsibilityPolicyService.js'
import { responsibilityEvents, type ResponsibilityPolicy } from '../contracts/fdeResponsibilityPolicyContract.js'
import { responsibilityPolicyCurrentView, responsibilityPolicyListView, responsibilityPolicyVersionView } from '../contracts/fdeResponsibilityPolicyViewContract.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.DB_FREFIX, process.env.FDE_ACCEPTANCE_PREFIX)
assert.ok(process.env.PROJECT_FILE_ROOT?.includes('fde-migration-acceptance-'))
const checks: string[] = [], marker = randomUUID().slice(0, 8)
const denied = async (operation: Promise<unknown>, code: string) => { const error = await operation.then(() => null, cause => cause); assert.equal(error?.code, code, error?.message ?? 'unexpected success') }
let server: Server | undefined
try {
  process.env.AUTH_COOKIE_SECURE = 'false'; process.env.AUTH_COOKIE_DOMAIN = ''; process.env.AUTH_ALLOW_LEGACY_BEARER = 'false'; process.env.JWT_SECRET = randomUUID() + randomUUID()
  const { hashNewPassword } = await import('../security/passwordPolicy.js')
  const password = `Responsibility-Test-${randomUUID()}!`, passwordHash = await hashNewPassword(password)
  const people = ['系统管理员', '系统管理员', '董事长', '投资经理'].map((role, i) => ({ id: randomUUID(), name: `责任规则-${marker}-${i}`, email: `responsibility-${marker}-${i}@example.invalid`, role, department: `责任验收-${marker}`, passwordHash }))
  const [admin, otherAdmin, leader, member] = people
  await db.insert(users).values(people)
  for (const actor of people) await identityRepositories.users.synchronizeAdministrationBindings(actor.id, actor.role, actor.department)
  assert.equal((await list(admin.id)).policy, null)
  assert.equal(await db.transaction(tx => activeResponsibilityPolicy(tx, new Date())), null)
  await denied(list(member.id), 'RESP_POLICY_FORBIDDEN')
  const config: ResponsibilityPolicy = {
    rules: responsibilityEvents.map(rule => ({ code: rule.code, mode: rule.mode, enabled: true, points: rule.positive ? 1 : -1 })),
    timezone: 'Asia/Shanghai', calendar: { workingWeekdays: [1, 2, 3, 4, 5], holidays: ['2026-10-01'], extraWorkingDates: [] }, earlyWorkingDays: 1, graceMinutes: 0,
    appealLimit: 1, appealAggregation: 'exclude_pending', allowAdjustment: false, allowExemption: true, completionAggregation: 'one_per_task', feedbackAggregation: 'one_per_actor_task_business_day',
    missingReviewer: 'retain_pending_assignment', history: 'append_only_no_automatic_rescore',
  }
  const create = { commandId: randomUUID(), action: 'create' as const, configuration: config, expectedPolicyVersion: 0, reason: '隔离合成规则：不作为生产计分批准' }
  await denied(execute(member.id, create), 'RESP_POLICY_FORBIDDEN')
  const [created, replay] = await Promise.all([execute(admin.id, create), execute(admin.id, create)])
  assert.deepEqual(created, replay); assert.equal((await list(admin.id)).versions.length, 1)
  const adminView = responsibilityPolicyListView.parse(JSON.parse(JSON.stringify(await list(admin.id))))
  const leaderView = responsibilityPolicyListView.parse(JSON.parse(JSON.stringify(await list(leader.id))))
  assert.deepEqual(adminView.capabilities, { manage: true, approve: false })
  assert.deepEqual(leaderView.capabilities, { manage: false, approve: true })
  assert.equal(adminView.versions[0].capabilities.save, true); assert.equal(adminView.versions[0].capabilities.approve, false)
  assert.equal(leaderView.versions[0].capabilities.approve, true); assert.equal(leaderView.versions[0].capabilities.save, false)
  assert.equal(adminView.versions[0].createdByName, admin.name)
  assert.equal(adminView.events[0].actorName, admin.name)
  await denied(getCurrentResponsibilityPolicy(member.id), 'RESP_POLICY_FORBIDDEN')
  assert.deepEqual(await recover(admin.id, { commandId: create.commandId }), { state: 'committed', receipt: created })
  await denied(execute(admin.id, { ...create, reason: '同一请求不同内容应当拒绝' }), 'RESP_COMMAND_REUSED')
  assert.equal((await list(admin.id)).policy!.enabled, false)
  checks.push('no-seed-or-active-default:strict-eight-rules-stable-command-concurrent-replay-one-draft')

  const publication = { action: 'publish' as const, commandId: randomUUID(), versionId: created.versionId, expectedDraftVersion: created.draftVersion, expectedPolicyVersion: created.policyVersion, reason: '未经独立批准不能发布规则' }
  await denied(execute(admin.id, publication), 'RESP_POLICY_APPROVAL_REQUIRED')
  await denied(execute(admin.id, { action: 'approve', commandId: randomUUID(), versionId: created.versionId, expectedDraftVersion: created.draftVersion, reason: '技术管理员不能代业务批准' }), 'RESP_POLICY_ACTION_FORBIDDEN')
  const save = { action: 'save' as const, commandId: randomUUID(), versionId: created.versionId, expectedDraftVersion: created.draftVersion, configuration: { ...config, graceMinutes: 15 }, reason: '修订隔离合成宽限参数' }
  const saved = await execute(admin.id, save)
  const approved = await execute(leader.id, { action: 'approve', commandId: randomUUID(), versionId: created.versionId, expectedDraftVersion: saved.draftVersion, reason: '业务账号批准此隔离合成版本' })
  await denied(execute(admin.id, { ...save, commandId: randomUUID(), expectedDraftVersion: approved.draftVersion }), 'RESP_POLICY_IMMUTABLE')
  const published = await execute(admin.id, { ...publication, commandId: randomUUID(), expectedDraftVersion: approved.draftVersion, expectedPolicyVersion: approved.policyVersion })
  assert.equal((await list(admin.id)).policy!.enabled, false)
  assert.equal(await db.transaction(tx => activeResponsibilityPolicy(tx, new Date())), null)
  let toggled = await execute(admin.id, { action: 'toggle', commandId: randomUUID(), expectedPolicyVersion: published.policyVersion, enabled: true, reason: '明确启用隔离合成规则' })
  const active = (await db.transaction(tx => activeResponsibilityPolicy(tx, new Date(Date.now() + 1000))))!
  assert.equal(active.id, created.versionId)
  assert.equal(await db.transaction(tx => activeResponsibilityPolicy(tx, new Date(active.effectiveFrom.getTime() - 1))), null)
  assert.ok(active.activationEventId)
  assert.equal(await db.transaction(tx => activeResponsibilityPolicy(tx, new Date('2020-01-01T00:00:00Z'))), null)
  const original = await getResponsibilityPolicyVersion(admin.id, created.versionId!)
  responsibilityPolicyVersionView.parse(JSON.parse(JSON.stringify(original)))
  assert.equal(original.status, 'published'); assert.equal(original.approvedBy, leader.id); assert.equal(original.publishedBy, admin.id)
  await denied(execute(otherAdmin.id, { action: 'toggle', commandId: randomUUID(), expectedPolicyVersion: published.policyVersion, enabled: false, reason: '过期版本不能覆盖当前状态' }), 'VERSION_CONFLICT')
  toggled = await execute(admin.id, { action: 'toggle', commandId: randomUUID(), expectedPolicyVersion: toggled.policyVersion, enabled: false, reason: '测试停用期事件不得追溯' })
  assert.equal(await db.transaction(tx => activeResponsibilityPolicy(tx, new Date())), null)
  const duringDisabled = new Date()
  toggled = await execute(admin.id, { action: 'toggle', commandId: randomUUID(), expectedPolicyVersion: toggled.policyVersion, enabled: true, reason: '重新明确启用隔离规则' })
  const reactivated = (await db.transaction(tx => activeResponsibilityPolicy(tx, new Date(Date.now() + 1000))))!
  assert.notEqual(reactivated.activationEventId, active.activationEventId)
  assert.ok(reactivated.effectiveFrom > duringDisabled)
  assert.equal(await db.transaction(tx => activeResponsibilityPolicy(tx, duringDisabled)), null)
  checks.push('independent-approval-immutable-version-separate-publication-enable-no-retroactive-events')

  const leaderRole = (await db.select().from(userRoles).where(eq(userRoles.userId, leader.id)))[0].roleId
  await db.insert(userRoles).values({ userId: admin.id, roleId: leaderRole })
  const authored = await execute(admin.id, { ...create, commandId: randomUUID(), expectedPolicyVersion: toggled.policyVersion })
  const edited = await execute(otherAdmin.id, { ...save, commandId: randomUUID(), versionId: authored.versionId, expectedDraftVersion: authored.draftVersion })
  assert.equal((await getResponsibilityPolicyVersion(admin.id, authored.versionId!)).capabilities.approve, false)
  await denied(execute(admin.id, { action: 'approve', commandId: randomUUID(), versionId: authored.versionId, expectedDraftVersion: edited.draftVersion, reason: '双角色不能批准自己参与编制版本' }), 'RESP_POLICY_SELF_APPROVAL')
  await db.delete(userRoles).where(and(eq(userRoles.userId, admin.id), eq(userRoles.roleId, leaderRole)))
  const secondApproval = await execute(leader.id, { action: 'approve', commandId: randomUUID(), versionId: authored.versionId, expectedDraftVersion: edited.draftVersion, reason: '独立批准另一个合成规则版本' })
  await db.update(users).set({ status: '禁用' }).where(eq(users.id, leader.id))
  assert.equal((await getResponsibilityPolicyVersion(admin.id, authored.versionId!)).capabilities.publish, false)
  await denied(execute(admin.id, { ...publication, commandId: randomUUID(), versionId: authored.versionId, expectedDraftVersion: secondApproval.draftVersion, expectedPolicyVersion: secondApproval.policyVersion }), 'RESP_POLICY_APPROVER_CHANGED')
  await db.update(users).set({ status: '启用' }).where(eq(users.id, leader.id))
  assert.deepEqual(await getResponsibilityPolicyVersion(admin.id, created.versionId!), original)
  checks.push('multi-role-self-approval-forbidden-all-editors-traced-current-approver-required-old-version-retained')

  const closed = { ...create, commandId: randomUUID(), expectedPolicyVersion: secondApproval.policyVersion }
  assert.deepEqual(await recover(admin.id, { commandId: closed.commandId }), { state: 'not_committed', receipt: null })
  await denied(execute(admin.id, closed), 'RESP_COMMAND_CLOSED')
  assert.deepEqual(await recover(member.id, { commandId: create.commandId }), { state: 'not_committed', receipt: null })
  assert.deepEqual(await recover(admin.id, { commandId: create.commandId }), { state: 'committed', receipt: created })
  for (let i = 0; i < 4; i++) {
    const race = { ...create, commandId: randomUUID(), expectedPolicyVersion: (await list(admin.id)).policy!.version }
    const [write, resolution] = await Promise.allSettled([execute(admin.id, race), recover(admin.id, { commandId: race.commandId })])
    assert.equal(resolution.status, 'fulfilled')
    if (write.status === 'fulfilled') assert.deepEqual(await recover(admin.id, { commandId: race.commandId }), { state: 'committed', receipt: write.value })
    else { assert.equal(write.reason.code, 'RESP_COMMAND_CLOSED'); assert.deepEqual(await recover(admin.id, { commandId: race.commandId }), { state: 'not_committed', receipt: null }) }
  }
  checks.push('unknown-result-seal-late-request-rejection-four-write-recovery-races-cross-account-isolation')

  const corruptCommand = randomUUID()
  await db.insert(commands).values({ actorId: admin.id, commandId: corruptCommand })
  await denied(recover(admin.id, { commandId: corruptCommand }), 'RESP_COMMAND_INTEGRITY')
  checks.push('incomplete-command-receipt-never-pretends-reliable-not-committed')

  await db.delete(userRoles).where(eq(userRoles.userId, admin.id))
  assert.deepEqual(await recover(admin.id, { commandId: create.commandId }), { state: 'committed', receipt: created })
  assert.deepEqual(await execute(admin.id, create), created)
  await denied(list(admin.id), 'RESP_POLICY_FORBIDDEN')
  await denied(execute(admin.id, { ...create, commandId: randomUUID() }), 'RESP_POLICY_FORBIDDEN')
  await db.update(users).set({ status: '禁用' }).where(eq(users.id, admin.id))
  await denied(recover(admin.id, { commandId: create.commandId }), 'RESP_ACTOR_FORBIDDEN')
  await db.update(users).set({ status: '启用' }).where(eq(users.id, admin.id))
  await identityRepositories.users.synchronizeAdministrationBindings(admin.id, admin.role, admin.department)
  checks.push('revocation-only-own-minimal-receipt-no-content-or-new-write-disabled-user-denied')

  const headBefore = (await list(admin.id)).policy!, faultCommand = randomUUID()
  const table = quoteMysqlIdentifier(mysqlTableName('responsibility_policy_commands')), constraint = quoteMysqlIdentifier(`resp_fail_${marker}`)
  const auditBefore = await db.select().from(auditLogs).where(eq(auditLogs.module, '责任规则'))
  const eventBefore = await db.select().from(events), versionBefore = await db.select().from(versions)
  await db.execute(sql.raw(`ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK (command_id <> '${faultCommand}')`))
  try { await assert.rejects(execute(admin.id, { ...create, commandId: faultCommand, expectedPolicyVersion: headBefore.version })) }
  finally { await db.execute(sql.raw(`ALTER TABLE ${table} DROP CHECK ${constraint}`)) }
  assert.deepEqual((await list(admin.id)).policy, headBefore)
  assert.deepEqual(await db.select().from(events), eventBefore); assert.deepEqual(await db.select().from(versions), versionBefore)
  assert.deepEqual(await db.select().from(auditLogs).where(eq(auditLogs.module, '责任规则')), auditBefore)
  assert.equal((await db.select().from(commands).where(eq(commands.commandId, faultCommand))).length, 0)
  checks.push('real-mysql-late-constraint-failure-rolls-back-head-version-history-command-and-audit')

  await db.update(versions).set({ sha256: '0'.repeat(64) }).where(eq(versions.id, original.id))
  await denied(db.transaction(tx => activeResponsibilityPolicy(tx, new Date(Date.now() + 1000))), 'RESP_POLICY_INTEGRITY')
  await db.update(versions).set({ sha256: original.sha256 }).where(eq(versions.id, original.id))
  checks.push('active-published-version-integrity-enforced-without-demo-fallback')

  const { authRouter } = await import('../routes/auth.js'), { responsibilityPoliciesRouter } = await import('../routes/responsibilityPolicies.js'), { requireAuth } = await import('../middleware/requireAuth.js'), { errorHandler } = await import('../middleware/errorHandler.js')
  const faults = new Set<string>()
  const app = express(); app.use(express.json()); app.use('/api', (req, res, next) => req.path === '/auth/login' ? next() : requireAuth(req, res, next)); app.use('/api/auth', authRouter)
  app.use('/api/responsibility-policies/commands', (req, res, next) => {
    if (faults.delete(req.body?.commandId)) res.json = function () { this.destroy(); return this }
    next()
  })
  app.use('/api/responsibility-policies', responsibilityPoliciesRouter); app.use(errorHandler)
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server!.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; process.env.AUTH_ALLOWED_ORIGINS = base
  const sessions = new Map<string, { cookie: string; csrf: string }>()
  for (const actor of [admin, leader, member]) {
    const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: actor.email, password }) }); assert.equal(response.status, 200)
    const cookies = response.headers.getSetCookie()
    sessions.set(actor.id, { cookie: cookies.map(value => value.split(';')[0]).join('; '), csrf: decodeURIComponent(cookies.find(value => value.startsWith('cybernaut_csrf='))!.split(';')[0].slice('cybernaut_csrf='.length)) })
  }
  const request = (uid: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const session = sessions.get(uid)!
    return fetch(`${base}/api/responsibility-policies${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) })
  }
  assert.equal((await fetch(`${base}/api/responsibility-policies`)).status, 401)
  assert.equal((await request(member.id, '')).status, 403)
  const allowed = await request(admin.id, ''); assert.equal(allowed.status, 200); assert.equal(allowed.headers.get('cache-control'), 'private, no-store'); assert.equal(allowed.headers.get('x-content-type-options'), 'nosniff')
  assert.equal((await request(admin.id, '/commands', create, { 'X-CSRF-Token': '' })).status, 403)
  assert.equal((await request(admin.id, '/commands', create, { Origin: 'https://forbidden.invalid' })).status, 403)
  assert.equal((await request(admin.id, '/commands', { ...create, actorId: leader.id })).status, 400)
  assert.equal((await request(leader.id, '/versions/' + original.id)).status, 200)
  checks.push('real-session-CSRF-Origin-strict-body-private-cache-and-role-authority')

  const lostCreate = { ...create, commandId: randomUUID(), expectedPolicyVersion: (await list(admin.id)).policy!.version }
  const lostActions: Array<{ actorId: string; input: Record<string, unknown> }> = [{ actorId: admin.id, input: lostCreate }]
  let expectedActiveId = original.id
  for (const action of ['create', 'save', 'approve', 'publish', 'toggle'] as const) {
    const work = lostActions[lostActions.length - 1]
    faults.add(String(work.input.commandId))
    await assert.rejects(request(work.actorId, '/commands', work.input))
    const result = await request(work.actorId, '/commands/recover', { commandId: work.input.commandId }); assert.equal(result.status, 200)
    const body = await result.json() as { state: string; receipt: { versionId: string; draftVersion: number; policyVersion: number } }; assert.equal(body.state, 'committed')
    const again = await request(work.actorId, '/commands', work.input); assert.equal(again.status, 200); assert.deepEqual(await again.json(), body.receipt)
    const receipt = body.receipt
    if (action === 'publish') expectedActiveId = receipt.versionId
    const next = action === 'create' ? { actorId: admin.id, input: { ...save, commandId: randomUUID(), versionId: receipt.versionId, expectedDraftVersion: receipt.draftVersion } }
      : action === 'save' ? { actorId: leader.id, input: { action: 'approve', commandId: randomUUID(), versionId: receipt.versionId, expectedDraftVersion: receipt.draftVersion, reason: '隔离响应丢失业务批准' } }
        : action === 'approve' ? { actorId: admin.id, input: { ...publication, commandId: randomUUID(), versionId: receipt.versionId, expectedDraftVersion: receipt.draftVersion, expectedPolicyVersion: receipt.policyVersion } }
          : { actorId: admin.id, input: { action: 'toggle', commandId: randomUUID(), expectedPolicyVersion: receipt.policyVersion, enabled: false, reason: '隔离响应丢失停用规则' } }
    lostActions.push(next)
    assert.equal((await db.select().from(events).where(eq(events.commandId, String(work.input.commandId)))).length, 1)
  }
  checks.push('all-five-policy-actions-authenticated-postcommit-response-loss-recovery-and-replay-no-duplicate-events')
  assert.equal((await list(admin.id)).policy!.enabled, false)
  assert.deepEqual(await getResponsibilityPolicyVersion(admin.id, original.id), original)
  const paged = responsibilityPolicyListView.parse(JSON.parse(JSON.stringify(await list(admin.id, { page: 100, eventPage: 100 }))))
  assert.equal(paged.versions.length, 0); assert.equal(paged.events.length, 0)
  assert.equal(paged.activeVersion?.id, expectedActiveId)
  const current = responsibilityPolicyCurrentView.parse(JSON.parse(JSON.stringify(await getCurrentResponsibilityPolicy(leader.id))))
  assert.equal(current.activeVersion?.id, expectedActiveId); assert.equal(current.capabilities.manage, false)
  checks.push('typed-ui-current-publication-independent-pagination-actor-capabilities-and-stable-names-no-admin-escalation')
  console.log(JSON.stringify({ ok: true, scope: 'fde-responsibility-policy-foundation-not-full-management', checks, count: checks.length, eightEventTriggersCoveredByThisScript: false, appealsCoveredByThisScript: false, browserVerified: false }))
} finally {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }
  await pool.end()
}
