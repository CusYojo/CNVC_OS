import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import express from 'express'
import { and, count, eq } from 'drizzle-orm'
import { materialResponseLossFixture, type MaterialResponseFault } from './fdeMaterialResponseLossFixture.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.DB_FREFIX, process.env.FDE_ACCEPTANCE_PREFIX)
assert.ok(process.env.PROJECT_FILE_ROOT?.includes('fde-migration-acceptance-'))
process.env.AUTH_COOKIE_SECURE = 'false'
process.env.AUTH_COOKIE_DOMAIN = ''
process.env.AUTH_ALLOW_LEGACY_BEARER = 'false'
process.env.JWT_SECRET = randomUUID() + randomUUID()
const { db, pool } = await import('../db/client.js')
const { users, projects, projectMaterialEvents, projectMaterialSubmissions, projectMaterialRequestClosures } = await import('../db/schema.js')
const { identityRepositories } = await import('../repositories/index.js')
const { hashNewPassword } = await import('../security/passwordPolicy.js')
const { addFile, classifyProject, createProject, setFileStoragePath } = await import('../services/projectService.js')
const { proposeFdeGovernance } = await import('../services/fdeGovernanceService.js')
const { setFdeFilePermissions, getFdeFile } = await import('../services/fdeFileService.js')
const { getMaterialContext } = await import('../services/fdeMaterialService.js')
const { saveProjectFileRevision } = await import('../services/projectFileStorageService.js')
const { authRouter } = await import('../routes/auth.js')
const { projectsRouter } = await import('../routes/projects.js')
const { requireAuth } = await import('../middleware/requireAuth.js')
const { errorHandler } = await import('../middleware/errorHandler.js')
const checks: string[] = [], faults: MaterialResponseFault[] = [], marker = randomUUID().slice(0, 8)
let server: Server | undefined
type Session = { cookie: string; csrf: string }
try {
  const password = `Isolated-Material-${randomUUID()}!`, passwordHash = await hashNewPassword(password)
  const people = ['投资经理', '投资经理', '董事长', '投资经理'].map((role, i) => ({ id: randomUUID(), name: `材料HTTP-${marker}-${i}`, role, department: `材料HTTP-${marker}`, email: `material-http-${marker}-${i}@example.invalid`, passwordHash }))
  const [owner, member, leader, outsider] = people
  await db.insert(users).values(people)
  for (const actor of people) await identityRepositories.users.synchronizeAdministrationBindings(actor.id, actor.role, actor.department)
  let project = await createProject({ name: `材料HTTP-${marker}`, owner: owner.name, ownerUserId: owner.id, collaborators: [] }, owner.id)
  project = await classifyProject({ projectId: project.id, userId: owner.id, expectedVersion: project.version, toClassification: 'normal', reason: '隔离HTTP初筛验收' })
  await proposeFdeGovernance({ projectId: project.id, userId: owner.id, ownerUserId: owner.id, expectedVersion: project.governanceVersion, reason: '隔离HTTP材料职责配置', assignments: [{ duty: 'member', userId: member.id }, { duty: 'member', userId: outsider.id }, { duty: 'concerned_leader', userId: leader.id }] })
  const bytes = Buffer.from(`HTTP送审冻结原件-${marker}`), sha256 = createHash('sha256').update(bytes).digest('hex')
  const file = await addFile({ projectId: project.id, name: `${marker}.txt`, type: 'TXT', category: '项目资料', uploader: member.name, byteSize: bytes.length, sha256 }, member.id)
  await setFileStoragePath(file.id, await saveProjectFileRevision(project.id, file.id, bytes), member.id)
  await setFdeFilePermissions(file.id, owner.id, { clientRequestId: randomUUID(), expectedVersion: 1, reason: '隔离HTTP仅发送人查看', grants: [{ userId: member.id, canView: true, canDownload: false }] })
  const app = express(); app.use(express.json())
  app.use('/api', (req, res, next) => req.path === '/auth/login' ? next() : requireAuth(req, res, next))
  app.use('/api/auth', authRouter); app.use(materialResponseLossFixture(faults)); app.use('/api/projects', projectsRouter); app.use(errorHandler)
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server!.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  process.env.AUTH_ALLOWED_ORIGINS = base
  const root = `/api/projects/${project.id}`, submissions = `${root}/material-submissions`, resolution = `${root}/material-request-resolution`
  const request = (url: string, session?: Session, body?: unknown, extra: Record<string, string> = {}) => fetch(base + url, { method: body === undefined ? 'GET' : 'POST', headers: { ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}), 'Content-Type': 'application/json', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const login = async (email: string): Promise<Session> => {
    const res = await request('/api/auth/login', undefined, { email, password }); assert.equal(res.status, 200)
    const cookies = res.headers.getSetCookie(); const cookie = cookies.map(line => line.split(';')[0]).join('; ')
    const csrf = decodeURIComponent(cookies.find(line => line.startsWith('cybernaut_csrf='))!.split(';')[0].slice('cybernaut_csrf='.length))
    assert.ok(cookies.some(line => line.startsWith('cybernaut_session=') && /HttpOnly/i.test(line)))
    return { cookie, csrf }
  }
  assert.equal((await request(`${root}/material-context`)).status, 401)
  assert.equal((await request(resolution, undefined, { clientRequestId: randomUUID() })).status, 401)
  assert.equal((await request('/api/auth/login', undefined, { email: member.email, password: 'incorrect' })).status, 401)
  const [memberSession, ownerSession, leaderSession, outsiderSession] = await Promise.all(people.slice().map(actor => login(actor.email))).then(items => [items[1], items[0], items[2], items[3]])
  assert.equal((await request(resolution, memberSession, { clientRequestId: randomUUID() }, { 'X-CSRF-Token': '' })).status, 403)
  assert.equal((await request(resolution, memberSession, { clientRequestId: randomUUID() }, { Origin: 'https://untrusted.invalid' })).status, 403)
  checks.push('FDE-AUTH-003/007:real-login-session-http-only-cookie-unauthenticated-csrf-and-origin-rejection')

  const payload = async () => {
    const context = await getMaterialContext(project.id, member.id), detail = await getFdeFile(file.id, member.id)
    return { clientRequestId: randomUUID(), fileId: file.id, fileVersion: detail.file.version, expectedAccessVersion: detail.file.accessVersion, expectedProjectVersion: context.projectVersion, expectedGovernanceVersion: context.governanceVersion, title: 'HTTP原件送审', note: '隔离接口正文', recipientIds: [owner.id, leader.id] }
  }
  const initial = await payload()
  assert.equal((await request(submissions, memberSession, { ...initial, senderId: outsider.id })).status, 400)
  const stale = await request(submissions, memberSession, { ...initial, expectedAccessVersion: 999 }); assert.equal(stale.status, 409); assert.equal((await stale.json()).code, 'VERSION_CONFLICT')
  assert.equal((await db.select().from(projectMaterialSubmissions).where(eq(projectMaterialSubmissions.projectId, project.id))).length, 0)
  faults.push('after-commit')
  assert.equal((await request(submissions, memberSession, initial)).status, 502)
  const resolved = await request(resolution, memberSession, { clientRequestId: initial.clientRequestId }); assert.equal(resolved.status, 200); assert.equal(resolved.headers.get('cache-control'), 'private, no-store')
  const receipt = await resolved.json(); assert.equal(receipt.state, 'committed'); assert.equal(receipt.action, 'submit')
  assert.deepEqual(await (await request(resolution, memberSession, { clientRequestId: initial.clientRequestId })).json(), receipt)
  assert.deepEqual(Object.keys(receipt).sort(), ['action', 'id', 'state'])
  assert.equal((await db.select().from(projectMaterialSubmissions).where(eq(projectMaterialSubmissions.projectId, project.id))).length, 1)
  checks.push('FDE-REC-002/CONC-002:real-route-commit-response-lost-recovery-returns-one-original-submission')

  const detail = await request(`${submissions}/${receipt.id}`, ownerSession); assert.equal(detail.status, 200)
  assert.equal((await detail.json()).submission.recipients.some((person: { readAt: unknown }) => person.readAt), false)
  const preview = await request(`${submissions}/${receipt.id}/preview`, ownerSession); assert.equal(preview.status, 200); assert.equal(preview.headers.get('cache-control'), 'private, no-store')
  assert.equal(preview.headers.get('x-content-sha256'), sha256); assert.deepEqual(Buffer.from(await preview.arrayBuffer()), bytes)
  assert.equal((await request(`/api/projects/files/${file.id}/versions/1/download`, ownerSession)).status, 403)
  assert.equal((await request(`${submissions}/${receipt.id}`, outsiderSession)).status, 403)
  const foreign = await request(resolution, outsiderSession, { clientRequestId: initial.clientRequestId }); assert.equal(foreign.status, 409); assert.equal('id' in await foreign.json(), false)
  checks.push('FDE-FILE-001/003/005:authenticated-original-preview-no-store-get-does-not-read-download-and-foreign-receipt-denied')

  const unsent = await payload(); faults.push('before-commit')
  assert.equal((await request(submissions, memberSession, unsent)).status, 502)
  assert.deepEqual(await (await request(resolution, memberSession, { clientRequestId: unsent.clientRequestId })).json(), { state: 'not_applied' })
  const late = await request(submissions, memberSession, unsent); assert.equal(late.status, 409); assert.equal((await late.json()).code, 'MATERIAL_REQUEST_CLOSED')
  assert.equal((await db.select().from(projectMaterialSubmissions).where(eq(projectMaterialSubmissions.projectId, project.id))).length, 1)
  assert.equal((await db.select().from(projectMaterialRequestClosures).where(and(eq(projectMaterialRequestClosures.projectId, project.id), eq(projectMaterialRequestClosures.actorId, member.id)))).length, 1)
  const secondRes = await request(submissions, memberSession, { ...unsent, clientRequestId: randomUUID() }); assert.equal(secondRes.status, 201)
  const second = await secondRes.json()
  checks.push('FDE-REC-002:precommit-response-loss-fences-late-command-before-explicit-new-confirmation')

  const decision = { clientRequestId: randomUUID(), expectedRecipientVersion: 1, decision: 'approve', feedback: '真实接收人独立反馈' }
  faults.push('after-commit'); assert.equal((await request(`${submissions}/${receipt.id}/decision`, leaderSession, decision)).status, 502)
  assert.deepEqual(await (await request(resolution, leaderSession, { clientRequestId: decision.clientRequestId })).json(), { state: 'committed', id: receipt.id, action: 'approve' })
  const withdrawal = { clientRequestId: randomUUID(), expectedVersion: 1, reason: '真实发送人撤回未反馈轮次' }
  faults.push('after-commit'); assert.equal((await request(`${submissions}/${second.id}/withdraw`, memberSession, withdrawal)).status, 502)
  assert.deepEqual(await (await request(resolution, memberSession, { clientRequestId: withdrawal.clientRequestId })).json(), { state: 'committed', id: second.id, action: 'withdraw' })
  for (const clientRequestId of [decision.clientRequestId, withdrawal.clientRequestId]) assert.equal((await db.select({ n: count() }).from(projectMaterialEvents).where(eq(projectMaterialEvents.requestId, clientRequestId)))[0].n, 1)
  assert.equal((await db.select().from(projects).where(eq(projects.id, project.id)))[0].stage, '立项')
  checks.push('FDE-FILE-003/REC-002:feedback-and-withdrawal-response-loss-recover-one-decision-stage-unchanged')

  assert.equal((await request('/api/auth/logout', memberSession, {})).status, 200)
  assert.equal((await request(resolution, memberSession, { clientRequestId: initial.clientRequestId })).status, 401)
  await db.update(users).set({ status: '停用' }).where(eq(users.id, leader.id))
  assert.equal((await request(`${submissions}/${receipt.id}`, leaderSession)).status, 401)
  checks.push('FDE-AUTH-003:revoked-session-and-disabled-account-cannot-recover-or-read-material')
  console.log(JSON.stringify({ ok: true, suite: 'fde-material-authenticated-http', checks: checks.length, details: checks }))
} finally {
  if (server) { server.closeIdleConnections(); await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())) }
  await pool.end()
}
