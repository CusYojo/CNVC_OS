import assert from 'node:assert/strict'
import test from 'node:test'
import * as XLSX from 'xlsx'
import { extractText } from '../src/services/ragService.js'

function workbookBuffer(bookType: 'biff8' | 'xlsx'): Buffer {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['公司', '估值'],
    ['迁移验收项目', 42],
  ]), '证据表')
  return XLSX.write(workbook, { bookType, type: 'buffer' }) as Buffer
}

test('SheetJS 0.20.3 keeps legacy XLS extraction while ExcelJS handles XLSX', async () => {
  assert.equal(XLSX.version, '0.20.3')
  const legacy = await extractText(workbookBuffer('biff8'), 'application/vnd.ms-excel', 'legacy.xls')
  assert.match(legacy, /迁移验收项目/)
  assert.match(legacy, /42/)

  const modern = await extractText(
    workbookBuffer('xlsx'),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'modern.xlsx',
  )
  assert.match(modern, /迁移验收项目/)
  assert.match(modern, /42/)
})
