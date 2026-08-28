import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { projects, users, todos, todoFeedbacks, todoAcceptances, projectFiles, projectFileVersions, responsibilityRecords, responsibilityPolicyVersions, responsibilityPolicyEvents } from '../db/schema.js'
import { createFdeTask, feedbackFdeTask, decideFdeTask } from '../services/fdeTaskService.js'
import { setFdeFilePermissions } from '../services/fdeFileService.js'
import { executeResponsibilityPolicyCommand as policyCommand, listResponsibilityPolicies } from '../services/fdeResponsibilityPolicyService.js'
import { executeResponsibilityCommand as command, getResponsibilityRecord } from '../services/fdeResponsibilityService.js'
import { responsibilityEvents, responsibilityBusinessDate, type ResponsibilityPolicy } from '../contracts/fdeResponsibilityPolicyContract.js'
import { createRisk } from '../services/riskService.js'
import { saveProjectFile } from '../services/projectFileStorageService.js'
import { runResponsibilityScanBatch } from '../services/fdeResponsibilityScanner.js'

export async function seedResponsibilityBrowser(projectId: string, ownerId: string, memberId: string, leaderId: string, adminId: string, fileId: string) {
  assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
  assert.equal(process.env.DB_FREFIX, process.env.FDE_ACCEPTANCE_PREFIX)
  const reason = '隔离浏览器责任验收，合成规则不用于正式业务', evidence = [{ fileId, version: 1 }]
  await setFdeFilePermissions(fileId, ownerId, { clientRequestId: randomUUID(), expectedVersion: 1, reason, grants: [{ userId: ownerId, canView: true, canDownload: true }, { userId: memberId, canView: true, canDownload: true }, { userId: leaderId, canView: true, canDownload: false }] })
  const configuration: ResponsibilityPolicy = { rules: responsibilityEvents.map(event => ({ code: event.code, mode: event.mode, enabled: true, points: event.positive ? 2 : -4 })), timezone: 'Asia/Shanghai', calendar: { workingWeekdays: [1, 2, 3, 4, 5], holidays: [], extraWorkingDates: [] }, earlyWorkingDays: 1, graceMinutes: 0, appealLimit: 1, appealAggregation: 'exclude_pending', allowAdjustment: true, allowExemption: true, completionAggregation: 'one_per_task', feedbackAggregation: 'one_per_actor_task_business_day', missingReviewer: 'retain_pending_assignment', history: 'append_only_no_automatic_rescore' }
  const head = (await listResponsibilityPolicies(adminId)).policy
  const created = await policyCommand(adminId, { action: 'create', commandId: randomUUID(), expectedPolicyVersion: head?.version ?? 0, configuration, reason })
  const approved = await policyCommand(leaderId, { action: 'approve', commandId: randomUUID(), versionId: created.versionId, expectedDraftVersion: created.draftVersion, reason })
  const published = await policyCommand(adminId, { action: 'publish', commandId: randomUUID(), versionId: created.versionId, expectedDraftVersion: approved.draftVersion, expectedPolicyVersion: approved.policyVersion, reason })
  const activated = await policyCommand(adminId, { action: 'toggle', commandId: randomUUID(), expectedPolicyVersion: published.policyVersion, enabled: true, reason })
  const dueDate = responsibilityBusinessDate(new Date(Date.now() + 7 * 86_400_000)), ids: string[] = []
  const version = async (id: string) => (await db.select().from(todos).where(eq(todos.id, id)))[0].version
  for (const [index, title] of ['责任申诉页面验收', '已有申诉复核验收', '待确认候选页面验收'].entries()) {
    const taskId = randomUUID()
    await createFdeTask(projectId, ownerId, { clientRequestId: taskId, title, ownerUserId: memberId, dueDate, deliverable: '原件与核对结果' })
    await feedbackFdeTask(projectId, taskId, memberId, { expectedVersion: await version(taskId), kind: 'submission', progress: 100, result: '提交合成材料用于人工确认流程，不代表已认定责任', blocker: '', estimatedDate: dueDate, evidence })
    const [feedback] = await db.select().from(todoFeedbacks).where(eq(todoFeedbacks.todoId, taskId)).orderBy(desc(todoFeedbacks.taskVersion))
    await decideFdeTask(projectId, taskId, ownerId, { expectedVersion: await version(taskId), feedbackId: feedback.id, action: 'return', reason: '隔离复查发现待核对事项，退回本身不自动归责' })
    const [acceptance] = await db.select().from(todoAcceptances).where(eq(todoAcceptances.feedbackId, feedback.id))
    const proposed = await command(projectId, ownerId, { commandId: randomUUID(), action: 'propose', taskId, expectedTaskVersion: await version(taskId), eventCode: 'incorrect_completion', sourceId: acceptance.id, relatedSourceId: null, evidence, reason })
    ids.push(proposed.recordId!)
    if (index < 2) await command(projectId, ownerId, { commandId: randomUUID(), action: 'confirm', recordId: proposed.recordId, expectedVersion: proposed.version, decision: 'confirm', reason })
    if (index === 1) await command(projectId, memberId, { commandId: randomUUID(), action: 'appeal', recordId: proposed.recordId, expectedVersion: (await getResponsibilityRecord(memberId, proposed.recordId!)).record.version, evidence, reason: '本人补充合成证据请求独立复核，原始记录保留' })
  }
  console.log(JSON.stringify({ responsibilityFixture: true, projectId, appealRecordId: ids[0], reviewRecordId: ids[1], candidateRecordId: ids[2] }))
  if (process.env.FDE_RESPONSIBILITY_ASSIGNMENT_BROWSER_FIXTURE === '1') {
    const file = async (name: string, allowed: string[], uploaderId = ownerId) => {
      const id = randomUUID(), bytes = Buffer.from(`仅用于隔离浏览器缺岗验收：${name}`), sha256 = createHash('sha256').update(bytes).digest('hex')
      const storagePath = await saveProjectFile(projectId, id, bytes)
      const [uploader] = await db.select().from(users).where(eq(users.id, uploaderId))
      await db.insert(projectFiles).values({ id, projectId, name, type: 'TXT', category: '项目资料', uploadedBy: uploaderId, uploader: uploader.name, storagePath, byteSize: bytes.length, sha256 })
      await db.insert(projectFileVersions).values({ fileId: id, version: 1, storagePath, byteSize: bytes.length, sha256, createdBy: uploaderId })
      await setFdeFilePermissions(id, uploaderId, { clientRequestId: randomUUID(), expectedVersion: 1, reason, grants: allowed.map(userId => ({ userId, canView: true, canDownload: userId === ownerId })) })
      return id
    }
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId))
    const riskCandidate = async (title: string, subjectId: string, proofId: string) => {
      const taskId = randomUUID(), [subject] = await db.select().from(users).where(eq(users.id, subjectId))
      await createFdeTask(projectId, ownerId, { clientRequestId: taskId, title, ownerUserId: subjectId, dueDate, deliverable: '人工核验风险与原件' })
      const risk = await createRisk({ projectId, projectName: project.name, title, type: '财务', level: '高' }, subjectId, subject.name)
      return command(projectId, ownerId, { commandId: randomUUID(), action: 'propose', taskId, expectedTaskVersion: await version(taskId), eventCode: 'major_risk', sourceId: risk.id, relatedSourceId: null, evidence: [{ fileId: proofId, version: 1 }], reason })
    }
    const unassignedFileId = await file('缺岗补岗授权证据.txt', [ownerId])
    const unassigned = await riskCandidate('负责人本人记录缺独立处理人', ownerId, unassignedFileId)
    assert.equal((await getResponsibilityRecord(ownerId, unassigned.recordId!)).assignmentState, 'unassigned')
    const invalidFileId = await file('原处理人失权证据.txt', [ownerId, memberId, leaderId], leaderId)
    const invalid = await riskCandidate('原处理人失权待领导协调', memberId, invalidFileId)
    await setFdeFilePermissions(invalidFileId, leaderId, { clientRequestId: randomUUID(), expectedVersion: 2, reason, grants: [{ userId: memberId, canView: true, canDownload: false }, { userId: leaderId, canView: true, canDownload: false }] })
    assert.equal((await getResponsibilityRecord(leaderId, invalid.recordId!)).assignmentState, 'invalid')
    // Synthetic historical dates only, followed by the actual scanner. No fixture
    // route accepts a caller-supplied clock, system identity or generated record.
    const epoch = new Date(Date.now() - 3 * 86_400_000), scanTaskId = randomUUID()
    await db.update(responsibilityPolicyVersions).set({ publishedAt: epoch }).where(eq(responsibilityPolicyVersions.id, published.versionId!))
    const [activation] = await db.select().from(responsibilityPolicyEvents).where(and(eq(responsibilityPolicyEvents.actorId, adminId), eq(responsibilityPolicyEvents.commandId, activated.commandId), eq(responsibilityPolicyEvents.action, 'toggle')))
    assert.ok(activation, '必须定位实际已提交的启用事件，启停事件不绑定 versionId 字段')
    await db.update(responsibilityPolicyEvents).set({ createdAt: epoch }).where(eq(responsibilityPolicyEvents.id, activation.id))
    await createFdeTask(projectId, ownerId, { clientRequestId: scanTaskId, title: '系统期限扫描来源页面验收', ownerUserId: memberId, dueDate: responsibilityBusinessDate(new Date(Date.now() - 86_400_000)), deliverable: '扫描候选须人工确认' })
    await db.update(todos).set({ createdAt: epoch }).where(eq(todos.id, scanTaskId))
    const scan = await runResponsibilityScanBatch({ limit: 100 })
    const candidates = await db.select({ id: responsibilityRecords.id }).from(responsibilityRecords).where(eq(responsibilityRecords.taskId, scanTaskId))
    assert.equal(candidates.length, 2)
    console.log(JSON.stringify({ responsibilityAssignmentFixture: true, projectId, unassignedRecordId: unassigned.recordId, unassignedFileId, invalidRecordId: invalid.recordId, scannerRecordIds: candidates.map(row => row.id), scanCycleId: scan.cycleId }))
  }
}
