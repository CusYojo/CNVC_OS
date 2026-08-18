import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import XLSX from 'xlsx'
import { ensureSchema } from '../db/migrate.js'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import {
  importManagedWechatAccounts,
  updateManagedRadarSourceMetadata,
} from '../services/radarSourceManagementService.js'
import { assertIsolatedMysqlAcceptanceDatabase } from './mysqlAcceptanceSafety.js'

assertIsolatedMysqlAcceptanceDatabase('radarManagementAcceptance')

const registryTable = quoteMysqlIdentifier(mysqlTableName('radar_source_registry'))
const marker = randomUUID().replaceAll('-', '').slice(0, 20)
const wxNames = [`accept_${marker}_a`, `accept_${marker}_b`]

async function cleanup() {
  await pool.query(
    `DELETE FROM ${registryTable} WHERE source_kind='wechat-account' AND external_key IN (?,?)`,
    wxNames,
  )
}

try {
  await ensureSchema()
  await cleanup()
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['公众号', '帐号名', '分组'],
    ['迁移验收账号 A', wxNames[0], '机构'],
    ['迁移验收账号 A 重复行', wxNames[0], '机构'],
    ['迁移验收账号 B', wxNames[1], '高校'],
  ]), '验收来源')
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer
  const imported = await importManagedWechatAccounts({
    name: 'radar-management-acceptance.xlsx',
    dataBase64: buffer.toString('base64'),
    replace: false,
  })
  assert.equal(imported.imported, 2)
  assert.equal(imported.duplicatesRemoved, 1)
  const [rows] = await pool.query<Array<RowDataPacket & {
    id: string; source_group: string; enabled: number; frequency: string | null
  }>>(
    `SELECT id,source_group,enabled,JSON_UNQUOTE(JSON_EXTRACT(config,'$.frequency')) frequency
     FROM ${registryTable} WHERE source_kind='wechat-account' AND external_key IN (?,?) ORDER BY external_key`,
    wxNames,
  )
  assert.equal(rows.length, 2)
  assert(rows.every((row) => Boolean(row.enabled)))
  await updateManagedRadarSourceMetadata(rows[0].id, { group: '其他', frequency: '每周' })
  const [updated] = await pool.query<Array<RowDataPacket & { source_group: string; frequency: string }>>(
    `SELECT source_group,JSON_UNQUOTE(JSON_EXTRACT(config,'$.frequency')) frequency
     FROM ${registryTable} WHERE id=?`,
    [rows[0].id],
  )
  assert.equal(updated[0]?.source_group, '其他')
  assert.equal(updated[0]?.frequency, '每周')
  console.log(JSON.stringify({
    ok: true,
    workbookImported: true,
    duplicateAccountsRemoved: true,
    sourceMetadataUpdated: true,
    records: rows.length,
  }))
} finally {
  await cleanup()
  await pool.end()
}
