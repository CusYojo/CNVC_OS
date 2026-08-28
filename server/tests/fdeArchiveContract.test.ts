import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { ARCHIVE_EXPORT_LIMIT, archiveAuditQuery, archiveCsv, archiveCsvCell, archiveQuery } from '../src/contracts/fdeArchiveContract.js'

test('archive query uses stable IDs and bounded server pagination, not display names', () => {
  assert.equal(archiveQuery.parse({}).pageSize, 6)
  assert.equal(archiveQuery.parse({ keyword: ' 文件 ', projectId: randomUUID(), page: '2' }).keyword, '文件')
  for (const input of [{ projectId: '同名项目' }, { page: 0 }, { page: 100001 }, { pageSize: 51 }, { page: 1.5 }, { keyword: 'x'.repeat(101) }, { category: 'x'.repeat(33) }, { userId: randomUUID() }, { includeDeleted: true }]) assert.equal(archiveQuery.safeParse(input).success, false)
})
test('audit query limits kinds and stable file identity', () => {
  assert.equal(archiveAuditQuery.parse({ fileId: randomUUID() }).kind, 'access')
  for (const input of [{ kind: 'all' }, { fileId: 'filename.txt' }, { actorId: randomUUID() }]) assert.equal(archiveAuditQuery.safeParse(input).success, false)
})
test('CSV quotes newlines and separators, neutralizes formulas and controls, includes UTF8 BOM', () => {
  assert.equal(archiveCsvCell('文档,"第一行"\n第二行'), '"文档,""第一行""\n第二行"')
  for (const text of ['=1+1', '+cmd', '-1', '@SUM(1)', ' \t=HYPERLINK("x")', '\uFEFF=1', '\t普通文本', '\r换行']) assert.ok(archiveCsvCell(text).startsWith('"\''))
  assert.equal(archiveCsvCell(null), '""'); assert.equal(archiveCsvCell('零\0字节'), '"零字节"')
  assert.equal(archiveCsv([['标题'], ['中文']]), '\uFEFF"标题"\r\n"中文"\r\n')
  assert.equal(ARCHIVE_EXPORT_LIMIT, 2000)
})
