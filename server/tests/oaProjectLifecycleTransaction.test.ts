import assert from 'node:assert/strict'
import test from 'node:test'
import { getTableName, type SQL } from 'drizzle-orm'
import { MySqlDialect } from 'drizzle-orm/mysql-core'

// This fixture imports schema/SQL builders only. It never loads .env, opens a
// connection or calls the production db client.
Object.assign(process.env, { DB_HOST: '127.0.0.1', DB_PORT: '1', DB_DATABASE: 'isolated_no_connection', DB_USERNAME: 'test', DB_PASSWORD: 'test', DB_FREFIX: 'unit_' })
const { closeDeletedProjectApprovals, projectApprovalOperableCondition } = await import('../src/services/oaProjectLifecycleService.js')
const dialect = new MySqlDialect()
type Write = { table: string; values: Record<string, unknown>; where?: ReturnType<MySqlDialect['sqlToQuery']> }
type Read = { table: string; rows: unknown[] }

function transaction(reads: Read[]) {
  const writes: Write[] = [], queries: Array<ReturnType<MySqlDialect['sqlToQuery']>> = []
  const remaining = [...reads]
  const tx = {
    select() {
      let table = '', condition: SQL | undefined
      const builder = {
        from(value: Parameters<typeof getTableName>[0]) { table = getTableName(value); return builder },
        leftJoin() { return builder },
        where(value: SQL) { condition = value; return builder },
        orderBy() { return builder },
        for() { return builder },
        then(resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) {
          const read = remaining.shift()
          assert.equal(table, `unit_${read?.table}`, 'transaction reads only its expected project data')
          if (condition) queries.push(dialect.sqlToQuery(condition))
          return Promise.resolve(read?.rows ?? []).then(resolve, reject)
        },
      }
      return builder
    },
    update(table: Parameters<typeof getTableName>[0]) {
      return { set(values: Record<string, unknown>) { return { where(condition: SQL) {
        writes.push({ table: getTableName(table), values, where: dialect.sqlToQuery(condition) })
        return Promise.resolve()
      } } } }
    },
    insert(table: Parameters<typeof getTableName>[0]) {
      return { values(values: Record<string, unknown>) { writes.push({ table: getTableName(table), values }); return Promise.resolve() } }
    },
  }
  return { tx: tx as unknown as Parameters<typeof closeDeletedProjectApprovals>[0], writes, queries, remaining }
}

test('project approval SQL requires active project and exact stage without conflating office workflows', () => {
  const query = dialect.sqlToQuery(projectApprovalOperableCondition())
  assert.match(query.sql, /approval_project.lifecycle='active'/)
  assert.match(query.sql, /approval_project.stage=CASE/)
  assert.match(query.sql, /business_type`='office' OR EXISTS/)
  assert.match(query.sql, /unit_projects/)
  assert.doesNotMatch(query.sql, /DELETE|UPDATE/)
})

test('future deletion closes unresolved stage and task approvals, keeps opinions and appends auditable closure', async () => {
  const request = { id: 'request-1', projectId: 'project', requestNo: 'OA-1', businessType: 'project_stage', status: '审批中', currentNodeId: 'review', lockVersion: 4 }
  const extension = { ...request, id: 'extension', businessType: 'task_extension', currentNodeId: null, status: '已退回', lockVersion: 2 }
  const fixture = transaction([
    { table: 'oa_approval_requests', rows: [] },
    { table: 'oa_approval_requests', rows: [request, extension] },
    { table: 'oa_approval_nodes', rows: [{ id: 'submitted', status: '已通过' }, { id: 'review', status: '会签中' }] },
    { table: 'oa_approval_nodes', rows: [{ id: 'extension-submit', status: '已通过' }] },
    { table: 'fde_type_execution_reviews', rows: [] },
  ])
  await closeDeletedProjectApprovals(fixture.tx, 'project', { id: 'leader', name: '领导' })
  assert.equal(fixture.remaining.length, 0)
  const requests = fixture.writes.filter(write => write.table === 'unit_oa_approval_requests')
  assert.deepEqual(requests.map(write => [write.values.status, write.values.lockVersion, write.values.currentNodeId, write.values.activeKey]), [['已撤回', 5, null, null], ['已撤回', 3, null, null]])
  const records = fixture.writes.filter(write => write.table === 'unit_oa_approval_records')
  assert.deepEqual(records.map(write => [write.values.nodeId, write.values.action, write.values.operatorUserId]), [['review', '撤回', 'leader'], ['extension-submit', '撤回', 'leader']])
  for (const write of fixture.writes.filter(write => write.table === 'unit_oa_approval_nodes')) {
    assert.deepEqual(write.where?.params.slice(1), ['未开始', '待审批', '会签中'])
    assert.equal(write.values.approvedByUserIds, undefined, 'co-signers original approval remains intact')
  }
  assert.equal(fixture.writes.filter(write => write.table === 'unit_oa_office_notices' && write.values.closedAt).length, 2)
  for (const write of fixture.writes.filter(write => write.table === 'unit_todos')) assert.match(write.where!.sql, /NOT IN \('已完成','已关闭','已取消','已归档'\)/)
  assert.equal(fixture.writes.filter(write => write.table === 'unit_audit_logs').length, 2)
  assert.ok(fixture.queries[1].params.includes('project_stage'))
  assert.ok(!fixture.queries[1].params.includes('office'))
})

test('open office approval or unfulfilled payment prevents any project deletion side effect', async () => {
  for (const obligation of [{ status: '审批中' }, { status: '已退回' }, { status: '已通过', executionEnabled: true, latestExecutionOutcome: null }, { status: '已通过', executionEnabled: true, latestExecutionOutcome: 'failed' }]) {
    const fixture = transaction([{ table: 'oa_approval_requests', rows: [obligation] }])
    await assert.rejects(closeDeletedProjectApprovals(fixture.tx, 'project', { id: 'leader', name: '领导' }), { code: 'PROJECT_OFFICE_OBLIGATIONS_OPEN' })
    assert.deepEqual(fixture.writes, [])
  }
})

test('completed office obligations are left unchanged; type reviews close with snapshots and notice history intact', async () => {
  const snapshot = { status: 'reviewing', nodes: [{ approvedByUserIds: ['first-reviewer'] }], decisions: [{ action: 'approve' }] }
  const fixture = transaction([
    { table: 'oa_approval_requests', rows: [{ status: '已通过', executionEnabled: true, latestExecutionOutcome: 'succeeded' }] },
    { table: 'oa_approval_requests', rows: [] },
    { table: 'fde_type_execution_reviews', rows: [{ id: 'review-1', version: 3, snapshot }] },
  ])
  await closeDeletedProjectApprovals(fixture.tx, 'project', { id: 'leader', name: '领导' })
  assert.deepEqual(snapshot.status, 'reviewing', 'no mutation of original captured evidence')
  const review = fixture.writes.find(write => write.table === 'unit_fde_type_execution_reviews')!
  assert.equal(review.values.status, 'withdrawn')
  assert.equal(review.values.activeKey, null)
  assert.equal(review.values.version, 4)
  assert.deepEqual(review.values.snapshot, { ...snapshot, status: 'withdrawn' })
  assert.ok(fixture.writes.some(write => write.table === 'unit_fde_type_execution_notices' && write.values.closedAt))
  assert.ok(!fixture.writes.some(write => write.table === 'unit_oa_approval_requests'))
})
