import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import express, { type ErrorRequestHandler } from 'express'
import mysql, { type RowDataPacket } from 'mysql2/promise'
import { eq } from 'drizzle-orm'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { cleanupFdeTables, withAcceptanceCleanup } from './fdeAcceptanceCleanup.js'
import { withFdeAcceptanceSignals } from './fdeAcceptanceSignals.js'
import { assertIsolatedMysqlAcceptanceDatabase } from './mysqlAcceptanceSafety.js'

assertIsolatedMysqlAcceptanceDatabase('dueDiligenceReleaseAcceptance')
assert.equal(process.argv.length, 2, '不接受自定义前缀或写入目标')
const sourcePrefix = process.env.DB_FREFIX ?? ''
assert.match(sourcePrefix, /^[A-Za-z0-9_]+$/)
assert.ok(!sourcePrefix.startsWith('fde_accept_'))
const targetPrefix = `fde_accept_${randomBytes(5).toString('hex')}_`
if (process.env.DB_MIGRATION_USERNAME && process.env.DB_MIGRATION_PASSWORD) {
  process.env.DB_USERNAME = process.env.DB_MIGRATION_USERNAME
  process.env.DB_PASSWORD = process.env.DB_MIGRATION_PASSWORD
}
process.env.DB_FREFIX = targetPrefix
process.env.DB_MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url))
const { mysqlConfig, quoteMysqlIdentifier } = await import('../db/config.js')
assert.equal(mysqlConfig.tablePrefix, targetPrefix)
const connect = () => mysql.createConnection({ host: mysqlConfig.host, port: mysqlConfig.port,
  database: mysqlConfig.database, user: mysqlConfig.user, password: mysqlConfig.password,
  charset: 'utf8mb4_0900_ai_ci', connectTimeout: 10_000 })
async function tableNames(connection: mysql.Connection, prefix: string) {
  const [rows] = await connection.query<Array<RowDataPacket & { name: string }>>(
    'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND LEFT(TABLE_NAME,?)=? ORDER BY TABLE_NAME',
    [mysqlConfig.database, prefix.length, prefix])
  return rows.map(row => row.name)
}

await withFdeAcceptanceSignals(async lifecycle => {
  const metadata = await connect()
  let sourceTables: string[]
  try {
    sourceTables = await tableNames(metadata, sourcePrefix)
    assert.equal((await tableNames(metadata, targetPrefix)).length, 0)
  } finally { await metadata.end().catch(() => metadata.destroy()) }
  let fixturePool: { end(): Promise<void> } | undefined
  let server: Server | undefined
  const originalFetch = globalThis.fetch
  const checks: string[] = []
  await withAcceptanceCleanup(async () => {
    lifecycle.checkpoint()
    const { pool, db } = await import('../db/client.js'); fixturePool = pool
    const { applySchemaMigrations, assertSchemaReady } = await import('../db/migrate.js')
    await applySchemaMigrations(); await assertSchemaReady()
    const { users, projects, projectFiles, digitalTwinLearningCandidates } = await import('../db/schema.js')
    const owner = randomUUID(), outsider = randomUUID(), projectId = randomUUID(), otherProject = randomUUID(), fileId = randomUUID()
    await db.insert(users).values([owner, outsider].map(id => ({ id, email: `${id}@acceptance.invalid`, name: '合成验收用户', role: '投资经理', passwordHash: 'synthetic-non-login' })))
    await db.insert(projects).values([projectId, otherProject].map(id => ({ id, name: '合成尽调项目', industry: 'SaaS', owner: '合成验收用户', ownerUserId: owner, createdBy: owner, workflowModel: 'fde-v1' })))
    await db.insert(projectFiles).values({ id: fileId, projectId, name: '合成项目材料.txt', type: 'TXT', category: '项目基础资料', uploader: '合成验收用户', uploadedBy: owner, parseStatus: '成功', contentText: 'SaaS 订阅业务合成材料' })
    const { dueDiligenceRouter } = await import('../routes/dueDiligence.js')
    const app = express()
    app.use(express.json())
    // Test-only identity injection: this app listens on a random loopback port.
    app.use((req: AuthedRequest, _res, next) => {
      req.user = { uid: req.header('x-fixture-user') === outsider ? outsider : owner, email: 'fixture@acceptance.invalid', name: '合成验收用户', role: '投资经理', department: '投资部' }; next()
    })
    app.use('/dd', dueDiligenceRouter)
    app.use(((error, _req, res, _next) => {
      const status = error.status ?? (error.name === 'ZodError' ? 400 : 500)
      res.status(status).json({ code: error.code ?? 'INTERNAL_ERROR' })
    }) as ErrorRequestHandler)
    server = await new Promise<Server>(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)) })
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}/dd`
    // Block every non-fixture HTTP call, even if baseline behavior regresses.
    globalThis.fetch = ((input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      assert.ok(url.startsWith(`${base}/`), '验收禁止模型或其他外部 HTTP 调用')
      return originalFetch(input, init)
    }) as typeof fetch
    async function request(method: string, route: string, status: number, body?: unknown, user = owner): Promise<Record<string, any>> {
      lifecycle.checkpoint()
      const response = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json', 'x-fixture-user': user }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
      assert.equal(response.status, status, `${method} ${route}: ${await response.clone().text().then(text => text.slice(0, 160))}`)
      if (status === 204) return {}
      return response.json() as Promise<Record<string, any>>
    }
    const root = `/projects/${projectId}`
    const pack = await request('POST', `${root}/question-packs/generate`, 201, { mode: 'baseline', fileIds: [fileId] })
    assert.equal(pack.generationMode, 'baseline'); assert.equal(pack.modelStatus, '未调用'); assert.ok(pack.questions.length >= 18)
    const fallback = await request('POST', `${root}/question-packs/generate`, 201, { mode: 'auto', fileIds: [fileId] })
    assert.equal(fallback.generationMode, 'baseline'); assert.equal(fallback.modelStatus, '不可用'); assert.ok(fallback.warning)
    assert.equal(fallback.created, 0, '重复回退不得重复插入问题')
    checks.push('auto-mode-blocked-model-falls-back-without-duplicate-questions')
    const applied = await request('POST', `${root}/question-packs/${pack.id}/apply`, 200, {})
    assert.equal(applied.created, pack.questions.length)
    const document = await fetch(`${base}${root}/question-packs/${pack.id}/docx`)
    assert.equal(document.status, 200); assert.match(document.headers.get('content-type') ?? '', /wordprocessingml/)
    const bytes = Buffer.from(await document.arrayBuffer()); assert.equal(bytes.subarray(0, 2).toString(), 'PK'); assert.ok(bytes.length > 1000)
    checks.push('baseline-pack-generate-apply-docx')
    const question = await request('POST', `${root}/questions`, 201, { title: '合成手工问题', fileIds: [fileId] })
    const updated = await request('PATCH', `${root}/questions/${question.id}`, 200, { title: '已更新问题', expectedVersion: question.version })
    assert.equal(updated.version, question.version + 1)
    assert.equal((await request('PATCH', `${root}/questions/${question.id}`, 409, { title: '过期修改', expectedVersion: question.version })).code, 'VERSION_CONFLICT')
    assert.ok((await request('GET', `${root}/questions`, 200)).list.some((row: { id: string; title: string }) => row.id === question.id && row.title === '已更新问题'))
    checks.push('question-create-read-update-version-conflict')
    const interview = await request('POST', `${root}/interviews`, 201, { title: '合成访谈', mode: '远程' })
    const revised = await request('PATCH', `${root}/interviews/${interview.id}`, 200, { notes: '合成记录', expectedVersion: interview.version })
    assert.equal(revised.notes, '合成记录')
    await request('PATCH', `${root}/interviews/${interview.id}`, 409, { notes: '旧版本', expectedVersion: interview.version })
    assert.ok((await request('GET', `${root}/interviews`, 200)).list.some((row: { id: string }) => row.id === interview.id))
    const otherQuestion = await request('POST', `/projects/${otherProject}/questions`, 201, { title: '另一项目问题' })
    await request('POST', `${root}/interviews/${interview.id}/prompts`, 400, { content: '跨项目引用', questionId: otherQuestion.id })
    await request('POST', `${root}/interviews/${interview.id}/prompts`, 201, { content: '同项目引用', questionId: question.id })
    checks.push('interview-create-read-update-version-conflict-cross-project-prompt')
    for (const route of ['/questions', '/interviews', `/question-packs/${pack.id}/docx`]) await request('GET', `${root}${route}`, 403, undefined, outsider)
    await db.update(projectFiles).set({ accessMode: 'explicit' }).where(eq(projectFiles.id, fileId))
    for (const route of ['/questions', '/interviews', `/question-packs/${pack.id}/docx`]) {
      assert.equal((await request('GET', `${root}${route}`, 403)).code, 'DUE_DILIGENCE_SOURCE_FORBIDDEN')
    }
    await request('POST', `${root}/question-packs/generate`, 403, { mode: 'baseline' })
    await db.update(projectFiles).set({ accessMode: 'project', lifecycle: 'deleted', deletedBy: owner, deletedAt: new Date(), deleteReason: '合成回收站验收', retentionUntil: new Date(Date.now() + 86_400_000) }).where(eq(projectFiles.id, fileId))
    await request('GET', `${root}/questions`, 403)
    await db.update(projectFiles).set({ lifecycle: 'active', deletedBy: null, deletedAt: null, deleteReason: null, retentionUntil: null }).where(eq(projectFiles.id, fileId))
    checks.push('outsider-restricted-file-recycled-source-denied')
    const capabilities = await request('GET', '/capabilities', 200)
    assert.equal(capabilities.apiVersion, 2); assert.equal(capabilities.database.ready, true)
    await request('POST', '/capabilities/write-probe', 200, {})
    const twin = await request('POST', '/twins', 201, { name: '合成分身', role: '尽调顾问', rules: '优先核验现金流', cases: '', clientRequestId: randomUUID() })
    const emptyLibrary = await request('GET', `/twins/${twin.id}/skill-library`, 200)
    assert.equal(emptyLibrary.apiVersion, 2); assert.deepEqual(emptyLibrary.assets, []); assert.deepEqual(emptyLibrary.imports, [])
    await request('POST', `/twins/${twin.id}/publish`, 200, { introduction: '合成分身', publicRules: '优先核验现金流', publicCases: '', industryTags: [], capabilityTags: [] })
    assert.ok((await request('GET', '/twin-directory', 200)).list.some((row: { twinId: string }) => row.twinId === twin.id))
    await request('POST', `/twins/${twin.id}/withdraw-publication`, 200, {})
    assert.ok(!(await request('GET', '/twin-directory', 200)).list.some((row: { twinId: string }) => row.twinId === twin.id))
    checks.push('capabilities-unified-skill-library-publication-withdrawal')
    const candidateId = randomUUID()
    await db.insert(digitalTwinLearningCandidates).values({ id: candidateId, twinId: twin.id, ownerUserId: owner, sourceFileId: fileId, sourceHash: 'synthetic-hash', sourceName: '合成来源', sourceKey: 'synthetic-key', projectId, rules: '合成规则', cases: '合成案例', boundaries: '合成边界', rationale: '合成依据' })
    const snapshot = async () => {
      const tables = ['digital_twin_learning_candidates', 'digital_twin_experience_events', 'digital_twin_skills', 'digital_twins', 'audit_logs']
      return Promise.all(tables.map(async table => {
        const [rows] = await pool.query(`SELECT * FROM ${quoteMysqlIdentifier(`${targetPrefix}${table}`)} ORDER BY id`)
        return JSON.stringify(rows)
      }))
    }
    const before = await snapshot()
    assert.ok((await request('GET', `/twins/${twin.id}/learning-candidates`, 200)).list.some((row: { id: string }) => row.id === candidateId))
    assert.deepEqual(await snapshot(), before)
    await db.update(projectFiles).set({ accessMode: 'explicit' }).where(eq(projectFiles.id, fileId))
    assert.equal((await request('GET', `/twins/${twin.id}/learning-candidates`, 200)).list.length, 0)
    await db.update(projectFiles).set({ accessMode: 'project' }).where(eq(projectFiles.id, fileId))
    await db.update(projects).set({ ownerUserId: outsider }).where(eq(projects.id, projectId))
    assert.equal((await request('GET', `/twins/${twin.id}/learning-candidates`, 200)).list.length, 0)
    await db.update(projects).set({ ownerUserId: owner }).where(eq(projects.id, projectId))
    checks.push('learning-candidates-read-only-and-revoked-source-filtered')
    await request('DELETE', `${root}/interviews/${interview.id}`, 204)
    await request('DELETE', `${root}/questions/${question.id}`, 204)
    assert.ok(!(await request('GET', `${root}/interviews`, 200)).list.length)
    checks.push('interview-and-question-delete')
    console.log(JSON.stringify({ checks, syntheticDataOnly: true, modelCalls: 0 }))
  }, async () => {
    globalThis.fetch = originalFetch
    await withAcceptanceCleanup(async () => {
      if (server) await new Promise<void>((resolve, reject) => { server!.close(error => error ? reject(error) : resolve()); server!.closeIdleConnections() })
    }, async () => {
      await withAcceptanceCleanup(async () => { await fixturePool?.end() }, async () => {
        const result = await cleanupFdeTables({ targetPrefix, sourcePrefix, sourceTables, connect: async () => {
          const connection = await connect()
          try { await connection.query('SET SESSION lock_wait_timeout=10') }
          catch (error) { await connection.end().catch(() => connection.destroy()); throw error }
          return { tables: prefix => tableNames(connection, prefix), foreignKeys: async enabled => { await connection.query(`SET FOREIGN_KEY_CHECKS=${enabled ? 1 : 0}`) },
            drop: async table => { await connection.query(`DROP TABLE IF EXISTS ${quoteMysqlIdentifier(table)}`) }, close: async () => { await connection.end().catch(() => connection.destroy()) } }
        } })
        console.log(JSON.stringify({ cleanup: true, tables: result.tables, businessTableSetUnchanged: true }))
      })
    })
  })
  lifecycle.checkpoint()
  console.log(JSON.stringify({ ok: true, acceptance: 'due-diligence-release', checks: checks.length, cleanupCompleted: true }))
})
