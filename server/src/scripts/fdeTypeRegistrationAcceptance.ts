import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { assertIsolatedMysqlAcceptanceDatabase } from './mysqlAcceptanceSafety.js'

// This file is an executable specification, not evidence of a completed run.
// Load no DB/config module until both dedicated-database and harness guards pass.
assertIsolatedMysqlAcceptanceDatabase('fdeTypeRegistrationAcceptance')
assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
const { db, pool } = await import('../db/client.js')
const { and, asc, eq, sql } = await import('drizzle-orm')
const { users, userRoles, roles, projects, projectMembers, projectClassificationHistory, todos, leads, fdeTypeRegistrationCommands: commands } = await import('../db/schema.js')
const { identityRepositories } = await import('../repositories/index.js')
const { executeTypePolicy, getTypePolicy, listTypePolicies } = await import('../services/fdeTypePolicyService.js')
const { registerTypeProject, recoverTypeRegistration, listTypeRegistrationOptions } = await import('../services/fdeTypeRegistrationService.js')
const { getTypeRuntime } = await import('../services/fdeTypeRuntimeService.js')
const { typePolicyFixture } = await import('./fdeTypePolicyFixture.js')
const { mysqlTableName, quoteMysqlIdentifier } = await import('../db/config.js')
const bcrypt = (await import('bcryptjs')).default
const password = `Isolated-${randomUUID()}!`, passwordHash = await bcrypt.hash(password, 10), mark = randomUUID().slice(0, 8)
const actors = ['系统管理员', '董事长', '投资经理', '投资经理'].map((role, i) => ({ id: randomUUID(), name: `登记隔离-${mark}-${i}`, email: `registration-${mark}-${i}@accept.invalid`, role, department: '隔离验收', passwordHash }))
const [admin, leader, registrar, outsider] = actors, checks: string[] = []
let server: import('node:http').Server | undefined
const rejected = (work: Promise<unknown>, code: string) => assert.rejects(work, e => (e as { code?: string }).code === code)
try {
  const protectedBefore = JSON.stringify(await Promise.all([db.select().from(todos).orderBy(asc(todos.id)), db.select().from(leads).orderBy(asc(leads.id))]))
  await db.insert(users).values(actors)
  for (const actor of actors) await identityRepositories.users.synchronizeAdministrationBindings(actor.id, actor.role, actor.department)
  const [sourceRole] = await db.select({ role: roles }).from(roles).innerJoin(userRoles, eq(userRoles.roleId, roles.id)).where(and(eq(userRoles.userId, registrar.id), eq(roles.status, '启用'))).limit(1)
  // A dedicated synthetic role avoids giving every investment manager access.
  const roleId = randomUUID()
  await db.insert(roles).values({ ...sourceRole.role, id: roleId, code: `registration_${mark}`, name: `合成登记角色-${mark}`, builtIn: false })
  await db.insert(userRoles).values({ userId: registrar.id, roleId, isPrimary: false })
  const config = typePolicyFixture()
  config.planApprovals = [{ duty: 'concerned_leader', name: '合成独立计划审批', mode: '会签' }]
  config.registration = { roleIds: [roleId], ownership: 'registrar', classification: 'normal', onDisable: 'continue_bound_version', ruleReference: '仅隔离测试规则，不用于正式业务；自有登记和保留在途版本' }
  const existing = (await listTypePolicies(admin.id)).policies.find(p => p.code === 'noninvestment:fundraising')
  const created = await executeTypePolicy(admin.id, { commandId: randomUUID(), action: 'create', expectedPolicyVersion: existing?.version ?? 0, configuration: config, reason: '隔离合成受控登记模板' })
  const act = async (action: 'approve' | 'publish' | 'activate' | 'deactivate', uid = admin.id) => {
    const view = await getTypePolicy(admin.id, created.policyId), version = view.versions.find(v => v.id === created.versionId)!
    return executeTypePolicy(uid, { commandId: randomUUID(), action, policyId: created.policyId, versionId: created.versionId, expectedVersion: version.version, ...(action !== 'approve' ? { expectedPolicyVersion: view.policy.version } : {}), reason: '隔离明确办理具体版本' })
  }
  await act('approve', leader.id); await act('publish')
  assert.equal((await listTypeRegistrationOptions(registrar.id)).policies.some(p => p.policyId === created.policyId), false)
  await act('activate')
  const option = (await listTypeRegistrationOptions(registrar.id)).policies.find(p => p.policyId === created.policyId)!
  assert.ok(option)
  assert.equal((await listTypeRegistrationOptions(admin.id)).policies.some(p => p.policyId === created.policyId), false)
  assert.equal((await listTypeRegistrationOptions(outsider.id)).policies.some(p => p.policyId === created.policyId), false)
  const input = { commandId: randomUUID(), policyId: option.policyId, versionId: option.versionId, expectedPolicyVersion: option.policyVersion, expectedSha256: option.sha256, name: `合成登记-${mark}`, cycleDays: 15, targetDate: '2026-10-30', reason: '隔离验收真实登记与回执' }
  await rejected(registerTypeProject(admin.id, input), 'TYPE_REGISTRATION_FORBIDDEN')
  await rejected(registerTypeProject(outsider.id, input), 'TYPE_REGISTRATION_FORBIDDEN')
  checks.push('independent-reviewed-explicit-activation:only-exact-current-role-no-admin-or-name-bypass')
  const [first, replay] = await Promise.all([registerTypeProject(registrar.id, input), registerTypeProject(registrar.id, input)])
  assert.deepEqual(first, replay)
  const [project] = await db.select().from(projects).where(eq(projects.id, first.projectId))
  assert.equal(project.ownerUserId, registrar.id); assert.equal(project.projectType, '基金募资项目'); assert.equal(project.workflowModel, 'fde-v1')
  assert.equal(project.classification, 'normal'); assert.equal(project.stage, config.stages[0].name); assert.equal(project.workflowPolicyVersionId, created.versionId)
  assert.equal((await db.select().from(projectMembers).where(eq(projectMembers.projectId, project.id))).length, 1)
  assert.equal((await db.select().from(projectClassificationHistory).where(eq(projectClassificationHistory.projectId, project.id))).length, 1)
  assert.equal(JSON.stringify(await Promise.all([db.select().from(todos).orderBy(asc(todos.id)), db.select().from(leads).orderBy(asc(leads.id))])), protectedBefore)
  assert.equal((await getTypeRuntime(project.id, registrar.id)).instance, null)
  await rejected(registerTypeProject(registrar.id, { ...input, name: '不同内容' }), 'TYPE_REGISTRATION_COMMAND_REUSED')
  checks.push('concurrent-identical-command:one-project-member-history-receipt-no-tasks-or-lead-conversion:runtime-entry')
  const closedId = randomUUID()
  assert.equal((await recoverTypeRegistration(registrar.id, { commandId: closedId })).state, 'not_committed')
  await rejected(registerTypeProject(registrar.id, { ...input, commandId: closedId }), 'TYPE_REGISTRATION_COMMAND_CLOSED')
  assert.equal((await recoverTypeRegistration(outsider.id, { commandId: input.commandId })).state, 'not_committed')
  checks.push('recovery-seals-late-requests-and-isolates-actors')
  const failedId = randomUUID(), table = quoteMysqlIdentifier(mysqlTableName('fde_type_registration_commands')), constraint = quoteMysqlIdentifier(mysqlTableName(`reg_fail_${mark}`))
  const beforeFailure = JSON.stringify(await Promise.all([db.select().from(projects).orderBy(asc(projects.id)), db.select().from(projectMembers).orderBy(asc(projectMembers.projectId)), db.select().from(projectClassificationHistory).orderBy(asc(projectClassificationHistory.id))]))
  await db.execute(sql.raw(`ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK (command_id <> '${failedId}')`))
  try { await assert.rejects(registerTypeProject(registrar.id, { ...input, commandId: failedId })); assert.equal(JSON.stringify(await Promise.all([db.select().from(projects).orderBy(asc(projects.id)), db.select().from(projectMembers).orderBy(asc(projectMembers.projectId)), db.select().from(projectClassificationHistory).orderBy(asc(projectClassificationHistory.id))])), beforeFailure) }
  finally { await db.execute(sql.raw(`ALTER TABLE ${table} DROP CHECK ${constraint}`)) }
  assert.equal((await db.select().from(commands).where(eq(commands.commandId, failedId))).length, 0)
  checks.push('late-real-SQL-failure-rolls-back-project-membership-classification-and-command')

  const express = (await import('express')).default
  const { requireAuth } = await import('../middleware/requireAuth.js'), { errorHandler } = await import('../middleware/errorHandler.js'), { authRouter } = await import('../routes/auth.js'), { fdeTypeRegistrationRouter } = await import('../routes/fdeTypeRegistration.js')
  const app = express(); app.use(express.json()); app.use('/api', (req, res, next) => req.path === '/auth/login' ? next() : requireAuth(req, res, next)); app.use('/api/auth', authRouter)
  let loseResponse = false
  app.use('/api/fde-type-registration/commands', (req, res, next) => { if (req.path === '/' && loseResponse) { loseResponse = false; res.json = (() => { res.destroy(); return res }) as typeof res.json }; next() })
  app.use('/api/fde-type-registration', fdeTypeRegistrationRouter); app.use(errorHandler)
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server!.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`; process.env.AUTH_ALLOWED_ORIGINS = base
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: registrar.email, password }) }); assert.equal(login.status, 200)
  const cookies = login.headers.getSetCookie(), cookie = cookies.map(s => s.split(';')[0]).join('; '), csrf = decodeURIComponent(cookies.find(s => s.startsWith('cybernaut_csrf='))!.split(';')[0].slice('cybernaut_csrf='.length))
  const headers = { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json', Origin: base }
  const post = (path: string, body: unknown, extra = {}) => fetch(`${base}/api/fde-type-registration${path}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) })
  assert.equal((await fetch(`${base}/api/fde-type-registration/options`)).status, 401)
  assert.equal((await post('/commands', { ...input, commandId: randomUUID() }, { Origin: 'https://invalid.example' })).status, 403)
  assert.equal((await post('/commands', { ...input, commandId: randomUUID() }, { 'X-CSRF-Token': '' })).status, 403)
  const lost = { ...input, commandId: randomUUID() }; loseResponse = true
  await assert.rejects(post('/commands', lost))
  const recovered = await post('/commands/recover', { commandId: lost.commandId }); assert.equal(recovered.status, 200)
  const recovery = await recovered.json() as { state: string; receipt: { projectId: string } }; assert.equal(recovery.state, 'committed')
  assert.equal((await db.select().from(projects).where(eq(projects.id, recovery.receipt.projectId))).length, 1)
  checks.push('real-login-session-csrf-origin:http-committed-response-loss-recovers-same-project')
  await db.delete(userRoles).where(and(eq(userRoles.userId, registrar.id), eq(userRoles.roleId, roleId)))
  assert.equal((await listTypeRegistrationOptions(registrar.id)).policies.some(p => p.policyId === option.policyId), false)
  await rejected(registerTypeProject(registrar.id, { ...input, commandId: randomUUID() }), 'TYPE_REGISTRATION_FORBIDDEN')
  assert.equal((await recoverTypeRegistration(registrar.id, { commandId: input.commandId })).state, 'committed')
  await db.update(users).set({ status: '禁用' }).where(eq(users.id, registrar.id))
  await rejected(recoverTypeRegistration(registrar.id, { commandId: input.commandId }), 'TYPE_REGISTRATION_FORBIDDEN')
  await db.update(users).set({ status: '启用' }).where(eq(users.id, registrar.id))
  await db.insert(userRoles).values({ userId: registrar.id, roleId, isPrimary: false })
  await act('deactivate')
  await rejected(registerTypeProject(registrar.id, { ...input, commandId: randomUUID() }), 'TYPE_REGISTRATION_UNAVAILABLE')
  assert.equal((await getTypeRuntime(project.id, registrar.id)).canAdvance, true)
  assert.equal((await getTypeRuntime(project.id, registrar.id)).policyEnabled, false)
  checks.push('revoked-registration-role-denies-new-work:minimal-own-recovery-disabled-user-denied:disabled-policy-preserves-approved-bound-version')
  console.log(JSON.stringify({ ok: true, checks, scope: 'controlled-noninvestment-registration-not-full-lifecycle-uat' }))
} finally {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
  await pool.end()
}
