import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import XLSX from 'xlsx'
import ExcelJS from 'exceljs'
import { unlink } from 'node:fs/promises'
import { buildLeadImportTemplate, previewLeadImport } from '../services/leadIntakeService.js'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import type { RowDataPacket } from 'mysql2'

const [routes, service, storage, page, schema, migration, routeIndex, serverEntry] = await Promise.all([
  readFile(path.resolve('server/src/routes/leadIntake.ts'), 'utf8'),
  readFile(path.resolve('server/src/services/leadIntakeService.ts'), 'utf8'),
  readFile(path.resolve('server/src/services/leadIntakeFileStorageService.ts'), 'utf8'),
  readFile(path.resolve('src/pages/SourcingPage.tsx'), 'utf8'),
  readFile(path.resolve('server/src/db/schema.ts'), 'utf8'),
  readFile(path.resolve('server/drizzle/0040_add_lead_intake.sql'), 'utf8'),
  readFile(path.resolve('server/src/routes/index.ts'), 'utf8'),
  readFile(path.resolve('server/src/index.ts'), 'utf8'),
])

for (const endpoint of [
  '/leads/import-template', '/leads/imports/preview', '/leads/imports/:id/commit',
  '/leads/bp-uploads', '/leads/bp-uploads/:id', '/leads/bp-uploads/:id/retry',
]) assert.match(routes, new RegExp(endpoint.replace(/[/:]/g, (value) => value === '/' ? '\\/' : value)))

assert.ok(routeIndex.indexOf("apiRouter.use('/', leadIntakeRouter)") < routeIndex.indexOf("apiRouter.use('/', metaRouter)"), 'specific intake routes must be mounted before /leads/:id')
for (const table of ['lead_intake_files', 'lead_import_batches', 'lead_import_rows']) {
  assert.match(schema, new RegExp(`mysqlTable\\('${table}'`))
  assert.match(migration, new RegExp('CREATE TABLE `sbl_' + table + '`'))
}
assert.match(service, /decodeAndValidateProjectFile/)
assert.match(service, /saveLeadIntakeFile/)
assert.match(service, /recordLeadPipelineRawEvent/)
assert.match(service, /recordLeadPipelineDecision/)
assert.match(service, /commitRadarLeadPipelineReady/)
assert.match(service, /FOR UPDATE SKIP LOCKED/)
assert.match(service, /BP_MAX_ATTEMPTS/)
assert.match(service, /scheduleScoring/)
assert.match(storage, /mode: 0o600/)
assert.match(storage, /isSymbolicLink/)
assert.match(serverEntry, /startLeadBpWorker\(scheduleLeadScoring\)/)
assert.match(serverEntry, /stopLeadBpWorker\(\)/)
assert.match(page, /\/leads\/imports\/preview/)
assert.match(page, /\/leads\/bp-uploads/)
assert.doesNotMatch(page, /score:\s*76|setTimeout\(async/)

const template = await buildLeadImportTemplate()
assert.ok(template.length > 1_000, 'template workbook should not be empty')
const workbook = XLSX.read(template, { type: 'buffer' })
assert.ok(workbook.SheetNames.includes('线索导入模板'))
assert.ok(workbook.SheetNames.includes('填写说明'))
const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets['线索导入模板'], { header: 1, raw: false })
assert.deepEqual((rows[0] ?? []).slice(0, 5), ['项目名称*', '公司名称', '行业', '地区', '来源'])

console.log(JSON.stringify({ ok: true, checks: 31, templateBytes: template.length }))

if (process.argv.includes('--live')) {
  const filesTable = quoteMysqlIdentifier(mysqlTableName('lead_intake_files'))
  const batchesTable = quoteMysqlIdentifier(mysqlTableName('lead_import_batches'))
  const rowsTable = quoteMysqlIdentifier(mysqlTableName('lead_import_rows'))
  const usersTable = quoteMysqlIdentifier(mysqlTableName('users'))
  const [users] = await pool.query<Array<RowDataPacket & { id: string; name: string }>>(`SELECT id,name FROM ${usersTable} ORDER BY created_at LIMIT 1`)
  const user = users[0]
  assert.ok(user, 'live acceptance requires one existing user')
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('导入')
  sheet.addRow(['项目名称*', '公司名称', '行业', '地区'])
  sheet.addRow(['线索导入验收科技', '线索导入验收科技有限公司', '人工智能', '北京'])
  sheet.addRow(['', '缺少项目名有限公司', '企业服务', '上海'])
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer())
  let batchId = ''
  let fileId = ''
  let storagePath = ''
  try {
    const result = await previewLeadImport({
      name: `lead-intake-acceptance-${Date.now()}.xlsx`,
      declaredType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      dataBase64: bytes.toString('base64'),
    }, { userId: user.id, userName: user.name })
    batchId = result.id
    assert.equal(result.totalRows, 2)
    assert.equal(result.validRows, 1)
    assert.equal(result.errorRows, 1)
    const [files] = await pool.query<Array<RowDataPacket & { id: string; storage_path: string }>>(
      `SELECT f.id,f.storage_path FROM ${filesTable} f JOIN ${batchesTable} b ON b.file_id=f.id WHERE b.id=?`, [batchId],
    )
    fileId = files[0]?.id ?? ''
    storagePath = files[0]?.storage_path ?? ''
    assert.ok(fileId && storagePath)
    console.log(JSON.stringify({ ok: true, live: true, totalRows: result.totalRows, validRows: result.validRows, errorRows: result.errorRows }))
  } finally {
    if (batchId) {
      await pool.query(`DELETE FROM ${rowsTable} WHERE batch_id=?`, [batchId])
      await pool.query(`DELETE FROM ${batchesTable} WHERE id=?`, [batchId])
    }
    if (fileId) await pool.query(`DELETE FROM ${filesTable} WHERE id=?`, [fileId])
    if (storagePath) {
      const root = path.resolve(process.env.LEAD_INTAKE_FILE_ROOT || path.join(process.cwd(), 'server', 'lead-intake-files'))
      const target = path.resolve(root, storagePath)
      assert.ok(target.startsWith(`${root}${path.sep}`))
      await unlink(target).catch(() => undefined)
    }
    await pool.end()
  }
}
