import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { committeeAgendas, committeeFiles, committeeMeetings, committeeCommands, meetingParticipants, meetings, meetingWorkflowEvents, meetingWorkflowNotices, oaApprovalRequests, projects, projectFileGrants, projectFiles, projectFileVersions, todos, users } from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'
import { addFile, classifyProject, createProject, setFileStoragePath } from '../services/projectService.js'
import { proposeFdeGovernance } from '../services/fdeGovernanceService.js'
import { saveProjectFileRevision } from '../services/projectFileStorageService.js'
import { checkCommitteeEditorAccess, committeeHistory, committeeOptions, executeCommittee, getCommittee, listCommittee, readCommitteeNotice, recoverCommittee } from '../services/fdeCommitteeService.js'
import { fileDeletionBlockers } from '../services/fdeFileService.js'
import { getMeeting, listMeetings, updateMeeting } from '../services/meetingService.js'
import { syncMeetingIdentityBindings } from '../services/identityResolutionService.js'
import { listCalendar, writeCalendarEvent } from '../services/fdeCalendarService.js'
import { canReadReportSupplementSources } from '../services/fdeWeeklyReportSourcesService.js'
import { collectWeeklyReportFacts } from '../services/fdeWeeklyReportService.js'
import { shanghaiToday, shiftDate, weekStartFor } from '../contracts/fdeWeeklyPlanContract.js'
import type { CommitteeDefinition } from '../contracts/fdeCommitteeContract.js'
import { assertIsolatedMysqlAcceptanceDatabase } from './mysqlAcceptanceSafety.js'

assertIsolatedMysqlAcceptanceDatabase('fdeCommitteeAcceptance')
assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
assert.ok(process.env.PROJECT_FILE_ROOT?.includes('fde-migration-acceptance-'))
const marker = randomUUID().slice(0, 8), checks: string[] = [], week = shiftDate(weekStartFor(shanghaiToday()), -7)
const people = ['投资经理', '投资经理', '投资经理', '投资经理', '系统管理员'].map((role, i) => ({ id: randomUUID(), role, name: `投决-${marker}-${i}`, email: `committee-${marker}-${i}@example.invalid`, department: `投决验收-${marker}`, passwordHash: 'not-for-login' }))
const [owner, memberA, memberB, outsider, admin] = people
const expectCode = async (work: Promise<unknown>, code: string) => { const error = await work.then(() => null, e => e); assert.equal(error?.code, code, `${code}: ${error?.message ?? 'unexpected success'}`) }
const action = (action: string, meetingId: string, expectedVersion: number) => ({ commandId: randomUUID(), action, meetingId, expectedVersion, reason: '隔离投决会业务操作验收' })
try {
  await db.insert(users).values(people)
  for (const person of people) await identityRepositories.users.synchronizeAdministrationBindings(person.id, person.role, person.department)
  const projectRows = []
  for (const [i, member] of [memberA, memberB].entries()) {
    let p = await createProject({ name: `投决议题-${marker}-${i}`, owner: owner.name, ownerUserId: owner.id, collaborators: [] }, owner.id)
    p = await classifyProject({ projectId: p.id, userId: owner.id, expectedVersion: p.version, toClassification: 'normal', reason: '既有项目完成受控初筛' })
    await proposeFdeGovernance({ projectId: p.id, userId: owner.id, ownerUserId: owner.id, expectedVersion: p.governanceVersion, reason: '分别配置议题参会项目成员', assignments: [{ duty: 'member', userId: member.id }] })
    projectRows.push(p)
  }
  const refs: Array<{ fileId: string; version: number }> = []
  for (const p of projectRows) {
    const bytes = Buffer.from(`仅供隔离验收的投决会议原件-${p.id}`), sha256 = createHash('sha256').update(bytes).digest('hex')
    const file = await addFile({ projectId: p.id, name: `投决原件-${p.id}.txt`, type: 'TXT', category: '项目基础资料', uploader: owner.name, byteSize: bytes.length, sha256 }, owner.id)
    await setFileStoragePath(file.id, await saveProjectFileRevision(p.id, file.id, bytes), owner.id)
    refs.push({ fileId: file.id, version: 1 })
  }
  const baselineProjects = await db.select().from(projects).where(eq(projects.ownerUserId, owner.id))
  const baselineTasks = await db.select().from(todos).where(eq(todos.createdBy, owner.id))
  const definition: CommitteeDefinition = { title: `多议题投决-${marker}`, hostUserId: memberA.id, startsAt: `${week}T10:00`, endsAt: `${week}T11:00`, materialCheckAt: `${week}T09:00`, ruleNote: '仅沿用正式投资审批，不执行线上逐票表决',
    agendas: projectRows.map((p, i) => ({ id: randomUUID(), projectId: p.id, title: i ? '乙项目保密议题' : '甲项目投决议题', participantIds: [i ? memberB.id : memberA.id], materials: [refs[i]] })) }
  const create = { commandId: randomUUID(), action: 'create', reason: '创建真实多议题投决草案', definition }
  await expectCode(executeCommittee(memberA.id, create), 'COMMITTEE_PROJECT_FORBIDDEN')
  const created = await executeCommittee(owner.id, create), id = created.meetingId
  assert.deepEqual(await executeCommittee(owner.id, create), created)
  await expectCode(executeCommittee(owner.id, { ...create, reason: '同编号不同业务内容' }), 'COMMITTEE_COMMAND_REUSED')
  assert.equal((await listCommittee(memberA.id, { q: marker })).total, 0)
  assert.equal((await listCommittee(admin.id, { q: marker })).total, 0)
  const options = await committeeOptions(owner.id, { projectId: projectRows[0].id })
  assert.ok('people' in options)
  assert.ok(options.people?.some(r => r.id === memberA.id) && !options.people.some(r => r.id === memberB.id))
  assert.ok(options.files?.some(r => r.fileId === refs[0].fileId && r.version === 1))
  const act = async (name: string) => executeCommittee(owner.id, action(name, id, (await getCommittee(owner.id, id)).version))
  await act('schedule')
  const partial = await getCommittee(memberA.id, id)
  assert.equal(partial.agendas.length, 1); assert.equal(partial.agendas[0].id, definition.agendas[0].id); assert.equal(partial.partial, true)
  assert.ok(!JSON.stringify(partial).includes('乙项目保密')); assert.ok(!JSON.stringify(partial).includes(refs[1].fileId)); assert.ok(!JSON.stringify(partial).includes(memberB.id))
  assert.equal((await listCommittee(memberA.id, { q: marker, pageSize: 1 })).total, 1)
  checks.push('FDE-IC-001/002:stable-identity-multi-agenda-ACL-before-list-count-and-version-pinned-originals')

  const notice = partial.notices[0]
  assert.ok(notice); await readCommitteeNotice(memberA.id, id, notice.id)
  const readAt = (await getCommittee(memberA.id, id)).notices[0].readAt
  await readCommitteeNotice(memberA.id, id, notice.id)
  assert.deepEqual((await getCommittee(memberA.id, id)).notices[0].readAt, readAt)
  await expectCode(readCommitteeNotice(owner.id, id, notice.id), 'COMMITTEE_NOTICE_NOT_FOUND')
  assert.equal(await getMeeting(id, { uid: admin.id, name: admin.name, role: admin.role }), undefined)
  assert.ok(!(await listMeetings(undefined, { uid: admin.id, name: admin.name, role: admin.role })).some(r => r.id === id))
  const participantBefore = await db.select().from(meetingParticipants).where(eq(meetingParticipants.meetingId, id))
  await syncMeetingIdentityBindings(id, outsider.name, [outsider.name])
  assert.deepEqual(await db.select().from(meetingParticipants).where(eq(meetingParticipants.meetingId, id)), participantBefore)
  await expectCode(updateMeeting(id, { rawTranscript: '不能从旧入口覆盖投决会' }, 2), 'FDE_MEETING_WORKFLOW_REQUIRED')
  const personal = await listCalendar(memberA.id, week, 'personal')
  assert.equal(personal.items.find(r => r.id === id)?.target, `/committee?meeting=${id}`)
  const hidden = await listCalendar(outsider.id, week, 'company')
  assert.ok(hidden.items.some(r => r.source === 'busy')); assert.ok(!JSON.stringify(hidden).includes(definition.title))
  await expectCode(writeCalendarEvent(memberA.id, { clientRequestId: randomUUID(), definition: { title: '冲突独立安排', detail: '', startsAt: `${week}T10:30`, endsAt: `${week}T11:30`, visibility: 'private' } }), 'CALENDAR_CONFLICT')
  checks.push('FDE-IC-003:existing-calendar-occupancy-private-busy-notices-and-no-legacy-rebinding')

  const sourceOptions = { calendar: true, privateCalendar: false, independentWork: true }
  const facts = await collectWeeklyReportFacts(db, memberA.id, [], week, sourceOptions)
  assert.equal(facts.calendar?.filter(r => r.id === id).length, 1)
  assert.equal(await canReadReportSupplementSources(db, facts, memberB.id), true)
  await db.update(projectFileGrants).set({ canView: false, canDownload: false }).where(and(eq(projectFileGrants.fileId, refs[0].fileId), eq(projectFileGrants.userId, memberA.id)))
  assert.equal((await listCommittee(memberA.id, { q: marker })).total, 0)
  await expectCode(getCommittee(memberA.id, id), 'COMMITTEE_NOT_FOUND')
  assert.equal(await canReadReportSupplementSources(db, facts, memberA.id), false)
  assert.ok(!(await listCalendar(memberA.id, week, 'personal')).items.some(r => r.id === id))
  await db.update(projectFileGrants).set({ canView: true }).where(and(eq(projectFileGrants.fileId, refs[0].fileId), eq(projectFileGrants.userId, memberA.id)))
  checks.push('FDE-IC-002:revoked-file-access-hides-agenda-calendar-and-frozen-report-without-expanding-snapshot-audience')

  const [revision] = await db.select().from(projectFileVersions).where(eq(projectFileVersions.fileId, refs[0].fileId))
  await db.update(projectFileVersions).set({ sha256: 'f'.repeat(64) }).where(eq(projectFileVersions.id, revision.id))
  const versionBefore = (await getCommittee(owner.id, id)).version
  await expectCode(act('check_materials'), 'COMMITTEE_FILE_INTEGRITY')
  assert.equal((await getCommittee(owner.id, id)).version, versionBefore)
  await db.update(projectFileVersions).set({ sha256: revision.sha256 }).where(eq(projectFileVersions.id, revision.id))
  await act('check_materials')
  const record = async (index: number, approvalId: string | null = null) => executeCommittee(owner.id, { ...action('record', id, (await getCommittee(owner.id, id)).version), agendaId: definition.agendas[index].id,
    minutes: `议题 ${index} 实际讨论纪要，不能代替审批结论`, minutesFile: refs[index], resolutionNote: approvalId ? '关联已存在的正式决议及其审批' : '', resolutionFile: approvalId ? refs[index] : null, approvalId })
  await expectCode(act('complete'), 'COMMITTEE_MINUTES_REQUIRED')
  const approvalId = randomUUID(), wrongApprovalId = randomUUID()
  for (const [requestId, fromStage, targetStage] of [[wrongApprovalId, '内核', '投决'], [approvalId, '投决', '打款']]) await db.insert(oaApprovalRequests).values({ id: requestId, requestNo: `IC-${requestId}`, projectId: projectRows[0].id, projectName: projectRows[0].name, title: '仅供关联测试的正式审批夹具', type: '投决审批', fromStage, targetStage, status: '已通过', applicantUserId: owner.id, applicantName: owner.name, department: owner.department, currentNodeName: '已完成', reason: '隔离审批源关联夹具，不代表真实审批验收', completedAt: new Date(), materialSnapshot: [{ requirementKey: 'fixture', fileId: refs[0].fileId, fileVersion: 1, waiverReason: null }] })
  await expectCode(record(0, wrongApprovalId), 'COMMITTEE_APPROVAL_REQUIRED')
  await record(0, approvalId); await record(1)
  await expectCode(executeCommittee(owner.id, { ...action('save', id, (await getCommittee(owner.id, id)).version), definition }), 'COMMITTEE_IMMUTABLE')
  const completeCommand = action('complete', id, (await getCommittee(owner.id, id)).version)
  const race = await Promise.allSettled([executeCommittee(owner.id, completeCommand), executeCommittee(owner.id, { ...completeCommand, commandId: randomUUID() })])
  assert.equal(race.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal((await getCommittee(owner.id, id)).status, 'completed')
  assert.deepEqual(await db.select().from(projects).where(eq(projects.ownerUserId, owner.id)), baselineProjects)
  assert.deepEqual(await db.select().from(todos).where(eq(todos.createdBy, owner.id)), baselineTasks)
  assert.equal((await db.select().from(meetings).where(eq(meetings.id, id)))[0].rawTranscript, null)
  assert.ok((await fileDeletionBlockers(db, refs[0].fileId)).some(r => r.includes('投决会')))
  const completedFacts = await collectWeeklyReportFacts(db, memberA.id, [], week, sourceOptions)
  assert.equal(completedFacts.meetings.filter(r => r.id === id).length, 1)
  checks.push('FDE-IC-004/005:real-bytes-check-manual-minutes-approved-decision-link-not-stage-entry-no-project-or-task-mutation')

  // Follow-up cases are pending execution in an explicitly approved dedicated
  // database. They must not be reported as covered by the first batch's 6 groups.
  const beforeLink = await getCommittee(owner.id, id), beforeLinkAgenda = beforeLink.agendas[1]
  const [beforeMeeting] = await db.select().from(meetings).where(eq(meetings.id, id))
  const beforeRefs = await db.select().from(committeeFiles).where(eq(committeeFiles.agendaId, beforeLinkAgenda.id))
  const lateApproval = randomUUID()
  await db.insert(oaApprovalRequests).values({ id: lateApproval, requestNo: `IC-${lateApproval}`, projectId: projectRows[1].id, projectName: projectRows[1].name, title: '会后独立正式审批夹具', type: '投决审批', fromStage: '投决', targetStage: '打款', status: '已通过', applicantUserId: owner.id, applicantName: owner.name, department: owner.department, currentNodeName: '已完成', reason: '只作关联来源，不冒充完整投资审批链路验收', completedAt: new Date(), materialSnapshot: [{ requirementKey: 'late', fileId: refs[1].fileId, fileVersion: 1, waiverReason: null }] })
  const link = { ...action('link_decision', id, beforeLink.version), agendaId: beforeLinkAgenda.id, approvalId: lateApproval, resolutionFile: refs[1] }
  await expectCode(executeCommittee(memberB.id, link), 'COMMITTEE_PROJECT_FORBIDDEN')
  await expectCode(executeCommittee(owner.id, { ...link, commandId: randomUUID(), approvalId }), 'COMMITTEE_APPROVAL_REQUIRED')
  const linkRace = await Promise.allSettled([executeCommittee(owner.id, link), executeCommittee(owner.id, { ...link, commandId: randomUUID() })])
  assert.equal(linkRace.filter(row => row.status === 'fulfilled').length, 1)
  const winner = linkRace.find(row => row.status === 'fulfilled')!
  if (winner.status === 'fulfilled') assert.deepEqual((await recoverCommittee(owner.id, { commandId: winner.value.commandId })).receipt, winner.value)
  const afterLink = await getCommittee(owner.id, id), afterLinkAgenda = afterLink.agendas[1]
  for (const key of ['minutes', 'resolutionNote', 'recordedAt', 'recordedBy'] as const) assert.deepEqual(afterLinkAgenda[key], beforeLinkAgenda[key])
  assert.equal(afterLinkAgenda.approvalId, lateApproval)
  assert.equal(afterLink.version, beforeLink.version + 1)
  const [afterMeeting] = await db.select().from(meetings).where(eq(meetings.id, id))
  for (const key of ['confirmedAt', 'confirmedBy', 'startedAt', 'endsAt', 'workflowStatus'] as const) assert.deepEqual(afterMeeting[key], beforeMeeting[key])
  const afterRefs = await db.select().from(committeeFiles).where(eq(committeeFiles.agendaId, beforeLinkAgenda.id))
  for (const ref of beforeRefs) assert.deepEqual(afterRefs.find(row => row.id === ref.id), ref)
  await expectCode(executeCommittee(owner.id, { ...link, commandId: randomUUID(), expectedVersion: afterLink.version }), 'COMMITTEE_DECISION_LINK_STATE')
  assert.deepEqual(await db.select().from(projects).where(eq(projects.ownerUserId, owner.id)), baselineProjects)
  assert.deepEqual(await db.select().from(todos).where(eq(todos.createdBy, owner.id)), baselineTasks)
  checks.push('FDE-IC-004/REC:late-approved-decision-append-only-current-agenda-scope-concurrency-and-frozen-minutes-retained')

  const firstHistory = await committeeHistory(owner.id, id, { pageSize: 2 }), secondHistory = await committeeHistory(owner.id, id, { pageSize: 2, page: 2 })
  assert.equal(firstHistory.total, secondHistory.total); assert.ok(firstHistory.total > 2)
  assert.ok(secondHistory.rows.every(row => !firstHistory.rows.some(first => first.id === row.id)))
  await expectCode(committeeHistory(memberA.id, id, { page: 1 }), 'COMMITTEE_HISTORY_FORBIDDEN')
  const currentAccess = await checkCommitteeEditorAccess(owner.id, { action: 'archive', meetingId: id, projectIds: [], files: [], participants: [] })
  assert.deepEqual(currentAccess, { allowed: true, version: afterLink.version, writable: true })
  for (let start = 2; start <= 521; start += 100) await db.insert(projectFileVersions).values(Array.from({ length: Math.min(100, 522 - start) }, (_, i) => ({ fileId: refs[0].fileId, version: start + i, storagePath: revision.storagePath, byteSize: revision.byteSize, sha256: revision.sha256, createdBy: owner.id })))
  const lastFiles = await committeeOptions(owner.id, { projectId: projectRows[0].id, kind: 'files', page: 27, pageSize: 20, q: projectRows[0].id })
  assert.ok('files' in lastFiles); assert.equal(lastFiles.pagination.files!.total, 521); assert.equal(lastFiles.files.length, 1); assert.equal(lastFiles.files[0].version, 1)
  const literal = await committeeOptions(owner.id, { projectId: projectRows[0].id, kind: 'files', q: '%' })
  assert.ok('files' in literal); assert.equal(literal.pagination.files!.total, 0)
  checks.push('FDE-IC/PAGE:authorized-history-before-count-stable-pages-literal-search-over-500-file-versions-and-readonly-editor-check')

  await act('archive')
  assert.equal((await listCommittee(owner.id, { q: marker })).total, 0)
  assert.equal((await listCommittee(owner.id, { q: marker, view: 'archived' })).total, 1)
  assert.equal((await db.select().from(meetingWorkflowNotices).where(and(eq(meetingWorkflowNotices.meetingId, id), isNull(meetingWorkflowNotices.closedAt)))).length, 0)
  assert.ok((await db.select().from(committeeFiles).where(eq(committeeFiles.agendaId, definition.agendas[0].id))).length >= 4)
  await expectCode(executeCommittee(owner.id, action('cancel', id, (await getCommittee(owner.id, id)).version)), 'COMMITTEE_ARCHIVED')
  await expectCode(executeCommittee(owner.id, { ...link, commandId: randomUUID(), expectedVersion: (await getCommittee(owner.id, id)).version }), 'COMMITTEE_ARCHIVED')
  const createOther = async (index: number) => {
    const d = { ...definition, title: `编号并发-${marker}-${index}`, hostUserId: index ? memberB.id : memberA.id, startsAt: `${shiftDate(week, 1)}T12:00`, endsAt: `${shiftDate(week, 1)}T13:00`, materialCheckAt: null, agendas: [{ ...definition.agendas[index], id: randomUUID() }] }
    const receipt = await executeCommittee(owner.id, { ...create, commandId: randomUUID(), definition: d })
    return { receipt, definition: d }
  }
  const pair = await Promise.all([createOther(0), createOther(1)])
  await Promise.all(pair.map(r => executeCommittee(owner.id, action('schedule', r.receipt.meetingId, 1))))
  const numbers = await Promise.all(pair.map(r => getCommittee(owner.id, r.receipt.meetingId)))
  assert.notEqual(numbers[0].sequenceNumber, numbers[1].sequenceNumber)
  const first = pair[0], other = pair[1]
  const conflictDef = { ...other.definition, agendas: [{ ...other.definition.agendas[0], participantIds: [memberB.id, owner.id] }] }
  await executeCommittee(owner.id, { ...action('save', other.receipt.meetingId, 2), definition: conflictDef })
  const firstConflict = { ...first.definition, agendas: [{ ...first.definition.agendas[0], participantIds: [memberA.id, owner.id] }] }
  await expectCode(executeCommittee(owner.id, { ...action('save', first.receipt.meetingId, 2), definition: firstConflict }), 'MEETING_TIME_CONFLICT')
  assert.equal((await getCommittee(owner.id, first.receipt.meetingId)).version, 2)
  const nextYear = Number(first.definition.startsAt.slice(0, 4)) + 1
  await executeCommittee(owner.id, { ...action('save', first.receipt.meetingId, 2), definition: { ...first.definition, startsAt: `${nextYear}-01-05T10:00`, endsAt: `${nextYear}-01-05T11:00` } })
  assert.equal((await getCommittee(owner.id, first.receipt.meetingId)).sequenceYear, nextYear)
  await executeCommittee(owner.id, action('cancel', first.receipt.meetingId, 3))
  assert.equal((await db.select().from(meetingWorkflowNotices).where(and(eq(meetingWorkflowNotices.meetingId, first.receipt.meetingId), isNull(meetingWorkflowNotices.closedAt)))).length, 0)
  assert.ok((await db.select().from(meetingWorkflowEvents).where(eq(meetingWorkflowEvents.meetingId, first.receipt.meetingId))).length === 4)
  checks.push('FDE-IC-001/003/005:concurrent-annual-numbers-cross-year-reallocation-reschedule-conflict-rollback-and-cancel-retained-history')

  assert.deepEqual(await recoverCommittee(owner.id, { commandId: create.commandId }), { state: 'committed', receipt: created })
  const closed = { ...create, commandId: randomUUID(), definition: { ...definition, agendas: definition.agendas.map(r => ({ ...r, id: randomUUID() })) } }
  assert.equal((await recoverCommittee(owner.id, { commandId: closed.commandId })).state, 'not_committed')
  await expectCode(executeCommittee(owner.id, closed), 'COMMITTEE_COMMAND_CLOSED')
  assert.deepEqual(await recoverCommittee(outsider.id, { commandId: create.commandId }), { state: 'not_committed', receipt: null })
  await db.update(users).set({ status: '停用' }).where(eq(users.id, owner.id))
  await expectCode(recoverCommittee(owner.id, { commandId: create.commandId }), 'COMMITTEE_ACTOR_FORBIDDEN')
  assert.equal((await db.select().from(committeeCommands).where(and(eq(committeeCommands.actorId, owner.id), eq(committeeCommands.commandId, create.commandId)))).length, 1)
  assert.equal((await db.select().from(committeeMeetings).where(eq(committeeMeetings.meetingId, id))).length, 1)
  assert.equal((await db.select().from(committeeAgendas).where(eq(committeeAgendas.meetingId, id))).length, 2)
  assert.equal((await db.select().from(projectFiles).where(eq(projectFiles.id, refs[0].fileId)))[0].lifecycle, 'active')
  checks.push('FDE-REC-002:actor-scoped-minimal-receipts-fence-delayed-post-disabled-account-and-original-history-retained')
  console.log(JSON.stringify({ ok: true, prefix: process.env.DB_FREFIX, suite: 'fde-committee', passed: checks.length, checks }))
} finally { await pool.end() }
