import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { risks, auditLogs, projects } from '../db/schema.js'
import {
  isSystemAdmin,
  projectAccessCondition,
  type ProjectAccessActor,
} from './projectAccessService.js'
import { syncRiskAssigneeIdentity } from './identityResolutionService.js'
import { formatShanghaiDateKey } from '../utils/shanghaiTime.js'
import { businessVersionConflict } from './businessOptimisticLock.js'

function isGlobalRiskViewer(actor: ProjectAccessActor) {
  return isSystemAdmin(actor) || ['风控与法务', '风控法务', '风险控制'].includes(actor.role)
}

function riskAccessCondition(actor: ProjectAccessActor) {
  const accessibleProjectIds = db.select({ id: projects.id }).from(projects)
    .where(projectAccessCondition(actor))
  const globalConditions = [eq(risks.createdBy, actor.uid), eq(risks.assigneeUserId, actor.uid)]
  if (isGlobalRiskViewer(actor)) globalConditions.push(sql<boolean>`TRUE`)
  return or(
    inArray(risks.projectId, accessibleProjectIds),
    and(isNull(risks.projectId), or(...globalConditions)),
  )!
}

export async function listRisks(projectId?: string, status?: string, actor?: ProjectAccessActor) {
  const conds = []
  if (projectId) conds.push(eq(risks.projectId, projectId))
  if (status) conds.push(eq(risks.status, status))
  if (actor) conds.push(riskAccessCondition(actor))
  const where = conds.length ? and(...conds) : undefined
  return db.select().from(risks).where(where as never).orderBy(desc(risks.detectedAt)).limit(100)
}

export async function getRisk(id: string, actor?: ProjectAccessActor) {
  const where = actor
    ? and(eq(risks.id, id), riskAccessCondition(actor))
    : eq(risks.id, id)
  const [row] = await db.select().from(risks).where(where).limit(1)
  return row
}

export type PublicRisk = {
  id: string
  projectId: string
  projectName: string
  type: string
  level: '高' | '中' | '低'
  description: string
  status: '待确认' | '处理中' | '已关闭' | '误报'
  owner: string
  occurredAt: string
  version: number
}

const publicStatus = (status: string): PublicRisk['status'] => ({
  待处置: '待确认',
  处置中: '处理中',
  已解除: '已关闭',
  已忽略: '误报',
  待确认: '待确认',
  处理中: '处理中',
  已关闭: '已关闭',
  误报: '误报',
}[status] as PublicRisk['status'] | undefined) ?? '待确认'

export function presentRisk(row: typeof risks.$inferSelect): PublicRisk {
  return {
    id: row.id,
    projectId: row.projectId ?? '',
    projectName: row.projectName,
    type: row.type,
    level: ['高', '中', '低'].includes(row.level) ? row.level as PublicRisk['level'] : '中',
    description: row.description ?? row.title,
    status: publicStatus(row.status),
    owner: row.assignee ?? '',
    occurredAt: formatShanghaiDateKey(row.detectedAt),
    version: row.version,
  }
}

export function presentRisks(rows: (typeof risks.$inferSelect)[]) {
  return rows.map(presentRisk)
}

export async function createRisk(input: typeof risks.$inferInsert, userId: string, userName = '（系统）') {
  const insertedId = await db.transaction(async (tx) => {
    const [inserted] = await tx.insert(risks).values({ ...input, createdBy: userId }).$returningId()
    await tx.insert(auditLogs).values({
      userId,
      userName,
      module: '风险预警',
      action: '新增风险',
      target: `${input.projectName}：${input.type}`,
    })
    return inserted.id
  })
  let [row] = await db.select().from(risks).where(eq(risks.id, insertedId)).limit(1)
  await syncRiskAssigneeIdentity(row.id, row.assignee)
  ;[row] = await db.select().from(risks).where(eq(risks.id, insertedId)).limit(1)
  return row
}

export async function updateRisk(
  id: string,
  patch: Partial<typeof risks.$inferInsert>,
  userId: string,
  userName = '（系统）',
  expectedVersion?: number,
) {
  const { id: _id, createdBy: _createdBy, assigneeUserId: _assigneeUserId, version: _version, ...safePatch } = patch
  await db.transaction(async (tx) => {
    const condition = expectedVersion === undefined
      ? eq(risks.id, id)
      : and(eq(risks.id, id), eq(risks.version, expectedVersion))
    const [result] = await tx.update(risks).set({
      ...safePatch,
      version: sql`${risks.version} + 1`,
    }).where(condition)
    if (expectedVersion !== undefined && result.affectedRows !== 1) throw businessVersionConflict('风险')
    const [updated] = await tx.select({ projectName: risks.projectName }).from(risks).where(eq(risks.id, id)).limit(1)
    if (updated) await tx.insert(auditLogs).values({
      userId,
      userName,
      module: '风险预警',
      action: '更新风险状态',
      target: updated.projectName,
    })
  })
  let [row] = await db.select().from(risks).where(eq(risks.id, id)).limit(1)
  if (row) {
    await syncRiskAssigneeIdentity(row.id, row.assignee)
    ;[row] = await db.select().from(risks).where(eq(risks.id, id)).limit(1)
  }
  return row
}

export async function riskCounts(actor?: ProjectAccessActor) {
  const rows = await db.select({
    status: risks.status,
    level: risks.level,
    c: sql<number>`count(*)`,
  }).from(risks).where(actor ? riskAccessCondition(actor) : undefined).groupBy(risks.status, risks.level)
  return rows
}
