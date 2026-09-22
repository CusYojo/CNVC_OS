import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import type { AddressInfo } from 'node:net'

// Run the real meeting router/service against an in-memory query adapter. No DB
// client, configuration, .env, authentication store or external services load.
test('meeting HTTP writes enforce manager, project scope, version and terminal states', async () => {
  let actorId = 'host', projectVisible = true, writes = 0
  let row: Record<string, any> = {}
  const reset = (patch: Record<string, unknown> = {}) => {
    writes = 0; actorId = 'host'; projectVisible = true
    row = { id: 'meeting', projectId: 'project', projectName: 'Fixture', title: 'Meeting', workflowKind: 'legacy', workflowStatus: 'scheduled', confirmedAt: null,
      createdBy: 'host', hostUserId: 'host', host: 'Host', attendees: ['Host'], version: 3, startedAt: new Date('2090-01-01T08:00:00Z'), endsAt: new Date('2090-01-01T09:00:00Z'), conclusions: [], weeklyReview: null, ...patch }
  }
  const tables = Object.fromEntries(['directiveNotices', 'meetingParticipants', 'meetingWorkflowEvents', 'meetingWorkflowNotices', 'meetings', 'projectDirectives', 'todos', 'auditLogs', 'knowledgeChunks', 'projectFiles', 'projectMembers', 'projects', 'users'].map(name => [name, new Proxy({ table: name }, { get: (target, field) => field === 'table' ? target.table : { table: name, column: field } })]))
  const sql = (parts: TemplateStringsArray, ...values: unknown[]) => ({ kind: 'sql', text: parts.join(''), values })
  const accepts = (condition: any, item: any): boolean => !condition ? true : condition.kind === 'and' ? condition.values.every((value: any) => accepts(value, item))
    : condition.kind === 'or' ? condition.values.some((value: any) => accepts(value, item))
      : condition.kind === 'scope' ? projectVisible
        : condition.kind === 'eq' ? item[condition.values[0].column] === condition.values[1] : true
  const db: any = {
    execute: async () => [],
    select: () => {
      let table: string, condition: any
      const query: any = {
        from: (value: any) => { table = value.table; return query },
        where: (value: any) => { condition = value; return query },
        limit: () => query, for: () => query, orderBy: () => query, groupBy: () => query,
        then: (resolve: any, reject: any) => {
          const rows = table === 'meetings' ? [row] : table === 'users' ? [{ id: actorId, name: actorId, role: '投资经理', status: '启用' }] : table === 'projects' ? [{ id: 'project', lifecycle: 'active' }] : []
          return Promise.resolve(rows.filter(item => accepts(condition, item))).then(resolve, reject)
        },
      }
      return query
    },
    update: (table: any) => ({ set: (patch: any) => ({ where: async (condition: any) => {
      if (table.table === 'meetings' && accepts(condition, row)) { writes += 1; row = { ...row, ...patch, version: typeof patch.version === 'number' ? patch.version : row.version + 1 }; return [{ affectedRows: 1 }] }
      return [{ affectedRows: 0 }]
    } }) }),
  }
  const fixture = { db, tables, sql, scope: () => ({ kind: 'scope' }), transaction: (operation: any) => operation(db) }
  const mocks: Record<string, string> = {
    'drizzle-orm': `export const sql=globalThis.fixture.sql; ${['and', 'or', 'eq', 'desc', 'gte', 'inArray', 'isNull', 'lt', 'lte', 'ne', 'notInArray'].map(name => `export const ${name}=(...values)=>({kind:'${name}',values});`).join('')}`,
    'db/client.js': 'export const db=globalThis.fixture.db;',
    'db/schema.js': Object.keys(tables).map(name => `export const ${name}=globalThis.fixture.tables.${name};`).join(''),
    'services/projectAccessService.js': "export const projectAccessCondition=globalThis.fixture.scope; export const isSystemAdmin=()=>false; export const requireAccessibleProject=async()=>{};",
    'services/identityResolutionService.js': 'export const syncMeetingIdentityBindings=async()=>{};export const syncTodoOwnerIdentity=async()=>{};',
    'services/fdeTaskService.js': 'export const prepareFdeTodo=async(_tx,input)=>input;',
    'services/fdeDirectiveLinksService.js': 'export const directiveTaskAccessCondition=()=>undefined;',
    'services/fdeScheduleTransactionService.js': 'export const scheduleTransaction=globalThis.fixture.transaction;',
    'services/projectFileAccessService.js': 'export const requireProjectFileAccess=async()=>{};',
    'services/ragService.js': 'export const ingestToKnowledge=async()=>{};',
    'services/aiService.js': 'export const answerQuestion=async()=>{}; export const meetingSummary=async()=>{};',
  }
  const bundle = await build({ entryPoints: ['server/src/routes/meetings.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent', plugins: [{ name: 'isolated-meeting-services', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => {
      const key = Object.keys(mocks).find(name => args.path === name || args.path.startsWith('.') && args.path.split('/').pop() === name.split('/').pop())
      return key ? { path: key, namespace: 'fixture' } : undefined
    })
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }))
  } }] })
  const module = { exports: {} as any }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: createRequire(import.meta.url), fixture, Date, console, setTimeout, clearTimeout })
  const app = express()
  app.use(express.json(), (req: any, _res, next) => { req.user = { uid: actorId, name: actorId, role: '投资经理' }; next() })
  app.use('/meetings', module.exports.meetingsRouter)
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status || 500).json({ code: error.code || 'ERROR' }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/meetings/meeting`
  const request = (suffix = '', body: unknown = { expectedVersion: 3, title: 'Updated' }, method = 'PATCH') => fetch(`${base}${suffix}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  try {
    reset(); actorId = 'member'
    assert.equal((await request()).status, 403); assert.equal(writes, 0)
    reset(); projectVisible = false
    assert.equal((await request()).status, 403); assert.equal(writes, 0)
    reset({ confirmedAt: new Date(), workflowStatus: 'completed' })
    assert.equal((await request()).status, 409); assert.equal(writes, 0)
    reset()
    assert.equal((await request('', { expectedVersion: 2, title: 'Stale' })).status, 409); assert.equal(writes, 0)
    for (const workflowStatus of ['deleted', 'cancelled']) {
      reset({ workflowStatus })
      for (const [suffix, body] of [['/lifecycle', { expectedVersion: 3, action: 'start' }], ['/contributions', { expectedVersion: 3, content: 'Cannot append' }], ['/finalize', { expectedVersion: 3, summary: 'Cannot finalize', conclusions: [], tasks: [] }]] as const) {
        assert.equal((await request(suffix, body, 'POST')).status, workflowStatus === 'deleted' ? 404 : 409)
        assert.equal(writes, 0)
      }
    }
    reset()
    assert.equal((await request()).status, 200)
    assert.equal(row.title, 'Updated'); assert.equal(row.version, 4); assert.equal(writes, 1)
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
