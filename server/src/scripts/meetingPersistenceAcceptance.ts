import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { and, count, eq, inArray } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { ensureSchema } from '../db/migrate.js'
import {
  auditLogs,
  identityResolutionIssues,
  meetingParticipants,
  meetings,
  todos,
  users,
} from '../db/schema.js'
import {
  createMeeting,
  listMeetings,
  presentMeeting,
  presentMeetings,
} from '../services/meetingService.js'

const checks: string[] = []
function check(name: string, assertion: () => void) {
  assertion()
  checks.push(name)
}

await ensureSchema()
const marker = randomUUID().slice(0, 8)
const userId = randomUUID()
const userName = `会议验收用户-${marker}`
const title = `会议持久化验收-${marker}`
const rollbackTitle = `会议事务回滚验收-${marker}`
const meetingIds: string[] = []

try {
  await db.insert(users).values({
    id: userId,
    email: `meeting-${marker}@example.invalid`,
    name: userName,
    role: '投资经理',
    department: '会议验收',
    passwordHash: 'meeting-acceptance-not-for-login',
  })

  const created = await createMeeting({
    projectId: null,
    projectName: '全局会议',
    title,
    type: '项目沟通会',
    host: userName,
    attendees: [userName],
    rawTranscript: '这是来自验收脚本的真实输入文本。',
    aiSummary: '验收摘要',
    conclusions: ['验收结论'],
    startedAt: new Date('2026-08-09T10:30:00+08:00'),
  }, [
    { title: `会议待办A-${marker}`, owner: userName, dueDate: '2026-08-11', priority: '高', type: '会议' },
    { title: `会议待办B-${marker}`, owner: userName, dueDate: '2026-08-13', priority: '中', type: '会议' },
  ], userId, userName)
  meetingIds.push(created.id)

  const persistedTodos = await db.select().from(todos).where(eq(todos.meetingId, created.id))
  const [participant] = await db.select().from(meetingParticipants)
    .where(eq(meetingParticipants.meetingId, created.id)).limit(1)
  const [audit] = await db.select().from(auditLogs).where(and(
    eq(auditLogs.userId, userId),
    eq(auditLogs.target, title),
  )).limit(1)
  check('meeting-todos-and-actor-audit-persist-together', () => {
    assert.equal(persistedTodos.length, 2)
    assert.ok(persistedTodos.every((todo) => todo.ownerUserId === userId))
    assert.equal(participant?.userId, userId)
    assert.equal(audit?.userName, userName)
  })

  const publicCreated = await presentMeeting(created)
  check('api-contract-maps-mysql-fields-and-linked-todo-count', () => {
    assert.equal(publicCreated.meetingTime, '2026-08-09T02:30:00.000Z')
    assert.deepEqual(publicCreated.participants, [userName])
    assert.equal(publicCreated.rawText, '这是来自验收脚本的真实输入文本。')
    assert.equal(publicCreated.summary, '验收摘要')
    assert.deepEqual(publicCreated.conclusions, ['验收结论'])
    assert.equal(publicCreated.todoCount, 2)
  })

  const refreshed = await presentMeetings(await listMeetings())
  check('refresh-reloads-meeting-and-todo-count-from-mysql', () => {
    const item = refreshed.find((meeting) => meeting.id === created.id)
    assert.equal(item?.todoCount, 2)
    assert.equal(item?.summary, '验收摘要')
  })

  const rollbackError = await createMeeting({
    projectId: null,
    projectName: '全局会议',
    title: rollbackTitle,
    host: userName,
    attendees: [userName],
  }, [
    { title: `回滚前待办-${marker}`, owner: userName },
    { title: null as never, owner: userName },
  ], userId, userName).then(() => null, (error: Error) => error)
  const [{ value: rolledBackMeetings }] = await db.select({ value: count() }).from(meetings)
    .where(eq(meetings.title, rollbackTitle))
  const [{ value: rolledBackTodos }] = await db.select({ value: count() }).from(todos)
    .where(eq(todos.title, `回滚前待办-${marker}`))
  const [{ value: rolledBackAudits }] = await db.select({ value: count() }).from(auditLogs)
    .where(eq(auditLogs.target, rollbackTitle))
  check('meeting-todo-audit-transaction-rolls-back-on-any-write-failure', () => {
    assert.ok(rollbackError)
    assert.equal(Number(rolledBackMeetings), 0)
    assert.equal(Number(rolledBackTodos), 0)
    assert.equal(Number(rolledBackAudits), 0)
  })

  console.log(JSON.stringify({ ok: true, checks }))
} finally {
  await db.delete(auditLogs).where(eq(auditLogs.userId, userId)).catch(() => {})
  await db.delete(todos).where(eq(todos.createdBy, userId)).catch(() => {})
  await db.delete(meetings).where(eq(meetings.createdBy, userId)).catch(() => {})
  if (meetingIds.length) {
    await db.delete(identityResolutionIssues)
      .where(inArray(identityResolutionIssues.entityId, meetingIds)).catch(() => {})
  }
  await db.delete(users).where(eq(users.id, userId)).catch(() => {})
  await pool.end()
}
