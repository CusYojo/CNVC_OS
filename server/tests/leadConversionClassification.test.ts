import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Execute the real conversion function with an in-memory transaction, without loading
// the database client or .env. MySQL locking/rollback remain integration-test concerns.
const source = ts.createSourceFile('aiSummaryService.ts', readFileSync(new URL('../src/services/aiSummaryService.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const functions = ['leadConversionError', 'objectValue', 'textValue', 'convertLead']
const declarations = source.statements.filter(node => ts.isFunctionDeclaration(node) && functions.includes(node.name?.text ?? ''))
assert.equal(declarations.length, functions.length)
const code = ts.transpileModule(declarations.map(node => node.getText(source)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText

type Row = Record<string, any>
type Predicate = (row: Row) => boolean
type Table = Record<string, string>

function fixture(
  leadPatch: Row = {},
  actorPatch: Row = {},
  options: { ownerPatch?: Row; permissionCodes?: string[] } = {},
) {
  const actor = { id: 'current-user', name: '当前用户', status: '启用', ...actorPatch }
  const owner = { id: 'assigned-owner', name: '目标负责人', department: '硬科技部', status: '启用', ...options.ownerPatch }
  const tableNames = ['projects', 'leads', 'migrationEntityMappings', 'projectMembers', 'projectClassificationHistory', 'auditLogs', 'leadScoreJobs', 'leadEnrichmentTopicRuns', 'leadEnrichmentJobs']
  const tables = Object.fromEntries(tableNames.map(name => [name, Object.fromEntries(['id', 'targetId', 'sourceSystem', 'sourceTable', 'sourceId', 'leadId', 'status'].map(key => [key, key]))])) as Record<string, Table>
  const rows = new Map<Table, Row[]>(Object.values(tables).map(table => [table, []]))
  rows.set(tables.leads, [{ id: 'lead-1', name: '待转换线索', companyName: '企业主体', source: '公开报道', poolStatus: '公共池', score: 68, fundingRounds: [{ round: 'A轮', amount: '人民币1亿元' }], radarSourceKeys: ['vc-hunter:test'], ...leadPatch }])
  const read = (name: string) => rows.get(tables[name])!
  const tx = {
    select: () => ({ from: (table: Table) => ({ where: (matches: Predicate) => ({ limit: async (size: number) => rows.get(table)!.filter(matches).slice(0, size) }) }) }),
    execute: async () => {},
    insert: (table: Table) => ({ values: (values: Row | Row[]) => {
      const inserted = (Array.isArray(values) ? values : [values]).map(value => ({ id: `row-${rows.get(table)!.length + 1}`, ...value }))
      rows.get(table)!.push(...inserted)
      return { $returningId: async () => inserted.map(({ id }) => ({ id })) }
    } }),
    update: (table: Table) => ({ set: (patch: Row) => ({ where: async (matches: Predicate) => {
      for (const row of rows.get(table)!.filter(matches)) Object.assign(row, patch)
    } }) }),
    delete: (table: Table) => ({ where: async (matches: Predicate) => { rows.set(table, rows.get(table)!.filter(row => !matches(row))) } }),
  }
  const convertLead = runInNewContext(`${code}\nconvertLead`, {
    exports: {}, ...tables,
    db: { ...tx, transaction: async (callback: (value: typeof tx) => unknown) => callback(tx) },
    createMySqlIdentityRepositoryContext: () => ({ users: {
      findById: async (id: string) => id === actor.id ? actor : id === owner.id ? owner : undefined,
      listPermissionCodes: async () => options.permissionCodes ?? [],
    } }),
    canAssignProjectDiscoveryOwner: (actorId: string, ownerId: string, permissionCodes: string[]) => (
      actorId === ownerId || permissionCodes.includes('project.classify') || permissionCodes.includes('system.manage')
    ),
    isProjectDiscoveryLead: (sourceKeys: unknown) => Array.isArray(sourceKeys)
      && sourceKeys.some((key) => typeof key === 'string' && (key.startsWith('vc-hunter:') || key.startsWith('bp-upload:'))),
    activeWorkflowPolicyVersion: async () => 'active-policy',
    sanitizeScoringCompetitors: (value: unknown) => value,
    eq: (field: string, value: unknown): Predicate => row => row[field] === value,
    and: (...conditions: Predicate[]): Predicate => row => conditions.every(matches => matches(row)),
    inArray: (field: string, values: unknown[]): Predicate => row => values.includes(row[field]),
    sql: () => ({}),
  }) as (leadId: string, userId: string, assignment?: { ownerUserId?: string; department?: string }) => Promise<{ project: Row; lead: Row }>
  return {
    convert: (leadId = 'lead-1', userId = actor.id, assignment?: { ownerUserId?: string; department?: string }) => convertLead(leadId, userId, assignment),
    read,
    actor,
    owner,
  }
}

test('lead conversion returns an active normal project owned by the current user', async () => {
  const { convert, read, actor } = fixture()
  const result = await convert()
  assert.equal(result.project.classification, 'normal')
  assert.equal(result.project.lifecycle, 'active')
  assert.equal(result.project.stage, '立项')
  assert.equal(result.project.progress, 10)
  assert.equal(result.project.stageSource, '线索转入')
  assert.equal(result.project.workflowModel, 'fde-v1')
  assert.equal(result.project.workflowPolicyVersionId, 'active-policy')
  assert.equal(result.project.latestApprovalId, undefined)
  assert.equal(result.project.ownerUserId, actor.id)
  assert.equal(result.project.owner, actor.name)
  assert.equal(result.project.createdBy, actor.id)
  assert.equal(read('projectMembers')[0].userId, actor.id)
  assert.equal(read('projectMembers')[0].memberRole, 'owner')
  assert.equal(result.lead.poolStatus, '已转专属项目')
  assert.equal(result.lead.convertedProjectId, result.project.id)
  assert.equal(result.lead.claimedBy, actor.name)
  assert.equal(read('projects').length, 1)
  const history = read('projectClassificationHistory')
  assert.equal(history.length, 1)
  assert.equal(history[0].projectId, result.project.id)
  assert.equal(history[0].fromClassification, null)
  assert.equal(history[0].toClassification, 'normal')
  assert.equal(history[0].changedBy, actor.id)
  assert.equal(history[0].changedByName, actor.name)
  assert.equal(read('auditLogs').length, 2)
})

test('conversion retains source facts and handles absent optional fields', async () => {
  const { project } = await fixture().convert()
  assert.equal(project.companyName, '企业主体')
  assert.equal(project.source, '公开报道')
  assert.equal(project.round, 'A轮')
  assert.equal(project.financing, '人民币1亿元')
  assert.equal(project.score, 68)
  const empty = await fixture({ companyName: null, fundingRounds: null, radarProfile: null, riskTags: null }).convert()
  assert.equal(empty.project.classification, 'normal')
  assert.equal(empty.project.companyName, undefined)
  assert.equal(empty.project.round, undefined)
  assert.equal(empty.project.financing, undefined)
})

test('authorized discovery conversion assigns the project to the selected department owner', async () => {
  const { convert, read, actor, owner } = fixture({}, {}, { permissionCodes: ['project.classify'] })
  const result = await convert('lead-1', actor.id, { ownerUserId: owner.id, department: owner.department })
  assert.equal(result.project.ownerUserId, owner.id)
  assert.equal(result.project.owner, owner.name)
  assert.equal(result.project.createdBy, actor.id)
  assert.equal(read('projectMembers')[0].userId, owner.id)
  assert.equal(result.lead.claimedBy, owner.name)
})

test('discovery conversion rejects unauthorized or mismatched owner assignment', async () => {
  const unauthorized = fixture()
  await assert.rejects(
    unauthorized.convert('lead-1', unauthorized.actor.id, { ownerUserId: unauthorized.owner.id, department: unauthorized.owner.department }),
    { code: 'LEAD_ASSIGNMENT_FORBIDDEN', status: 403 },
  )
  assert.equal(unauthorized.read('projects').length, 0)

  const mismatch = fixture({}, {}, { permissionCodes: ['system.manage'] })
  await assert.rejects(
    mismatch.convert('lead-1', mismatch.actor.id, { ownerUserId: mismatch.owner.id, department: '错误部门' }),
    { code: 'LEAD_ASSIGNMENT_DEPARTMENT_MISMATCH', status: 400 },
  )
  assert.equal(mismatch.read('projects').length, 0)

  const sharedPool = fixture({ radarSourceKeys: ['radar:legacy'] }, {}, { permissionCodes: ['system.manage'] })
  await assert.rejects(
    sharedPool.convert('lead-1', sharedPool.actor.id, { ownerUserId: sharedPool.owner.id, department: sharedPool.owner.department }),
    { code: 'LEAD_ASSIGNMENT_SCOPE_FORBIDDEN', status: 403 },
  )
  assert.equal(sharedPool.read('projects').length, 0)
})

test('repeat conversion still rejects without a second project or history row', async () => {
  const { convert, read } = fixture()
  await convert()
  await assert.rejects(convert(), { code: 'LEAD_ALREADY_CONVERTED', status: 409 })
  assert.equal(read('projects').length, 1)
  assert.equal(read('projectClassificationHistory').length, 1)
})

for (const scenario of [
  { name: 'missing lead', leadId: 'missing', code: 'LEAD_NOT_FOUND', status: 404 },
  { name: 'missing actor', userId: 'missing', code: 'LEAD_CONVERT_ACTOR_INVALID', status: 403 },
  { name: 'disabled actor', actor: { status: '停用' }, code: 'LEAD_CONVERT_ACTOR_INVALID', status: 403 },
  { name: 'deregistered company', lead: { poolStatus: '已注销' }, code: 'COMPANY_DEREGISTERED', status: 409 },
]) {
  test(`${scenario.name} cannot create a normal project`, async () => {
    const { convert, read } = fixture(scenario.lead, scenario.actor)
    await assert.rejects(convert(scenario.leadId, scenario.userId), { code: scenario.code, status: scenario.status })
    assert.equal(read('projects').length, 0)
    assert.equal(read('projectMembers').length, 0)
    assert.equal(read('projectClassificationHistory').length, 0)
    assert.equal(read('auditLogs').length, 0)
  })
}
