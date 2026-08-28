import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { and, asc, desc, eq, gt, inArray, isNotNull, lte } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { users, projects, todos, todoFeedbacks, projectFiles, projectFileVersions, responsibilityRecords as records, responsibilityEventsLog as events, responsibilityNotices as notices, responsibilityScanState as state, responsibilityScanCycles as cycles, responsibilityPolicyVersions as versions, responsibilityPolicyEvents as policyEvents, auditLogs } from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'
import { createProject, classifyProject } from '../services/projectService.js'
import { proposeFdeGovernance } from '../services/fdeGovernanceService.js'
import { createFdeTask, feedbackFdeTask, requestFdeTaskExtension, actOnFdeTaskExtension } from '../services/fdeTaskService.js'
import { listOaApprovalRequests } from '../services/oaWorkflowService.js'
import { executeResponsibilityPolicyCommand as policyCommand, listResponsibilityPolicies, activeResponsibilityPolicy } from '../services/fdeResponsibilityPolicyService.js'
import { executeResponsibilityCommand, getResponsibilityRecord } from '../services/fdeResponsibilityService.js'
import { responsibilityDetail } from '../contracts/fdeResponsibilityViewContract.js'
import { responsibilityEvents, responsibilityBusinessDate, type ResponsibilityPolicy } from '../contracts/fdeResponsibilityPolicyContract.js'
import { runResponsibilityScanBatch, startResponsibilityScanner, stopResponsibilityScanner, responsibilityScannerHealth } from '../services/fdeResponsibilityScanner.js'
import { saveProjectFile } from '../services/projectFileStorageService.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.DB_FREFIX, process.env.FDE_ACCEPTANCE_PREFIX)
assert.ok(process.env.PROJECT_FILE_ROOT?.includes('fde-migration-acceptance-'))
const checks: string[] = [], marker = randomUUID().slice(0, 8), reason = '隔离系统扫描验收，不批准正式责任计分'
const date = (days: number) => responsibilityBusinessDate(new Date(Date.now() + days * 86_400_000))
const epoch = new Date(Date.now() - 10 * 86_400_000)
const runChild = (crash = false) => promisify(execFile)(process.execPath, ['--import', 'tsx', 'server/src/scripts/fdeResponsibilityScannerAcceptance.ts', crash ? '--resume-crash' : '--resume'], { env: { ...process.env }, maxBuffer: 1024 * 1024 })
const taskRows = (id: string) => db.select().from(records).where(eq(records.taskId, id))
const drain = async () => { for (let i = 0; i < 200; i++) { const result = await runResponsibilityScanBatch({ limit: 100 }); if (result.state === 'complete' || result.state === 'disabled') return result } throw new Error('扫描未在有界轮次完成') }
try {
  if (process.argv.includes('--resume') || process.argv.includes('--resume-crash')) {
    const result = await runResponsibilityScanBatch({ limit: 1 })
    await new Promise<void>(resolve => { process.stdout.write(JSON.stringify(result) + '\n', () => resolve()) })
    if (process.argv.includes('--resume-crash')) process.kill(process.pid, 'SIGKILL')
  } else {
    assert.equal(process.argv.length, 2)
    const people = ['投资经理', '投资经理', '董事长', '系统管理员'].map((role, i) => ({ id: randomUUID(), name: `扫描-${marker}-${i}`, role, email: `scanner-${marker}-${i}@example.invalid`, department: `扫描-${marker}`, passwordHash: 'not-for-login' }))
    const [owner, member, leader, admin] = people
    await db.insert(users).values(people)
    for (const person of people) await identityRepositories.users.synchronizeAdministrationBindings(person.id, person.role, person.department)
    let project = await createProject({ name: `系统期限扫描-${marker}`, owner: owner.name, ownerUserId: owner.id, collaborators: [], targetDate: date(90) }, owner.id)
    project = await classifyProject({ projectId: project.id, userId: owner.id, expectedVersion: project.version, toClassification: 'normal', reason })
    await proposeFdeGovernance({ projectId: project.id, userId: owner.id, ownerUserId: owner.id, expectedVersion: project.governanceVersion, reason, assignments: [{ duty: 'member', userId: member.id }, { duty: 'concerned_leader', userId: leader.id }] })
    const task = async (id: string) => (await db.select().from(todos).where(eq(todos.id, id)))[0]
    const makeTask = async (label: string, old = true, id = randomUUID()) => {
      await createFdeTask(project.id, owner.id, { clientRequestId: id, title: label, ownerUserId: member.id, dueDate: date(-1), deliverable: '真实任务与待确认候选' })
      // Synthetic historical time only; never backdate a business-prefix task.
      if (old) await db.update(todos).set({ createdAt: epoch }).where(eq(todos.id, id))
      return id
    }
    const toggle = async (enabled: boolean) => {
      const head = (await listResponsibilityPolicies(admin.id)).policy
      return policyCommand(admin.id, { action: 'toggle', commandId: randomUUID(), expectedPolicyVersion: head!.version, enabled, reason })
    }
    const historicalPolicy = async (versionId: string | null, commandId: string) => {
      assert.ok(versionId)
      return db.transaction(async tx => {
        // Resolve the exact committed command, not wall-clock eligibility: the
        // database clock may be ahead of this process immediately after toggle.
        const activations = await tx.select().from(policyEvents).where(and(eq(policyEvents.actorId, admin.id), eq(policyEvents.commandId, commandId), eq(policyEvents.action, 'toggle')))
        assert.equal(activations.length, 1)
        const activation = activations[0]
        const [version] = await tx.select().from(versions).where(eq(versions.id, versionId))
        assert.ok(version.publishedAt)
        const effectiveFrom = new Date(Math.max(version.publishedAt.getTime(), activation.createdAt.getTime()))
        assert.equal(await activeResponsibilityPolicy(tx, new Date(effectiveFrom.getTime() - 1)), null)
        const atBoundary = await activeResponsibilityPolicy(tx, effectiveFrom)
        assert.equal(atBoundary?.id, versionId)
        assert.equal(atBoundary?.activationEventId, activation.id)
        // Backdate only these synthetic records after proving the real boundary.
        await tx.update(versions).set({ publishedAt: epoch }).where(eq(versions.id, versionId))
        await tx.update(policyEvents).set({ createdAt: epoch }).where(eq(policyEvents.id, activation.id))
        const historical = await activeResponsibilityPolicy(tx, new Date())
        assert.ok(historical)
        assert.equal(historical.id, versionId)
        assert.equal(historical.effectiveFrom.getTime(), epoch.getTime())
        return historical
      })
    }
    const existing = (await listResponsibilityPolicies(admin.id)).policy
    if (existing?.enabled) await toggle(false)
    const stateBefore = await db.select().from(state)
    assert.equal((await runResponsibilityScanBatch()).state, 'disabled')
    assert.deepEqual(await db.select().from(state), stateBefore)
    checks.push('disabled-policy-readonly-no-cycle-or-candidate')

    const configuration: ResponsibilityPolicy = { rules: responsibilityEvents.map(event => ({ code: event.code, mode: event.mode, enabled: ['no_feedback', 'unjustified_delay'].includes(event.code), points: event.positive ? null : -2 })), timezone: 'Asia/Shanghai', calendar: { workingWeekdays: [1, 2, 3, 4, 5], holidays: [], extraWorkingDates: [] }, graceMinutes: 0, earlyWorkingDays: null, appealLimit: 1, appealAggregation: 'exclude_pending', allowAdjustment: false, allowExemption: false, completionAggregation: 'one_per_task', feedbackAggregation: 'one_per_actor_task_business_day', missingReviewer: 'retain_pending_assignment', history: 'append_only_no_automatic_rescore' }
    const draft = await policyCommand(admin.id, { action: 'create', commandId: randomUUID(), expectedPolicyVersion: (await listResponsibilityPolicies(admin.id)).policy?.version ?? 0, configuration, reason })
    const approved = await policyCommand(leader.id, { action: 'approve', commandId: randomUUID(), versionId: draft.versionId, expectedDraftVersion: draft.draftVersion, reason })
    await policyCommand(admin.id, { action: 'publish', commandId: randomUUID(), versionId: draft.versionId, expectedDraftVersion: approved.draftVersion, expectedPolicyVersion: approved.policyVersion, reason })
    const activation = await toggle(true)
    const historical = await makeTask('启用前的期限不得补扣')
    await drain(); assert.equal((await taskRows(historical)).length, 0)
    // Shift only this synthetic policy's publication/activation to exercise past deadlines.
    const active = await historicalPolicy(draft.versionId, activation.commandId)
    const lateAssignment = await makeTask('期限早于任务创建不能自动追溯', false)
    const batchTasks = [historical, await makeTask('断点样本二'), await makeTask('断点样本三')]
    const beforeTasks = await db.select().from(todos).where(inArray(todos.id, batchTasks))
    const one = await runResponsibilityScanBatch({ limit: 1 })
    assert.equal(one.state, 'partial')
    assert.ok(one.cycleId)
    const beforeResume = (await db.select().from(cycles).where(eq(cycles.id, one.cycleId!)))[0]
    const child = await runChild(); assert.ok(JSON.parse(child.stdout.trim()).cycleId)
    const afterResume = (await db.select().from(cycles).where(eq(cycles.id, one.cycleId!)))[0]
    assert.equal(afterResume.processed, beforeResume.processed + 1)
    const crashed = await runChild(true).then(() => null, error => error)
    assert.equal(crashed?.signal, 'SIGKILL')
    const afterCrash = (await db.select().from(cycles).where(eq(cycles.id, one.cycleId!)))[0]
    assert.equal(afterCrash.processed, afterResume.processed + 1, '强制退出保留最后已提交的游标')
    await Promise.all([runChild(), runChild()]); await drain()
    for (const id of batchTasks) {
      const rows = await taskRows(id)
      assert.equal(rows.length, 2)
      for (const row of rows) { assert.equal(row.createdBy, null); assert.equal(row.creationOrigin, 'scanner'); assert.ok(row.scanCycleId); assert.equal(row.effectivePoints, 0); assert.equal(row.status, 'pending_confirmation'); assert.equal(row.reviewerId, owner.id) }
    }
    assert.equal((await taskRows(lateAssignment)).length, 0)
    assert.deepEqual(await db.select().from(todos).where(inArray(todos.id, batchTasks)), beforeTasks)
    checks.push('activation-cutoff-assignment-time-durable-cursor-real-SIGKILL-restart-and-two-process-serialization')

    const sample = (await taskRows(historical))[0]
    const detail = responsibilityDetail.parse(JSON.parse(JSON.stringify(await getResponsibilityRecord(owner.id, sample.id))))
    assert.equal(detail.events[0].actorName, '系统期限扫描'); assert.equal(detail.countedPoints, 0)
    assert.equal((await db.select().from(events).where(eq(events.recordId, sample.id)))[0].actorId, null)
    assert.equal((await db.select().from(notices).where(eq(notices.recordId, sample.id))).length, 1)
    assert.ok((await db.select().from(auditLogs).where(and(eq(auditLogs.action, 'scan_candidate'), eq(auditLogs.userName, '系统期限扫描')))).every(row => row.userId === null))
    await assert.rejects(db.update(records).set({ creationOrigin: 'user' }).where(eq(records.id, sample.id)))
    await assert.rejects(db.update(events).set({ action: 'confirm' }).where(eq(events.recordId, sample.id)))
    await assert.rejects(executeResponsibilityCommand(project.id, member.id, { action: 'confirm', commandId: randomUUID(), recordId: sample.id, expectedVersion: 1, decision: 'confirm', reason }), (e: unknown) => (e as { code: string }).code === 'RESP_REVIEW_FORBIDDEN')
    await executeResponsibilityCommand(project.id, owner.id, { action: 'confirm', commandId: randomUUID(), recordId: sample.id, expectedVersion: 1, decision: 'revoke', reason })
    await drain(); assert.equal((await taskRows(historical)).length, 2)
    checks.push('system-origin-db-constraints-view-contract-human-only-decision-notice-audit-and-revoked-dedupe')

    const fileId = randomUUID(), bytes = Buffer.from(`扫描真实反馈证据-${marker}`), sha256 = createHash('sha256').update(bytes).digest('hex'), storagePath = await saveProjectFile(project.id, fileId, bytes)
    await db.insert(projectFiles).values({ id: fileId, projectId: project.id, name: `扫描证据-${marker}.txt`, type: 'TXT', category: '项目资料', uploadedBy: member.id, uploader: member.name, storagePath, byteSize: bytes.length, sha256 })
    await db.insert(projectFileVersions).values({ fileId, version: 1, storagePath, byteSize: bytes.length, sha256, createdBy: member.id })
    const validFeedback = await makeTask('完整反馈与上游阻塞'), cancelled = await makeTask('取消不扫描'), unknownCompleted = await makeTask('历史完成无验收来源')
    await feedbackFdeTask(project.id, validFeedback, member.id, { expectedVersion: 1, kind: 'progress', progress: 30, result: '反馈及上游依赖已提供', blocker: '上游资料尚未送达', estimatedDate: date(1), evidence: [{ fileId, version: 1 }] })
    await db.update(todoFeedbacks).set({ submittedAt: new Date(Date.now() - 2 * 86_400_000) }).where(eq(todoFeedbacks.todoId, validFeedback))
    await db.update(todos).set({ status: '已取消' }).where(eq(todos.id, cancelled))
    await db.update(todos).set({ status: '已完成' }).where(eq(todos.id, unknownCompleted))
    await drain()
    for (const id of [validFeedback, cancelled, unknownCompleted]) assert.equal((await taskRows(id)).length, 0)
    checks.push('complete-feedback-real-proof-upstream-blocker-cancelled-and-unknown-historical-completion-excluded')

    // Fail after candidate/notice/audit writes, exactly at checkpoint update.
    const failureTask = await makeTask('末端检查点故障', true, 'ffffffff-ffff-4fff-bfff-fffffffffff1'), failureStart = await runResponsibilityScanBatch({ limit: 1 })
    let current = (await db.select().from(cycles).where(eq(cycles.id, failureStart.cycleId!)))[0]
    assert.equal((await taskRows(failureTask)).length, 0, '固定高位任务尚未处理，失败步骤必须实际写入候选')
    for (let i = 0; i < 2000; i++) {
      const [next] = await db.select({ id: todos.id }).from(todos).where(and(eq(todos.executionModel, 'fde-v1'), isNotNull(todos.projectId), isNotNull(todos.dueDate), lte(todos.dueDate, responsibilityBusinessDate(current.asOf)), lte(todos.createdAt, current.asOf), lte(todos.id, current.upperTaskId!), current.cursorTaskId ? gt(todos.id, current.cursorTaskId) : undefined)).orderBy(asc(todos.id)).limit(1)
      assert.ok(next)
      if (next.id === failureTask) break
      await runResponsibilityScanBatch({ limit: 1 })
      current = (await db.select().from(cycles).where(eq(cycles.id, current.id)))[0]
      assert.ok(i < 1999)
    }
    const constraint = quoteMysqlIdentifier(`${process.env.DB_FREFIX}scanner_checkpoint_guard`)
    const table = quoteMysqlIdentifier(mysqlTableName('responsibility_scan_cycles'))
    const beforeRecords = await db.select().from(records), beforeEvents = await db.select().from(events), beforeNotices = await db.select().from(notices), beforeAudit = await db.select().from(auditLogs)
    await pool.query(`ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK (id <> '${current.id}' OR processed <= ${current.processed})`)
    try {
      await assert.rejects(runResponsibilityScanBatch({ limit: 100 }))
      const failed = (await db.select().from(cycles).where(eq(cycles.id, current.id)))[0]
      assert.equal(failed.cursorTaskId, current.cursorTaskId); assert.equal(failed.processed, current.processed); assert.ok(failed.lastErrorCode)
      assert.deepEqual(await db.select().from(records), beforeRecords); assert.deepEqual(await db.select().from(events), beforeEvents); assert.deepEqual(await db.select().from(notices), beforeNotices)
      assert.deepEqual(await db.select().from(auditLogs), beforeAudit)
    } finally { await pool.query(`ALTER TABLE ${table} DROP CHECK ${constraint}`) }
    await runChild(); await drain(); assert.equal((await taskRows(failureTask)).length, 2)
    checks.push('late-checkpoint-constraint-rolls-back-candidate-notice-and-event-cursor-retained-restart-recovers')

    const extend = await makeTask('扫描与正式延期串行')
    await requestFdeTaskExtension(project.id, extend, member.id, { expectedVersion: (await task(extend)).version, requestedDueDate: date(2), requestedDueTime: null, reason, reviewerUserId: owner.id })
    const approvals = await listOaApprovalRequests(owner.id)
    const request = approvals.find(row => row.taskId === extend && row.businessType === 'task_extension')!
    assert.ok(request)
    await Promise.all([drain(), actOnFdeTaskExtension({ requestId: request.id, userId: owner.id, expectedVersion: request.lockVersion, action: 'approve', comment: reason })])
    assert.equal((await task(extend)).dueDate, date(2))
    assert.ok((await taskRows(extend)).every(row => row.status === 'exempted' && row.effectivePoints === 0))
    await drain(); assert.ok((await taskRows(extend)).every(row => row.effectivePoints === 0))
    checks.push('approved-extension-versus-scan-one-project-lock-effective-deadline-correction-no-unrelated-rewrite')

    const changedConfig = { ...configuration, rules: configuration.rules.map(rule => ({ ...rule, points: rule.enabled ? -3 : rule.points })) }
    const newDraft = await policyCommand(admin.id, { action: 'create', commandId: randomUUID(), expectedPolicyVersion: (await listResponsibilityPolicies(admin.id)).policy!.version, configuration: changedConfig, reason })
    const newApproved = await policyCommand(leader.id, { action: 'approve', commandId: randomUUID(), versionId: newDraft.versionId, expectedDraftVersion: newDraft.draftVersion, reason })
    await policyCommand(admin.id, { action: 'publish', commandId: randomUUID(), versionId: newDraft.versionId, expectedDraftVersion: newApproved.draftVersion, expectedPolicyVersion: newApproved.policyVersion, reason })
    const newActivation = await toggle(true)
    const newActive = await historicalPolicy(newDraft.versionId, newActivation.commandId)
    const newPolicyTask = await makeTask('新版本只产生新的期限事件')
    await drain()
    assert.equal((await taskRows(newPolicyTask)).length, 2)
    assert.ok((await taskRows(newPolicyTask)).every(row => row.policyVersionId === newActive.id && row.originalPoints === -3 && row.effectivePoints === 0))
    for (const id of batchTasks) assert.ok((await taskRows(id)).every(row => row.policyVersionId === active.id && row.originalPoints === -2))
    checks.push('new-policy-new-facts-retain-original-version-points-and-revoked-event-dedupe')

    const gapTask = await makeTask('停用间隔不得补扣')
    await toggle(false)
    const held = await db.select().from(state); assert.equal((await runResponsibilityScanBatch()).state, 'disabled'); assert.deepEqual(await db.select().from(state), held)
    await toggle(true); await drain(); assert.equal((await taskRows(gapTask)).length, 0)
    for (const id of batchTasks) assert.equal((await taskRows(id)).length, 2)
    await toggle(false)
    const priorFlag = process.env.FDE_RESPONSIBILITY_SCANNER_ENABLED
    try {
      delete process.env.FDE_RESPONSIBILITY_SCANNER_ENABLED
      startResponsibilityScanner(); assert.equal(responsibilityScannerHealth().state, 'intentionally-disabled')
      process.env.FDE_RESPONSIBILITY_SCANNER_ENABLED = 'true'
      startResponsibilityScanner(); await stopResponsibilityScanner()
      assert.equal(responsibilityScannerHealth().state, 'stopped')
    } finally { if (priorFlag === undefined) delete process.env.FDE_RESPONSIBILITY_SCANNER_ENABLED; else process.env.FDE_RESPONSIBILITY_SCANNER_ENABLED = priorFlag }
    checks.push('disable-retains-checkpoint-reenable-no-retroactive-candidates-default-off-worker-drains-before-pool-close')
    console.log(JSON.stringify({ ok: true, prefix: process.env.DB_FREFIX, scope: 'responsibility-scanner-isolated-not-production-policy', checks, passed: checks.length, productionPolicyApproved: false }))
  }
} finally { await stopResponsibilityScanner(); await pool.end() }
