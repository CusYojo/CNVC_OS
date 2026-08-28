import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { committeeCanAppendDecision, committeeCommand, committeeDefinition, committeeEditorAccessQuery, committeeHistoryQuery, committeeOptionsQuery, committeePageWindow, committeeQuery, committeeReceipt, committeeSearchPattern } from '../src/contracts/fdeCommitteeContract.js'

const host = randomUUID(), projectId = randomUUID(), fileId = randomUUID()
const definition = () => ({ title: '投决会隔离契约', hostUserId: host, startsAt: '2026-08-28T10:00', endsAt: '2026-08-28T11:30', ruleNote: '按正式审批矩阵办理，不开启线上投票', materialCheckAt: null,
  agendas: [{ id: randomUUID(), projectId, title: '第一投资议题', participantIds: [host], materials: [{ fileId, version: 1 }] }] })
test('committee explicit dates, people, rules and version-pinned sources; no demo defaults', () => {
  assert.deepEqual(committeeDefinition.parse(definition()).materialCheckAt, null)
  for (const patch of [{ startsAt: '2026-02-30T10:00' }, { endsAt: '2026-08-28T09:00' }, { endsAt: '2026-09-06T10:00' }, { startsAt: '0001-01-01T10:00' }, { materialCheckAt: '2026-08-29T10:00' }, { ruleNote: '' }]) assert.equal(committeeDefinition.safeParse({ ...definition(), ...patch }).success, false)
  const row = definition(); row.agendas[0].participantIds = [randomUUID()]
  assert.equal(committeeDefinition.safeParse(row).success, false)
  row.agendas[0].participantIds = [host, host]; assert.equal(committeeDefinition.safeParse(row).success, false)
  assert.equal(committeeDefinition.safeParse({ ...definition(), voteRule: 'majority' }).success, false)
})
test('committee rejects cross-command extra state, missing versions, forged hashes and one-sided decision link', () => {
  const base = { commandId: randomUUID(), reason: '用户明确确认本次操作' }
  assert.ok(committeeCommand.safeParse({ ...base, action: 'create', definition: definition() }).success)
  assert.equal(committeeCommand.safeParse({ ...base, action: 'schedule', meetingId: randomUUID() }).success, false)
  const record = { ...base, action: 'record', meetingId: randomUUID(), expectedVersion: 2, agendaId: randomUUID(), minutes: '实际会议纪要正文', minutesFile: { fileId, version: 1 }, resolutionNote: '', resolutionFile: null, approvalId: null }
  assert.ok(committeeCommand.safeParse(record).success)
  assert.equal(committeeCommand.safeParse({ ...record, approvalId: randomUUID() }).success, false)
  assert.equal(committeeCommand.safeParse({ ...record, minutesFile: { fileId, version: 1, sha256: 'forged' } }).success, false)
  assert.equal(committeeCommand.safeParse({ ...record, projectStage: '打款' }).success, false)
})
test('committee pagination is bounded and receipts cannot embed business contents', () => {
  assert.equal(committeeQuery.parse({}).pageSize, 20)
  assert.equal(committeeQuery.safeParse({ pageSize: 101 }).success, false)
  assert.equal(committeeReceipt.safeParse({ commandId: randomUUID(), meetingId: randomUUID(), version: 1, action: 'create', title: 'private' }).success, false)
})
test('late decision link cannot rewrite minutes, confirmation, project stage or an existing record', () => {
  const command = { action: 'link_decision', commandId: randomUUID(), meetingId: randomUUID(), expectedVersion: 7, agendaId: randomUUID(), approvalId: randomUUID(), resolutionFile: { fileId, version: 2 }, reason: '归档前追加正式审批' }
  assert.ok(committeeCommand.safeParse(command).success)
  for (const patch of [{ minutes: '覆盖已确认纪要' }, { recordedBy: host }, { confirmedAt: 'forged' }, { projectStage: '打款' }, { approvalId: null }, { resolutionFile: null }, { expectedVersion: undefined }]) assert.equal(committeeCommand.safeParse({ ...command, ...patch }).success, false)
  const state = { status: 'completed', archived: false, recorded: true, hasMinutes: true, linked: false }
  assert.equal(committeeCanAppendDecision(state), true)
  for (const patch of [{ status: 'draft' }, { status: 'scheduled' }, { status: 'cancelled' }, { archived: true }, { recorded: false }, { hasMinutes: false }, { linked: true }]) assert.equal(committeeCanAppendDecision({ ...state, ...patch }), false)
})
test('history and each candidate kind have bounded explicit search pagination without the former 100/500 cut-off', () => {
  for (const kind of ['people', 'files', 'approvals']) assert.ok(committeeOptionsQuery.safeParse({ projectId, kind, q: '原件', page: 28, pageSize: 20 }).success)
  assert.equal(committeeOptionsQuery.safeParse({ kind: 'files' }).success, false)
  for (const value of [{ page: 0 }, { pageSize: 51 }, { page: 100001 }, { q: 'x'.repeat(101) }, { unfiltered: true }]) assert.equal(committeeHistoryQuery.safeParse(value).success, false)
  assert.deepEqual(committeePageWindow(601, 31, 20), { total: 601, page: 31, pageSize: 20, hasMore: false, offset: 600 })
  assert.equal(committeePageWindow(103, 6, 20).offset, 100)
  assert.equal(committeePageWindow(0, 5, 20).page, 1)
  assert.equal(committeePageWindow(1, 8, 20).page, 1)
  assert.throws(() => committeePageWindow(-1, 1, 20))
  assert.equal(committeeSearchPattern('审%_\\'), '%审\\%\\_\\\\%')
})
test('focus access checks accept only bounded source IDs, never business prose, and bind original agenda actions', () => {
  const scope = { action: 'record', meetingId: randomUUID(), agendaId: randomUUID(), projectIds: [projectId], files: [{ projectId, fileId, version: 1 }], participants: [] }
  assert.ok(committeeEditorAccessQuery.safeParse(scope).success)
  for (const patch of [{ agendaId: undefined }, { meetingId: undefined }, { minutes: '不能上传未提交正文' }, { action: 'create' }, { projectIds: Array(21).fill(projectId) }]) assert.equal(committeeEditorAccessQuery.safeParse({ ...scope, ...patch }).success, false)
  assert.ok(committeeEditorAccessQuery.safeParse({ action: 'create', projectIds: [], files: [], participants: [] }).success)
})
