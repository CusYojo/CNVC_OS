import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { ensureSchema } from '../db/migrate.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { operationalTelemetryRepository } from '../repositories/mysql/mysqlOperationalTelemetryRepository.js'

const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))
const checks: string[] = []

function check(condition: unknown, name: string) {
  assert.ok(condition, name)
  checks.push(name)
}

async function main() {
  await ensureSchema()
  const suffix = randomUUID()
  const ids = [randomUUID(), randomUUID()]
  const name = `重复指标验收-${suffix}`
  const companyName = `重复指标验收公司-${suffix}`
  const baseline = (await operationalTelemetryRepository.snapshot()).leadAgents
  try {
    await pool.query(
      `INSERT INTO ${leadsTable}
        (id,name,company_name,source,pool_status,score,created_at)
       VALUES (?, ?, ?, 'duplicate-telemetry-acceptance', '成功', 0, NOW(3)),
              (?, ?, ?, 'duplicate-telemetry-acceptance', '成功', 0, NOW(3))`,
      [ids[0], name, companyName, ids[1], name, companyName],
    )
    const observed = (await operationalTelemetryRepository.snapshot()).leadAgents
    check(observed.duplicateNameGroups === baseline.duplicateNameGroups + 1,
      'duplicate-name-group-increments-exactly')
    check(observed.duplicateNameRecords === baseline.duplicateNameRecords + 2,
      'duplicate-name-records-increment-exactly')
    check(observed.duplicateCompanyGroups === baseline.duplicateCompanyGroups + 1,
      'duplicate-company-group-increments-exactly')
    check(observed.duplicateCompanyRecords === baseline.duplicateCompanyRecords + 2,
      'duplicate-company-records-increment-exactly')
    check(observed.duplicateEntityGroups === baseline.duplicateEntityGroups + 2,
      'duplicate-entity-group-total-increments-exactly')
  } finally {
    await pool.query(`DELETE FROM ${leadsTable} WHERE id IN (?,?)`, ids).catch(() => undefined)
  }
  const restored = (await operationalTelemetryRepository.snapshot()).leadAgents
  check(restored.duplicateNameGroups === baseline.duplicateNameGroups
    && restored.duplicateNameRecords === baseline.duplicateNameRecords
    && restored.duplicateCompanyGroups === baseline.duplicateCompanyGroups
    && restored.duplicateCompanyRecords === baseline.duplicateCompanyRecords
    && restored.duplicateEntityGroups === baseline.duplicateEntityGroups,
  'duplicate-metrics-return-to-baseline-after-cleanup')
  const [residueRows] = await pool.query<Array<RowDataPacket & { count: number }>>(
    `SELECT COUNT(*) count FROM ${leadsTable} WHERE id IN (?,?)`, ids,
  )
  check(Number(residueRows[0]?.count || 0) === 0, 'duplicate-telemetry-fixture-residue-is-zero')
  console.log(JSON.stringify({ ok: true, checks, baseline: {
    duplicateNameGroups: baseline.duplicateNameGroups,
    duplicateNameRecords: baseline.duplicateNameRecords,
    duplicateCompanyGroups: baseline.duplicateCompanyGroups,
    duplicateCompanyRecords: baseline.duplicateCompanyRecords,
    duplicateEntityGroups: baseline.duplicateEntityGroups,
  } }))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => await pool.end())
