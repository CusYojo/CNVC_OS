import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { identityRepositories } from '../repositories/index.js'
import { auditLogs, fdeTypeExecutionNotices as notices, fdeTypeExecutionReviews as reviews, fdeTypeExecutionEvents as events, fdeTypeExecutionFiles as refs, fdeWorkflowPolicies, oaApprovalRequests, projectDutyAssignments, projectFileGrants, projectFiles, projectFileVersions, projectMembers, projects, userRoles, users } from '../db/schema.js'
import { executeTypePolicy, getTypePolicy, listTypePolicies } from '../services/fdeTypePolicyService.js'
import { executeTypeRuntime, getTypeRuntime } from '../services/fdeTypeRuntimeService.js'
import { listApprovalCenter } from '../services/fdeApprovalCenterService.js'
import { readTypeApprovalNotice } from '../services/fdeTypeApprovalService.js'
import { typePolicyFixture } from './fdeTypePolicyFixture.js'
import { saveProjectFile } from '../services/projectFileStorageService.js'
import { seedApprovalCenterFixture } from './fdeApprovalCenterFixture.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
assert.ok(process.env.PROJECT_FILE_ROOT?.includes('fde-migration-acceptance-'))
const checks: string[] = [], marker = randomUUID().slice(0, 8)
const people = ['系统管理员', '投资经理', '投资经理', '董事长', '董事长', '投资经理'].map((role, i) => ({ id: randomUUID(), name: `统一执行-${marker}-${i}`, email: `type-inbox-${marker}-${i}@accept.invalid`, role, department: `隔离-${marker}`, passwordHash: 'not-a-login-password' }))
const [admin, owner, secretary, a, b, outsider] = people
const denied = (work: Promise<unknown>, code: string) => assert.rejects(work, e => (e as { code?: string }).code === code)
try {
  await db.insert(users).values(people)
  for (const p of people) await identityRepositories.users.synchronizeAdministrationBindings(p.id, p.role, p.department)
  const configuration = typePolicyFixture()
  configuration.actions.forEach(action => { action.needLeader = false })
  configuration.planApprovals = [{ duty: 'concerned_leader', name: '两位领导会签', mode: '会签' }, { duty: 'owner', name: '负责人最后核对', mode: '或签' }]
  const old = (await listTypePolicies(admin.id)).policies.find(p => p.code === 'noninvestment:fundraising')
  const created = await executeTypePolicy(admin.id, { action: 'create', commandId: randomUUID(), expectedPolicyVersion: old?.version ?? 0, configuration, reason: '隔离会签待办配置' })
  const approved = await executeTypePolicy(a.id, { action: 'approve', commandId: randomUUID(), versionId: created.versionId, policyId: created.policyId, expectedVersion: created.version, reason: '独立核对隔离配置' })
  await executeTypePolicy(admin.id, { action: 'publish', commandId: randomUUID(), versionId: created.versionId, policyId: created.policyId, expectedVersion: approved.version, expectedPolicyVersion: approved.policyVersion, reason: '发布隔离会签测试版本' })
  const version = (await getTypePolicy(admin.id, created.policyId)).versions.find(v => v.id === created.versionId)!
  const projectId = randomUUID(), projectName = `非投资统一审批-${marker}`
  await db.insert(projects).values({ id: projectId, name: projectName, owner: owner.name, ownerUserId: owner.id, createdBy: owner.id, workflowModel: 'fde-v1', projectType: '基金募资项目', workflowPolicyVersionId: version.id, stage: configuration.stages[0].name, classification: 'normal', lifecycle: 'active' })
  await db.insert(projectMembers).values([owner, secretary, a, b].map(p => ({ projectId, userId: p.id, memberRole: p === owner ? 'owner' : 'member', sourceName: p.name })))
  await db.insert(projectDutyAssignments).values([{ projectId, userId: secretary.id, duty: 'secretary', assignedBy: owner.id }, ...[a, b].map(p => ({ projectId, userId: p.id, duty: 'concerned_leader' as const, assignedBy: owner.id }))])
  const get = (uid = secretary.id, raw = {}) => getTypeRuntime(projectId, uid, raw)
  const center = (uid: string, view = 'pending', extra = {}) => listApprovalCenter(uid, { view, q: projectName, ...extra })
  const command = async (uid: string, action: string, extra = {}) => executeTypeRuntime(projectId, uid, { commandId: randomUUID(), expectedVersion: (await get()).instance?.version ?? 0, action, reason: '明确核对统一审批链路', ...extra })
  const plan = { expectedProjectVersion: 1, expectedGovernanceVersion: 1, expectedPolicyVersionId: version.id, expectedPolicySha256: version.sha256, cycleDays: 50, targetDate: '2026-10-30', selections: configuration.actions.map((act, i) => ({ actionKey: act.key, userId: i ? owner.id : secretary.id, dueTime: '18:07' })) }
  await command(secretary.id, 'save_plan', { plan })
  assert.equal((await center(a.id)).total, 0)
  await command(secretary.id, 'submit_plan')
  let review = (await get()).reviews[0]
  const decide = async (uid: string, decision: string) => { review = (await get()).reviews[0]; return command(uid, 'decide', { requestId: review.id, expectedReviewVersion: review.version, decision }) }
  assert.equal((await center(a.id)).total, 1); assert.equal((await center(b.id)).total, 1)
  assert.equal((await center(owner.id)).total, 0); assert.equal((await center(secretary.id)).total, 0)
  assert.equal((await center(admin.id)).total, 0); assert.equal((await center(outsider.id)).total, 0)
  assert.equal((await center(secretary.id, 'mine')).total, 1)
  assert.equal((await center(owner.id, 'tracking')).total, 1)
  assert.equal((await center(a.id)).list[0].businessType, 'type_execution')
  assert.equal((await center(a.id)).list[0].projectId, projectId)
  assert.equal((await db.select().from(oaApprovalRequests).where(eq(oaApprovalRequests.id, review.id))).length, 0)
  checks.push('one-authoritative-type-review:current-two-cosigners-only:future-node-and-self-excluded:no-shadow-OA')
  const aNotice = (await center(a.id)).list[0].notice!, bNotice = (await center(b.id)).list[0].notice!
  // Simulate a pre-notice review without inventing a migration/backfill policy.
  // Reads must keep it actionable and must not create notices or business events.
  const retainedNotices = await db.select().from(notices).where(eq(notices.reviewId, review.id))
  const preNoticeView = await get(a.id)
  const preNoticeEvents = await db.select().from(events).where(eq(events.projectId, projectId)).orderBy(asc(events.id))
  const preNoticeAudits = await db.select().from(auditLogs).where(eq(auditLogs.module, '非投资项目执行')).orderBy(asc(auditLogs.id))
  await db.delete(notices).where(eq(notices.reviewId, review.id))
  for (const person of [a, b]) {
    const legacyPending = await center(person.id)
    assert.equal(legacyPending.total, 1)
    assert.equal(legacyPending.counts.pending, 1)
    assert.equal(legacyPending.list[0].id, review.id)
    assert.equal(legacyPending.list[0].notice, null)
    assert.equal((await get(person.id, { review: review.id })).reviews[0].canDecide, true)
  }
  assert.deepEqual(await get(a.id), preNoticeView)
  assert.equal((await db.select().from(notices).where(eq(notices.reviewId, review.id))).length, 0)
  assert.deepEqual(await db.select().from(events).where(eq(events.projectId, projectId)).orderBy(asc(events.id)), preNoticeEvents)
  assert.deepEqual(await db.select().from(auditLogs).where(eq(auditLogs.module, '非投资项目执行')).orderBy(asc(auditLogs.id)), preNoticeAudits)
  await db.insert(notices).values(retainedNotices)
  assert.equal((await center(a.id)).list[0].notice?.id, aNotice.id)
  assert.equal((await center(b.id)).list[0].notice?.id, bNotice.id)
  checks.push('legacy-review-without-notice-remains-actionable:counts-and-deep-link-match:GET-never-backfills-or-mutates')
  const before = await get(), beforeEvents = await db.select().from(events).where(eq(events.projectId, projectId))
  const read = await readTypeApprovalNotice(bNotice.id, b.id)
  assert.deepEqual(await readTypeApprovalNotice(bNotice.id, b.id), read)
  assert.equal((await center(b.id)).total, 1); assert.ok((await center(b.id)).list[0].notice?.readAt)
  assert.deepEqual(await get(), before); assert.deepEqual(await db.select().from(events).where(eq(events.projectId, projectId)), beforeEvents)
  await denied(readTypeApprovalNotice(bNotice.id, a.id), 'TYPE_NOTICE_FORBIDDEN')
  assert.equal((await db.select().from(auditLogs).where(and(eq(auditLogs.userId, b.id), eq(auditLogs.action, '阅读待审批通知')))).length, 1)
  checks.push('own-notice-idempotent-read-one-audit:no-review-instance-event-or-pending-count-transition')
  await decide(a.id, 'approve')
  assert.equal((await center(a.id)).total, 0); assert.equal((await center(b.id)).total, 1)
  assert.equal((await center(owner.id)).total, 0); assert.equal((await center(a.id, 'processed')).total, 1)
  assert.equal((await center(b.id)).list[0].notice?.id, bNotice.id)
  assert.equal((await center(b.id)).list[0].notice?.readAt, read.readAt)
  await denied(readTypeApprovalNotice(aNotice.id, a.id), 'TYPE_NOTICE_FORBIDDEN')
  checks.push('partial-cosign-keeps-remaining-read-marker:processed-is-not-completed:next-node-not-early')
  const bRoles = await db.select().from(userRoles).where(eq(userRoles.userId, b.id))
  await db.delete(userRoles).where(eq(userRoles.userId, b.id))
  assert.equal((await center(b.id)).total, 0); assert.equal((await get(b.id)).reviews[0].canDecide, false)
  await denied(readTypeApprovalNotice(bNotice.id, b.id), 'TYPE_NOTICE_FORBIDDEN')
  await db.insert(userRoles).values(bRoles)
  await db.delete(projectDutyAssignments).where(and(eq(projectDutyAssignments.projectId, projectId), eq(projectDutyAssignments.userId, b.id)))
  assert.equal((await center(b.id)).total, 0)
  await db.insert(projectDutyAssignments).values({ projectId, userId: b.id, duty: 'concerned_leader', assignedBy: owner.id })
  await db.update(users).set({ status: '停用' }).where(eq(users.id, b.id))
  await denied(center(b.id), 'OA_ACTOR_UNAVAILABLE'); await denied(readTypeApprovalNotice(bNotice.id, b.id), 'TYPE_NOTICE_FORBIDDEN')
  await db.update(users).set({ status: '启用' }).where(eq(users.id, b.id))
  assert.equal((await center(b.id)).total, 1)
  checks.push('live-role-duty-and-disabled-account-rechecked:detail-capability-matches-current-inbox')
  await decide(b.id, 'approve')
  assert.equal((await center(b.id)).total, 0); assert.equal((await center(owner.id)).total, 1)
  const ownerNotice = (await center(owner.id)).list[0].notice!
  // Late transaction failure must roll back review, instance and notice closure.
  const state = await get(), fakeEvent = randomUUID()
  await db.insert(events).values({ id: fakeEvent, projectId, actorId: owner.id, commandId: randomUUID(), action: 'save_plan', version: state.instance!.version + 1, reason: '隔离后段故障', snapshot: {} })
  const noticesBefore = await db.select().from(notices).where(eq(notices.reviewId, review.id)).orderBy(asc(notices.id))
  await assert.rejects(decide(owner.id, 'return'))
  assert.deepEqual(await db.select().from(notices).where(eq(notices.reviewId, review.id)).orderBy(asc(notices.id)), noticesBefore)
  assert.equal((await get()).instance!.version, state.instance!.version)
  await db.delete(events).where(eq(events.id, fakeEvent))
  await decide(owner.id, 'return')
  assert.equal((await center(owner.id)).total, 0); assert.equal((await center(owner.id, 'completed')).total, 1)
  await denied(readTypeApprovalNotice(ownerNotice.id, owner.id), 'TYPE_NOTICE_FORBIDDEN')
  const originalReview = review.id
  await command(secretary.id, 'submit_plan'); review = (await get()).reviews[0]
  assert.notEqual(review.id, originalReview); assert.equal((await center(a.id)).total, 1)
  assert.notEqual((await center(a.id)).list[0].notice!.id, aNotice.id)
  checks.push('node-advance-return-new-review:late-failure-rolls-back-notices:closed-notice-cannot-reopen')
  // Query-only evidence attachment exercises the exact normalized ACL boundary;
  // it is not a claim that this synthetic plan produced stage material itself.
  const fileId = randomUUID(), bytes = Buffer.from('隔离统一审批文件权限'), sha256 = createHash('sha256').update(bytes).digest('hex')
  const storagePath = await saveProjectFile(projectId, fileId, bytes), fileVersionId = randomUUID()
  await db.insert(projectFiles).values({ id: fileId, projectId, name: '审批权限原件.txt', type: 'TXT', category: '项目资料', uploader: secretary.name, uploadedBy: secretary.id, storagePath, byteSize: bytes.length, sha256, accessMode: 'explicit' })
  await db.insert(projectFileVersions).values({ id: fileVersionId, fileId, version: 1, storagePath, byteSize: bytes.length, sha256, createdBy: secretary.id })
  await db.insert(refs).values({ reviewId: review.id, fileId, fileVersionId })
  assert.equal((await center(a.id)).total, 0); assert.equal((await center(a.id)).kinds.includes('非投资计划审核'), true) // previous readable review still contributes kind
  await denied(get(a.id, { review: review.id }), 'TYPE_RUNTIME_REVIEW_NOT_FOUND')
  await db.insert(projectFileGrants).values({ fileId, userId: a.id, canView: true, canDownload: false, grantedBy: secretary.id })
  assert.equal((await center(a.id)).total, 1); assert.equal((await get(a.id, { review: review.id })).reviews.some(r => r.id === review.id), true)
  await db.update(projectFiles).set({ lifecycle: 'deleted', deletedBy: secretary.id, deletedAt: new Date(), deleteReason: '隔离文件回收权限验证', retentionUntil: new Date(Date.now() + 86400000) }).where(eq(projectFiles.id, fileId))
  assert.equal((await center(a.id)).total, 0)
  await db.update(projectFiles).set({ lifecycle: 'active', accessMode: 'project', deletedBy: null, deletedAt: null, deleteReason: null, retentionUntil: null }).where(eq(projectFiles.id, fileId))
  checks.push('file-ACL-and-trash-filter-before-count-pagination:deep-link-cannot-open-inaccessible-review')
  await decide(secretary.id, 'withdraw')
  assert.equal((await center(a.id)).total, 0)
  // Real submit/withdraw revisions build more than one history page.
  for (let i = 0; i < 21; i++) { await command(secretary.id, 'submit_plan'); await decide(secretary.id, 'withdraw') }
  const historic = await get(a.id, { review: originalReview })
  assert.equal(historic.page, 2); assert.ok(historic.reviews.some(r => r.id === originalReview))
  await denied(get(a.id, { review: randomUUID() }), 'TYPE_RUNTIME_REVIEW_NOT_FOUND')
  checks.push('withdraw-keeps-history:exact-old-review-location-beyond-page-one:no-cross-project-target')
  const leaderRoleId = (await db.select().from(userRoles).where(eq(userRoles.userId, a.id)))[0].roleId
  const legacy = await seedApprovalCenterFixture(secretary, a, leaderRoleId)
  const all = await listApprovalCenter(a.id, { view: 'completed', pageSize: 100 }), first = await listApprovalCenter(a.id, { view: 'completed', pageSize: 5 }), second = await listApprovalCenter(a.id, { view: 'completed', pageSize: 5, page: 2 })
  assert.ok(all.list.some(r => r.businessType === 'type_execution')); assert.ok(all.list.some(r => r.businessType === 'office'))
  assert.deepEqual([...first.list, ...second.list].map(r => r.id), all.list.slice(0, 10).map(r => r.id))
  assert.equal(first.total, all.total); assert.equal(first.counts.completed, first.total)
  const onlyTypes = await center(a.id, 'completed', { kind: '非投资计划审核', pageSize: 100 })
  assert.equal(onlyTypes.total, 23); assert.ok(onlyTypes.list.every(r => r.businessType === 'type_execution'))
  assert.equal((await listApprovalCenter(a.id, { view: 'completed', kind: '非投资计划审核' }, 'office')).total, 0)
  assert.equal((await listApprovalCenter(a.id, { view: 'completed', q: `${projectName}%_` })).total, 0)
  assert.equal((await listApprovalCenter(a.id, { view: 'completed', q: legacy.marker })).list.some(r => r.businessType === 'type_execution'), false)
  checks.push('SQL-union-global-stable-pagination-counts-search-kinds:office-only-scope-retained:no-client-page-merge')
  await db.delete(projectDutyAssignments).where(and(eq(projectDutyAssignments.projectId, projectId), eq(projectDutyAssignments.userId, secretary.id)))
  await db.delete(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, secretary.id)))
  assert.equal((await center(secretary.id, 'mine')).total, 0)
  assert.equal((await center(secretary.id, 'completed')).total, 0)
  assert.equal((await db.select().from(notices).innerJoin(reviews, eq(reviews.id, notices.reviewId)).where(and(eq(reviews.projectId, projectId), isNull(notices.closedAt)))).length, 0)
  await db.update(fdeWorkflowPolicies).set({ enabled: false }).where(eq(fdeWorkflowPolicies.id, created.policyId))
  checks.push('revoked-applicant-loses-history-body:all-terminal-notices-closed:formal-policy-never-enabled')
  console.log(JSON.stringify({ ok: true, passed: checks.length, checks, scope: 'type-approval-center-isolated-not-full-UAT' }))
} finally { await pool.end() }
