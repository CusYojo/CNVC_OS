import { and, desc, eq, ilike, or, sql } from 'drizzle-orm'
import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { db } from '../db/client.js'
import { projects, projectFiles, auditLogs, knowledgeChunks, fileChunks } from '../db/schema.js'
import { sanitizeScoringCompetitors } from './competitorEvidence.js'

const STAGES = ['线索', '初筛', '立项', '尽调', '上会', '投决', '投后', '退出'] as const
const ARTIFACT_ROOT = path.resolve(
  process.env.AI_ARTIFACT_ROOT || path.join(process.cwd(), 'server', 'ai-artifacts'),
)

async function deleteProjectArtifactDirectories(projectId: string) {
  const userDirectories = await readdir(ARTIFACT_ROOT, { withFileTypes: true }).catch(() => [])
  await Promise.all(userDirectories
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const projectDirectory = path.resolve(ARTIFACT_ROOT, entry.name, projectId)
      if (!projectDirectory.startsWith(`${ARTIFACT_ROOT}${path.sep}`)) return
      await rm(projectDirectory, { recursive: true, force: true })
    }))
}

interface ListArgs {
  keyword?: string
  stage?: string
  owner?: string
  page: number
  pageSize: number
}

function publicProject<T extends { scoring?: unknown }>(row: T): T {
  return row.scoring
    ? { ...row, scoring: sanitizeScoringCompetitors(row.scoring) }
    : row
}

export async function listProjects(args: ListArgs) {
  const conds = []
  if (args.keyword) {
    conds.push(or(
      ilike(projects.name, `%${args.keyword}%`),
      ilike(projects.companyName, `%${args.keyword}%`),
      ilike(projects.industry, `%${args.keyword}%`),
    ))
  }
  if (args.stage) conds.push(eq(projects.stage, args.stage))
  if (args.owner) conds.push(eq(projects.owner, args.owner))
  const where = conds.length ? and(...conds) : undefined
  const rows = await db.select().from(projects).where(where as never).orderBy(desc(projects.pinned), desc(projects.updatedAt))
    .limit(args.pageSize).offset((args.page - 1) * args.pageSize)
  const totalRows = await db.select({ c: sql<number>`count(*)::int` }).from(projects).where(where as never)
  return { list: rows.map(publicProject), total: totalRows[0]?.c ?? rows.length, page: args.page, pageSize: args.pageSize }
}

export async function getProject(id: string) {
  const rows = await db.select().from(projects).where(eq(projects.id, id)).limit(1)
  return rows[0] ? publicProject(rows[0]) : undefined
}

export async function listFiles(projectId: string) {
  return db.select().from(projectFiles).where(eq(projectFiles.projectId, projectId)).orderBy(desc(projectFiles.uploadedAt))
}

export async function listAllFiles() {
  return db.select().from(projectFiles).orderBy(desc(projectFiles.uploadedAt)).limit(500)
}

export async function createProject(input: Partial<typeof projects.$inferInsert>, userId: string) {
  const stage = input.stage ?? '线索'
  const progress = stage === '线索' ? 12 : 25
  const [row] = await db.insert(projects).values({
    ...input,
    stage: stage as string,
    progress,
    stageSource: (input.stageSource as string | undefined) ?? '系统初始化',
    createdBy: userId,
  } as typeof projects.$inferInsert).returning()
  await db.insert(auditLogs).values({ userId, userName: '（系统）', module: '项目管理', action: '创建项目', target: row.name })
  return row
}

export async function updateProject(id: string, patch: Partial<typeof projects.$inferInsert>, userId: string) {
  const [row] = await db.update(projects).set({ ...patch, updatedAt: new Date() }).where(eq(projects.id, id)).returning()
  if (row) await db.insert(auditLogs).values({ userId, userName: '（系统）', module: '项目管理', action: '编辑项目', target: row.name })
  return row
}

export async function moveProjectStage(id: string, nextStage: string, userId: string) {
  // 推进 progress（与前端规则一致）
  const idx = STAGES.indexOf(nextStage as typeof STAGES[number])
  const progress = nextStage === '放弃' ? undefined : Math.min(100, Math.max(0, (idx + 1) * 13))
  const [row] = await db.update(projects).set({ stage: nextStage, stageSource: 'OA审批', progress: progress as number | undefined, updatedAt: new Date() })
    .where(eq(projects.id, id)).returning()
  if (row) await db.insert(auditLogs).values({ userId, userName: '（系统）', module: 'OA 流程', action: '阶段流转', target: `${row.name} -> ${nextStage}` })
  return row
}

export async function addFile(input: typeof projectFiles.$inferInsert, userId: string) {
  const [row] = await db.insert(projectFiles).values(input).returning()
  if (row) await db.insert(auditLogs).values({ userId, userName: '（系统）', module: '资料库', action: '上传文件', target: row.name })
  return row
}

export async function finishFileParse(fileId: string) {
  const [row] = await db.update(projectFiles).set({ parseStatus: '成功' }).where(eq(projectFiles.id, fileId)).returning()
  return row
}


// 删除项目：连带删知识库(scope=project 的 knowledge_chunks;file_chunks/meetings 等由FK级联或set null)
export async function deleteProject(id: string, userId: string) {
  const [proj] = await db.select().from(projects).where(eq(projects.id, id))
  if (!proj) return null
  // 显式删统一知识库(无FK,不会自动级联)
  await db.delete(knowledgeChunks).where(and(eq(knowledgeChunks.scope, 'project'), eq(knowledgeChunks.refId, id)))
  // 删项目(file_chunks/project_files 由 onDelete cascade/set null 处理)
  await db.delete(projects).where(eq(projects.id, id))
  await db.insert(auditLogs).values({ userId, userName: '（系统）', module: '我的专属项目', action: '删除项目(连带知识库)', target: proj.name })
  await deleteProjectArtifactDirectories(id).catch((error) => {
    console.warn(`[projects] 清理项目产物目录失败：${id}`, error)
  })
  return proj
}

// 置顶/取消置顶
export async function pinProject(id: string, pinned: boolean, userId: string) {
  const [row] = await db.update(projects).set({ pinned, updatedAt: new Date() }).where(eq(projects.id, id)).returning()
  if (row) await db.insert(auditLogs).values({ userId, userName: '（系统）', module: '我的专属项目', action: pinned ? '置顶项目' : '取消置顶', target: row.name })
  return row
}


// 保存项目评分(复用线索池同款结构)+score同步
export async function saveProjectScoring(id: string, scoring: unknown, score: number) {
  const [row] = await db.update(projects).set({ scoring: scoring as never, score, updatedAt: new Date() }).where(eq(projects.id, id)).returning()
  return row
}


// 删除单个文件：连带删该文件的 RAG 块(file_chunks + knowledge_chunks by source_id)
export async function deleteFile(fileId: string) {
  const [f] = await db.select().from(projectFiles).where(eq(projectFiles.id, fileId))
  if (!f) return false
  await db.delete(fileChunks).where(eq(fileChunks.fileId, fileId))
  await db.delete(knowledgeChunks).where(eq(knowledgeChunks.sourceId, fileId))
  await db.delete(projectFiles).where(eq(projectFiles.id, fileId))
  return true
}
