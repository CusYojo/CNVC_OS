import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

test('project file cards expose permission-aware recycle and restore actions', () => {
  const service = read('server/src/services/fdeFileService.ts')
  const panel = read('src/components/FdeFilePanel.tsx')
  assert.match(service, /canDelete: sql<boolean>/)
  assert.match(service, /trash: query\.view === 'active' && canDelete/)
  assert.match(service, /restore: query\.view === 'deleted'/)
  assert.match(panel, /aria-label=\{`删除文件：\$\{file\.name\}`\}/)
  assert.match(panel, /删除项目文件/)
  assert.match(panel, /chooseListAction\(file\.id, 'restore'\)/)
  assert.match(service, /lifecycle: 'deleted'/)
  assert.match(service, /fileDeletionBlockers/)
})

test('removing an office attachment is limited to an unsubmitted own draft', () => {
  const service = read('server/src/services/fdeOfficeService.ts')
  const route = read('server/src/routes/office.ts')
  const panel = read('src/components/FdeOfficePanel.tsx')
  assert.match(route, /attachments\/:fileId\/delete/)
  assert.match(service, /row\.applicantUserId !== userId \|\| row\.status !== '草稿' \|\| row\.officeRevision !== 0/)
  assert.match(service, /definition\.attachmentIds\.filter\(value => value !== fileId\)/)
  assert.match(service, /delete next\.attachmentId/)
  assert.match(service, /delete next\.waterAttachmentId/)
  assert.match(panel, /删除草稿附件/)
  assert.match(panel, /f\.canDelete/)
})

test('task deletion stays audited and source-controlled instead of hard-deleting workflow facts', () => {
  const service = read('server/src/services/fdeTaskService.ts')
  const taskSystem = read('src/components/task/TaskSystem.tsx')
  assert.match(taskSystem, /key: 'cancel', label: '删除任务'/)
  assert.match(service, /planActionId\) return fail\('FDE_PLAN_LOCKED'/)
  assert.match(service, /set\(\{ status: '已取消'/)
  assert.match(service, /audit\(tx, userId, '取消任务'/)
  assert.doesNotMatch(service, /delete\(todos\).*taskId/)
})

test('formal business records keep archive or withdraw semantics', () => {
  const knowledge = read('server/src/services/fdeKnowledgeService.ts')
  const office = read('server/src/services/fdeOfficeService.ts')
  const meetings = read('server/src/services/meetingService.ts')
  assert.match(knowledge, /status: 'archived'/)
  assert.match(office, /input\.action === 'withdraw'/)
  assert.match(meetings, /workflowStatus: 'deleted'/)
})
