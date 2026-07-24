import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { meetings, todos, auditLogs } from '../db/schema.js'

export async function listMeetings(projectId?: string) {
  const where = projectId ? eq(meetings.projectId, projectId) : undefined
  return db.select().from(meetings).where(where as never).orderBy(desc(meetings.startedAt)).limit(50)
}

export async function getMeeting(id: string) {
  const rows = await db.select().from(meetings).where(eq(meetings.id, id)).limit(1)
  return rows[0]
}


// 会议纪要自动汇入统一知识库 scope=project(仅当挂了项目)
async function ingestMeeting(row: typeof meetings.$inferSelect) {
  try {
    if (!row.projectId) return
    const { ingestToKnowledge } = await import('./ragService.js')
    const parts = [
      `会议：${row.title}(${row.type})`,
      row.host ? `主持：${row.host}` : '',
      Array.isArray(row.attendees) && row.attendees.length ? `参会：${(row.attendees as string[]).join('、')}` : '',
      row.aiSummary ? `纪要摘要：${row.aiSummary}` : '',
      Array.isArray(row.conclusions) && row.conclusions.length ? `结论：${(row.conclusions as string[]).join('；')}` : '',
      row.rawTranscript ? `转录：${row.rawTranscript}` : '',
    ].filter(Boolean).join('\n')
    await ingestToKnowledge({ scope: 'project', refId: row.projectId, sourceType: 'meeting', sourceId: row.id, sourceName: row.title, text: parts })
  } catch { /* 不阻断 */ }
}

export async function createMeeting(input: typeof meetings.$inferInsert, newTodos: (typeof todos.$inferInsert)[], userId: string) {
  const [row] = await db.insert(meetings).values({ ...input, createdBy: userId }).returning()
  if (newTodos?.length) {
    await db.insert(todos).values(newTodos.map((t) => ({ ...t, createdBy: userId })))
  }
  await db.insert(auditLogs).values({ userId, userName: '（系统）', module: '会议纪要', action: '新建并生成纪要', target: row.title })
  void ingestMeeting(row)
  return row
}

export async function updateMeeting(id: string, patch: Partial<typeof meetings.$inferInsert>) {
  const [row] = await db.update(meetings).set(patch).where(eq(meetings.id, id)).returning()
  if (row) void ingestMeeting(row)
  return row
}

export async function listTodos(owner?: string, projectId?: string) {
  const conds = []
  if (owner) conds.push(eq(todos.owner, owner))
  if (projectId) conds.push(eq(todos.projectId, projectId))
  const where = conds.length ? and(...conds) : undefined
  return db.select().from(todos).where(where as never).orderBy(desc(todos.createdAt)).limit(100)
}

export async function createTodo(input: typeof todos.$inferInsert, userId: string) {
  const [row] = await db.insert(todos).values({ ...input, createdBy: userId }).returning()
  if (row) await db.insert(auditLogs).values({ userId, userName: '（系统）', module: '待办管理', action: '创建待办', target: row.title })
  return row
}

export async function updateTodo(id: string, patch: Partial<typeof todos.$inferInsert>) {
  const [row] = await db.update(todos).set(patch).where(eq(todos.id, id)).returning()
  return row
}

export async function deleteTodo(id: string) {
  const [row] = await db.delete(todos).where(eq(todos.id, id)).returning()
  return row
}

export async function todoCounts() {
  const rows = await db.select({
    status: todos.status,
    c: sql<number>`count(*)::int`,
  }).from(todos).groupBy(todos.status)
  const map: Record<string, number> = {}
  for (const r of rows) map[r.status] = r.c
  return map
}
