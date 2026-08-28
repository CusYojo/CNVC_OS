import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { and, eq, sql } from 'drizzle-orm'
import { officeResponseLossFixture, type OfficeResponseFault } from './fdeOfficeResponseLossFixture.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.DB_FREFIX, process.env.FDE_ACCEPTANCE_PREFIX)
assert.ok(process.env.PROJECT_FILE_ROOT?.includes('fde-migration-acceptance-'))
process.env.AUTH_COOKIE_SECURE = 'false'; process.env.AUTH_COOKIE_DOMAIN = ''; process.env.AUTH_ALLOW_LEGACY_BEARER = 'false'; process.env.JWT_SECRET = randomUUID() + randomUUID()
const { db, pool } = await import('../db/client.js')
const { users, userRoles, projects, oaOfficeCommands: commands, oaOfficeEvents: events, oaOfficeAttachments: files, oaOfficeAttachmentGrants: grants, oaApprovalRequests: requests, auditLogs } = await import('../db/schema.js')
const { identityRepositories } = await import('../repositories/index.js')
const { officeDefinition } = await import('../contracts/fdeOfficeContract.js')
const { saveOfficeRequest, resolveOfficeCommand, officeCommandReceipt, actOnOfficeRequest, uploadOfficeAttachment, grantOfficeAttachment, getOfficeRequest } = await import('../services/fdeOfficeService.js')
const { createProject } = await import('../services/projectService.js')
const checks: string[] = [], marker = randomUUID().slice(0, 8), faults: OfficeResponseFault[] = []
const denied = async (work: Promise<unknown>, code: string) => { const error = await work.then(() => null, e => e); assert.equal(error?.code, code, error?.message ?? 'unexpected success') }
let server: Server | undefined
try {
  const { hashNewPassword } = await import('../security/passwordPolicy.js'), password = `Office-Recovery-${randomUUID()}!`, passwordHash = await hashNewPassword(password)
  const people = [0, 1].map(i => ({ id: randomUUID(), name: `办公恢复-${marker}-${i}`, email: `office-recovery-${marker}-${i}@example.invalid`, role: '投资经理', department: `办公恢复-${marker}`, passwordHash }))
  const [author, outsider] = people
  await db.insert(users).values(people)
  for (const person of people) await identityRepositories.users.synchronizeAdministrationBindings(person.id, person.role, person.department)
  const definition = officeDefinition.parse({ title: `恢复-${marker}`, reason: '仅隔离验收合成申请正文', projectId: null, priority: '普通', details: { kind: '合同' }, attachmentIds: [] })
  const input = () => ({ clientRequestId: randomUUID(), expectedVersion: 0, definition })
  const commandRows = (commandId: string, actorId = author.id) => db.select().from(commands).where(and(eq(commands.commandId, commandId), eq(commands.actorId, actorId)))
  const eventRows = (commandId: string) => db.select().from(events).where(eq(events.commandId, commandId))
  const row = async (id: string) => (await db.select().from(requests).where(eq(requests.id, id)))[0]
  const resolve = (id: string, clientRequestId: string, actorId = author.id) => resolveOfficeCommand(id, actorId, { clientRequestId })
  const neverId = randomUUID(), never = input(), initialProjects = (await db.select({ id: projects.id }).from(projects)).length
  assert.deepEqual(await officeCommandReceipt(neverId, never.clientRequestId, author.id), { found: false, retrySameCommandOnly: true })
  assert.equal((await commandRows(never.clientRequestId)).length, 0, 'GET must not fence')
  assert.deepEqual(await resolve(neverId, never.clientRequestId), { state: 'not_applied' })
  assert.deepEqual(await resolve(neverId, never.clientRequestId), { state: 'not_applied' })
  await denied(saveOfficeRequest(neverId, author.id, never), 'OFFICE_COMMAND_CLOSED')
  assert.equal(await row(neverId), undefined); assert.equal((await eventRows(never.clientRequestId)).length, 0)
  assert.equal((await commandRows(never.clientRequestId)).length, 1)
  assert.equal((await db.select().from(auditLogs).where(and(eq(auditLogs.userId, author.id), eq(auditLogs.target, `${neverId} / ${never.clientRequestId}`)))).length, 1)
  assert.equal((await db.select({ id: projects.id }).from(projects)).length, initialProjects)
  checks.push('FDE-OA-008/REC-002:read-only-miss-is-not-proof-repeated-resolution-fences-uncreated-request-with-one-audit-no-draft-or-project')

  const id = randomUUID(), first = input(), receipt = await saveOfficeRequest(id, author.id, first)
  assert.deepEqual(await resolve(id, first.clientRequestId), { state: 'committed', receipt })
  assert.deepEqual(await saveOfficeRequest(id, author.id, first), receipt)
  await denied(saveOfficeRequest(id, author.id, { ...first, definition: { ...definition, title: 'changed' } }), 'OFFICE_COMMAND_REUSED')
  await denied(resolve(randomUUID(), first.clientRequestId), 'OFFICE_COMMAND_REUSED')
  assert.deepEqual(await resolve(id, first.clientRequestId, outsider.id), { state: 'not_applied' })
  assert.deepEqual(await resolve(id, first.clientRequestId), { state: 'committed', receipt })
  await denied(getOfficeRequest(id, outsider.id), 'OFFICE_FORBIDDEN')
  const crossId = randomUUID(), cross = input()
  await resolve(crossId, cross.clientRequestId, outsider.id)
  assert.equal((await saveOfficeRequest(crossId, author.id, cross)).version, 1, 'another actor cannot fence the real author')
  checks.push('FDE-OA-008/011:actor-bound-minimal-receipt-cross-account-fence-cannot-block-owner-replay-hash-and-request-binding')

  const fileId = randomUUID(), upload = { clientRequestId: randomUUID(), expectedVersion: 1, name: '恢复原件.txt', dataBase64: Buffer.from('合成原始字节').toString('base64'), reason: '隔离申请原件恢复验收' }
  await resolve(id, upload.clientRequestId)
  await denied(uploadOfficeAttachment(id, fileId, author.id, upload), 'OFFICE_COMMAND_CLOSED')
  assert.equal((await db.select().from(files).where(eq(files.requestId, id))).length, 0)
  const uploaded = await uploadOfficeAttachment(id, fileId, author.id, { ...upload, clientRequestId: randomUUID() })
  const changes = [
    { commandId: randomUUID(), run: (clientRequestId: string) => saveOfficeRequest(id, author.id, { ...first, clientRequestId, expectedVersion: uploaded.version, definition: { ...definition, title: '必须不生效' } }) },
    { commandId: randomUUID(), run: (clientRequestId: string) => grantOfficeAttachment(id, fileId, author.id, { clientRequestId, expectedVersion: uploaded.version, reason: '隔离授权恢复验收', grants: [{ userId: outsider.id, canDownload: true }] }) },
    { commandId: randomUUID(), run: (clientRequestId: string) => actOnOfficeRequest(id, author.id, { clientRequestId, expectedVersion: uploaded.version, action: 'delete', reason: '隔离删除恢复验收' }) },
  ]
  const unchanged = await row(id)
  for (const change of changes) { await resolve(id, change.commandId); await denied(change.run(change.commandId), 'OFFICE_COMMAND_CLOSED'); assert.equal((await eventRows(change.commandId)).length, 0) }
  assert.deepEqual(await row(id), unchanged)
  assert.equal((await db.select().from(grants).where(eq(grants.attachmentId, fileId))).length, 0)
  checks.push('FDE-OA-008/013/014:all-write-entrances-save-action-upload-grants-reject-fenced-delayed-command-without-business-effects')

  await db.delete(userRoles).where(eq(userRoles.userId, author.id))
  await assert.rejects(getOfficeRequest(id, author.id))
  assert.deepEqual(await resolve(id, first.clientRequestId), { state: 'committed', receipt })
  assert.deepEqual(await saveOfficeRequest(id, author.id, first), receipt)
  await db.update(users).set({ status: '停用' }).where(eq(users.id, author.id))
  await denied(resolve(id, first.clientRequestId), 'OFFICE_ACTOR_UNAVAILABLE')
  await denied(saveOfficeRequest(id, author.id, first), 'OFFICE_ACTOR_UNAVAILABLE')
  await db.update(users).set({ status: '启用' }).where(eq(users.id, author.id))
  await identityRepositories.users.synchronizeAdministrationBindings(author.id, author.role, author.department)
  const deletion = { clientRequestId: randomUUID(), expectedVersion: 1, action: 'delete', reason: '仅删除隔离测试草稿' }
  const deleted = await actOnOfficeRequest(crossId, author.id, deletion)
  await denied(getOfficeRequest(crossId, author.id), 'OFFICE_FORBIDDEN')
  assert.deepEqual(await resolve(crossId, deletion.clientRequestId), { state: 'committed', receipt: deleted })
  checks.push('FDE-AUTH-003/OA-011:lost-business-access-or-deleted-draft-only-own-receipt-enabled-account-required')

  const bad = { ...input(), expectedVersion: unchanged.lockVersion }, faultId = randomUUID()
  await db.insert(events).values({ id: faultId, requestId: id, commandId: randomUUID(), commandHash: 'f'.repeat(64), version: unchanged.lockVersion + 1, actorId: author.id, action: 'fixture-fault', reason: '隔离唯一约束事务回滚', snapshot: {} })
  await assert.rejects(saveOfficeRequest(id, author.id, bad))
  assert.deepEqual(await row(id), unchanged)
  assert.equal((await commandRows(bad.clientRequestId)).length, 0, 'failed transaction cannot retain an open reservation')
  assert.equal((await eventRows(bad.clientRequestId)).length, 0)
  await db.delete(events).where(eq(events.id, faultId))
  assert.deepEqual(await resolve(id, bad.clientRequestId), { state: 'not_applied' })
  await denied(saveOfficeRequest(id, author.id, bad), 'OFFICE_COMMAND_CLOSED')
  assert.equal((await saveOfficeRequest(id, author.id, { ...bad, clientRequestId: randomUUID() })).version, unchanged.lockVersion + 1)
  // A 0067-era event has no command row. Recovery must bridge it without
  // accepting a wrong request ID or rewriting the original business event.
  await db.delete(commands).where(and(eq(commands.actorId, author.id), eq(commands.commandId, first.clientRequestId)))
  await denied(resolve(randomUUID(), first.clientRequestId), 'OFFICE_COMMAND_REUSED')
  assert.equal((await commandRows(first.clientRequestId)).length, 0)
  assert.deepEqual(await resolve(id, first.clientRequestId), { state: 'committed', receipt })
  checks.push('FDE-CONC-001/REC-002:real-constraint-rollback-removes-reservation-failed-write-can-be-fenced-legacy-event-bridge-does-not-poison-key')

  let committedRaces = 0, closedRaces = 0
  for (let round = 0; round < 8; round++) {
    const raceId = randomUUID(), race = input()
    const write = () => saveOfficeRequest(raceId, author.id, race).then(value => ({ value, error: null }), error => ({ value: null, error }))
    const outcomes = round % 2
      ? await Promise.all([resolve(raceId, race.clientRequestId), write(), resolve(raceId, race.clientRequestId), write()])
      : await Promise.all([write(), resolve(raceId, race.clientRequestId), write(), resolve(raceId, race.clientRequestId)])
    const resolutions = outcomes.filter(value => 'state' in value), writes = outcomes.filter(value => 'error' in value)
    assert.equal(resolutions.length, 2); assert.deepEqual(resolutions[0], resolutions[1])
    const committed = resolutions[0].state === 'committed'
    committed ? committedRaces++ : closedRaces++
    assert.equal((await eventRows(race.clientRequestId)).length, committed ? 1 : 0)
    assert.equal(Boolean(await row(raceId)), committed)
    for (const result of writes) { if (committed) { assert.equal(result.error, null); assert.equal(result.value?.version, 1) } else assert.equal(result.error?.code, 'OFFICE_COMMAND_CLOSED') }
  }
  checks.push(`FDE-CONC-002/OA-008:eight-concurrent-create-replay-resolution-races-one-outcome-${committedRaces}-committed-${closedRaces}-fenced`)

  const project = await createProject({ name: `恢复锁-${marker}`, owner: author.name, ownerUserId: author.id, collaborators: [] }, author.id)
  const lockedId = randomUUID(), lockedInput = { ...input(), definition: { ...definition, projectId: project.id } }
  await saveOfficeRequest(lockedId, author.id, lockedInput)
  const delayed = { ...lockedInput, clientRequestId: randomUUID(), expectedVersion: 1 }
  await db.insert(commands).values({ actorId: author.id, commandId: delayed.clientRequestId, requestId: lockedId })
  let release!: () => void, ready!: () => void
  const gate = new Promise<void>(r => { release = r }), acquired = new Promise<void>(r => { ready = r })
  const holder = db.transaction(async tx => { await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${project.id} FOR UPDATE`); ready(); await gate })
  await acquired
  const writing = saveOfficeRequest(lockedId, author.id, delayed).then(value => ({ value, error: null }), error => ({ value: null, error }))
  let resolving: ReturnType<typeof resolve> | undefined
  try {
    let locked = false
    for (let attempt = 0; attempt < 100 && !locked; attempt++) {
      try { await db.execute(sql`SELECT ${commands.id} FROM ${commands} WHERE ${commands.actorId}=${author.id} AND ${commands.commandId}=${delayed.clientRequestId} FOR UPDATE NOWAIT`) }
      catch (error) { const cause = (error as { cause?: { code?: string }; code?: string }); if ((cause.cause?.code ?? cause.code) === 'ER_LOCK_NOWAIT') locked = true; else throw error }
      if (!locked) await new Promise(r => setTimeout(r, 10))
    }
    assert.equal(locked, true, 'real writer must hold the command before waiting on project')
    let finished = false
    resolving = resolve(lockedId, delayed.clientRequestId).finally(() => { finished = true })
    await new Promise(r => setTimeout(r, 30)); assert.equal(finished, false, 'resolution cannot claim absent while writer is in flight')
    release(); await holder
    const written = await writing; assert.equal(written.error, null)
    assert.deepEqual(await resolving, { state: 'committed', receipt: written.value })
    assert.equal((await eventRows(delayed.clientRequestId)).length, 1)
  } finally { release(); await Promise.allSettled([holder, writing, ...(resolving ? [resolving] : [])]) }
  checks.push('FDE-CONC-001/REC-002:real-MySQL-project-lock-holds-inflight-writer-resolution-waits-on-command-and-returns-commit')

  const { authRouter } = await import('../routes/auth.js'), { oaRouter } = await import('../routes/oa.js'), { requireAuth } = await import('../middleware/requireAuth.js'), { errorHandler } = await import('../middleware/errorHandler.js')
  const app = express(); app.use(express.json({ limit: '2mb' })); app.use('/api', (req, res, next) => req.path === '/auth/login' ? next() : requireAuth(req, res, next))
  app.use('/api/auth', authRouter); app.use(officeResponseLossFixture(faults)); app.use('/api/oa', oaRouter); app.use(errorHandler)
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server!.once('listening', r))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; process.env.AUTH_ALLOWED_ORIGINS = origin
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: author.email, password }) }); assert.equal(login.status, 200)
  const cookies = login.headers.getSetCookie(), cookie = cookies.map(v => v.split(';')[0]).join('; '), csrf = decodeURIComponent(cookies.find(v => v.startsWith('cybernaut_csrf='))!.split(';')[0].slice('cybernaut_csrf='.length))
  const httpId = randomUUID(), httpRoot = `${origin}/api/oa/office/requests/${httpId}`
  const http = (suffix: string, body: unknown, extra: Record<string, string> = {}) => fetch(httpRoot + suffix, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) })
  const httpFirst = input(), command = { clientRequestId: httpFirst.clientRequestId }
  assert.equal((await http('/commands/resolve', command, { Cookie: '' })).status, 401)
  assert.equal((await http('/commands/resolve', command, { 'X-CSRF-Token': '' })).status, 403)
  assert.equal((await http('/commands/resolve', command, { Origin: 'https://untrusted.invalid' })).status, 403)
  assert.equal((await http('/commands/resolve', { ...command, actorId: outsider.id })).status, 400)
  assert.equal((await commandRows(httpFirst.clientRequestId)).length, 0)
  checks.push('FDE-AUTH-003/007:real-session-resolution-rejects-missing-auth-csrf-origin-and-injected-actor-before-fencing')
  faults.push('after-commit'); assert.equal((await http('/save', httpFirst)).status, 502)
  const recovered = await http('/commands/resolve', command); assert.equal(recovered.status, 200); assert.equal(recovered.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(await recovered.json(), { state: 'committed', receipt: { id: httpId, version: 1 } })
  assert.equal((await http('/save', httpFirst)).status, 200)
  assert.equal((await eventRows(httpFirst.clientRequestId)).length, 1)
  checks.push('FDE-OA-008/REC-002:real-authenticated-route-response-lost-after-commit-returns-original-version-without-duplicate')
  const httpLate = { ...input(), expectedVersion: 1, definition: { ...definition, title: '未提交旧请求不能到达' } }, lateCommand = { clientRequestId: httpLate.clientRequestId }
  faults.push('before-commit'); assert.equal((await http('/save', httpLate)).status, 502)
  faults.push('after-commit'); assert.equal((await http('/commands/resolve', lateCommand)).status, 502)
  assert.deepEqual(await (await http('/commands/resolve', lateCommand)).json(), { state: 'not_applied' })
  const late = await http('/save', httpLate); assert.equal(late.status, 409); assert.equal((await late.json()).code, 'OFFICE_COMMAND_CLOSED')
  assert.equal((await row(httpId)).lockVersion, 1)
  assert.equal((await http('/save', { ...httpLate, clientRequestId: randomUUID(), definition: { ...definition, title: '重新确认后的新操作' } })).status, 200)
  assert.equal((await row(httpId)).lockVersion, 2)
  await db.update(users).set({ status: '停用' }).where(eq(users.id, author.id))
  assert.equal((await http('/commands/resolve', command)).status, 401)
  await db.update(users).set({ status: '启用' }).where(eq(users.id, author.id))
  checks.push('FDE-OA-008/REC-002:precommit-and-resolution-response-loss-repeated-fence-blocks-late-write-explicit-new-confirmation-disabled-session')
  console.log(JSON.stringify({ ok: true, suite: 'fde-office-recovery', checks: checks.length, details: checks }))
} catch (error) { console.error(JSON.stringify({ suite: 'fde-office-recovery', completedChecks: checks })); throw error }
finally { if (server) { server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())) }; await pool.end() }
