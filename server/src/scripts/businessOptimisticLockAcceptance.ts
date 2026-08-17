import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { assertSchemaReady } from '../db/migrate.js'
import { mysqlTableName } from '../db/config.js'

type Fixture = {
  label: string
  table: string
  id: string
  insertSql: string
  values: string[]
}

const checks: string[] = []
const marker = randomUUID().slice(0, 12)
const fixtures: Fixture[] = [
  {
    label: 'project', table: mysqlTableName('projects'), id: randomUUID(),
    insertSql: `INSERT INTO \`${mysqlTableName('projects')}\` (id,name,owner) VALUES (?,?,?)`,
    values: [`并发验收项目-${marker}`, `验收用户-${marker}`],
  },
  {
    label: 'meeting', table: mysqlTableName('meetings'), id: randomUUID(),
    insertSql: `INSERT INTO \`${mysqlTableName('meetings')}\` (id,project_name,title,host) VALUES (?,?,?,?)`,
    values: [`并发验收项目-${marker}`, `并发验收会议-${marker}`, `验收用户-${marker}`],
  },
  {
    label: 'todo', table: mysqlTableName('todos'), id: randomUUID(),
    insertSql: `INSERT INTO \`${mysqlTableName('todos')}\` (id,title,owner) VALUES (?,?,?)`,
    values: [`并发验收待办-${marker}`, `验收用户-${marker}`],
  },
  {
    label: 'risk', table: mysqlTableName('risks'), id: randomUUID(),
    insertSql: `INSERT INTO \`${mysqlTableName('risks')}\` (id,project_name,type,title) VALUES (?,?,?,?)`,
    values: [`并发验收项目-${marker}`, '合规风险', `并发验收风险-${marker}`],
  },
]

async function sourceContract() {
  const sources = await Promise.all([
    'server/src/routes/projects.ts',
    'server/src/routes/meetings.ts',
    'server/src/routes/risks.ts',
    'server/src/services/projectService.ts',
    'server/src/services/meetingService.ts',
    'server/src/services/riskService.ts',
    'server/src/services/businessOptimisticLock.ts',
    'src/store/useAppStore.ts',
  ].map((file) => readFile(file, 'utf8')))
  const combined = sources.join('\n')
  assert.match(combined, /expectedVersion:\s*z\.number\(\)\.int\(\)\.positive\(\)/)
  assert.match(combined, /BUSINESS_VERSION_CONFLICT/)
  assert.match(combined, /affectedRows\s*!==\s*1/)
  assert.match(combined, /version:\s*sql`\$\{(?:projects|meetings|todos|risks)\.version\}\s*\+\s*1`/)
  assert.match(combined, /\{\s*\.\.\.safePatch,\s*expectedVersion\s*\}/)
  checks.push('api-requires-expected-version-and-client-sends-current-version')
  checks.push('service-updates-use-atomic-version-compare-and-increment')
}

async function raceFixture(fixture: Fixture) {
  await pool.execute(fixture.insertSql, [fixture.id, ...fixture.values])
  const sql = `UPDATE \`${fixture.table}\` SET version=version+1 WHERE id=? AND version=?`
  const results = await Promise.all([
    pool.execute<ResultSetHeader>(sql, [fixture.id, 1]),
    pool.execute<ResultSetHeader>(sql, [fixture.id, 1]),
  ])
  const affected = results.map(([result]) => result.affectedRows).sort()
  assert.deepEqual(affected, [0, 1], `${fixture.label}: exactly one stale writer must win`)
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT version FROM \`${fixture.table}\` WHERE id=?`, [fixture.id],
  )
  assert.equal(Number(rows[0]?.version), 2, `${fixture.label}: winner must increment version once`)
  checks.push(`${fixture.label}-concurrent-writers-have-exactly-one-winner`)
}

try {
  await assertSchemaReady()
  await sourceContract()
  for (const fixture of fixtures) await raceFixture(fixture)
} finally {
  for (const fixture of [...fixtures].reverse()) {
    await pool.execute(`DELETE FROM \`${fixture.table}\` WHERE id=?`, [fixture.id]).catch(() => undefined)
  }
}

for (const fixture of fixtures) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS count FROM \`${fixture.table}\` WHERE id=?`, [fixture.id],
  )
  assert.equal(Number(rows[0]?.count), 0, `${fixture.label}: acceptance fixture residue`)
}
checks.push('acceptance-fixtures-fully-removed')

console.log(JSON.stringify({ ok: true, checks, fixtureResidue: 0 }))
await pool.end()
