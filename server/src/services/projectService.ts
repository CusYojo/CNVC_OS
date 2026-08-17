import { and, desc, eq, like, ne, or, sql } from 'drizzle-orm'
import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { db } from '../db/client.js'
import { projects, projectFiles, projectFileVersions, auditLogs, knowledgeChunks, fileChunks } from '../db/schema.js'
import { createMySqlIdentityRepositoryContext, identityRepositories } from '../repositories/index.js'
import { sanitizeScoringCompetitors } from './competitorEvidence.js'
import { removeOwnedProjectFile, removeProjectFileDirectory, removeProjectFileHistory } from './projectFileStorageService.js'
import { getAccessibleProject, projectAccessCondition } from './projectAccessService.js'
import { syncProjectIdentityBindings } from './identityResolutionService.js'
import { businessVersionConflict } from './businessOptimisticLock.js'

const STAGES = ['线索', '初筛', '立项', '尽调', '上会', '投决', '投后', '退出'] as const
const ARTIFACT_ROOT = path.resolve(
  process.env.AI_ARTIFACT_ROOT || path.join(process.cwd(), 'server', 'ai-artifacts'),
)

type ProjectFileTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

function boundedQuota(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name] || fallback)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

export function projectFileQuotaConfig() {
  return {
    maxFilesPerProject: boundedQuota('PROJECT_FILE_MAX_COUNT_PER_PROJECT', 500, 1, 100_000),
    maxBytesPerProject: boundedQuota('PROJECT_FILE_MAX_BYTES_PER_PROJECT', 5 * 1024 ** 3, 1, Number.MAX_SAFE_INTEGER),
    maxBytesPerUser: boundedQuota('PROJECT_FILE_MAX_BYTES_PER_USER', 20 * 1024 ** 3, 1, Number.MAX_SAFE_INTEGER),
  }
}

function projectFileError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code })
}

async function assertProjectFileQuota(
  tx: ProjectFileTransaction,
  input: { projectId: string; userId: string; byteSize: number; countDelta: number; replacedByteSize?: number; previousUploaderId?: string | null },
) {
  const quota = projectFileQuotaConfig()
  const [projectUsage] = await tx.select({
    count: sql<number>`COUNT(*)`, bytes: sql<number>`COALESCE(SUM(${projectFiles.byteSize}), 0)`,
  }).from(projectFiles).where(eq(projectFiles.projectId, input.projectId))
  const nextProjectCount = Number(projectUsage?.count || 0) + input.countDelta
  const nextProjectBytes = Number(projectUsage?.bytes || 0) - Number(input.replacedByteSize || 0) + input.byteSize
  if (nextProjectCount > quota.maxFilesPerProject) {
    throw projectFileError(413, 'PROJECT_FILE_COUNT_LIMIT', `项目文件数量不能超过 ${quota.maxFilesPerProject}`)
  }
  if (nextProjectBytes > quota.maxBytesPerProject) {
    throw projectFileError(413, 'PROJECT_FILE_STORAGE_LIMIT', '项目文件总容量超过配置上限')
  }
  const [userUsage] = await tx.select({
    bytes: sql<number>`COALESCE(SUM(${projectFiles.byteSize}), 0)`,
  }).from(projectFiles).where(eq(projectFiles.uploadedBy, input.userId))
  const currentUserBytes = Number(userUsage?.bytes || 0)
  const ownedPreviousBytes = input.previousUploaderId === input.userId ? Number(input.replacedByteSize || 0) : 0
  if (currentUserBytes - ownedPreviousBytes + input.byteSize > quota.maxBytesPerUser) {
    throw projectFileError(413, 'USER_FILE_STORAGE_LIMIT', '当前用户文件总容量超过配置上限')
  }
}

async function lockProjectFileQuotaScope(tx: ProjectFileTransaction, userId: string, projectId: string) {
  const user = await createMySqlIdentityRepositoryContext(tx).users.lockById(userId)
  if (!user) throw projectFileError(403, 'USER_DISABLED_OR_MISSING', '当前用户不存在')
  await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${projectId} FOR UPDATE`)
}

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

export async function listProjects(args: ListArgs, userId?: string) {
  const conds = []
  if (userId) {
    const user = await identityRepositories.users.findById(userId)
    if (!user || user.status !== '启用') return { list: [], total: 0, page: args.page, pageSize: args.pageSize }
    if (user.role !== '系统管理员') {
      conds.push(projectAccessCondition({ uid: user.id, name: user.name, role: user.role }))
    }
  }
  if (args.keyword) {
    conds.push(or(
      like(projects.name, `%${args.keyword}%`),
      like(projects.companyName, `%${args.keyword}%`),
      like(projects.industry, `%${args.keyword}%`),
    ))
  }
  if (args.stage) conds.push(eq(projects.stage, args.stage))
  if (args.owner) conds.push(eq(projects.owner, args.owner))
  const where = conds.length ? and(...conds) : undefined
  const rows = await db.select().from(projects).where(where as never).orderBy(
    desc(projects.pinned),
    desc(projects.updatedAt),
    desc(projects.id),
  )
    .limit(args.pageSize).offset((args.page - 1) * args.pageSize)
  const totalRows = await db.select({ c: sql<number>`count(*)` }).from(projects).where(where as never)
  return { list: rows.map(publicProject), total: totalRows[0]?.c ?? rows.length, page: args.page, pageSize: args.pageSize }
}

export async function getProject(id: string) {
  const rows = await db.select().from(projects).where(eq(projects.id, id)).limit(1)
  return rows[0] ? publicProject(rows[0]) : undefined
}

export async function listFiles(projectId: string) {
  const rows = await db.select().from(projectFiles).where(eq(projectFiles.projectId, projectId)).orderBy(desc(projectFiles.uploadedAt))
  return rows.map(publicProjectFile)
}

export async function listAllFiles(userId?: string) {
  const rows = await db.select().from(projectFiles).orderBy(desc(projectFiles.uploadedAt)).limit(500)
  if (!userId) return rows.map(publicProjectFile)
  const accessible = await Promise.all(rows.map(async (row) => (
    await getAccessibleProject(userId, row.projectId) ? row : null
  )))
  return accessible.filter((row): row is NonNullable<typeof row> => Boolean(row)).map(publicProjectFile)
}

function publicProjectFile<T extends typeof projectFiles.$inferSelect>(row: T) {
  const { storagePath, ...file } = row
  return { ...file, hasOriginal: Boolean(storagePath) }
}

export async function createProject(input: Partial<typeof projects.$inferInsert>, userId: string) {
  const stage = input.stage ?? '线索'
  const progress = stage === '线索' ? 12 : 25
  const [inserted] = await db.insert(projects).values({
    ...input,
    stage: stage as string,
    progress,
    stageSource: (input.stageSource as string | undefined) ?? '系统初始化',
    createdBy: userId,
  } as typeof projects.$inferInsert).$returningId()
  const [row] = await db.select().from(projects).where(eq(projects.id, inserted.id)).limit(1)
  await syncProjectIdentityBindings(row.id, row.owner, row.collaborators)
  await db.insert(auditLogs).values({ userId, userName: '（系统）', module: '项目管理', action: '创建项目', target: row.name })
  const [boundRow] = await db.select().from(projects).where(eq(projects.id, row.id)).limit(1)
  return boundRow
}

export async function updateProject(
  id: string,
  patch: Partial<typeof projects.$inferInsert>,
  userId: string,
  expectedVersion?: number,
) {
  const { id: _id, createdBy: _createdBy, ownerUserId: _ownerUserId, version: _version, ...safePatch } = patch
  const condition = expectedVersion === undefined
    ? eq(projects.id, id)
    : and(eq(projects.id, id), eq(projects.version, expectedVersion))
  const [result] = await db.update(projects).set({
    ...safePatch,
    version: sql`${projects.version} + 1`,
    updatedAt: new Date(),
  }).where(condition)
  if (expectedVersion !== undefined && result.affectedRows !== 1) throw businessVersionConflict('项目')
  const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1)
  if (row) {
    await syncProjectIdentityBindings(row.id, row.owner, row.collaborators)
    await db.insert(auditLogs).values({ userId, userName: '（系统）', module: '项目管理', action: '编辑项目', target: row.name })
  }
  const [boundRow] = await db.select().from(projects).where(eq(projects.id, id)).limit(1)
  return boundRow
}

export async function moveProjectStage(id: string, nextStage: string, userId: string, expectedVersion?: number) {
  // 推进 progress（与前端规则一致）
  const idx = STAGES.indexOf(nextStage as typeof STAGES[number])
  const progress = nextStage === '放弃' ? undefined : Math.min(100, Math.max(0, (idx + 1) * 13))
  const condition = expectedVersion === undefined
    ? eq(projects.id, id)
    : and(eq(projects.id, id), eq(projects.version, expectedVersion))
  const [result] = await db.update(projects).set({
    stage: nextStage, stageSource: 'OA审批', progress: progress as number | undefined,
    version: sql`${projects.version} + 1`, updatedAt: new Date(),
  }).where(condition)
  if (expectedVersion !== undefined && result.affectedRows !== 1) throw businessVersionConflict('项目')
  const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1)
  if (row) await db.insert(auditLogs).values({ userId, userName: '（系统）', module: 'OA 流程', action: '阶段流转', target: `${row.name} -> ${nextStage}` })
  return row
}

export async function addFile(input: typeof projectFiles.$inferInsert, userId: string) {
  return db.transaction(async (tx) => {
    const byteSize = Number(input.byteSize || 0)
    await lockProjectFileQuotaScope(tx, userId, input.projectId)
    if (input.sha256) {
      const [duplicate] = await tx.select({ id: projectFiles.id, name: projectFiles.name }).from(projectFiles)
        .where(and(eq(projectFiles.projectId, input.projectId), eq(projectFiles.sha256, input.sha256))).limit(1)
      if (duplicate) throw projectFileError(409, 'DUPLICATE_CONTENT', `相同内容已存在于「${duplicate.name}」`)
    }
    await assertProjectFileQuota(tx, { projectId: input.projectId, userId, byteSize, countDelta: 1 })
    const [inserted] = await tx.insert(projectFiles).values({ ...input, uploadedBy: userId, byteSize }).$returningId()
    const [row] = await tx.select().from(projectFiles).where(eq(projectFiles.id, inserted.id)).limit(1)
    if (row) await tx.insert(auditLogs).values({ userId, userName: '（系统）', module: '资料库', action: '上传文件', target: row.name })
    return row
  })
}

export async function setFileStoragePath(fileId: string, storagePath: string, userId: string) {
  return db.transaction(async (tx) => {
    const [initialFile] = await tx.select().from(projectFiles).where(eq(projectFiles.id, fileId)).limit(1)
    if (!initialFile) return undefined
    await lockProjectFileQuotaScope(tx, userId, initialFile.projectId)
    const [file] = await tx.select().from(projectFiles).where(eq(projectFiles.id, fileId)).limit(1)
    if (!file) return undefined
    await tx.update(projectFiles).set({ storagePath }).where(eq(projectFiles.id, fileId))
    await tx.insert(projectFileVersions).values({
      fileId, version: file.version, byteSize: file.byteSize, sha256: file.sha256,
      storagePath, createdBy: userId,
    })
    const [row] = await tx.select().from(projectFiles).where(eq(projectFiles.id, fileId)).limit(1)
    return row
  })
}

export async function replaceFileContent(fileId: string, storagePath: string, size: string, byteSize: number, sha256: string, userId: string) {
  return db.transaction(async (tx) => {
    const [file] = await tx.select().from(projectFiles).where(eq(projectFiles.id, fileId)).limit(1)
    if (!file) return undefined
    await assertProjectFileQuota(tx, {
      projectId: file.projectId, userId, byteSize, countDelta: 0,
      replacedByteSize: file.byteSize, previousUploaderId: file.uploadedBy,
    })
    if (file.storagePath && file.sha256 === sha256) {
      throw projectFileError(409, 'DUPLICATE_CONTENT', '补传内容与当前版本完全相同')
    }
    const [duplicate] = await tx.select({ id: projectFiles.id, name: projectFiles.name }).from(projectFiles)
      .where(and(eq(projectFiles.projectId, file.projectId), eq(projectFiles.sha256, sha256), ne(projectFiles.id, fileId))).limit(1)
    if (duplicate) throw projectFileError(409, 'DUPLICATE_CONTENT', `相同内容已存在于「${duplicate.name}」`)
    const nextVersion = file.storagePath ? file.version + 1 : file.version
    await tx.update(projectFiles).set({
      storagePath, size, byteSize, sha256, uploadedBy: userId, version: nextVersion,
      parseStatus: '解析中', parseError: null,
    }).where(eq(projectFiles.id, fileId))
    await tx.insert(projectFileVersions).values({
      fileId, version: nextVersion, byteSize, sha256, storagePath, createdBy: userId,
    })
    await tx.insert(auditLogs).values({
      userId, userName: '（系统）', module: '资料库',
      action: file.storagePath ? '替换原文件' : '补传原文件', target: `${file.name} v${nextVersion}`,
    })
    const [row] = await tx.select().from(projectFiles).where(eq(projectFiles.id, fileId)).limit(1)
    return row ? publicProjectFile(row) : undefined
  })
}

export async function attachRecoveredProjectFile(
  fileId: string, storagePath: string, size: string, byteSize: number, sha256: string, userId: string,
) {
  return db.transaction(async (tx) => {
    const [initialFile] = await tx.select().from(projectFiles).where(eq(projectFiles.id, fileId)).limit(1)
    if (!initialFile) throw projectFileError(404, 'NOT_FOUND', '资料记录不存在')
    await lockProjectFileQuotaScope(tx, userId, initialFile.projectId)
    const [file] = await tx.select().from(projectFiles).where(eq(projectFiles.id, fileId)).limit(1)
    if (!file) throw projectFileError(404, 'NOT_FOUND', '资料记录不存在')
    if (file.storagePath) throw projectFileError(409, 'ORIGINAL_ALREADY_ATTACHED', '资料记录已有原始文件')
    await assertProjectFileQuota(tx, {
      projectId: file.projectId, userId, byteSize, countDelta: 0,
      replacedByteSize: file.byteSize, previousUploaderId: file.uploadedBy,
    })
    const [duplicate] = await tx.select({ id: projectFiles.id, name: projectFiles.name }).from(projectFiles)
      .where(and(eq(projectFiles.projectId, file.projectId), eq(projectFiles.sha256, sha256), ne(projectFiles.id, fileId))).limit(1)
    if (duplicate) throw projectFileError(409, 'DUPLICATE_CONTENT', `相同内容已存在于「${duplicate.name}」`)
    const [existingVersion] = await tx.select({ id: projectFileVersions.id }).from(projectFileVersions)
      .where(and(eq(projectFileVersions.fileId, file.id), eq(projectFileVersions.version, file.version))).limit(1)
    if (existingVersion) throw projectFileError(409, 'FILE_VERSION_CONFLICT', '当前版本元数据已存在，不能自动认领原件')
    await tx.update(projectFiles).set({
      storagePath, size, byteSize, sha256, uploadedBy: userId,
    }).where(eq(projectFiles.id, file.id))
    await tx.insert(projectFileVersions).values({
      fileId: file.id, version: file.version, byteSize, sha256, storagePath, createdBy: userId,
    })
    await tx.insert(auditLogs).values({
      userId, userName: '（系统）', module: '资料库', action: '迁移补存原文件', target: `${file.name} v${file.version}`,
    })
    const [row] = await tx.select().from(projectFiles).where(eq(projectFiles.id, file.id)).limit(1)
    return row ? publicProjectFile(row) : undefined
  })
}

export async function getFile(fileId: string) {
  const [row] = await db.select().from(projectFiles).where(eq(projectFiles.id, fileId)).limit(1)
  return row
}

export async function listFileVersions(fileId: string) {
  return db.select({
    version: projectFileVersions.version,
    byteSize: projectFileVersions.byteSize,
    sha256: projectFileVersions.sha256,
    createdBy: projectFileVersions.createdBy,
    createdAt: projectFileVersions.createdAt,
  }).from(projectFileVersions).where(eq(projectFileVersions.fileId, fileId)).orderBy(desc(projectFileVersions.version))
}

export async function getFileVersion(fileId: string, version: number) {
  const [row] = await db.select().from(projectFileVersions)
    .where(and(eq(projectFileVersions.fileId, fileId), eq(projectFileVersions.version, version))).limit(1)
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
  await removeProjectFileDirectory(id).catch((error) => {
    console.warn(`[projects] 清理项目原始文件目录失败：${id}`, error)
  })
  await deleteProjectArtifactDirectories(id).catch((error) => {
    console.warn(`[projects] 清理项目产物目录失败：${id}`, error)
  })
  return proj
}

// 置顶/取消置顶
export async function pinProject(id: string, pinned: boolean, userId: string, expectedVersion?: number) {
  const condition = expectedVersion === undefined
    ? eq(projects.id, id)
    : and(eq(projects.id, id), eq(projects.version, expectedVersion))
  const [result] = await db.update(projects).set({
    pinned, version: sql`${projects.version} + 1`, updatedAt: new Date(),
  }).where(condition)
  if (expectedVersion !== undefined && result.affectedRows !== 1) throw businessVersionConflict('项目')
  const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1)
  if (row) await db.insert(auditLogs).values({ userId, userName: '（系统）', module: '我的专属项目', action: pinned ? '置顶项目' : '取消置顶', target: row.name })
  return row
}


// 保存项目评分(复用线索池同款结构)+score同步
export async function saveProjectScoring(id: string, scoring: unknown, score: number) {
  await db.update(projects).set({
    scoring: scoring as never, score,
    version: sql`${projects.version} + 1`, updatedAt: new Date(),
  }).where(eq(projects.id, id))
  const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1)
  return row
}


// 删除单个文件：连带删该文件的 RAG 块(file_chunks + knowledge_chunks by source_id)
export async function deleteFile(fileId: string, userId?: string) {
  const [f] = await db.select().from(projectFiles).where(eq(projectFiles.id, fileId))
  if (!f) return false
  const versions = await db.select({ storagePath: projectFileVersions.storagePath })
    .from(projectFileVersions).where(eq(projectFileVersions.fileId, fileId))
  await db.delete(fileChunks).where(eq(fileChunks.fileId, fileId))
  await db.delete(knowledgeChunks).where(eq(knowledgeChunks.sourceId, fileId))
  await db.delete(projectFiles).where(eq(projectFiles.id, fileId))
  await Promise.all([...new Set([f.storagePath, ...versions.map((row) => row.storagePath)].filter(Boolean))]
    .map((storagePath) => removeOwnedProjectFile(storagePath, f.projectId, fileId).catch((error) => {
      const code = (error as Error & { code?: string }).code || 'DELETE_FAILED'
      console.warn(`[project-files] 删除原始文件失败 code=${code}`)
    })))
  await removeProjectFileHistory(f.projectId, fileId).catch(() => {})
  if (userId) await db.insert(auditLogs).values({
    userId, userName: '（系统）', module: '资料库', action: '删除文件及全部版本', target: f.name,
  })
  return true
}
