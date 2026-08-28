import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { projectDutyAssignments, projectMembers, projectRecordComments, projectRecordEvents, projectRecords, projects, todos, users } from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'
import { createProject, classifyProject, deleteProject } from '../services/projectService.js'
import { proposeFdeGovernance } from '../services/fdeGovernanceService.js'
import { actOnProjectRecord, commentProjectRecord, createProjectRecord, getProjectRecord, listProjectRecords, withdrawProjectRecordComment } from '../services/fdeProjectRecordService.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
const marker = randomUUID().slice(0, 8), checks: string[] = []
const people = ['投资经理', '投资经理', '投资经理', '董事长', '时间协调人', '系统管理员', '投资经理'].map((role, i) => ({ id: randomUUID(), role, name: i === 6 ? `记录-${marker}-2` : `记录-${marker}-${i}`, email: `record-${marker}-${i}@example.invalid`, department: `记录验收-${marker}`, passwordHash: 'not-for-login' }))
const [owner, secretary, member, leader, coordinator, admin, stranger] = people
const code = async (operation: Promise<unknown>, expected: string) => { const error = await operation.then(() => null, cause => cause); assert.equal(error?.code, expected, error?.message ?? 'unexpected success') }
try {
  await db.insert(users).values(people)
  for (const person of people) await identityRepositories.users.synchronizeAdministrationBindings(person.id, person.role, person.department)
  let project = await createProject({ name: `记录项目-${marker}`, owner: owner.name, ownerUserId: owner.id, collaborators: [] }, owner.id)
  project = await classifyProject({ projectId: project.id, userId: owner.id, expectedVersion: project.version, toClassification: 'normal', reason: '记录验收初筛完成' })
  await proposeFdeGovernance({ projectId: project.id, userId: owner.id, ownerUserId: owner.id, expectedVersion: project.governanceVersion, reason: '配置记录项目参与职责', assignments: [{ duty: 'secretary', userId: secretary.id }, { duty: 'member', userId: member.id }, { duty: 'concerned_leader', userId: leader.id }, { duty: 'coordinator', userId: coordinator.id }] })
  const other = await createProject({ name: `其他记录项目-${marker}`, owner: owner.name, ownerUserId: owner.id, collaborators: [] }, owner.id)
  const taskId = randomUUID()
  await db.insert(todos).values({ id: taskId, projectId: project.id, title: '不能被记录评论完成的原任务', owner: member.name, ownerUserId: member.id, createdBy: owner.id, executionModel: 'fde-v1' })
  const baseline = (await db.select().from(projects).where(eq(projects.id, project.id)))[0]
  const payload = { clientRequestId: randomUUID(), kind: '关键判断', title: `独立判断-${marker}`, content: `撤回后不可搜出的正文-${marker}` }
  const { id } = await createProjectRecord(project.id, member.id, payload)
  await assert.rejects(createProjectRecord(project.id, member.id, { ...payload, clientRequestId: randomUUID(), authorId: owner.id, sourceMeetingId: randomUUID() }))
  assert.deepEqual(await createProjectRecord(project.id, member.id, payload), { id })
  await code(createProjectRecord(project.id, member.id, { ...payload, title: '复用请求编号修改' }), 'RECORD_REQUEST_REUSED')
  assert.equal((await db.select().from(projectRecordEvents).where(eq(projectRecordEvents.recordId, id))).length, 1)
  for (const person of [owner, secretary, member, leader]) assert.equal((await getProjectRecord(project.id, id, person.id)).record.content, payload.content)
  for (const person of [stranger, coordinator, admin]) await code(getProjectRecord(project.id, id, person.id), 'RECORD_FORBIDDEN')
  await code(getProjectRecord(other.id, id, owner.id), 'RECORD_NOT_FOUND')
  checks.push('FDE-COLLAB-010/AUTH:stable-identity-same-name-denial-project-scope-create-replay-and-no-source-injection')

  const supplement = { clientRequestId: randomUUID(), expectedVersion: 1, content: `仅在有效评论可搜索-${marker}` }
  await commentProjectRecord(project.id, id, secretary.id, supplement)
  await commentProjectRecord(project.id, id, secretary.id, supplement)
  assert.equal((await getProjectRecord(project.id, id, owner.id)).commentTotal, 1)
  assert.equal((await listProjectRecords(project.id, owner.id, { keyword: supplement.content })).total, 1)
  const commentId = (await getProjectRecord(project.id, id, owner.id)).comments[0].id
  await code(withdrawProjectRecordComment(project.id, id, commentId, member.id, { clientRequestId: randomUUID(), expectedVersion: 2, reason: '不能撤回他人的评论' }), 'RECORD_COMMENT_FORBIDDEN')
  await withdrawProjectRecordComment(project.id, id, commentId, secretary.id, { clientRequestId: randomUUID(), expectedVersion: 2, reason: '补充说明需要修正' })
  assert.equal((await listProjectRecords(project.id, owner.id, { keyword: supplement.content })).total, 0)
  assert.ok(!JSON.stringify(await getProjectRecord(project.id, id, owner.id)).includes(supplement.content))
  assert.equal((await getProjectRecord(project.id, id, owner.id)).record.commentCount, 0)
  assert.equal((await listProjectRecords(project.id, owner.id)).list[0].commentCount, 0)
  assert.equal((await getProjectRecord(project.id, id, owner.id)).commentTotal, 1, '分页总数包括撤回留痕，有效评论数不包括撤回正文')
  assert.equal((await db.select().from(projectRecordComments).where(eq(projectRecordComments.id, commentId)))[0].content, supplement.content)
  checks.push('FDE-COLLAB-010:comment-idempotency-author-only-withdrawal-current-search-and-history-redaction')

  const competitor = { clientRequestId: randomUUID(), expectedVersion: 3, content: '并发补充不能覆盖撤回决定' }
  const withdrawal = { clientRequestId: randomUUID(), expectedVersion: 3, action: 'withdraw', reason: '原判断尚待核实先撤回' }
  const competing = await Promise.allSettled([commentProjectRecord(project.id, id, owner.id, competitor), actOnProjectRecord(project.id, id, member.id, withdrawal)])
  assert.equal(competing.filter(item => item.status === 'fulfilled').length, 1)
  assert.ok(competing.some(item => item.status === 'rejected' && item.reason.code === 'VERSION_CONFLICT'))
  let state = (await getProjectRecord(project.id, id, owner.id)).record
  if (state.status !== 'withdrawn') await actOnProjectRecord(project.id, id, member.id, { ...withdrawal, clientRequestId: randomUUID(), expectedVersion: state.version })
  state = (await getProjectRecord(project.id, id, owner.id)).record
  assert.equal(state.status, 'withdrawn'); assert.equal(state.content, '')
  assert.ok(!JSON.stringify(await getProjectRecord(project.id, id, owner.id)).includes(payload.content))
  assert.equal((await listProjectRecords(project.id, owner.id, { keyword: payload.content })).total, 0)
  assert.equal((await listProjectRecords(project.id, owner.id, { view: 'withdrawn', keyword: payload.content })).total, 0)
  assert.equal((await listProjectRecords(project.id, owner.id, { view: 'withdrawn', keyword: id })).total, 1)
  await code(commentProjectRecord(project.id, id, owner.id, { ...competitor, clientRequestId: randomUUID(), expectedVersion: state.version }), 'RECORD_READONLY')
  checks.push('FDE-CONC-001/COLLAB-010:concurrent-comment-withdraw-one-version-no-resurrection-or-hidden-body-leak')

  const archive = await createProjectRecord(project.id, owner.id, { ...payload, clientRequestId: randomUUID(), title: '已结束讨论归档' })
  await code(actOnProjectRecord(project.id, archive.id, member.id, { clientRequestId: randomUUID(), expectedVersion: 1, action: 'archive', reason: '普通成员不能管理他人记录' }), 'RECORD_MANAGE_FORBIDDEN')
  await actOnProjectRecord(project.id, archive.id, secretary.id, { clientRequestId: randomUUID(), expectedVersion: 1, action: 'archive', reason: '讨论结束移入归档记录' })
  assert.equal((await listProjectRecords(project.id, member.id)).total, 0)
  assert.equal((await listProjectRecords(project.id, member.id, { view: 'archived' })).list[0].content, payload.content)
  await code(commentProjectRecord(project.id, archive.id, member.id, { ...competitor, clientRequestId: randomUUID(), expectedVersion: 2 }), 'RECORD_READONLY')
  await db.delete(projectDutyAssignments).where(and(eq(projectDutyAssignments.projectId, project.id), eq(projectDutyAssignments.userId, member.id)))
  await db.delete(projectMembers).where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, member.id)))
  await code(getProjectRecord(project.id, archive.id, member.id), 'RECORD_FORBIDDEN')
  await code(getProjectRecord(project.id, id, member.id), 'RECORD_FORBIDDEN')
  checks.push('FDE-AUTH-003/COLLAB-010:archive-readonly-and-current-membership-revokes-old-author-and-snapshots')

  const paging = await createProjectRecord(project.id, owner.id, { ...payload, clientRequestId: randomUUID(), title: '分页讨论验收' })
  for (let i = 1; i <= 3; i++) await commentProjectRecord(project.id, paging.id, owner.id, { clientRequestId: randomUUID(), expectedVersion: i, content: `分页评论${i}` })
  const first = await getProjectRecord(project.id, paging.id, owner.id, { pageSize: 2 })
  const second = await getProjectRecord(project.id, paging.id, owner.id, { pageSize: 2, page: 2, historyPage: 2 })
  assert.equal(first.commentTotal, 3); assert.equal(first.historyTotal, 4)
  assert.equal(first.comments.length, 2); assert.equal(second.comments.length, 1)
  assert.equal(new Set([...first.events, ...second.events].map(item => item.id)).size, 4)
  checks.push('FDE-COLLAB-010:bounded-comment-and-event-pages-no-silent-history-truncation')

  await assert.rejects(db.update(projectRecords).set({ status: 'withdrawn', closedBy: owner.id, closedAt: new Date(), closureReason: null }).where(eq(projectRecords.id, paging.id)))
  await code(deleteProject(project.id, owner.id), 'PROJECT_RECORD_HISTORY_PROTECTED')
  assert.deepEqual((await db.select().from(projects).where(eq(projects.id, project.id)))[0], baseline)
  const task = (await db.select().from(todos).where(eq(todos.id, taskId)))[0]
  assert.equal(task.version, 1); assert.equal(task.status, '未开始')
  await db.update(projects).set({ lifecycle: 'closed' }).where(eq(projects.id, project.id))
  await code(createProjectRecord(project.id, owner.id, { ...payload, clientRequestId: randomUUID() }), 'RECORD_PROJECT_CLOSED')
  await actOnProjectRecord(project.id, paging.id, owner.id, { clientRequestId: randomUUID(), expectedVersion: 4, action: 'archive', reason: '项目关闭后保留历史' })
  await db.update(users).set({ status: '禁用' }).where(eq(users.id, secretary.id))
  await code(listProjectRecords(project.id, secretary.id), 'RECORD_ACTOR_UNAVAILABLE')
  checks.push('FDE-LIFE/DATA:sql-closure-constraint-delete-atomic-protection-source-facts-unchanged-and-disabled-actor')
  console.log(JSON.stringify({ ok: true, prefix: process.env.DB_FREFIX, passed: checks.length, checks }))
} finally { await pool.end() }
