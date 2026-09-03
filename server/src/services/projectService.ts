import { and, desc, eq, inArray, like, ne, or, sql } from 'drizzle-orm'
import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { db } from '../db/client.js'
import {
  projects,
  projectClassificationHistory,
  projectDutyAssignments,
  projectMembers,
  projectFiles,
  projectFileVersions,
  oaApprovalRequests,
  auditLogs,
  knowledgeChunks,
  fileChunks,
  todoFeedbackEvidence,
  projectDirectives,
  projectRecords,
  projectFileGrants,
  projectFileEvents,
  projectMaterialRequestClosures,
  responsibilityRecords,
  responsibilityTaskMarkers,
  projectAgentRuns,
  projectAgentConfigs,
  projectAgentCommands,
  projectTimelineSyncs,
  projectStageMaterials,
  todos,
} from '../db/schema.js'
import { createMySqlIdentityRepositoryContext, identityRepositories } from '../repositories/index.js'
import { sanitizeScoringCompetitors } from './competitorEvidence.js'
import { removeOwnedProjectFile, removeProjectFileDirectory, removeProjectFileHistory } from './projectFileStorageService.js'
import { projectAccessCondition, requireAccessibleProject } from './projectAccessService.js'
import { syncProjectIdentityBindings } from './identityResolutionService.js'
import { businessVersionConflict } from './businessOptimisticLock.js'
import { activeWorkflowPolicyVersion } from './fdeWorkflowPolicyService.js'
import { initializeFdeFileGrants } from './fdeFileService.js'
import { projectFileAccessCondition, requireProjectFileAccess, requireProjectFileUpload } from './projectFileAccessService.js'
import { prepareFdeCreationGovernance } from './fdeGovernanceService.js'
import type { FdeCreationAssignment } from './fdeGovernanceService.js'
import { canDirectlyDeleteProject } from '../contracts/adminRoleContract.js'

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

async function lockProjectFileQuotaScope(tx: ProjectFileTransaction, userId: string, projectId: string, otherUserId?: string | null) {
  await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${projectId} FOR UPDATE`)
  for (const id of [...new Set([userId, otherUserId].filter(Boolean) as string[])].sort()) {
    const user = await createMySqlIdentityRepositoryContext(tx).users.lockById(id)
    if (!user) throw projectFileError(403, 'USER_DISABLED_OR_MISSING', '文件容量责任用户不存在')
  }
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
  industry?: string
  risk?: '低' | '中' | '高'
  scope?: 'mine' | 'all'
  classification?: 'pool' | 'normal' | 'key'
  lifecycle?: 'active' | 'closed' | 'archived' | 'deleted'
  page: number
  pageSize: number
}

function publicProject<T extends { scoring?: unknown }>(row: T): T {
  return row.scoring
    ? { ...row, scoring: sanitizeScoringCompetitors(row.scoring) }
    : row
}

export async function listProjects(args: ListArgs, userId?: string) {
  const baseConditions = []
  if (userId) {
    const user = await identityRepositories.users.findById(userId)
    if (!user || user.status !== '启用') return { list: [], total: 0, page: args.page, pageSize: args.pageSize, counts: { normal: 0, key: 0 } }
    baseConditions.push(projectAccessCondition({ uid: user.id, name: user.name, role: user.role }))
    if (args.scope === 'mine') {
      baseConditions.push(inArray(projects.id, db.select({ id: projectMembers.projectId }).from(projectMembers).where(eq(projectMembers.userId, user.id))))
    }
  }
  if (args.keyword) {
    baseConditions.push(or(
      like(projects.name, `%${args.keyword}%`),
      like(projects.companyName, `%${args.keyword}%`),
      like(projects.industry, `%${args.keyword}%`),
    ))
  }
  if (args.stage) baseConditions.push(eq(projects.stage, args.stage))
  if (args.owner) baseConditions.push(eq(projects.owner, args.owner))
  if (args.industry) baseConditions.push(eq(projects.industry, args.industry))
  if (args.risk) baseConditions.push(eq(projects.riskLevel, args.risk))
  if (args.lifecycle) baseConditions.push(eq(projects.lifecycle, args.lifecycle))
  const listConditions = args.classification
    ? [...baseConditions, eq(projects.classification, args.classification)]
    : baseConditions
  const listWhere = listConditions.length ? and(...listConditions) : undefined
  const countsWhere = baseConditions.length ? and(...baseConditions) : undefined
  const rows = await db.select().from(projects).where(listWhere as never).orderBy(
    desc(projects.pinned),
    desc(projects.updatedAt),
    desc(projects.id),
  )
    .limit(args.pageSize).offset((args.page - 1) * args.pageSize)
  const [totalRows, countRows] = await Promise.all([
    db.select({ c: sql<number>`count(*)` }).from(projects).where(listWhere as never),
    db.select({ classification: projects.classification, c: sql<number>`count(*)` })
      .from(projects).where(countsWhere as never).groupBy(projects.classification),
  ])
  const classificationCounts = { normal: 0, key: 0 }
  for (const row of countRows) {
    if (row.classification === 'normal' || row.classification === 'key') classificationCounts[row.classification] = Number(row.c)
  }
  const memberships = userId && rows.length
    ? await db.select({ projectId: projectMembers.projectId, memberRole: projectMembers.memberRole })
      .from(projectMembers).where(and(eq(projectMembers.userId, userId), inArray(projectMembers.projectId, rows.map((row) => row.id))))
    : []
  const membershipByProject = new Map(memberships.map((membership) => [membership.projectId, membership.memberRole]))
  return {
    list: rows.map((row) => publicProject({
      ...row,
      isParticipant: membershipByProject.has(row.id),
      participantRole: membershipByProject.get(row.id) ?? null,
    })),
    total: totalRows[0]?.c ?? rows.length,
    page: args.page,
    pageSize: args.pageSize,
    counts: classificationCounts,
  }
}

export async function getProject(id: string) {
  const rows = await db.select().from(projects).where(eq(projects.id, id)).limit(1)
  return rows[0] ? publicProject(rows[0]) : undefined
}

// 列表接口只返回页面需要的元数据。正文由 RAG/受控读取接口使用，不能随文件列表批量下发。
const projectFileListColumns = {
  id: projectFiles.id,
  projectId: projectFiles.projectId,
  name: projectFiles.name,
  type: projectFiles.type,
  category: projectFiles.category,
  size: projectFiles.size,
  uploader: projectFiles.uploader,
  parseStatus: projectFiles.parseStatus,
  visibility: projectFiles.visibility,
  storagePath: projectFiles.storagePath,
  version: projectFiles.version,
  uploadedAt: projectFiles.uploadedAt,
}

export async function listFiles(projectId: string, userId?: string) {
  const rows = await db.select(projectFileListColumns).from(projectFiles)
    .where(and(eq(projectFiles.projectId, projectId), userId ? projectFileAccessCondition(userId) : eq(projectFiles.lifecycle, 'active'))).orderBy(desc(projectFiles.uploadedAt))
  return rows.map(publicProjectFile)
}

export async function listAllFiles(userId?: string) {
  let accessWhere = eq(projectFiles.lifecycle, 'active')
  if (userId) {
    const user = await identityRepositories.users.findById(userId)
    if (!user || user.status !== '启用') return []
    accessWhere = projectFileAccessCondition(userId)
  }
  // 权限条件直接下推到 SQL。旧实现对每个文件并发调用 getAccessibleProject，
  // 会产生 N+1 查询并在几十份文件时耗尽 MySQL 连接池队列。
  const rows = await db.select(projectFileListColumns).from(projectFiles)
    .innerJoin(projects, eq(projectFiles.projectId, projects.id))
    .where(accessWhere)
    .orderBy(desc(projectFiles.uploadedAt))
    .limit(500)
  return rows.map(publicProjectFile)
}

function publicProjectFile<T extends { storagePath: string | null }>(row: T) {
  const { storagePath, ...file } = row
  return { ...file, hasOriginal: Boolean(storagePath) }
}

export async function createProject(
  input: Partial<typeof projects.$inferInsert>,
  userId: string,
  governance?: { ownerUserId: string; assignments: FdeCreationAssignment[] },
) {
  // 正式新建入口以稳定登录身份建立项目、成员、分类历史与审计，全部原子提交。
  // legacy 仅供历史迁移/身份恢复的内部调用；HTTP schema 不接受 workflowModel。
  if (input.workflowModel !== 'legacy') {
    if (input.projectType && input.projectType !== '投资项目') throw projectClassificationError(409, 'FDE_TYPE_EXECUTION_REQUIRED', '非投资类型必须使用独立批准模板与执行流程，不能静默创建为投资项目')
    return db.transaction(async (tx) => {
      const identity = createMySqlIdentityRepositoryContext(tx)
      const actor = await identity.users.findById(userId)
      if (!actor || actor.status !== '启用') throw projectClassificationError(403, 'USER_DISABLED_OR_MISSING', '当前用户不可创建项目')
      const prepared = governance ? await prepareFdeCreationGovernance(tx, governance) : null
      const owner = prepared?.owner ?? { id: actor.id, name: actor.name }
      const participantIds = prepared
        ? [...new Set([actor.id, owner.id, ...prepared.assignments.filter((assignment) => assignment.duty !== 'coordinator').map((assignment) => assignment.userId)])]
        : [actor.id]
      const peopleById = new Map<string, { name: string }>((prepared?.people ?? []).map((person) => [person.id, { name: person.name }]))
      peopleById.set(actor.id, { name: actor.name })
      const workflowPolicyVersionId = await activeWorkflowPolicyVersion(tx)
      const [inserted] = await tx.insert(projects).values({
        ...input, owner: owner.name, ownerUserId: owner.id,
        collaborators: participantIds.filter((id) => id !== owner.id).map((id) => peopleById.get(id)?.name).filter((name): name is string => Boolean(name)),
        workflowPolicyVersionId,
        stage: prepared ? '立项' : '入库', stageSource: prepared ? '入库完成' : '系统初始化',
        classification: prepared ? 'normal' : 'pool', lifecycle: 'active', workflowModel: 'fde-v1', progress: prepared ? 10 : 0, createdBy: actor.id,
      } as typeof projects.$inferInsert).$returningId()
      await tx.insert(projectMembers).values(participantIds.map((participantId) => ({
        projectId: inserted.id,
        userId: participantId,
        memberRole: participantId === owner.id ? 'owner' : 'collaborator',
        sourceName: peopleById.get(participantId)?.name ?? actor.name,
      })))
      if (prepared?.assignments.length) await tx.insert(projectDutyAssignments).values(prepared.assignments.map((assignment) => ({
        ...assignment,
        projectId: inserted.id,
        assignedBy: actor.id,
      })))
      await tx.insert(projectClassificationHistory).values({
        projectId: inserted.id,
        fromClassification: null,
        toClassification: prepared ? 'normal' : 'pool',
        reason: prepared ? '快速新建并完成组织配置' : '授权用户登记项目',
        changedBy: actor.id,
        changedByName: actor.name,
      })
      await identity.audits.append({ userId: actor.id, userName: actor.name, module: '项目管理', action: '创建项目', target: String(input.name ?? '') })
      const [row] = await tx.select().from(projects).where(eq(projects.id, inserted.id)).limit(1)
      return row
    })
  }
  const stage = input.stage ?? '线索'
  const [inserted] = await db.insert(projects).values({
    ...input,
    stage,
    classification: 'normal',
    lifecycle: 'active',
    workflowModel: 'legacy',
    progress: 0,
    stageSource: (input.stageSource as string | undefined) ?? '系统初始化',
    createdBy: userId,
  } as typeof projects.$inferInsert).$returningId()
  const [row] = await db.select().from(projects).where(eq(projects.id, inserted.id)).limit(1)
  await db.insert(projectClassificationHistory).values({
    projectId: row.id,
    fromClassification: null,
    toClassification: 'normal',
    reason: '历史项目身份恢复',
    changedBy: userId,
    changedByName: row.owner,
  })
  await syncProjectIdentityBindings(row.id, row.owner, row.collaborators)
  await db.insert(auditLogs).values({ userId, userName: '（系统）', module: '项目管理', action: '创建项目', target: row.name })
  const [boundRow] = await db.select().from(projects).where(eq(projects.id, row.id)).limit(1)
  return boundRow
}

export type ProjectClassification = 'pool' | 'normal' | 'key'

function projectClassificationError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code })
}

export async function listProjectClassificationHistory(projectId: string) {
  return db.select().from(projectClassificationHistory)
    .where(eq(projectClassificationHistory.projectId, projectId))
    .orderBy(desc(projectClassificationHistory.createdAt), desc(projectClassificationHistory.id))
}

export async function classifyProject(input: {
  projectId: string
  toClassification: ProjectClassification
  reason: string
  expectedVersion: number
  userId: string
  requestId?: string
}) {
  await requireAccessibleProject(input.userId, input.projectId)
  return db.transaction(async (tx) => {
    const repositories = createMySqlIdentityRepositoryContext(tx)
    const actor = await repositories.users.lockById(input.userId)
    if (!actor || actor.status !== '启用') {
      throw projectClassificationError(403, 'PROJECT_CLASSIFICATION_ACTOR_INVALID', '当前账号不可调整项目分类')
    }
    await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${input.projectId} FOR UPDATE`)
    const [project] = await tx.select().from(projects).where(eq(projects.id, input.projectId)).limit(1)
    if (!project) throw projectClassificationError(404, 'PROJECT_NOT_FOUND', '项目不存在')
    if (project.version !== input.expectedVersion) throw businessVersionConflict('项目')
    if (project.lifecycle !== 'active') {
      throw projectClassificationError(409, 'PROJECT_LIFECYCLE_LOCKED', '只有进行中的项目可以调整分类')
    }
    if (project.classification === input.toClassification) {
      throw projectClassificationError(409, 'PROJECT_CLASSIFICATION_UNCHANGED', '项目已经处于该分类')
    }

    const [membership] = await tx.select({ role: projectMembers.memberRole }).from(projectMembers).where(and(
      eq(projectMembers.projectId, project.id),
      eq(projectMembers.userId, actor.id),
    )).limit(1)
    const permissionCodes = await repositories.users.listPermissionCodes(actor.id)
    const canClassify = permissionCodes.includes('project.classify')
    const isProjectLead = project.ownerUserId === actor.id || membership?.role === 'owner' || membership?.role === 'project_lead'

    const currentClassification = project.classification as ProjectClassification
    if (currentClassification === 'pool') {
      if (input.toClassification !== 'normal') {
        throw projectClassificationError(409, 'PROJECT_POOL_TRANSITION_INVALID', '项目池只能在完成入库后进入普通项目')
      }
      if (!isProjectLead && !canClassify) {
        throw projectClassificationError(403, 'PROJECT_POOL_PROMOTION_FORBIDDEN', '仅项目负责人或授权领导可完成入库')
      }
      if (!['入库', '线索'].includes(project.stage)) {
        throw projectClassificationError(409, 'PROJECT_INTAKE_STAGE_INVALID', '只有入库阶段的项目可以完成入库')
      }
    } else {
      const projectLeadPromotion = currentClassification === 'normal' && input.toClassification === 'key' && isProjectLead
      if (!canClassify && !projectLeadPromotion) {
        throw projectClassificationError(403, 'PROJECT_CLASSIFICATION_FORBIDDEN', '项目负责人可将普通项目转为重点项目；调回普通项目需授权领导操作')
      }
      const validLeadershipTransition = (currentClassification === 'normal' && input.toClassification === 'key')
        || (currentClassification === 'key' && input.toClassification === 'normal')
      if (!validLeadershipTransition) {
        throw projectClassificationError(409, 'PROJECT_CLASSIFICATION_TRANSITION_INVALID', '不支持该项目分类变更')
      }
    }

    const reason = input.reason.trim()
    if (reason.length < 2) {
      throw projectClassificationError(400, 'PROJECT_CLASSIFICATION_REASON_REQUIRED', '请填写项目分类调整原因')
    }
    const completingIntake = currentClassification === 'pool' && input.toClassification === 'normal'
    const [result] = await tx.update(projects).set({
      classification: input.toClassification,
      ...(completingIntake ? { stage: '立项', stageSource: '入库完成', progress: 10 } : {}),
      version: sql`${projects.version} + 1`,
      updatedAt: new Date(),
    }).where(and(eq(projects.id, project.id), eq(projects.version, input.expectedVersion)))
    if (result.affectedRows !== 1) throw businessVersionConflict('项目')

    if (completingIntake) {
      const { reconcileTimelineEvent } = await import('./fdeTimelineTaskService.js')
      await reconcileTimelineEvent(tx, project.id, actor.id, { source: 'classification', sourceKey: `classification:${project.version + 1}` })
    }

    await tx.insert(projectClassificationHistory).values({
      projectId: project.id,
      fromClassification: currentClassification,
      toClassification: input.toClassification,
      reason,
      changedBy: actor.id,
      changedByName: actor.name,
      requestId: input.requestId?.slice(0, 64),
    })
    await tx.insert(auditLogs).values({
      userId: actor.id,
      userName: actor.name,
      module: '项目管理',
      action: completingIntake ? '完成项目入库' : '调整项目分类',
      target: JSON.stringify({
        projectId: project.id,
        projectName: project.name,
        fromClassification: currentClassification,
        toClassification: input.toClassification,
        reason,
      }),
    })
    const [updated] = await tx.select().from(projects).where(eq(projects.id, project.id)).limit(1)
    return publicProject(updated)
  })
}

export async function updateProject(
  id: string,
  patch: Partial<typeof projects.$inferInsert>,
  userId: string,
  expectedVersion?: number,
) {
  const { id: _id, createdBy: _createdBy, ownerUserId: _ownerUserId, version: _version, ...safePatch } = patch
  const [current] = await db.select().from(projects).where(eq(projects.id, id)).limit(1)
  if (current?.workflowModel === 'fde-v1') {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${id} FOR UPDATE`)
      const [locked] = await tx.select().from(projects).where(eq(projects.id, id)).limit(1)
      if (!locked) throw projectClassificationError(404, 'PROJECT_NOT_FOUND', '项目不存在')
      if (expectedVersion !== undefined && locked.version !== expectedVersion) throw businessVersionConflict('项目')
      const { stage: _stage, stageSource: _source, classification: _classification, lifecycle: _lifecycle, workflowModel: _model, workflowPolicyVersionId: _policyVersion, governanceVersion: _governanceVersion, progress: _progress, owner: _owner, collaborators: _collaborators, ...fdePatch } = safePatch
      if (('investmentFund' in fdePatch && fdePatch.investmentFund !== locked.investmentFund) || ('requirements' in fdePatch && fdePatch.requirements !== locked.requirements)) {
        if (locked.ownerUserId !== userId) throw projectClassificationError(403, 'FDE_OWNER_REQUIRED', '项目要求和投资基金只能由负责人修改')
        const [active] = await tx.select({ id: oaApprovalRequests.id }).from(oaApprovalRequests).where(and(eq(oaApprovalRequests.projectId, id), eq(oaApprovalRequests.status, '审批中'))).limit(1)
        if (active) throw projectClassificationError(409, 'FDE_APPROVAL_ACTIVE', '审批期间不能修改项目要求或投资基金，请先撤回修订')
      }
      await tx.update(projects).set({ ...fdePatch, version: locked.version + 1, updatedAt: new Date() }).where(eq(projects.id, id))
      const actor = await createMySqlIdentityRepositoryContext(tx).users.findById(userId)
      await createMySqlIdentityRepositoryContext(tx).audits.append({ userId, userName: actor?.name ?? '未知用户', module: '项目管理', action: '编辑项目', target: locked.name })
      const [updated] = await tx.select().from(projects).where(eq(projects.id, id)).limit(1)
      return updated
    })
  }
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
  const [current] = await db.select({ workflowModel: projects.workflowModel }).from(projects).where(eq(projects.id, id)).limit(1)
  if (current?.workflowModel === 'fde-v1') throw projectClassificationError(409, 'FDE_APPROVAL_REQUIRED', 'FDE 项目阶段只能通过入库初筛或正式审批推进')
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
    await requireProjectFileUpload(tx, input.projectId, userId)
    if (input.sha256) {
      const [duplicate] = await tx.select({ id: projectFiles.id, name: projectFiles.name }).from(projectFiles)
        .where(and(eq(projectFiles.projectId, input.projectId), eq(projectFiles.sha256, input.sha256))).limit(1)
      if (duplicate) throw projectFileError(409, 'DUPLICATE_CONTENT', '当前项目已存在相同内容，请核对有权访问的文件或联系项目负责人')
    }
    await assertProjectFileQuota(tx, { projectId: input.projectId, userId, byteSize, countDelta: 1 })
    const [inserted] = await tx.insert(projectFiles).values({ ...input, uploadedBy: userId, byteSize }).$returningId()
    const [initial] = await tx.select().from(projectFiles).where(eq(projectFiles.id, inserted.id)).limit(1)
    await initializeFdeFileGrants(tx, initial, userId)
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
    await requireProjectFileUpload(tx, initialFile.projectId, userId)
    await requireProjectFileAccess(tx, fileId, userId, 'delete')
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

export async function replaceFileContent(fileId: string, storagePath: string, size: string, byteSize: number, sha256: string, userId: string, expectedVersion?: number) {
  return db.transaction(async (tx) => {
    const [initial] = await tx.select().from(projectFiles).where(eq(projectFiles.id, fileId)).limit(1)
    if (!initial) return undefined
    await lockProjectFileQuotaScope(tx, userId, initial.projectId, initial.uploadedBy)
    const project = await requireProjectFileUpload(tx, initial.projectId, userId)
    const file = await requireProjectFileAccess(tx, fileId, userId, 'delete')
    if (project.workflowModel === 'fde-v1' && expectedVersion !== file.version) throw businessVersionConflict('文件内容')
    const quotaOwner = project.workflowModel === 'fde-v1' ? file.uploadedBy ?? userId : userId
    await assertProjectFileQuota(tx, {
      projectId: file.projectId, userId: quotaOwner, byteSize, countDelta: 0,
      replacedByteSize: file.byteSize, previousUploaderId: file.uploadedBy,
    })
    if (file.storagePath && file.sha256 === sha256) {
      throw projectFileError(409, 'DUPLICATE_CONTENT', '补传内容与当前版本完全相同')
    }
    const [duplicate] = await tx.select({ id: projectFiles.id, name: projectFiles.name }).from(projectFiles)
      .where(and(eq(projectFiles.projectId, file.projectId), eq(projectFiles.sha256, sha256), ne(projectFiles.id, fileId))).limit(1)
    if (duplicate) throw projectFileError(409, 'DUPLICATE_CONTENT', '当前项目已存在相同内容，请核对有权访问的文件或联系项目负责人')
    const nextVersion = file.storagePath ? file.version + 1 : file.version
    await tx.update(projectFiles).set({
      storagePath, size, byteSize, sha256, uploadedBy: quotaOwner, version: nextVersion,
      parseStatus: '解析中', parseError: null, contentText: null,
    }).where(eq(projectFiles.id, fileId))
    // The old text must not be labelled as the new content version while parsing.
    // Original bytes and immutable revisions remain available through version APIs.
    await tx.delete(fileChunks).where(eq(fileChunks.fileId, fileId))
    await tx.delete(knowledgeChunks).where(and(eq(knowledgeChunks.scope, 'project'), eq(knowledgeChunks.refId, file.projectId), eq(knowledgeChunks.sourceId, fileId)))
    await tx.insert(projectFileVersions).values({
      fileId, version: nextVersion, byteSize, sha256, storagePath, createdBy: userId,
    })
    await tx.insert(auditLogs).values({
      userId, userName: '（系统）', module: '资料库',
      action: file.storagePath ? '替换原文件' : '补传原文件', target: `${file.name} v${nextVersion}`,
    })
    const [binding] = await tx.select({ id: projectStageMaterials.id }).from(projectStageMaterials).where(eq(projectStageMaterials.fileId, fileId)).limit(1)
    if (binding) {
      const { reconcileTimelineEvent } = await import('./fdeTimelineTaskService.js')
      await reconcileTimelineEvent(tx, file.projectId, userId, { source: 'material', sourceKey: `file:${fileId}:${nextVersion}` })
    }
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

// 授权领导通过可审计的生命周期删除立即移出业务视图；普通项目成员仍沿用
// 原有的空项目硬删除，并且不能绕过 FDE 历史保留规则。
export async function deleteProject(id: string, userId: string, input?: { confirmation?: string; expectedVersion?: number }) {
  const proj = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${id} FOR UPDATE`)
    const [project] = await tx.select().from(projects).where(eq(projects.id, id))
    if (!project) return null
    const actor = await createMySqlIdentityRepositoryContext(tx).users.findById(userId)
    if (!actor || actor.status !== '启用') throw Object.assign(new Error('当前账号无权删除项目'), { status: 403, code: 'PROJECT_FORBIDDEN' })
    if (input?.confirmation !== undefined && input.confirmation !== project.name) {
      throw Object.assign(new Error('项目名称已变化，请刷新后重新确认'), { status: 409, code: 'PROJECT_DELETE_CONFIRMATION_MISMATCH' })
    }
    if (input?.expectedVersion !== undefined && input.expectedVersion !== project.version) throw businessVersionConflict('项目')
    if (project.lifecycle === 'deleted') throw Object.assign(new Error('项目已删除'), { status: 409, code: 'PROJECT_ALREADY_DELETED' })
    const permissionCodes = await createMySqlIdentityRepositoryContext(tx).users.listPermissionCodes(actor.id)
    const canDeleteWithHistory = canDirectlyDeleteProject(actor.role, permissionCodes)
    const [accessible] = await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.id, id), projectAccessCondition({ uid: actor.id, name: actor.name, role: actor.role })))
    if (!accessible && !canDeleteWithHistory) throw Object.assign(new Error('无权删除该项目'), { status: 403, code: 'PROJECT_FORBIDDEN' })
    if (canDeleteWithHistory) {
      await tx.update(projects).set({ lifecycle: 'deleted', pinned: false, version: sql`${projects.version} + 1`, updatedAt: new Date() }).where(eq(projects.id, id))
      await tx.update(todos).set({ status: '已关闭', closureReason: '所属项目已删除', version: sql`${todos.version} + 1` }).where(and(
        eq(todos.projectId, id),
        sql`${todos.status} NOT IN ('已完成','已关闭','已取消','已归档')`,
      ))
      await tx.insert(auditLogs).values({ userId, userName: actor.name, module: '项目管理', action: '删除项目', target: project.name })
      return { ...project, lifecycle: 'deleted' as const, pinned: false, version: project.version + 1 }
    }
    const [directive] = await tx.select({ id: projectDirectives.id }).from(projectDirectives).where(eq(projectDirectives.projectId, id)).limit(1)
    if (directive) throw Object.assign(new Error('项目包含需保留的批示及执行历史，不能直接删除；请按项目生命周期规则处理'), { status: 409, code: 'PROJECT_DIRECTIVE_HISTORY_PROTECTED' })
    const [record] = await tx.select({ id: projectRecords.id }).from(projectRecords).where(eq(projectRecords.projectId, id)).limit(1)
    if (record) throw Object.assign(new Error('项目包含需保留的记录与讨论历史，不能直接删除；请按项目生命周期规则处理'), { status: 409, code: 'PROJECT_RECORD_HISTORY_PROTECTED' })
    if (project.workflowModel === 'fde-v1') {
      const [agentRun] = await tx.select({ id: projectAgentRuns.id }).from(projectAgentRuns).where(eq(projectAgentRuns.projectId, id)).limit(1)
      const [agentConfig] = await tx.select({ id: projectAgentConfigs.projectId }).from(projectAgentConfigs).where(eq(projectAgentConfigs.projectId, id)).limit(1)
      if (agentRun || agentConfig) throw Object.assign(new Error('项目包含研判、配置或改期审批历史，不能通过旧接口删除；请使用受控生命周期流程'), { status: 409, code: 'PROJECT_AGENT_HISTORY_PROTECTED' })
      const [responsibility] = await tx.select({ id: responsibilityRecords.id }).from(responsibilityRecords).where(eq(responsibilityRecords.projectId, id)).limit(1)
      const [marker] = await tx.select({ id: responsibilityTaskMarkers.id }).from(responsibilityTaskMarkers).innerJoin(todos, eq(todos.id, responsibilityTaskMarkers.taskId)).where(eq(todos.projectId, id)).limit(1)
      if (responsibility || marker) throw Object.assign(new Error('项目包含责任或关键行动历史，不能直接删除；请按保留和生命周期政策处理'), { status: 409, code: 'PROJECT_RESPONSIBILITY_HISTORY_PROTECTED' })
      const [fileHistory] = await tx.select({ id: projectFiles.id }).from(projectFiles).where(eq(projectFiles.projectId, id)).limit(1)
      if (fileHistory) throw Object.assign(new Error('项目包含文件历史，不能通过旧接口删除原件；请使用受控生命周期流程'), { status: 409, code: 'PROJECT_FILE_HISTORY_PROTECTED' })
      // Preserve established business-history error priority as automatic syncs become ubiquitous.
      const [timelineSync] = await tx.select({ id: projectTimelineSyncs.id }).from(projectTimelineSyncs).where(eq(projectTimelineSyncs.projectId, id)).limit(1)
      if (timelineSync) throw Object.assign(new Error('项目包含流程行动及对账历史，不能通过旧接口删除'), { status: 409, code: 'PROJECT_TIMELINE_HISTORY_PROTECTED' })
    }
    // Fences only prevent a previously uncommitted command from arriving late;
    // they are not material history. Once the project is deleted, the same
    // project-first lock/context check rejects every late command. Keep audit
    // history and roll this cleanup back if any subsequent delete fails.
    await tx.delete(projectMaterialRequestClosures).where(eq(projectMaterialRequestClosures.projectId, id))
    await tx.delete(projectAgentCommands).where(and(eq(projectAgentCommands.projectId, id), sql`${projectAgentCommands.closedAt} IS NOT NULL`))
    await tx.delete(knowledgeChunks).where(and(eq(knowledgeChunks.scope, 'project'), eq(knowledgeChunks.refId, id)))
    await tx.delete(projects).where(eq(projects.id, id))
    await tx.insert(auditLogs).values({ userId, userName: actor.name, module: '我的专属项目', action: '删除项目(连带知识库)', target: project.name })
    return project
  })
  if (!proj) return null
  if (proj.lifecycle === 'deleted') return proj
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
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${f.projectId} FOR UPDATE`)
    await tx.execute(sql`SELECT ${projectFiles.id} FROM ${projectFiles} WHERE ${projectFiles.id}=${fileId} FOR UPDATE`)
    const [project] = await tx.select().from(projects).where(eq(projects.id, f.projectId))
    const [evidence] = await tx.select({ id: todoFeedbackEvidence.id }).from(todoFeedbackEvidence).where(eq(todoFeedbackEvidence.fileId, fileId)).limit(1)
    if (evidence) throw Object.assign(new Error('文件已作为任务成果证据，不能删除原始版本和验收证据'), { status: 409, code: 'FILE_TASK_EVIDENCE_REFERENCED' })
    if (project?.workflowModel === 'fde-v1') {
      const [event] = await tx.select({ id: projectFileEvents.id }).from(projectFileEvents).where(eq(projectFileEvents.fileId, fileId)).limit(1)
      // The only no-actor cleanup is a newly created upload whose bytes never committed.
      const [current] = await tx.select().from(projectFiles).where(eq(projectFiles.id, fileId))
      if (userId || current?.storagePath || versions.length || event) throw projectFileError(409, 'FILE_LIFECYCLE_REQUIRED', 'FDE 文件必须填写原因并移入回收站，不能硬删除')
      await tx.delete(projectFileGrants).where(eq(projectFileGrants.fileId, fileId))
    }
    await tx.delete(fileChunks).where(eq(fileChunks.fileId, fileId))
    await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.sourceId, fileId))
    await tx.delete(projectFiles).where(eq(projectFiles.id, fileId))
  })
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
