import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { risks, auditLogs } from '../db/schema.js'

export async function listRisks(projectId?: string, status?: string) {
  const conds = []
  if (projectId) conds.push(eq(risks.projectId, projectId))
  if (status) conds.push(eq(risks.status, status))
  const where = conds.length ? and(...conds) : undefined
  return db.select().from(risks).where(where as never).orderBy(desc(risks.detectedAt)).limit(100)
}

export async function createRisk(input: typeof risks.$inferInsert, userId: string) {
  const [row] = await db.insert(risks).values(input).returning()
  if (row) await db.insert(auditLogs).values({ userId, userName: '（系统）', module: '风险预警', action: '新增风险', target: `${row.projectName}：${row.type}` })
  return row
}

export async function updateRisk(id: string, patch: Partial<typeof risks.$inferInsert>, userId: string) {
  const [row] = await db.update(risks).set(patch).where(eq(risks.id, id)).returning()
  if (row) await db.insert(auditLogs).values({ userId, userName: '（系统）', module: '风险预警', action: '更新风险状态', target: row.projectName })
  return row
}

export async function riskCounts() {
  const rows = await db.select({
    status: risks.status,
    level: risks.level,
    c: sql<number>`count(*)::int`,
  }).from(risks).groupBy(risks.status, risks.level)
  return rows
}
