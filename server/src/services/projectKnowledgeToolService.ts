import { and, asc, desc, eq, ne, notInArray, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  aiSummaries,
  fileChunks,
  meetings,
  projectFiles,
  risks,
  todos,
} from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'
import { retrieveKnowledge } from './ragService.js'
import { getAccessibleProject } from './projectAccessService.js'
import { directiveTaskAccessCondition } from './fdeDirectiveLinksService.js'
import { canReadAllProjectFiles, projectFileAccessCondition, requireProjectFileAccess } from './projectFileAccessService.js'
import { readableStoredText } from './textQualityService.js'

function toolError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code })
}

async function assertEnabledUser(userId: string) {
  const user = await identityRepositories.users.findById(userId)
  if (!user || user.status !== '启用') {
    throw toolError(403, 'USER_DISABLED_OR_MISSING', '当前用户不存在或已禁用')
  }
}

async function assertProjectToolAccess(userId: string, projectId: string) {
  await assertEnabledUser(userId)
  const project = await getAccessibleProject(userId, projectId)
  if (!project) throw toolError(403, 'PROJECT_FORBIDDEN', '无权访问该项目资料')
  return project
}

function permission(scope: 'project' | 'org', projectId: string | null) {
  return { granted: true, checkedBy: 'server-stable-identity', scope, projectId }
}

function countValue(value: unknown): number {
  const parsed = Number(value || 0)
  return Number.isFinite(parsed) ? parsed : 0
}

export async function getProjectSummaryForUser(input: { userId: string; projectId: string }) {
  const project = await assertProjectToolAccess(input.userId, input.projectId)
  const [latestSummaries, fileRows, meetingRows, todoRows, riskRows] = await Promise.all([
    db.select().from(aiSummaries).where(eq(aiSummaries.projectId, input.projectId))
      .orderBy(desc(aiSummaries.updatedAt)).limit(1),
    db.select({
      total: sql<number>`COUNT(*)`,
      parsed: sql<number>`SUM(CASE WHEN ${projectFiles.parseStatus} = '成功' THEN 1 ELSE 0 END)`,
      withOriginal: sql<number>`SUM(CASE WHEN ${projectFiles.storagePath} IS NOT NULL THEN 1 ELSE 0 END)`,
    }).from(projectFiles).where(and(eq(projectFiles.projectId, input.projectId), projectFileAccessCondition(input.userId))),
    db.select({ total: sql<number>`COUNT(*)` }).from(meetings)
      .where(and(eq(meetings.projectId, input.projectId), or(
        and(eq(meetings.workflowKind, 'legacy'), notInArray(meetings.workflowStatus, ['cancelled', 'deleted'])),
        and(ne(meetings.workflowKind, 'legacy'), eq(meetings.workflowStatus, 'completed')),
      ))),
    db.select({
      total: sql<number>`COUNT(*)`,
      open: sql<number>`SUM(CASE WHEN ${todos.status} NOT IN ('已完成', '已取消', '已归档', '已关闭') THEN 1 ELSE 0 END)`,
    }).from(todos).where(and(eq(todos.projectId, input.projectId), directiveTaskAccessCondition(input.userId))),
    db.select({
      total: sql<number>`COUNT(*)`,
      open: sql<number>`SUM(CASE WHEN ${risks.status} NOT IN ('已解除', '已忽略') THEN 1 ELSE 0 END)`,
      openHigh: sql<number>`SUM(CASE WHEN ${risks.status} NOT IN ('已解除', '已忽略') AND ${risks.level} = '高' THEN 1 ELSE 0 END)`,
    }).from(risks).where(eq(risks.projectId, input.projectId)),
  ])
  const latestSummary = await canReadAllProjectFiles(db, input.projectId, input.userId) ? latestSummaries[0] ?? null : null
  const sources = [
    {
      citationId: 'S1', projectId: input.projectId, sourceId: project.id,
      sourceType: 'project_record', sourceName: project.name, locator: '项目主记录',
      updatedAt: project.updatedAt,
    },
    ...(latestSummary ? [{
      citationId: 'S2', projectId: input.projectId, sourceId: latestSummary.id,
      sourceType: 'project_ai_summary', sourceName: `${project.name} AI 摘要`, locator: '最新 AI 摘要记录',
      updatedAt: latestSummary.updatedAt,
    }] : []),
    {
      citationId: latestSummary ? 'S3' : 'S2', projectId: input.projectId, sourceId: project.id,
      sourceType: 'project_activity_stats', sourceName: `${project.name} 关联记录`,
      locator: '文件、会议、待办和风险实时统计', updatedAt: new Date(),
    },
  ]
  return {
    permission: permission('project', input.projectId),
    projectId: input.projectId,
    project: {
      id: project.id,
      name: project.name,
      companyName: project.companyName,
      industry: project.industry,
      round: project.round,
      stage: project.stage,
      owner: project.owner,
      source: project.source,
      financing: project.financing,
      valuation: project.valuation,
      riskLevel: project.riskLevel,
      score: project.score,
      progress: project.progress,
      summary: project.summary,
      businessModel: project.businessModel,
      market: project.market,
      team: project.team,
      tags: project.tags,
      updatedAt: project.updatedAt,
    },
    aiSummary: latestSummary ? {
      positioning: latestSummary.positioning,
      highlights: latestSummary.highlights,
      risks: latestSummary.risks,
      questions: latestSummary.questions,
      missing: latestSummary.missing,
      confidence: latestSummary.confidence,
      sources: latestSummary.sources,
      updatedAt: latestSummary.updatedAt,
    } : null,
    activity: {
      files: {
        total: countValue(fileRows[0]?.total),
        parsed: countValue(fileRows[0]?.parsed),
        withOriginal: countValue(fileRows[0]?.withOriginal),
      },
      meetings: { total: countValue(meetingRows[0]?.total) },
      todos: { total: countValue(todoRows[0]?.total), open: countValue(todoRows[0]?.open) },
      risks: {
        total: countValue(riskRows[0]?.total),
        open: countValue(riskRows[0]?.open),
        openHigh: countValue(riskRows[0]?.openHigh),
      },
    },
    sources,
  }
}

export async function searchProjectDocsForUser(input: {
  userId: string
  projectId: string | null
  query: string
  compareLeadPool?: boolean
  topK?: number
}) {
  const scope = input.projectId ? 'project' as const : 'org' as const
  if (input.projectId) await assertProjectToolAccess(input.userId, input.projectId)
  else await assertEnabledUser(input.userId)
  const topK = Math.max(1, Math.min(20, input.topK || 6))
  const chunks = await retrieveKnowledge(scope, input.projectId || undefined, input.query, topK, input.userId)
  const leadChunks = input.compareLeadPool
    ? await retrieveKnowledge('lead', undefined, input.query, Math.min(10, topK))
    : []
  const evidence = [...chunks.map((chunk) => ({ scope, chunk })), ...leadChunks.map((chunk) => ({ scope: 'lead' as const, chunk }))]
    .map(({ scope: evidenceScope, chunk }, index) => ({
      citationId: `${evidenceScope === 'lead' ? 'L' : evidenceScope === 'org' ? 'O' : 'P'}${index + 1}`,
      scope: evidenceScope,
      projectId: evidenceScope === 'project' ? input.projectId : null,
      refId: chunk.refId,
      sourceId: chunk.sourceId,
      sourceType: chunk.sourceType,
      fileName: chunk.fileName,
      chunkIndex: chunk.chunkIndex,
      locator: `知识片段 ${chunk.chunkIndex + 1}`,
      content: chunk.content,
      score: chunk.score,
    }))
  const sourceMap = new Map<string, {
    scope: string; projectId: string | null; refId: string; sourceId: string | null; sourceType: string; fileName: string; locators: string[];
  }>()
  for (const item of evidence) {
    const key = `${item.scope}\u0000${item.refId}\u0000${item.sourceId || ''}\u0000${item.fileName}`
    const source = sourceMap.get(key) || {
      scope: item.scope, projectId: item.projectId, refId: item.refId, sourceId: item.sourceId,
      sourceType: item.sourceType, fileName: item.fileName, locators: [],
    }
    if (!source.locators.includes(item.locator)) source.locators.push(item.locator)
    sourceMap.set(key, source)
  }
  return {
    permission: permission(scope, input.projectId), projectId: input.projectId, query: input.query,
    hasEvidence: evidence.length > 0, sources: [...sourceMap.values()], evidence,
  }
}

export async function listProjectFilesForUser(input: { userId: string; projectId: string }) {
  await assertProjectToolAccess(input.userId, input.projectId)
  const rows = await db.select({
    id: projectFiles.id, name: projectFiles.name, type: projectFiles.type, category: projectFiles.category,
    size: projectFiles.size, byteSize: projectFiles.byteSize, sha256: projectFiles.sha256,
    version: projectFiles.version, parseStatus: projectFiles.parseStatus, visibility: projectFiles.visibility,
    storagePath: projectFiles.storagePath, uploadedAt: projectFiles.uploadedAt,
  }).from(projectFiles).where(and(eq(projectFiles.projectId, input.projectId), projectFileAccessCondition(input.userId))).orderBy(asc(projectFiles.name))
  return {
    permission: permission('project', input.projectId), projectId: input.projectId,
    files: rows.map(({ storagePath, ...row }) => ({ ...row, hasOriginal: Boolean(storagePath) })),
  }
}

export async function readProjectFileForUser(input: {
  userId: string
  projectId: string
  fileId: string
  maxChunks?: number
  maxCharsPerChunk?: number
}) {
  await assertProjectToolAccess(input.userId, input.projectId)
  const [file] = await db.select().from(projectFiles)
    .where(and(eq(projectFiles.id, input.fileId), eq(projectFiles.projectId, input.projectId))).limit(1)
  if (!file) throw toolError(404, 'PROJECT_FILE_NOT_FOUND', '当前项目中不存在该文件')
  await requireProjectFileAccess(db, file.id, input.userId, 'view')
  const maxChunks = Math.max(1, Math.min(20, input.maxChunks || 10))
  const maxChars = Math.max(200, Math.min(8_000, input.maxCharsPerChunk || 4_000))
  const rows = await db.select({ chunkIndex: fileChunks.chunkIndex, content: fileChunks.content })
    .from(fileChunks).where(and(eq(fileChunks.fileId, file.id), eq(fileChunks.projectId, input.projectId)))
    .orderBy(asc(fileChunks.chunkIndex)).limit(maxChunks)
  const selected = rows.length ? rows : file.contentText
    ? [{ chunkIndex: 0, content: file.contentText }]
    : []
  return {
    permission: permission('project', input.projectId), projectId: input.projectId,
    file: {
      id: file.id, name: file.name, type: file.type, category: file.category, byteSize: file.byteSize,
      sha256: file.sha256, version: file.version, parseStatus: file.parseStatus,
      hasOriginal: Boolean(file.storagePath), totalChunksReturned: selected.length,
    },
    evidence: selected.map((chunk) => ({ ...chunk, content: readableStoredText(chunk.content) }))
      .filter((chunk) => Boolean(chunk.content))
      .map((chunk, index) => ({
        citationId: `F${index + 1}`, projectId: input.projectId, sourceId: file.id,
        sourceType: 'project_file', fileName: file.name, chunkIndex: chunk.chunkIndex,
        locator: `文件片段 ${chunk.chunkIndex + 1}`, content: chunk.content.slice(0, maxChars),
        truncated: chunk.content.length > maxChars,
      })),
  }
}
