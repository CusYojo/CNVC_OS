import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { and, count, eq, isNull, sql } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { auditLogs, oaApprovalRequests, projectDutyAssignments, projectFileEvents, projectFileGrants, projectFiles, projectFileVersions, projectMaterialEvents, projectMaterialNotices, projectMaterialRecipients, projectMaterialRequestClosures, projectMaterialSubmissions, projectMembers, projects, todos, users } from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'
import { addFile, classifyProject, createProject, deleteProject, replaceFileContent, setFileStoragePath } from '../services/projectService.js'
import { proposeFdeGovernance } from '../services/fdeGovernanceService.js'
import { actOnFdeFile, getFdeFile, setFdeFilePermissions } from '../services/fdeFileService.js'
import { requireProjectFileAccess } from '../services/projectFileAccessService.js'
import { readProjectFileBuffer, saveProjectFileRevision } from '../services/projectFileStorageService.js'
import { createMaterialSubmission, decideMaterialSubmission, getMaterialContext, getMaterialOriginal, getMaterialSubmission, listMaterialInbox, listMaterialSubmissions, readMaterialSubmission, resolveMaterialRequest, withdrawMaterialSubmission } from '../services/fdeMaterialService.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
assert.ok(process.env.PROJECT_FILE_ROOT?.includes('fde-migration-acceptance-'))
const checks: string[] = [], marker = randomUUID().slice(0, 8)
const people = ['投资经理', '投资经理', '投资经理', '董事长', '系统管理员', '时间协调人', '投资经理', '总裁'].map((role, i) => ({ id: randomUUID(), role, name: `送审-${marker}-${i}`, email: `material-${marker}-${i}@example.invalid`, department: `送审验收-${marker}`, passwordHash: 'not-for-login' }))
const [owner, secretary, member, leader, admin, coordinator, outsider, president] = people
const command = (extra: Record<string, unknown> = {}) => ({ clientRequestId: randomUUID(), ...extra })
const code = async (promise: Promise<unknown>, expected: string) => { const error = await promise.then(() => null, cause => cause); assert.equal(error?.code, expected, `${expected}: ${error?.message ?? 'unexpected success'}`) }
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
try {
  await db.insert(users).values(people)
  for (const person of people) await identityRepositories.users.synchronizeAdministrationBindings(person.id, person.role, person.department)
  let project = await createProject({ name: `材料送审-${marker}`, owner: owner.name, ownerUserId: owner.id, collaborators: [] }, owner.id)
  project = await classifyProject({ projectId: project.id, userId: owner.id, expectedVersion: project.version, toClassification: 'normal', reason: '材料送审隔离验收' })
  await proposeFdeGovernance({ projectId: project.id, userId: owner.id, ownerUserId: owner.id, expectedVersion: project.governanceVersion, reason: '配置材料送审职责人员', assignments: [{ duty: 'secretary', userId: secretary.id }, { duty: 'member', userId: member.id }, { duty: 'member', userId: outsider.id }, { duty: 'concerned_leader', userId: leader.id }, { duty: 'coordinator', userId: coordinator.id }] })
  const bytes = Buffer.from(`不可变的送审原件-${marker}`)
  const newFile = async (suffix: string) => {
    const content = Buffer.concat([bytes, Buffer.from(suffix)])
    const row = await addFile({ projectId: project.id, name: `送审材料-${marker}-${suffix}.txt`, type: 'TXT', category: '项目基础资料', uploader: member.name, byteSize: content.length, sha256: hash(content) }, member.id)
    const storage = await saveProjectFileRevision(project.id, row.id, content); await setFileStoragePath(row.id, storage, member.id)
    await setFdeFilePermissions(row.id, owner.id, command({ expectedVersion: 1, reason: '仅保留发送人员查看', grants: [{ userId: member.id, canView: true, canDownload: false }] }))
    return { id: row.id, content, storage }
  }
  const file = await newFile('一')
  const payload = async (fileId = file.id, extra: Record<string, unknown> = {}) => {
    const context = await getMaterialContext(project.id, member.id), detail = await getFdeFile(fileId, member.id)
    return command({ fileId, fileVersion: detail.file.version, expectedAccessVersion: detail.file.accessVersion, expectedProjectVersion: context.projectVersion, expectedGovernanceVersion: context.governanceVersion, title: `正式材料反馈-${marker}`, note: '请核对本轮原始材料', recipientIds: [owner.id, leader.id], ...extra })
  }
  const detail = (id: string, actor = member.id) => getMaterialSubmission(project.id, id, actor)
  const decide = (id: string, actor: string, decision = 'approve') => decideMaterialSubmission(project.id, id, actor, command({ expectedRecipientVersion: 1, decision, feedback: `独立${decision}反馈` }))
  const baseline = await db.select({ stage: projects.stage, version: projects.version, lifecycle: projects.lifecycle }).from(projects).where(eq(projects.id, project.id))
  const [todoBefore] = await db.select({ n: count() }).from(todos), [oaBefore] = await db.select({ n: count() }).from(oaApprovalRequests)
  const context = await getMaterialContext(project.id, member.id)
  assert.deepEqual(context.recipients.map(x => x.id).sort(), [owner.id, leader.id].sort())
  assert.equal((await getMaterialContext(project.id, leader.id)).canSubmit, false)
  for (const person of [admin, coordinator]) await code(getMaterialContext(project.id, person.id), 'MATERIAL_FORBIDDEN')
  const invalid = await payload(file.id, { recipientIds: [outsider.id] })
  await code(createMaterialSubmission(project.id, member.id, invalid), 'MATERIAL_RECIPIENT_INVALID')
  await code(createMaterialSubmission(project.id, member.id, await payload(file.id, { recipientIds: [member.id] })), 'MATERIAL_RECIPIENT_INVALID')
  assert.equal((await db.select().from(projectMaterialSubmissions).where(eq(projectMaterialSubmissions.projectId, project.id))).length, 0)
  await code(requireProjectFileAccess(db, file.id, leader.id), 'PROJECT_FILE_FORBIDDEN')
  checks.push('FDE-FILE-003/004:current-stage-recipient-scope-self-outsider-admin-coordinator-invalid-no-grants-or-submission')

  const input = await payload(), submission = await createMaterialSubmission(project.id, member.id, input)
  assert.deepEqual(await createMaterialSubmission(project.id, member.id, input), submission)
  await code(createMaterialSubmission(project.id, member.id, { ...input, title: '复用请求改写内容' }), 'MATERIAL_REQUEST_REUSED')
  await requireProjectFileAccess(db, file.id, leader.id)
  for (const person of [member, owner, leader]) await code(requireProjectFileAccess(db, file.id, person.id, 'download'), 'PROJECT_FILE_FORBIDDEN')
  await code(requireProjectFileAccess(db, file.id, outsider.id), 'PROJECT_FILE_FORBIDDEN')
  assert.equal((await db.select().from(projectFileEvents).where(and(eq(projectFileEvents.fileId, file.id), eq(projectFileEvents.action, 'material-view')))).length, 1)
  assert.equal((await listMaterialInbox(owner.id)).total, 1)
  assert.equal((await listMaterialInbox(leader.id)).total, 1)
  assert.equal((await detail(submission.id, owner.id)).submission.recipients.some(x => x.readAt), false, 'GET must not mutate read state')
  checks.push('FDE-FILE-003/004:submit-replay-one-submission-only-selected-view-grants-no-download-and-two-inbox-notices')

  const read = command()
  await readMaterialSubmission(project.id, submission.id, owner.id, read); await readMaterialSubmission(project.id, submission.id, owner.id, read)
  assert.equal((await detail(submission.id)).submission.status, 'pending')
  await readMaterialSubmission(project.id, submission.id, leader.id, command())
  assert.equal((await detail(submission.id)).submission.status, 'read')
  assert.equal((await db.select().from(projectMaterialEvents).where(and(eq(projectMaterialEvents.submissionId, submission.id), eq(projectMaterialEvents.action, 'read')))).length, 2)
  await decide(submission.id, owner.id)
  assert.equal((await detail(submission.id)).submission.status, 'partial')
  assert.equal((await detail(submission.id)).submission.recipients.find(x => x.userId === leader.id)!.decision, null)
  await code(withdrawMaterialSubmission(project.id, submission.id, member.id, command({ expectedVersion: (await detail(submission.id)).submission.version, reason: '有反馈后尝试撤回' })), 'MATERIAL_WITHDRAW_CLOSED')
  await decide(submission.id, leader.id, 'return')
  assert.equal((await detail(submission.id)).submission.status, 'returned')
  assert.equal((await listMaterialInbox(owner.id)).total, 0)
  assert.equal((await listMaterialInbox(member.id)).total, 2)
  await readMaterialSubmission(project.id, submission.id, member.id, command())
  assert.equal((await listMaterialInbox(member.id)).total, 0)
  await code(decide(submission.id, leader.id), 'MATERIAL_DECISION_CLOSED')
  checks.push('FDE-FILE-003:read-partial-returned-status-independent-feedback-no-withdraw-after-feedback-notice-ack')

  const second = await createMaterialSubmission(project.id, member.id, await payload(file.id, { previousSubmissionId: submission.id }))
  assert.equal((await detail(second.id)).submission.revision, 2)
  assert.equal((await detail(submission.id)).submission.nextId, second.id)
  await code(createMaterialSubmission(project.id, member.id, await payload(file.id, { previousSubmissionId: submission.id })), 'MATERIAL_ALREADY_RESUBMITTED')
  const ownerDecision = command({ expectedRecipientVersion: 1, decision: 'approve', feedback: '审核同意原送审版本' })
  await Promise.all([decideMaterialSubmission(project.id, second.id, owner.id, ownerDecision), decide(second.id, leader.id)])
  await decideMaterialSubmission(project.id, second.id, owner.id, ownerDecision)
  assert.equal((await detail(second.id)).submission.status, 'approved')
  assert.equal((await db.select().from(projectMaterialRecipients).where(and(eq(projectMaterialRecipients.submissionId, second.id), eq(projectMaterialRecipients.decision, 'approve')))).length, 2)
  await code(actOnFdeFile(file.id, member.id, command({ expectedVersion: (await getFdeFile(file.id, member.id)).file.accessVersion, reason: '尝试回收已批复原件', action: 'trash' })), 'FILE_REFERENCED')
  checks.push('FDE-FILE-003/006:resubmit-keeps-prior-feedback-parallel-recipients-both-commit-approved-reference-blocks-trash')

  const replacement = Buffer.from(`更新后的送审文件-${marker}`), updatedPath = await saveProjectFileRevision(project.id, file.id, replacement)
  await replaceFileContent(file.id, updatedPath, `${replacement.length} B`, replacement.length, hash(replacement), member.id, 1)
  assert.equal((await detail(second.id, owner.id)).submission.file!.version, 1)
  assert.equal((await detail(second.id, owner.id)).submission.file!.currentVersion, 2)
  assert.deepEqual((await getMaterialOriginal(project.id, second.id, owner.id)).bytes, file.content)
  checks.push('FDE-FILE-001/003:replacement-keeps-original-review-version-and-preview-bytes')

  const thirdFile = await newFile('三'), third = await createMaterialSubmission(project.id, member.id, await payload(thirdFile.id))
  await readMaterialSubmission(project.id, third.id, owner.id, command())
  const current = await detail(third.id), withdraw = command({ expectedVersion: current.submission.version, reason: '补充原始数据后重新送审' })
  await code(withdrawMaterialSubmission(project.id, third.id, owner.id, withdraw), 'MATERIAL_WITHDRAW_FORBIDDEN')
  await withdrawMaterialSubmission(project.id, third.id, member.id, withdraw); await withdrawMaterialSubmission(project.id, third.id, member.id, withdraw)
  assert.equal((await detail(third.id)).submission.status, 'withdrawn')
  assert.equal((await db.select().from(projectMaterialNotices).where(and(eq(projectMaterialNotices.submissionId, third.id), isNull(projectMaterialNotices.closedAt)))).length, 0)
  await requireProjectFileAccess(db, thirdFile.id, leader.id)
  await actOnFdeFile(thirdFile.id, member.id, command({ expectedVersion: (await getFdeFile(thirdFile.id, member.id)).file.accessVersion, reason: '已撤回无其他引用回收', action: 'trash' }))
  assert.deepEqual(await readProjectFileBuffer(thirdFile.storage), thirdFile.content)
  checks.push('FDE-FILE-003/006/007:sender-only-withdraw-after-read-keeps-view-history-closes-notices-permits-safe-trash')

  const fourthFile = await newFile('四'), fourth = await createMaterialSubmission(project.id, member.id, await payload(fourthFile.id))
  await setFdeFilePermissions(fourthFile.id, owner.id, command({ expectedVersion: (await getFdeFile(fourthFile.id, owner.id)).file.accessVersion, reason: '撤销送审接收人查看权', grants: [{ userId: member.id, canView: true, canDownload: false }] }))
  await code(detail(fourth.id, leader.id), 'MATERIAL_FORBIDDEN')
  await code(getMaterialOriginal(project.id, fourth.id, leader.id), 'PROJECT_FILE_FORBIDDEN')
  await code(decide(fourth.id, leader.id), 'PROJECT_FILE_FORBIDDEN')
  assert.equal((await listMaterialSubmissions(project.id, leader.id, { keyword: `正式材料反馈-${marker}` })).list.some(x => x.id === fourth.id), false)
  assert.equal((await listMaterialInbox(leader.id)).list.some(x => x.submissionId === fourth.id), false)
  await code(detail(fourth.id, outsider.id), 'MATERIAL_FORBIDDEN')
  assert.equal((await listMaterialSubmissions(project.id, outsider.id)).total, 0)
  checks.push('FDE-FILE-005/AUTH-003:revocation-hides-list-search-detail-inbox-original-and-decision-same-project-outsider-denied')

  const fifthFile = await newFile('五'), fifth = await createMaterialSubmission(project.id, member.id, await payload(fifthFile.id))
  const race = await Promise.allSettled([decide(fifth.id, owner.id), withdrawMaterialSubmission(project.id, fifth.id, member.id, command({ expectedVersion: 1, reason: '并发反馈与撤回竞态' }))])
  assert.equal(race.filter(x => x.status === 'fulfilled').length, 1)
  const fifthResult = await detail(fifth.id)
  assert.ok(['withdrawn', 'partial'].includes(fifthResult.submission.status))
  checks.push('FDE-CONC-001/002:withdraw-versus-feedback-serializes-one-legal-outcome')

  const integrityFile = await newFile('原件异常'), integrity = await createMaterialSubmission(project.id, member.id, await payload(integrityFile.id))
  const snapshot = async (id: string) => ({
    submissions: await db.select().from(projectMaterialSubmissions).where(eq(projectMaterialSubmissions.id, id)),
    recipients: await db.select().from(projectMaterialRecipients).where(eq(projectMaterialRecipients.submissionId, id)),
    notices: await db.select().from(projectMaterialNotices).where(eq(projectMaterialNotices.submissionId, id)),
    events: await db.select().from(projectMaterialEvents).where(eq(projectMaterialEvents.submissionId, id)),
  })
  const integrityBefore = await snapshot(integrity.id)
  const corruptPath = await saveProjectFileRevision(project.id, integrityFile.id, Buffer.from('不匹配的原始字节'))
  try {
    for (const storagePath of [corruptPath, `${integrityFile.storage}.missing-${marker}`]) {
      await db.update(projectFileVersions).set({ storagePath }).where(and(eq(projectFileVersions.fileId, integrityFile.id), eq(projectFileVersions.version, 1)))
      await code(decide(integrity.id, owner.id), 'MATERIAL_FILE_INTEGRITY')
      await code(getMaterialOriginal(project.id, integrity.id, owner.id), 'MATERIAL_FILE_INTEGRITY')
      assert.deepEqual(await snapshot(integrity.id), integrityBefore, '原件异常不得产生阅读、反馈、通知或版本更新')
    }
  } finally {
    await db.update(projectFileVersions).set({ storagePath: integrityFile.storage }).where(and(eq(projectFileVersions.fileId, integrityFile.id), eq(projectFileVersions.version, 1)))
  }
  await decide(integrity.id, owner.id)
  checks.push('FDE-FILE-001/003/005:corrupt-and-missing-frozen-bytes-fail-without-feedback-notices-or-version-mutation')

  const rollbackFile = await newFile('事务回滚'), rollbackInput = await payload(rollbackFile.id)
  const rollbackBefore = await getFdeFile(rollbackFile.id, owner.id)
  // A real unique-key failure occurs after submission/recipient/grant writes.
  // Only the random acceptance prefix is touched; no production failure hook.
  await db.insert(projectFileEvents).values({ fileId: rollbackFile.id, actorId: owner.id, requestId: rollbackInput.clientRequestId, requestHash: hash(Buffer.from('隔离约束冲突')), action: 'permissions', version: 999, reason: '隔离事务回滚约束夹具', snapshot: {} })
  const rollbackError = await createMaterialSubmission(project.id, member.id, rollbackInput).then(() => null, error => error)
  assert.ok(rollbackError, '唯一键故障必须使送审失败')
  assert.equal(rollbackError.cause?.code ?? rollbackError.code, 'ER_DUP_ENTRY')
  assert.equal((await db.select().from(projectMaterialSubmissions).where(eq(projectMaterialSubmissions.fileId, rollbackFile.id))).length, 0)
  assert.equal((await db.select().from(projectMaterialEvents).where(eq(projectMaterialEvents.requestId, rollbackInput.clientRequestId))).length, 0)
  const rollbackAfter = await getFdeFile(rollbackFile.id, owner.id)
  assert.deepEqual(rollbackAfter.file, rollbackBefore.file)
  assert.deepEqual(rollbackAfter.grants, rollbackBefore.grants)
  await code(requireProjectFileAccess(db, rollbackFile.id, leader.id), 'PROJECT_FILE_FORBIDDEN')
  const [orphanNotices] = await db.select({ n: count() }).from(projectMaterialNotices).leftJoin(projectMaterialSubmissions, eq(projectMaterialSubmissions.id, projectMaterialNotices.submissionId)).where(isNull(projectMaterialSubmissions.id))
  assert.equal(orphanNotices.n, 0)
  checks.push('FDE-CONC-001/002:real-mysql-unique-key-failure-rolls-back-submission-recipients-grants-and-notices')

  for (let round = 0; round < 6; round++) {
    const raceFile = await newFile(`引用竞争${round}`), raceInput = await payload(raceFile.id)
    const raceVersion = (await getFdeFile(raceFile.id, member.id)).file.accessVersion
    const send = () => createMaterialSubmission(project.id, member.id, raceInput)
    const recycle = () => actOnFdeFile(raceFile.id, member.id, command({ expectedVersion: raceVersion, action: 'trash', reason: '隔离送审与文件回收竞争' }))
    const ordered = round % 2 ? [recycle, send] : [send, recycle]
    // Exercise both committed orders deterministically, then race both callers.
    // A send that observes an already recycled file must retain the existing 404 contract.
    const outcomes = round < 2
      ? [...await Promise.allSettled([ordered[0]()]), ...await Promise.allSettled([ordered[1]()])]
      : await Promise.allSettled(ordered.map(action => action()))
    assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1)
    const rejected = outcomes.find(item => item.status === 'rejected') as PromiseRejectedResult
    const [storedFile] = await db.select().from(projectFiles).where(eq(projectFiles.id, raceFile.id))
    if (storedFile.lifecycle === 'deleted') assert.equal(rejected.reason.code, 'PROJECT_FILE_NOT_FOUND', rejected.reason.message)
    else {
      assert.equal(storedFile.lifecycle, 'active')
      assert.ok(['VERSION_CONFLICT', 'FILE_REFERENCED'].includes(rejected.reason.code), rejected.reason.message)
    }
    const submissions = await db.select().from(projectMaterialSubmissions).where(eq(projectMaterialSubmissions.fileId, raceFile.id))
    assert.equal(submissions.length, storedFile.lifecycle === 'active' ? 1 : 0)
    assert.deepEqual(await readProjectFileBuffer(raceFile.storage), raceFile.content)
  }
  checks.push('FDE-FILE-006/CONC-001:both-committed-orders-and-four-races-one-winner-no-live-reference-to-recycled-file')

  const paged = await listMaterialSubmissions(project.id, member.id, { pageSize: 2 })
  const collected: string[] = []
  for (let page = 1; page <= Math.ceil(paged.total / 2); page++) {
    const result = await listMaterialSubmissions(project.id, member.id, { page, pageSize: 2 })
    assert.equal(result.total, paged.total); collected.push(...result.list.map(row => row.id))
  }
  assert.equal(new Set(collected).size, paged.total)
  assert.equal(collected.length, paged.total)
  const history = await getMaterialSubmission(project.id, integrity.id, owner.id, { page: 1, pageSize: 1 })
  const historyNext = await getMaterialSubmission(project.id, integrity.id, owner.id, { page: 2, pageSize: 1 })
  assert.equal(history.events.length, 1); assert.equal(historyNext.events.length, 1)
  assert.notEqual(history.events[0].id, historyNext.events[0].id)
  const inbox = await listMaterialInbox(owner.id, { page: 1, pageSize: 1 }), inboxNext = await listMaterialInbox(owner.id, { page: 2, pageSize: 1 })
  assert.equal(inbox.list.length, 1); assert.equal(inboxNext.list.length, 1); assert.notEqual(inbox.list[0].id, inboxNext.list[0].id)
  assert.equal((await listMaterialInbox(outsider.id, { pageSize: 1 })).total, 0)
  checks.push('FDE-FILE-003/005:permission-filtered-list-history-and-inbox-pagination-without-duplicates')

  const receipt = await resolveMaterialRequest(project.id, member.id, { clientRequestId: input.clientRequestId })
  assert.deepEqual(receipt, { state: 'committed', id: submission.id, action: 'submit' })
  assert.deepEqual(await resolveMaterialRequest(project.id, member.id, { clientRequestId: input.clientRequestId }), receipt)
  await code(resolveMaterialRequest(project.id, owner.id, { clientRequestId: input.clientRequestId }), 'MATERIAL_REQUEST_REUSED')
  const otherProject = await createProject({ name: `恢复范围-${marker}`, owner: member.name, ownerUserId: member.id, collaborators: [] }, member.id)
  await code(resolveMaterialRequest(otherProject.id, member.id, { clientRequestId: input.clientRequestId }), 'MATERIAL_REQUEST_REUSED')
  assert.equal('title' in receipt, false); assert.equal('snapshot' in receipt, false)
  checks.push('FDE-REC-002/AUTH-003:committed-receipt-is-actor-project-scoped-minimal-and-idempotent')

  const emptyRequest = { clientRequestId: randomUUID() }
  await resolveMaterialRequest(otherProject.id, member.id, emptyRequest)
  const closuresFor = (id: string) => db.select().from(projectMaterialRequestClosures).where(eq(projectMaterialRequestClosures.projectId, id))
  const emptyClosures = await closuresFor(otherProject.id)
  assert.equal(emptyClosures.length, 1)
  await code(deleteProject(otherProject.id, owner.id), 'PROJECT_FORBIDDEN')
  assert.deepEqual(await closuresFor(otherProject.id), emptyClosures)
  // A real late FK failure must roll back cleanup of technical request fences.
  // This table belongs only to the guarded random acceptance prefix.
  const guardTable = quoteMysqlIdentifier(mysqlTableName('material_delete_guard'))
  const projectTable = quoteMysqlIdentifier(mysqlTableName('projects'))
  await db.execute(sql.raw(`CREATE TABLE ${guardTable} (project_id varchar(36) NOT NULL, FOREIGN KEY (project_id) REFERENCES ${projectTable}(id) ON DELETE RESTRICT)`))
  try {
    await db.execute(sql`INSERT INTO ${sql.raw(guardTable)} (project_id) VALUES (${otherProject.id})`)
    const auditsBefore = (await db.select({ n: count() }).from(auditLogs))[0].n
    const blockedDelete = await deleteProject(otherProject.id, member.id).then(() => null, error => error)
    // MySQL exposes both variants for a referenced parent row; either must
    // still leave the project, request fences and audit log unchanged.
    const deleteCause = blockedDelete?.cause ?? blockedDelete
    assert.ok(['ER_ROW_IS_REFERENCED', 'ER_ROW_IS_REFERENCED_2'].includes(deleteCause?.code), `expected FK delete protection, got ${deleteCause?.code}`)
    assert.equal(deleteCause?.sqlState, '23000')
    assert.deepEqual(await closuresFor(otherProject.id), emptyClosures)
    assert.equal((await db.select().from(projects).where(eq(projects.id, otherProject.id))).length, 1)
    assert.equal((await db.select({ n: count() }).from(auditLogs))[0].n, auditsBefore)
  } finally { await db.execute(sql.raw(`DROP TABLE ${guardTable}`)) }
  assert.equal((await deleteProject(otherProject.id, member.id))?.id, otherProject.id)
  assert.equal((await closuresFor(otherProject.id)).length, 0)
  assert.equal((await db.select().from(projects).where(eq(projects.id, otherProject.id))).length, 0)
  assert.equal((await db.select().from(auditLogs).where(and(eq(auditLogs.action, '核对未提交并封闭请求'), eq(auditLogs.target, `${otherProject.id} / ${emptyRequest.clientRequestId}`)))).length, 1)
  await code(resolveMaterialRequest(otherProject.id, member.id, emptyRequest), 'MATERIAL_FORBIDDEN')
  await code(createMaterialSubmission(otherProject.id, member.id, { ...input, clientRequestId: emptyRequest.clientRequestId }), 'MATERIAL_FORBIDDEN')
  const protectedRequest = { clientRequestId: randomUUID() }
  await resolveMaterialRequest(project.id, member.id, protectedRequest)
  const protectedClosures = await closuresFor(project.id)
  await code(deleteProject(project.id, owner.id), 'PROJECT_FILE_HISTORY_PROTECTED')
  assert.deepEqual(await closuresFor(project.id), protectedClosures)
  assert.ok((await db.select().from(projectMaterialEvents).where(eq(projectMaterialEvents.submissionId, submission.id))).length > 0)
  for (let round = 0; round < 4; round++) {
    const empty = await createProject({ name: `删除恢复竞争-${marker}-${round}`, owner: member.name, ownerUserId: member.id, collaborators: [] }, member.id)
    const request = { clientRequestId: randomUUID() }
    const remove = () => deleteProject(empty.id, member.id)
    const recover = () => resolveMaterialRequest(empty.id, member.id, request)
    const results = await Promise.allSettled(round % 2 ? [recover(), remove()] : [remove(), recover()])
    const deleted = results[round % 2 ? 1 : 0], recovered = results[round % 2 ? 0 : 1]
    assert.equal(deleted.status, 'fulfilled')
    if (recovered.status === 'fulfilled') assert.deepEqual(recovered.value, { state: 'not_applied' })
    else assert.equal(recovered.reason.code, 'MATERIAL_FORBIDDEN')
    assert.equal((await closuresFor(empty.id)).length, 0)
    assert.equal((await db.select().from(projects).where(eq(projects.id, empty.id))).length, 0)
  }
  checks.push('FDE-REC-002/LIFE-004/CONC-001:technical-fence-delete-compatibility-unauthorized-denial-real-rollback-audit-retention-and-four-races')

  const fenceFile = await newFile('延迟提交封闭'), fenceInput = await payload(fenceFile.id)
  const fenceRequest = { clientRequestId: fenceInput.clientRequestId }
  assert.deepEqual(await resolveMaterialRequest(project.id, member.id, fenceRequest), { state: 'not_applied' })
  const closureAudits = (await db.select({ n: count() }).from(auditLogs).where(eq(auditLogs.action, '核对未提交并封闭请求')))[0].n
  assert.deepEqual(await resolveMaterialRequest(project.id, member.id, fenceRequest), { state: 'not_applied' })
  assert.equal((await db.select({ n: count() }).from(auditLogs).where(eq(auditLogs.action, '核对未提交并封闭请求')))[0].n, closureAudits)
  await code(createMaterialSubmission(project.id, member.id, fenceInput), 'MATERIAL_REQUEST_CLOSED')
  assert.equal((await db.select().from(projectMaterialSubmissions).where(eq(projectMaterialSubmissions.fileId, fenceFile.id))).length, 0)
  await code(requireProjectFileAccess(db, fenceFile.id, leader.id), 'PROJECT_FILE_FORBIDDEN')
  const fresh = await createMaterialSubmission(project.id, member.id, { ...fenceInput, clientRequestId: randomUUID() })
  assert.ok(fresh.id)
  const decisionRequest = command({ expectedRecipientVersion: 1, decision: 'approve', feedback: '延迟反馈不能越过封闭' })
  await resolveMaterialRequest(project.id, owner.id, { clientRequestId: decisionRequest.clientRequestId })
  await code(decideMaterialSubmission(project.id, fresh.id, owner.id, decisionRequest), 'MATERIAL_REQUEST_CLOSED')
  const withdrawRequest = command({ expectedVersion: 1, reason: '延迟撤回不能越过封闭' })
  await resolveMaterialRequest(project.id, member.id, { clientRequestId: withdrawRequest.clientRequestId })
  await code(withdrawMaterialSubmission(project.id, fresh.id, member.id, withdrawRequest), 'MATERIAL_REQUEST_CLOSED')
  assert.equal((await detail(fresh.id)).submission.status, 'pending')
  checks.push('FDE-REC-002/CONC-002:uncommitted-fence-replay-blocks-late-create-decision-withdraw-without-grants-or-duplicate-audit')

  for (let round = 0; round < 4; round++) {
    const raceFile = await newFile(`核对竞争${round}`), raceInput = await payload(raceFile.id)
    const send = () => createMaterialSubmission(project.id, member.id, raceInput)
    const resolve = () => resolveMaterialRequest(project.id, member.id, { clientRequestId: raceInput.clientRequestId })
    const result = await Promise.allSettled(round % 2 ? [resolve(), send()] : [send(), resolve()])
    const sent = result[round % 2 ? 1 : 0], resolved = result[round % 2 ? 0 : 1]
    assert.equal(resolved.status, 'fulfilled')
    if (resolved.status !== 'fulfilled') throw new Error('核对请求不得失败')
    const outcome = resolved.value as Awaited<ReturnType<typeof resolveMaterialRequest>>
    if (outcome.state === 'committed') { assert.equal(sent.status, 'fulfilled'); if (sent.status === 'fulfilled') assert.equal((sent.value as { id: string }).id, outcome.id) }
    else { assert.equal(sent.status, 'rejected'); if (sent.status === 'rejected') assert.equal(sent.reason.code, 'MATERIAL_REQUEST_CLOSED') }
    const rows = await db.select().from(projectMaterialSubmissions).where(eq(projectMaterialSubmissions.fileId, raceFile.id))
    const fences = await db.select().from(projectMaterialRequestClosures).where(and(eq(projectMaterialRequestClosures.requestId, raceInput.clientRequestId), eq(projectMaterialRequestClosures.actorId, member.id)))
    assert.equal(rows.length + fences.length, 1)
  }
  const scopedFile = await newFile('不同用户封闭隔离'), scopedInput = await payload(scopedFile.id)
  await resolveMaterialRequest(project.id, outsider.id, { clientRequestId: scopedInput.clientRequestId })
  assert.ok((await createMaterialSubmission(project.id, member.id, scopedInput)).id, '他人的恢复请求不得封闭实际发送人的操作')
  checks.push('FDE-CONC-001/REC-002:four-round-send-versus-resolution-single-outcome-and-foreign-actor-fence-isolated')

  await db.update(projects).set({ stage: '启动尽调', version: sql`${projects.version}+1` }).where(eq(projects.id, project.id))
  assert.ok((await getMaterialContext(project.id, member.id)).recipients.some(x => x.id === president.id))
  await db.update(projects).set({ stage: baseline[0].stage, version: baseline[0].version }).where(eq(projects.id, project.id))
  const stale = await payload(fourthFile.id, { expectedGovernanceVersion: 999 })
  await code(createMaterialSubmission(project.id, member.id, stale), 'VERSION_CONFLICT')
  const sixthFile = await newFile('六'), sixth = await createMaterialSubmission(project.id, member.id, await payload(sixthFile.id))
  await db.delete(projectMembers).where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, member.id)))
  await db.delete(projectDutyAssignments).where(and(eq(projectDutyAssignments.projectId, project.id), eq(projectDutyAssignments.userId, member.id)))
  await code(detail(sixth.id), 'MATERIAL_FORBIDDEN')
  await code(resolveMaterialRequest(project.id, member.id, { clientRequestId: input.clientRequestId }), 'MATERIAL_FORBIDDEN')
  await code(withdrawMaterialSubmission(project.id, sixth.id, member.id, command({ expectedVersion: 1, reason: '失去项目权限后撤回' })), 'MATERIAL_FORBIDDEN')
  assert.deepEqual(await db.select({ stage: projects.stage, version: projects.version, lifecycle: projects.lifecycle }).from(projects).where(eq(projects.id, project.id)), baseline)
  assert.equal((await db.select({ n: count() }).from(todos))[0].n, todoBefore.n)
  assert.equal((await db.select({ n: count() }).from(oaApprovalRequests))[0].n, oaBefore.n)
  assert.ok((await db.select({ n: count() }).from(auditLogs).where(and(eq(auditLogs.module, '材料送审'), eq(auditLogs.action, '拒绝访问'))))[0].n > 0)
  checks.push('FDE-FILE-003/005:stage-specific-executives-governance-version-removed-membership-no-project-task-or-approval-mutation')
  console.log(JSON.stringify({ ok: true, suite: 'fde-material-submissions', checks: checks.length, details: checks }))
} finally { await pool.end() }
