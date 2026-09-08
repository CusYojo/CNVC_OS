import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { personalNoteCreate } from '../src/contracts/personalNoteContract.js'

const root = resolve(import.meta.dirname, '../..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

test('personal note contract accepts structured formatting and rejects blank or unsupported content', () => {
  const valid = personalNoteCreate.parse({
    title: '今日复盘',
    noteDate: '2026-09-04',
    content: [
      { text: '坚持长期判断', bold: true, color: 'teal' },
      { text: '\n继续验证关键假设', bold: false, color: 'default' },
    ],
  })
  assert.equal(valid.content[0]?.bold, true)
  assert.equal(valid.content[0]?.color, 'teal')
  assert.equal(personalNoteCreate.safeParse({ title: '空白', noteDate: '2026-09-04', content: [{ text: '   ', bold: false, color: 'default' }] }).success, false)
  assert.equal(personalNoteCreate.safeParse({ title: '异常颜色', noteDate: '2026-09-04', content: [{ text: '内容', bold: false, color: 'script' }] }).success, false)
})

test('personal note routes and persistence always scope operations to the signed-in owner', () => {
  const route = read('server/src/routes/personalNotes.ts')
  const service = read('server/src/services/personalNoteService.ts')
  assert.match(route, /req\.user!\.uid/)
  assert.match(route, /Cache-Control', 'private, no-store'/)
  assert.match(service, /eq\(personalNotes\.ownerId, ownerId\)/)
  assert.match(service, /and\(eq\(personalNotes\.id, id\), eq\(personalNotes\.ownerId, ownerId\)\)/)
  assert.match(service, /eq\(personalNotes\.version, input\.expectedVersion\)/)
  assert.doesNotMatch(service, /writeAudit/)
})

test('personal notes are exposed as safe cards with editing controls and a workbench shortcut', () => {
  const component = read('src/components/PersonalNotesPanel.tsx')
  const knowledge = read('src/pages/DataKnowledgePage.tsx')
  const dashboard = read('src/pages/DashboardPage.tsx')
  for (const capability of ['contentEditable', "command('bold')", "command('foreColor'", 'apiPatch', 'apiDelete']) assert.match(component, new RegExp(capability.replace(/[()]/g, '\\$&')))
  assert.doesNotMatch(component, /dangerouslySetInnerHTML/)
  assert.match(component, /const block = tag === 'div' \|\| tag === 'p'/)
  assert.match(component, /run\.text\.split\('\\n'\)/)
  assert.match(component, /lineIndex < lines\.length - 1 && <br \/>/)
  assert.match(knowledge, /requestedView === 'notes'/)
  assert.match(knowledge, />个人笔记<\/button>/)
  assert.match(dashboard, /to="\/knowledge\?view=notes"/)
})

test('0097 migration and runtime readiness include the owner-isolated notes table', () => {
  const migration = read('server/drizzle/0097_add_personal_notes.sql')
  const journal = JSON.parse(read('server/drizzle/meta/_journal.json')) as { entries: Array<{ idx: number; tag: string }> }
  const schema = read('server/src/db/schema.ts')
  const readiness = read('server/src/db/migrate.ts')
  assert.equal(journal.entries.find(entry => entry.idx === 97)?.tag, '0097_add_personal_notes')
  assert.match(migration, /FOREIGN KEY \(`owner_id`\)/)
  assert.match(migration, /INDEX `idx_personal_notes_owner_date`/)
  assert.match(schema, /mysqlTable\('personal_notes'/)
  assert.match(readiness, /'personal_notes'/)
})
