import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { db, pool } from '../db/client.js'
import { auditLogs, companyKnowledge as entries, companyKnowledgeCommands as commands, companyKnowledgeComments as comments, companyKnowledgeEvents as events, companyKnowledgeGrants as grants, companyKnowledgeRatings as ratings, knowledgeChunks, users } from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'
import { getCompanyKnowledge, saveCompanyKnowledge } from '../services/fdeKnowledgeService.js'
import { resolveKnowledgeCommand } from '../services/fdeKnowledgeCommandService.js'
import { knowledgeCommandPath, type KnowledgeCommandTarget } from '../contracts/fdeKnowledgeCommandContract.js'
import { knowledgeResponseLossFixture } from './fdeKnowledgeResponseLossFixture.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
assert.ok(process.env.PROJECT_FILE_ROOT?.includes('fde-migration-acceptance-'))
const checks: string[] = [], marker = randomUUID().slice(0, 8)
const denied = async (operation: Promise<unknown>, code: string) => { const error = await operation.then(() => null, cause => cause); assert.equal(error?.code, code, error?.message ?? 'unexpected success') }
let server: Server | undefined
try {
  process.env.AUTH_COOKIE_SECURE = 'false'; process.env.AUTH_COOKIE_DOMAIN = ''; process.env.AUTH_ALLOW_LEGACY_BEARER = 'false'; process.env.JWT_SECRET = randomUUID() + randomUUID()
  const { hashNewPassword } = await import('../security/passwordPolicy.js')
  const password = `Knowledge-Recovery-${randomUUID()}!`, passwordHash = await hashNewPassword(password)
  const people = ['author', 'viewer', 'other'].map((kind, i) => ({ id: randomUUID(), name: `知识恢复-${marker}-${i === 2 ? 1 : i}`, email: `${kind}-${marker}@example.invalid`, role: '投资经理', department: `恢复验收-${marker}`, passwordHash }))
  const [author, viewer, other] = people
  await db.insert(users).values(people)
  for (const user of people) await identityRepositories.users.synchronizeAdministrationBindings(user.id, user.role, user.department)
  const faults: Array<'before-commit' | 'after-commit'> = []
  const { authRouter } = await import('../routes/auth.js'), { companyKnowledgeRouter } = await import('../routes/companyKnowledge.js'), { requireAuth } = await import('../middleware/requireAuth.js'), { errorHandler } = await import('../middleware/errorHandler.js')
  const app = express(); app.use(express.json()); app.use('/api', (req, res, next) => req.path === '/auth/login' ? next() : requireAuth(req, res, next)); app.use('/api/auth', authRouter); app.use(knowledgeResponseLossFixture(faults)); app.use('/api/company-knowledge', companyKnowledgeRouter); app.use(errorHandler)
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server!.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; process.env.AUTH_ALLOWED_ORIGINS = base
  const sessions = new Map<string, { cookie: string; csrf: string }>()
  for (const user of people) {
    const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: user.email, password }) }); assert.equal(response.status, 200)
    const cookies = response.headers.getSetCookie(); assert.ok(cookies.some(value => value.startsWith('cybernaut_session=') && /HttpOnly/i.test(value)))
    sessions.set(user.id, { cookie: cookies.map(value => value.split(';')[0]).join('; '), csrf: decodeURIComponent(cookies.find(value => value.startsWith('cybernaut_csrf='))!.split(';')[0].slice('cybernaut_csrf='.length)) })
  }
  const request = (userId: string, path: string, body: unknown, extra: Record<string, string> = {}) => {
    const session = sessions.get(userId)!
    return fetch(`${base}/api${path}`, { method: 'POST', headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) })
  }
  const definition = { kind: '方法论', title: `知识恢复-${marker}`, summary: `合成私有摘要-${marker}`, link: '', audience: 'selected', readerIds: [viewer.id], editorIds: [], fileId: null, fileVersion: null }
  const id = randomUUID(), history: Array<{ target: KnowledgeCommandTarget; userId: string; body: object; version: number }> = []
  const lostWrite = async (action: KnowledgeCommandTarget['action'], userId: string, version: number, payload: object, commentId?: string) => {
    const target = { id, action, clientRequestId: randomUUID(), ...(commentId ? { commentId } : {}) }, body = { clientRequestId: target.clientRequestId, expectedVersion: version - 1, ...payload }
    faults.push('after-commit')
    assert.equal((await request(userId, knowledgeCommandPath(target), body)).status, 502)
    const recovered = await request(userId, '/company-knowledge/commands/resolve', target)
    assert.equal(recovered.status, 200); assert.equal(recovered.headers.get('cache-control'), 'private, no-store')
    assert.deepEqual(await recovered.json(), { state: 'committed', receipt: { id, version } })
    assert.deepEqual(await (await request(userId, knowledgeCommandPath(target), body)).json(), { id, version })
    history.push({ target, userId, body, version })
  }
  await lostWrite('save', author.id, 1, { definition })
  await lostWrite('save', author.id, 2, { definition: { ...definition, summary: '编辑后的合成摘要' } })
  await lostWrite('publish', author.id, 3, { action: 'publish', reason: '合成知识人工明确发布' })
  await lostWrite('comment', viewer.id, 4, { content: '合成批注仅可新增一次' })
  const commentId = (await getCompanyKnowledge(id, author.id)).comments[0].id
  await lostWrite('rate', viewer.id, 5, { score: 4 })
  await lostWrite('rate', viewer.id, 6, { score: null })
  await lostWrite('withdraw-comment', viewer.id, 7, { reason: '撤回合成批注保留审计' }, commentId)
  await lostWrite('archive', author.id, 8, { action: 'archive', reason: '合成内容归档保留历史' })
  assert.equal((await db.select().from(events).where(eq(events.entryId, id))).length, 8)
  assert.equal((await db.select().from(comments).where(eq(comments.entryId, id))).length, 1)
  assert.equal((await db.select().from(ratings).where(eq(ratings.entryId, id))).length, 1)
  assert.equal((await getCompanyKnowledge(id, author.id)).entry.ratings, 0)
  checks.push('all-eight-actions:real-authenticated-postcommit-response-loss-resolve-minimal-original-receipt-no-duplicate-business-events')

  for (const item of history) {
    // Synthetic old-version state: preserve the real event; remove only its new technical record.
    await db.delete(commands).where(and(eq(commands.actorId, item.userId), eq(commands.commandId, item.target.clientRequestId)))
    assert.deepEqual(await resolveKnowledgeCommand(item.userId, item.target), { state: 'committed', receipt: { id, version: item.version } })
    const replay = await request(item.userId, knowledgeCommandPath(item.target), item.body)
    assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), { id, version: item.version })
  }
  assert.equal((await db.select().from(events).where(eq(events.entryId, id))).length, 8)
  checks.push('legacy-eight-actions:event-hash-action-comment-identity-bridge-preserves-history-even-after-archive')

  const original = history[0]
  for (const target of [{ ...original.target, id: randomUUID() }, { ...original.target, action: 'publish' as const }]) await denied(resolveKnowledgeCommand(author.id, target), 'KNOWLEDGE_REQUEST_REUSED')
  await denied(saveCompanyKnowledge(id, author.id, { ...original.body, definition: { ...definition, title: '不同内容不得重放' } }), 'KNOWLEDGE_REQUEST_REUSED')
  const wrongComment = { ...history[6].target, commentId: randomUUID() }
  await denied(resolveKnowledgeCommand(viewer.id, wrongComment), 'KNOWLEDGE_REQUEST_REUSED')
  assert.deepEqual(await resolveKnowledgeCommand(other.id, original.target), { state: 'not_applied' })
  assert.deepEqual(await resolveKnowledgeCommand(author.id, original.target), { state: 'committed', receipt: { id, version: 1 } })
  await denied(getCompanyKnowledge(id, viewer.id), 'KNOWLEDGE_FORBIDDEN')
  assert.deepEqual(await resolveKnowledgeCommand(viewer.id, history[3].target), { state: 'committed', receipt: { id, version: 4 } })
  checks.push('scope-and-revocation:other-account-cannot-read-or-fence-owner-command-target-content-and-comment-mismatch-rejected')

  const delayed = { id: randomUUID(), action: 'save' as const, clientRequestId: randomUUID() }, delayedBody = { clientRequestId: delayed.clientRequestId, expectedVersion: 0, definition }
  faults.push('before-commit'); assert.equal((await request(author.id, knowledgeCommandPath(delayed), delayedBody)).status, 502)
  assert.deepEqual(await resolveKnowledgeCommand(author.id, delayed), { state: 'not_applied' })
  assert.deepEqual(await resolveKnowledgeCommand(author.id, delayed), { state: 'not_applied' })
  await denied(saveCompanyKnowledge(delayed.id, author.id, delayedBody), 'KNOWLEDGE_COMMAND_CLOSED')
  assert.equal((await db.select().from(entries).where(eq(entries.id, delayed.id))).length, 0)
  assert.equal((await db.select().from(events).where(eq(events.entryId, delayed.id))).length, 0)
  assert.equal((await saveCompanyKnowledge(delayed.id, author.id, { ...delayedBody, clientRequestId: randomUUID() })).version, 1)
  checks.push('precommit-loss:repeated-resolution-fences-late-write-without-phantom-entry-fresh-confirmed-intent-can-create')

  for (let round = 0; round < 8; round++) {
    const target = { id: randomUUID(), action: 'save' as const, clientRequestId: randomUUID() }, body = { clientRequestId: target.clientRequestId, expectedVersion: 0, definition }
    const operations = round % 2 ? [resolveKnowledgeCommand(author.id, target), saveCompanyKnowledge(target.id, author.id, body)] : [saveCompanyKnowledge(target.id, author.id, body), resolveKnowledgeCommand(author.id, target)]
    const results = await Promise.allSettled(operations), resolution = results[round % 2 ? 0 : 1], write = results[round % 2 ? 1 : 0]
    assert.equal(resolution.status, 'fulfilled')
    const value = resolution.value as Awaited<ReturnType<typeof resolveKnowledgeCommand>>
    if (value.state === 'committed') { assert.equal(write.status, 'fulfilled'); assert.equal(value.receipt.version, 1) }
    else { assert.equal(write.status, 'rejected'); if (write.status === 'rejected') assert.equal(write.reason.code, 'KNOWLEDGE_COMMAND_CLOSED') }
    assert.equal((await db.select().from(entries).where(eq(entries.id, target.id))).length, value.state === 'committed' ? 1 : 0)
    assert.equal((await db.select().from(events).where(eq(events.entryId, target.id))).length, value.state === 'committed' ? 1 : 0)
  }
  // Distinct authors can grant each other without exclusive account-lock cycles.
  await Promise.all([author, viewer].map(person => saveCompanyKnowledge(randomUUID(), person.id, { clientRequestId: randomUUID(), expectedVersion: 0, definition: { ...definition, readerIds: [person.id === author.id ? viewer.id : author.id] } })))
  checks.push('mysql-competition:eight-resolve-write-races-one-terminal-outcome-and-cross-author-grants-without-lock-upgrade')

  const faultId = delayed.id, before = (await db.select().from(entries).where(eq(entries.id, faultId)))[0], beforeGrants = await db.select().from(grants).where(eq(grants.entryId, faultId))
  const auditBefore = await db.select().from(auditLogs).where(eq(auditLogs.userId, author.id)), indexBefore = await db.select().from(knowledgeChunks).where(eq(knowledgeChunks.sourceId, faultId))
  const faultEvent = randomUUID(), command = randomUUID()
  await db.insert(events).values({ id: faultEvent, entryId: faultId, actorId: author.id, requestId: randomUUID(), requestHash: 'x'.repeat(64), action: 'fixture-fault', version: 2, reason: '隔离唯一约束故障', snapshot: {} })
  await assert.rejects(saveCompanyKnowledge(faultId, author.id, { clientRequestId: command, expectedVersion: 1, definition: { ...definition, summary: '失败不得保留', readerIds: [] } }))
  assert.deepEqual((await db.select().from(entries).where(eq(entries.id, faultId)))[0], before)
  assert.deepEqual(await db.select().from(grants).where(eq(grants.entryId, faultId)), beforeGrants)
  assert.deepEqual(await db.select().from(knowledgeChunks).where(eq(knowledgeChunks.sourceId, faultId)), indexBefore)
  assert.deepEqual(await db.select().from(auditLogs).where(eq(auditLogs.userId, author.id)), auditBefore)
  assert.equal((await db.select().from(commands).where(eq(commands.commandId, command))).length, 0)
  await db.delete(events).where(eq(events.id, faultEvent))
  assert.deepEqual(await resolveKnowledgeCommand(author.id, { id: faultId, action: 'save', clientRequestId: command }), { state: 'not_applied' })
  checks.push('real-constraint-rollback:entry-grants-index-audit-and-command-receipt-atomic-no-false-success')

  const resolvePath = '/company-knowledge/commands/resolve', target = history[0].target
  assert.equal((await fetch(`${base}/api${resolvePath}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(target) })).status, 401)
  assert.equal((await request(author.id, resolvePath, target, { 'X-CSRF-Token': '' })).status, 403)
  assert.equal((await request(author.id, resolvePath, target, { Origin: 'https://invalid.example.invalid' })).status, 403)
  assert.equal((await request(author.id, resolvePath, { ...target, actorId: viewer.id })).status, 400)
  await db.update(users).set({ status: '停用' }).where(eq(users.id, author.id))
  assert.equal((await request(author.id, resolvePath, target)).status, 401)
  await denied(resolveKnowledgeCommand(author.id, target), 'KNOWLEDGE_ACTOR_FORBIDDEN')
  await db.update(users).set({ status: '启用' }).where(eq(users.id, author.id))
  checks.push('real-session:anonymous-csrf-origin-actor-injection-and-disabled-account-recovery-rejected')
  console.log(JSON.stringify({ ok: true, suite: 'fde-knowledge-recovery', checks: checks.length, details: checks }))
} catch (error) { console.error(JSON.stringify({ suite: 'fde-knowledge-recovery', completedChecks: checks })); throw error }
finally { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }; await pool.end() }
