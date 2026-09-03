import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import mysql from 'mysql2/promise'

const host = process.env.DB_HOST?.trim()
const port = Number(process.env.DB_PORT)
const user = process.env.DB_MIGRATION_USERNAME?.trim() || process.env.DB_USERNAME?.trim()
const password = process.env.DB_MIGRATION_PASSWORD || process.env.DB_PASSWORD
if (!host || !Number.isInteger(port) || !user || !password) throw new Error('MySQL acceptance credentials are incomplete')
const database = `sbl_accept_research_${randomBytes(6).toString('hex')}`
if (!/^sbl_accept_research_[a-f0-9]{12}$/.test(database)) throw new Error('unsafe acceptance database name')
const connection = await mysql.createConnection({ host, port, user, password, charset: 'utf8mb4_0900_ai_ci' })
try {
  await connection.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`)
  await connection.query(`USE \`${database}\``)
  await connection.query('CREATE TABLE `sbl_leads` (`id` varchar(36) NOT NULL PRIMARY KEY) ENGINE=InnoDB')
  await connection.query('CREATE TABLE `sbl_lead_enrichment_snapshots` (`id` varchar(36) NOT NULL PRIMARY KEY) ENGINE=InnoDB')
  const migration = await readFile(new URL('../../drizzle/0095_add_lead_research_profile_projections.sql', import.meta.url), 'utf8')
  for (const statement of migration.split('--> statement-breakpoint').map((value) => value.trim()).filter(Boolean)) await connection.query(statement)
  const leadId = randomUUID()
  const snapshotId = randomUUID()
  await connection.query('INSERT INTO `sbl_leads` (`id`) VALUES (?)', [leadId])
  await connection.query('INSERT INTO `sbl_lead_enrichment_snapshots` (`id`) VALUES (?)', [snapshotId])
  await connection.query(`INSERT INTO sbl_lead_research_profile_projections
    (lead_id,schema_version,projection_version,snapshot_id,snapshot_hash,source_hash,profile_payload,profile_status)
    VALUES (?,?,?,?,?,?,CAST(? AS JSON),'partial')`, [leadId, 'lead-research-profile-v1', 'lead-research-profile-projection-v1', snapshotId, 'snapshot', 'source', JSON.stringify({ subject: { type: 'research' } })])
  await connection.query('DELETE FROM `sbl_lead_enrichment_snapshots` WHERE id=?', [snapshotId])
  const [afterSnapshot] = await connection.query<mysql.RowDataPacket[]>('SELECT snapshot_id FROM `sbl_lead_research_profile_projections` WHERE lead_id=?', [leadId])
  assert.equal(afterSnapshot[0]?.snapshot_id, null)
  await connection.query('DELETE FROM `sbl_leads` WHERE id=?', [leadId])
  const [afterLead] = await connection.query<mysql.RowDataPacket[]>('SELECT COUNT(*) count FROM `sbl_lead_research_profile_projections`')
  assert.equal(Number(afterLead[0]?.count), 0)
  console.log(JSON.stringify({ ok: true, isolatedDatabase: true, migration: '0095', snapshotDelete: 'set_null', leadDelete: 'cascade' }))
} finally {
  await connection.query(`DROP DATABASE IF EXISTS \`${database}\``).catch(() => undefined)
  await connection.end()
}
