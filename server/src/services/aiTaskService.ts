import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm'
import JSZip from 'jszip'
import { db } from '../db/client.js'
import {
  fileChunks,
  knowledgeChunks,
  projectFiles,
  projects,
} from '../db/schema.js'
import type {
  AiArtifactRecord,
  AiTaskRecord,
  CreateAiArtifactRecord,
} from '../repositories/aiTaskRepository.js'
import { agentConversationRepository, aiTaskRepository, identityRepositories } from '../repositories/index.js'
import {
  annotateDueDiligencePendingAfterResearch,
  composeBusinessContent,
  dueDiligencePendingResearchTopics,
  investmentRecommendationContentQualityIssues,
  investmentRecommendationPendingResearchTopics,
  usedBusinessSourceIndexes,
  type BusinessContent,
  type EvidenceSource,
} from './aiBusinessContentService.js'
import {
  generateBusinessDocx,
  generateBusinessPptx,
  generateBusinessPptxPreview,
  makeArtifactFileName,
} from './aiBusinessDocumentService.js'
import {
  AI_TEMPLATE_CATALOG,
  assertAiTemplateReferences,
  isAiExecutableTaskType,
  type AiBusinessTaskType,
  type AiExecutableTaskType,
  type AiTemplateDefinition,
} from './aiTemplateCatalog.js'
import { loadAiSkill } from './aiSkillService.js'
import { resolveAiCustomTemplateForTask } from './aiCustomTemplateService.js'
import { recordJobCoordinationEventSafely } from '../runtime/jobCoordinationTelemetry.js'
import { recordAiTaskModelCall, runWithAiTaskModelUsage } from '../runtime/aiTaskModelUsage.js'
import {
  curateEvidenceSources,
  dedupeTextList,
  isDiagnosticEvidenceSourceName,
} from './aiEvidenceQualityService.js'
import {
  complianceBlueprintMetadata,
  parseComplianceDocumentBlueprint,
  type ComplianceDocumentBlueprint,
} from './aiComplianceBlueprintService.js'
import {
  buildComplianceEvidencePackets,
  composeComplianceStatement,
  type ComplianceWorkflowResult,
} from './aiComplianceWorkflowService.js'
import {
  fetchDueDiligenceNetworkEvidence,
  type DueDiligenceNetworkResearchAudit,
} from './aiDueDiligenceNetworkResearchService.js'
import {
  fetchComplianceModelEvidence,
  type ComplianceModelResearchAudit,
} from './aiComplianceModelResearchService.js'
import { makeProjectQaFileNames } from './aiQaDocumentService.js'
import { generateProjectQaWithSkill } from './aiProjectQaSkillRuntimeService.js'
import {
  buildProjectQaDocumentContent,
  generateProjectQaAnswers,
  generateProjectQaQuestions,
  reviewProjectQaAnswers,
  usedProjectQaSourceIndexes,
  type ProjectQaMode,
} from './aiQaPipelineService.js'
import {
  buildProjectKnowledgeBrief,
  type ProjectKnowledgeBrief,
} from './aiProjectKnowledgeBriefService.js'
import {
  fetchProjectQaModelEvidence,
  fetchVerifiedProjectWebEvidence,
  PROJECT_QA_RESEARCH_TOPICS,
  projectQaResearchTopicsForSources,
  projectWebResearchTopicsForSources,
  type ProjectQaModelResearchAudit,
  type ProjectQaResearchTopic,
  type ProjectWebResearchAudit,
} from './aiQaModelResearchService.js'
import {
  createProjectQaSkillProfile,
  type QaTemplateProfile,
} from './aiQaTemplateParser.js'
import { generateDueDiligenceReportWithSkill } from './aiDueDiligenceSkillRuntimeService.js'
import {
  safeAiTaskFailureMessage,
  safeAiTaskFailureStage,
} from './aiTaskErrorService.js'
import {
  runDirectBusinessDocumentAgent,
  runDirectInvestmentProposalAgent,
} from './aiDirectInvestmentProposalAgentService.js'
import { runDirectInvestmentCommitteePptAgent } from './aiDirectInvestmentCommitteePptAgentService.js'
import { formatShanghaiDateKey } from '../utils/shanghaiTime.js'
import {
  buildInvestmentRecommendationGenerationAudit,
  prepareInvestmentRecommendationPptWorkflow,
  type InvestmentRecommendationPptWorkflow,
} from './aiInvestmentRecommendationPptWorkflowService.js'
import { getAccessibleProject } from './projectAccessService.js'

export type AiTaskStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export type AiTaskFailureClassification = {
  errorCode: string
  retryable: boolean
}

export type AiTaskUser = {
  uid: string
  name: string
  role: string
}

export type CreateAiTaskInput = {
  type: AiExecutableTaskType
  projectId: string
  conversationId?: string
  parameters: Record<string, unknown>
  idempotencyKey: string
  retryOfTaskId?: string
}

export type CreateInvestmentPptPreparationInput = {
  projectId: string
  conversationId: string
  fileName: string
  progressId: string
  startedAt: string
  sourceCutoffDate: string
  outputFormat: 'PPTX'
  language: '中文'
  structureMode: 'strict-template'
  userInstructions?: string
  idempotencyKey: string
}

export function buildImageDeckArtifactMetadata(input: {
  existingMetadata?: Record<string, unknown> | null
  generationMetadata: Record<string, unknown>
  skill: { name: string; version: string; sha256: string }
  slideCount: number
  bytes: number
  sha256: string
  refreshedAfterResume: boolean
}) {
  return {
    ...(input.existingMetadata ?? {}),
    ...input.generationMetadata,
    skillName: input.skill.name,
    skillVersion: input.skill.version,
    skillSha256: input.skill.sha256,
    artifactStage: 'image-deck',
    artifactLabel: '图片高保真版',
    editableScope: 'image',
    slideCount: input.slideCount,
    bytes: input.bytes,
    sha256: input.sha256,
    encodingClean: true,
    acceptanceAuthority: 'agent-and-current-skill',
    acceptanceDecision: 'accepted-on-agent-skill-completion',
    programmaticBusinessAcceptance: false,
    deliveryValidation: 'file-integrity-and-authorization-only',
    availableWhileTaskRunning: true,
    refreshedAfterResume: input.refreshedAfterResume,
  }
}

const ARTIFACT_ROOT = path.resolve(process.env.AI_ARTIFACT_ROOT || path.join(process.cwd(), 'server', 'ai-artifacts'))
const running = new Set<string>()
let aiTaskWorkerStopping = false
const AI_TASK_WORKER_OWNER = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`
const AI_TASK_LEASE_SECONDS = (() => {
  const value = Number(process.env.AI_TASK_LEASE_SECONDS || 900)
  if (!Number.isSafeInteger(value) || value < 60) throw new Error('AI_TASK_LEASE_SECONDS must be an integer >= 60')
  return value
})()
const AUTO_RECOVERY_TASK_TYPES = new Set<AiExecutableTaskType>([
  'compliance_statement',
  'investment_proposal',
  'investment_recommendation_ppt',
  'due_diligence_report',
  'project_qa',
  'custom_template_document',
])
const NON_RETRYABLE_AI_TASK_ERROR_CODES = new Set([
  'CUSTOM_TEMPLATE_FORMAT_MISMATCH',
  'INVESTMENT_RECOMMENDATION_CONTENT_QUALITY_REJECTED',
  'GORDEN_VISIBLE_TEXT_CONTRACT_REJECTED',
  'TASK_NOT_FOUND',
  'PROJECT_NOT_FOUND',
  'TASK_ATTACHMENT_NOT_FOUND',
  'TASK_ATTACHMENT_PARSE_FAILED',
  'DUE_DILIGENCE_EVIDENCE_EMPTY',
  'DUE_DILIGENCE_PUBLIC_RESEARCH_AUDIT_REQUIRED',
  'DUE_DILIGENCE_SKILL_RUNTIME_UNAVAILABLE',
  'AI_TEMPLATE_REGISTRY_MISMATCH',
  'DIRECT_SKILL_AGENT_AUTH_OR_QUOTA',
])

export function classifyAiTaskFailure(error: unknown): AiTaskFailureClassification {
  const diagnostic = error as { code?: unknown; status?: unknown }
  const rawCode = typeof diagnostic?.code === 'string'
    ? diagnostic.code.trim().toUpperCase()
    : ''
  const errorCode = /^[A-Z][A-Z0-9_]{1,63}$/.test(rawCode)
    ? rawCode
    : 'AI_TASK_EXECUTION_FAILED'
  const status = Number(diagnostic?.status)
  const message = error instanceof Error ? error.message : String(error ?? '')
  const permanentMessage = /项目不存在|模板不存在|输出格式应为|缺少 Document Blueprint|缺少Document Blueprint/.test(message)
  const permanentStatus = Number.isInteger(status)
    && status >= 400
    && status < 500
    && status !== 408
    && status !== 429
  return {
    errorCode,
    retryable: !NON_RETRYABLE_AI_TASK_ERROR_CODES.has(errorCode)
      && !permanentMessage
      && !permanentStatus,
  }
}

async function authorizedArtifactPath(storagePath: string): Promise<{ resolved: string; size: number } | undefined> {
  const resolved = path.resolve(storagePath)
  if (!resolved.startsWith(ARTIFACT_ROOT + path.sep)) return undefined
  const [rootReal, fileReal, linkInfo, fileStat] = await Promise.all([
    realpath(ARTIFACT_ROOT).catch(() => ARTIFACT_ROOT),
    realpath(resolved).catch(() => null),
    lstat(resolved).catch(() => null),
    stat(resolved).catch(() => null),
  ])
  if (!fileReal || !linkInfo || linkInfo.isSymbolicLink() || !fileStat?.isFile()) return undefined
  if (fileReal !== rootReal && !fileReal.startsWith(rootReal + path.sep)) return undefined
  return { resolved, size: fileStat.size }
}

function aiTaskLeaseExpiry(): Date {
  return new Date(Date.now() + AI_TASK_LEASE_SECONDS * 1_000)
}

export async function claimAiTaskForExecution(taskId: string): Promise<boolean> {
  if (aiTaskWorkerStopping) return false
  return aiTaskRepository.claimTask({
    taskId,
    leaseOwner: AI_TASK_WORKER_OWNER,
    leaseExpiresAt: aiTaskLeaseExpiry(),
    updatedAt: new Date(),
  })
}

async function retryDocumentStep<T>(
  label: string,
  operation: (attempt: number) => Promise<T>,
  maxAttempts = 2,
) {
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation(attempt)
    } catch (error) {
      lastError = error
      console.warn(
        `[aiTask] ${label}第 ${attempt} 次未完成${attempt < maxAttempts ? '，自动再次生成' : ''}:`,
        (error as Error).message,
      )
    }
  }
  throw lastError
}

async function withTaskHeartbeat<T>(
  taskId: string,
  operation: () => Promise<T>,
  options: {
    startProgress: number
    endProgress: number
    stage: (elapsedSeconds: number) => string
  },
) {
  const startedAt = Date.now()
  let progressWrite = Promise.resolve()
  const heartbeat = setInterval(() => {
    const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
    const progress = Math.min(
      options.endProgress,
      options.startProgress + Math.floor(elapsedSeconds / 15),
    )
    progressWrite = progressWrite
      .then(() => updateStage(taskId, options.stage(elapsedSeconds), progress))
      .catch((error) => {
        console.warn('[aiTask] 任务进度心跳写入未完成:', (error as Error).message)
      })
  }, 15_000)
  heartbeat.unref?.()
  try {
    return await operation()
  } finally {
    clearInterval(heartbeat)
    await progressWrite
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function createRequestHash(input: CreateAiTaskInput) {
  return createHash('sha256').update(canonicalJson({
    type: input.type,
    projectId: input.projectId,
    conversationId: input.conversationId ?? null,
    parameters: input.parameters,
    ...(input.retryOfTaskId ? { retryOfTaskId: input.retryOfTaskId } : {}),
  })).digest('hex')
}

function requestIdentityForStoredTask(task: AiTaskRecord): CreateAiTaskInput {
  return {
    type: task.type as AiExecutableTaskType,
    projectId: task.projectId,
    conversationId: task.conversationId ?? undefined,
    parameters: (task.parameters ?? {}) as Record<string, unknown>,
    idempotencyKey: task.idempotencyKey,
    retryOfTaskId: task.retryOfTaskId ?? undefined,
  }
}

function legacyRequestHashWithoutRetrySource(input: CreateAiTaskInput) {
  return createHash('sha256').update(canonicalJson({
    type: input.type,
    projectId: input.projectId,
    conversationId: input.conversationId ?? null,
    parameters: input.parameters,
  })).digest('hex')
}

async function findIdempotentAiTask(userId: string, input: CreateAiTaskInput) {
  const existing = await aiTaskRepository.findTaskByIdempotency(userId, input.idempotencyKey)
  if (!existing) return undefined
  const expectedHash = createRequestHash(input)
  const storedIdentity = requestIdentityForStoredTask(existing)
  const storedHash = existing.requestHash || createRequestHash(storedIdentity)
  const exactLegacyRetryReplay = Boolean(
    existing.requestHash
    && existing.retryOfTaskId
    && input.retryOfTaskId === existing.retryOfTaskId
    && existing.requestHash === legacyRequestHashWithoutRetrySource(input)
    && existing.requestHash === legacyRequestHashWithoutRetrySource(storedIdentity),
  )
  if (storedHash !== expectedHash && !exactLegacyRetryReplay) {
    throw Object.assign(new Error('该幂等键已用于不同的任务参数'), {
      status: 409,
      code: 'IDEMPOTENCY_CONFLICT',
    })
  }
  await recordJobCoordinationEventSafely({
    domain: 'ai-task', entityId: existing.id, event: 'duplicateSuppressed',
  })
  return existing
}

function publicArtifact(row: AiArtifactRecord) {
  const { storagePath: _storagePath, ...safe } = row
  return {
    ...safe,
    downloadUrl: `/api/ai/artifacts/${row.id}/download`,
  }
}

async function userCanAccessProject(user: AiTaskUser, projectId: string) {
  const project = await getAccessibleProject(user.uid, projectId)
  return {
    allowed: Boolean(project),
    project: project ?? undefined,
    reason: project ? '' : '项目不存在或无权访问',
  }
}

async function writeTaskAudit(user: AiTaskUser, action: string, target: string) {
  await identityRepositories.audits.append({
    userId: user.uid,
    userName: user.name,
    module: 'AI 智能助手',
    action,
    target,
  })
}

type RequiredProjectFile = {
  sourceId: string
  sourceName: string
}

type ProjectSourceLoadResult = {
  sources: EvidenceSource[]
  requiredProjectFiles: RequiredProjectFile[]
}

async function sourcesForProject(
  projectId: string,
  sourceCutoffDate: string,
  limit = 40,
  options: { completeProjectFileCoverage?: boolean } = {},
): Promise<ProjectSourceLoadResult> {
  const cutoff = new Date(`${sourceCutoffDate}T23:59:59.999+08:00`)
  const projectFileQuery = db.select({
    id: projectFiles.id,
    name: projectFiles.name,
    parseStatus: projectFiles.parseStatus,
    contentText: projectFiles.contentText,
    uploadedAt: projectFiles.uploadedAt,
  }).from(projectFiles)
    .where(and(
      eq(projectFiles.projectId, projectId),
      lte(projectFiles.uploadedAt, cutoff),
    ))
    .orderBy(asc(projectFiles.uploadedAt), asc(projectFiles.name))
  const knowledgeQuery = db.select().from(knowledgeChunks)
      .where(and(
        eq(knowledgeChunks.scope, 'project'),
        eq(knowledgeChunks.refId, projectId),
        lte(knowledgeChunks.createdAt, cutoff),
      ))
      .orderBy(
        sql`CASE
          WHEN lower(${knowledgeChunks.sourceName}) LIKE 'perf\_%'
            OR lower(${knowledgeChunks.sourceName}) LIKE 'localperf\_%'
            OR ${knowledgeChunks.sourceName} LIKE '%大文件测试%'
            OR ${knowledgeChunks.sourceName} LIKE '%解析测试%'
            OR ${knowledgeChunks.sourceName} LIKE '%卡住排查%'
            OR ${knowledgeChunks.sourceName} LIKE '%异步上传%'
            OR ${knowledgeChunks.sourceName} LIKE '%日志测试%'
            OR ${knowledgeChunks.sourceName} LIKE '%需求1复核%'
            OR lower(${knowledgeChunks.sourceName}) LIKE 'csv测试%'
            OR lower(${knowledgeChunks.sourceName}) LIKE 'pptx测试%'
            OR lower(${knowledgeChunks.sourceName}) LIKE 'txt测试%'
          THEN 2
          WHEN ${knowledgeChunks.sourceType} LIKE 'public_web%' THEN 1
          ELSE 0
        END`,
        asc(knowledgeChunks.sourceName),
        asc(knowledgeChunks.chunkIndex),
      )
  // 历史文件可能已解析进 file_chunks，但知识库双写曾失败。这里直接兜底读取，
  // 避免“资料库有文件、生成任务却判无资料”。
  const legacyFileQuery = db.select().from(fileChunks)
      .where(and(
        eq(fileChunks.projectId, projectId),
        lte(fileChunks.createdAt, cutoff),
      ))
      .orderBy(
        sql`CASE
          WHEN lower(${fileChunks.fileName}) LIKE 'perf\_%'
            OR lower(${fileChunks.fileName}) LIKE 'localperf\_%'
            OR ${fileChunks.fileName} LIKE '%大文件测试%'
            OR ${fileChunks.fileName} LIKE '%解析测试%'
            OR ${fileChunks.fileName} LIKE '%卡住排查%'
            OR ${fileChunks.fileName} LIKE '%异步上传%'
            OR ${fileChunks.fileName} LIKE '%日志测试%'
            OR ${fileChunks.fileName} LIKE '%需求1复核%'
            OR lower(${fileChunks.fileName}) LIKE 'csv测试%'
            OR lower(${fileChunks.fileName}) LIKE 'pptx测试%'
            OR lower(${fileChunks.fileName}) LIKE 'txt测试%'
          THEN 1
          ELSE 0
        END`,
        asc(fileChunks.fileName),
        asc(fileChunks.chunkIndex),
      )
  const projectFileRows = await projectFileQuery
  if (options.completeProjectFileCoverage) {
    const notReady = projectFileRows.filter((row) => row.parseStatus !== '成功')
    if (notReady.length > 0) {
      const names = notReady.slice(0, 6)
        .map((row) => `${row.name}（${row.parseStatus}）`)
        .join('、')
      throw new Error(`项目资料尚未全部解析成功，不能执行完整资料生成：${names}${notReady.length > 6 ? `等 ${notReady.length} 份` : ''}`)
    }
  }
  const [rows, legacyFileRows] = options.completeProjectFileCoverage
    ? await Promise.all([knowledgeQuery, legacyFileQuery])
    : await Promise.all([knowledgeQuery.limit(limit), legacyFileQuery.limit(limit)])
  const knowledgeSources = rows.filter((row) =>
    !isDiagnosticEvidenceSourceName(row.sourceName)).map((row) => {
    const cachedUrl = row.sourceType.startsWith('public_web')
      ? row.content.match(/(?:来源网址|规范化\s*URL|页面\s*URL)[:：]\s*(https?:\/\/\S+)/i)?.[1]
      : undefined
    return {
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      sourceName: row.sourceName || '项目资料',
      chunkIndex: row.chunkIndex,
      versionOrDate: formatShanghaiDateKey(row.createdAt),
      locator: cachedUrl,
      content: row.content,
    }
  })
  const contentHashes = new Set(knowledgeSources.map((source) =>
    createHash('sha256').update(source.content.trim()).digest('hex')))
  const legacyFileSources: EvidenceSource[] = []
  for (const row of legacyFileRows) {
    if (isDiagnosticEvidenceSourceName(row.fileName)) continue
    const content = row.content.trim()
    if (!content) continue
    const contentHash = createHash('sha256').update(content).digest('hex')
    if (contentHashes.has(contentHash)) continue
    contentHashes.add(contentHash)
    legacyFileSources.push({
      sourceType: 'file',
      sourceId: row.fileId,
      sourceName: row.fileName || '项目文件',
      chunkIndex: row.chunkIndex,
      versionOrDate: formatShanghaiDateKey(row.createdAt),
      content,
    })
  }
  const sources = [...knowledgeSources, ...legacyFileSources]
  const requiredProjectFiles = options.completeProjectFileCoverage
    ? projectFileRows
      .filter((row) => !isDiagnosticEvidenceSourceName(row.name))
      .map((row) => ({ sourceId: row.id, sourceName: row.name }))
    : []
  const representedFileIds = new Set(sources
    .filter((source) => !source.sourceType.startsWith('public_web'))
    .map((source) => source.sourceId)
    .filter((sourceId): sourceId is string => Boolean(sourceId)))
  const rowsById = new Map(projectFileRows.map((row) => [row.id, row]))
  for (const file of requiredProjectFiles) {
    if (representedFileIds.has(file.sourceId)) continue
    const row = rowsById.get(file.sourceId)
    const content = row?.contentText?.trim()
    if (!row || !content) {
      throw new Error(`项目资料缺少可研读正文，不能执行完整资料生成：${file.sourceName}`)
    }
    // 极少数历史文件只有 project_files.content_text，没有分块记录。
    // 仍将全文交给后续清洗和代表片段选择，避免静默漏掉该文件。
    sources.push({
      sourceType: 'file',
      sourceId: file.sourceId,
      sourceName: file.sourceName,
      chunkIndex: 0,
      versionOrDate: formatShanghaiDateKey(row.uploadedAt),
      content,
    })
  }
  return { sources, requiredProjectFiles }
}

async function cacheProjectNetworkEvidence(projectId: string, sources: EvidenceSource[]) {
  const cacheable = sources.filter((source) =>
    source.sourceType.startsWith('public_web') && source.sourceId && source.locator)
  for (const source of cacheable) {
    const [existing] = await db.select({ id: knowledgeChunks.id }).from(knowledgeChunks)
      .where(and(
        eq(knowledgeChunks.scope, 'project'),
        eq(knowledgeChunks.refId, projectId),
        eq(knowledgeChunks.sourceType, source.sourceType),
        eq(knowledgeChunks.sourceId, source.sourceId!),
      ))
      .limit(1)
    if (existing) continue
    await db.insert(knowledgeChunks).values({
      scope: 'project',
      refId: projectId,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      sourceName: source.sourceName,
      chunkIndex: source.chunkIndex ?? 0,
      content: [
        source.content,
        source.locator ? `来源网址：${source.locator}` : '',
      ].filter(Boolean).join('\n'),
    })
  }
}

function complianceNetworkResearchTopics(
  sources: EvidenceSource[],
  project: {
    name: string
    companyName?: string | null
    industry?: string | null
  },
  parameters: Record<string, unknown>,
) {
  const subject = project.companyName || project.name
  const userIntent = [
    typeof parameters.researchIntent === 'string' ? parameters.researchIntent : '',
    typeof parameters.userInstructions === 'string' ? parameters.userInstructions : '',
  ].map((value) => value.trim()).find(Boolean)
  const compactUserIntent = userIntent?.replace(/\s+/g, ' ').slice(0, 300) ?? ''
  const packets = buildComplianceEvidencePackets(sources)
  const emptySections = new Set(
    packets.filter((packet) => packet.items.length === 0).map((packet) => packet.sectionTitle),
  )
  const cachedPublicText = sources
    .filter((source) => source.sourceType.startsWith('public_web'))
    .map((source) => `${source.sourceName}\n${source.content}`)
    .join('\n')
  const fundEntities = [...new Set(
    sources
      .filter((source) => !source.sourceType.startsWith('public_web'))
      .flatMap((source) =>
        source.content.match(/[\u3400-\u9fffA-Za-z0-9（）()·-]{2,36}(?:基金|合伙企业)/g) ?? [])
      .map((name) => name.trim())
      .filter((name) => name.length <= 40),
  )].slice(0, 2)
  const fundScope = fundEntities.length ? `${fundEntities.join('、')} ` : ''
  const topics: string[] = compactUserIntent
    ? [`${subject} ${compactUserIntent}`]
    : []

  if (['公司简介', '核心团队', '产品及技术'].some((title) => emptySections.has(title))) {
    topics.push(`${subject} 公司简介、主体工商、核心团队、创始人、产品技术、知识产权、客户和商业化公开信息`)
  }
  if (emptySections.has('投资理由') || !/行业政策|市场趋势|产业政策/.test(cachedPublicText)) {
    topics.push(`${project.industry || '项目所属细分领域'} 行业政策、市场趋势和产业政策公开依据`)
  }
  if (emptySections.has('投资计划') || !/融资|估值|投资方|资金用途/.test(cachedPublicText)) {
    topics.push('融资事件、投资方、估值、交易方式和资金用途公开信息')
  }
  if (!/返投|投资限制|返投认定|返投台账/.test(cachedPublicText)) {
    topics.push(`${fundScope}投资方式、投资限制、返投政策、返投认定口径及可公开查询的返投记录`)
  }
  if (!/关联交易|投资方向|投资配置|SPV|集中度/.test(cachedPublicText)) {
    topics.push('关联交易、投资方向、SPV或直投配置和投资集中度监管规则')
  }
  if (!/许可|备案|处罚|诉讼|失信|制裁|监管/.test(cachedPublicText)) {
    topics.push('许可备案、处罚诉讼、失信制裁和其他监管合规公开信息')
  }

  return topics.slice(0, 8)
}

function sharedInvestmentResearchTopics(
  type: AiExecutableTaskType,
  project: {
    name: string
    companyName?: string | null
    industry?: string | null
  },
  parameters: Record<string, unknown>,
) {
  const subject = project.companyName || project.name
  const intent = typeof parameters.researchIntent === 'string'
    ? parameters.researchIntent.trim()
    : ''
  if (type === 'investment_recommendation_ppt') {
    const chapterResearch: Record<ProjectQaResearchTopic, string> = {
      '项目主体与工商': '法律主体、成立时间、注册资本、所在地和历史沿革',
      '股权、治理与关联关系': '股权结构、实际控制人、董事治理和关联关系',
      '创始人与核心团队': '创始人、核心团队履历、分工和任职关系',
      '产品、技术指标与工程化里程碑': '具名产品、技术路线、性能指标、工程化和交付进展',
      '知识产权与研发合作': '专利、软件著作权、论文、研发合作和权属',
      '客户、订单与商业化信号': '客户、测试、合同、订单、交付、验收、收入、回款和复购',
      '财务与现金流': '历史收入、成本、毛利、利润、现金流、应收回款和管理层预测',
      '融资、估值与投资方': '历史融资、本轮融资、投资方、投前投后估值和资金用途',
      '交易方案与关键条款': '投资金额、增资或老股、持股比例、交割条件、治理和保护性条款',
      '行业、市场空间与政策': `${project.industry || '所属细分行业'}定义、TAM/SAM/SOM、市场规模、增长率、渗透率、需求和政策`,
      '竞品、替代方案与项目级对标': '具名竞品、替代方案、产品参数、价格、客户场景、融资和商业化对标',
      '监管、诉讼与重大风险': '资质、行政处罚、诉讼、失信、监管和其他可能影响交易的风险',
    }
    return [...new Set([
      ...(intent ? [`${subject} ${intent}`] : []),
      ...PROJECT_QA_RESEARCH_TOPICS.map((topic) =>
        `${subject} ${chapterResearch[topic]}`),
    ])]
  }
  const common = [
    `${subject} 公司主体、股东与治理、创始人和核心团队`,
    `${subject} 产品、技术指标、知识产权、研发合作和工程化进展`,
    `${subject} 客户、合同、订单、交付、验收、收入、回款和商业化进展`,
    `${subject} 融资轮次、融资金额、投资方、估值、资金用途和交易事项`,
    `${subject} 行政处罚、诉讼、失信、监管、资质和其他重大风险`,
  ]
  const typeSpecific = type === 'investment_proposal'
    ? [`${subject} 商业模式、财务表现、投资亮点、交易条件和退出路径`]
    : type === 'due_diligence_report'
        ? [`${subject} 财务报表、现金流、关联交易、劳动用工和合规事项`]
        : type === 'project_qa'
          ? [`${subject} 近期进展、争议事项、公开回应和下一步投资核验重点`]
          : [`${subject} 近期公开进展、商业化信号和投资判断所需关键信息`]
  return [...new Set([
    ...(intent ? [`${subject} ${intent}`] : []),
    ...common,
    ...typeSpecific,
  ])].slice(0, 7)
}

function investmentRecommendationWebTopicsForSources(
  sources: readonly EvidenceSource[],
  maxTopics = 12,
): ProjectQaResearchTopic[] {
  return [...new Set<ProjectQaResearchTopic>([
    ...PROJECT_QA_RESEARCH_TOPICS,
    ...projectWebResearchTopicsForSources(sources, maxTopics),
  ])].slice(0, maxTopics)
}

function compactEvidenceName(value: unknown) {
  return String(value ?? '')
    .replace(/(?:有限责任公司|股份有限公司|有限公司|项目)$/g, '')
    .replace(/[“”"'《》\s]+/g, '')
}

/**
 * 历史公开网页缓存可能由同项目下的其他任务产生。只有命中当前主体，
 * 或明确标记为当前项目行业上下文的页面，才允许进入本次生成。
 */
export function evidenceSourceMatchesProject(
  source: EvidenceSource,
  project: {
    name: string
    companyName?: string | null
    industry?: string | null
  },
) {
  if (!source.sourceType.startsWith('public_web')) return true
  const text = `${source.sourceName}\n${source.content}`.replace(/\s+/g, '')
  const entityNames = [...new Set([
    compactEvidenceName(project.companyName),
    compactEvidenceName(project.name),
  ].filter((value) => value.length >= 2))]
  if (entityNames.some((name) => text.includes(name))) return true
  if (!/项目匹配：行业上下文一致/.test(source.content)) return false
  const generic = new Set(['科技', '技术', '智能', '人工智能', '软件', '硬件', '制造业', '服务业'])
  const industryTerms = String(project.industry ?? '')
    .split(/[、，,；;\/|·\s]+/)
    .map(compactEvidenceName)
    .filter((value) => value.length >= 3 && !generic.has(value))
  return industryTerms.some((term) => text.includes(term))
}

export function screenEvidenceSources(sources: EvidenceSource[], type?: AiExecutableTaskType) {
  const options = [
    'investment_proposal',
    'investment_recommendation_ppt',
    'project_qa',
    'due_diligence_report',
  ].includes(String(type))
    ? {
        guaranteeDocumentCoverage: true,
        retainAllUsable: true,
        preserveFullContent: true,
        retainEveryReadableChunk: true,
      }
    : type === 'compliance_statement'
      ? { maxTotal: 96, maxPerDocument: 12 }
      : type === 'custom_template_document'
          ? { maxTotal: 96, maxPerDocument: 4 }
          : { maxTotal: 18, maxPerDocument: 3 }
  const result = curateEvidenceSources(sources, options)
  // 本地项目资料优先，项目档案和用户补充输入其次，缓存公开证据最后。
  const priority = (sourceType: string) => {
    if (sourceType.startsWith('public_web')) return 2
    if (sourceType === 'project_record' || sourceType === 'user_input') return 1
    return 0
  }
  result.usable.sort((left, right) =>
    priority(left.sourceType) - priority(right.sourceType))
  return result
}

export function missingRequiredProjectFiles(
  requiredProjectFiles: readonly RequiredProjectFile[],
  sources: readonly EvidenceSource[],
) {
  const representedIds = new Set(sources
    .filter((source) => !source.sourceType.startsWith('public_web'))
    .map((source) => source.sourceId)
    .filter((sourceId): sourceId is string => Boolean(sourceId)))
  return requiredProjectFiles.filter((file) => !representedIds.has(file.sourceId))
}

function assertCompleteProjectFileCoverage(
  requiredProjectFiles: readonly RequiredProjectFile[],
  sources: readonly EvidenceSource[],
) {
  const missing = missingRequiredProjectFiles(requiredProjectFiles, sources)
  if (missing.length === 0) return
  const names = missing.slice(0, 8).map((file) => file.sourceName).join('、')
  throw new Error(
    `项目资料未实现完整研读覆盖，已停止生成：${names}${missing.length > 8 ? `等 ${missing.length} 份` : ''}`,
  )
}

function usesDirectInvestmentProposalAgent(type: string): boolean {
  return String(type) === 'investment_proposal'
}

function usesDirectInvestmentCommitteePptAgent(type: string): boolean {
  return String(type) === 'investment_recommendation_ppt'
}

function usesDirectQaOrDueDiligenceAgent(type: string): boolean {
  return type === 'project_qa' || type === 'due_diligence_report'
}

async function getTaskRow(userId: string, taskId: string) {
  return aiTaskRepository.findOwnedTask(userId, taskId)
}

async function isCancellationRequested(taskId: string) {
  const row = await aiTaskRepository.getTaskCancellationState(taskId)
  return !row
    || row.cancellationRequested
    || row.status === 'cancelled'
    || row.leaseOwner !== AI_TASK_WORKER_OWNER
}

async function updateStage(taskId: string, stage: string, progress: number) {
  const boundedProgress = Math.max(0, Math.min(100, Math.round(progress)))
  await aiTaskRepository.updateRunningStage({
    taskId,
    leaseOwner: AI_TASK_WORKER_OWNER,
    stage,
    progress: boundedProgress,
    updatedAt: new Date(),
  })
}

type InvestmentRecommendationResumeCheckpoint = {
  content: BusinessContent
  sourceSnapshots: Array<Record<string, unknown>>
  checkpointPath: string
}

export function auditableTaskSourceIndexes(
  usedSourceIndexes: number[],
  sources: readonly EvidenceSource[],
) {
  const valid = [...new Set(usedSourceIndexes.filter((index) =>
    Number.isInteger(index) && index >= 0 && index < sources.length))]
  if (valid.length > 0) return valid
  const projectRecordIndex = sources.findIndex((source) => source.sourceType === 'project_record')
  return projectRecordIndex >= 0 ? [projectRecordIndex] : []
}

export function auditableTaskSources(
  usedSourceIndexes: number[],
  sources: readonly EvidenceSource[],
  rawSources: readonly EvidenceSource[] = sources,
) {
  const selected = auditableTaskSourceIndexes(usedSourceIndexes, sources)
    .map((index) => sources[index])
    .filter((source): source is EvidenceSource => Boolean(source))
  if (selected.length > 0) return selected
  const projectRecord = rawSources.find((source) => source.sourceType === 'project_record')
  return projectRecord ? [projectRecord] : []
}

export function investmentRecommendationReviewProjectName(project: {
  name: string
  companyName?: string | null
}) {
  return String(project.companyName || '').trim() || project.name
}

function checkpointSourceIdentity(source: Record<string, unknown>) {
  return [
    String(source.sourceType ?? source.type ?? ''),
    String(source.sourceName ?? source.name ?? source.title ?? ''),
    String(source.locator ?? ''),
    String(source.versionOrDate ?? source.version_or_date ?? ''),
  ].join('\u001f')
}

function isBusinessContentCheckpoint(value: unknown): value is BusinessContent {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.title === 'string'
    && typeof record.executiveSummary === 'string'
    && Array.isArray(record.sections)
    && Array.isArray(record.highlights)
    && Array.isArray(record.risks)
    && Array.isArray(record.missing)
}

export function remapInvestmentRecommendationCheckpointSources(input: {
  content: BusinessContent
  checkpointSources: Array<Record<string, unknown>>
  currentSources: EvidenceSource[]
}) {
  const currentQueues = new Map<string, number[]>()
  input.currentSources.forEach((source, index) => {
    const key = checkpointSourceIdentity(source as unknown as Record<string, unknown>)
    currentQueues.set(key, [...(currentQueues.get(key) ?? []), index])
  })
  const indexMap = new Map<number, number>()
  input.checkpointSources.forEach((source, index) => {
    const exactCurrent = input.currentSources[index]
    const identity = checkpointSourceIdentity(source)
    const queue = currentQueues.get(identity) ?? []
    if (
      exactCurrent
      && checkpointSourceIdentity(exactCurrent as unknown as Record<string, unknown>)
        === identity
      && queue.includes(index)
    ) {
      indexMap.set(index, index)
      const position = queue.indexOf(index)
      if (position >= 0) queue.splice(position, 1)
      return
    }
    const next = queue.shift()
    if (next !== undefined) indexMap.set(index, next)
  })
  const remap = (indexes: number[] | undefined) => [...new Set((indexes ?? [])
    .map((index) => indexMap.get(index))
    .filter((index): index is number => index !== undefined))]
  const content = JSON.parse(JSON.stringify(input.content)) as BusinessContent
  content.executiveSummarySourceIndexes = remap(content.executiveSummarySourceIndexes)
  for (const section of content.sections) {
    section.summarySourceIndexes = remap(section.summarySourceIndexes)
    for (const finding of section.findings) finding.sourceIndexes = remap(finding.sourceIndexes)
    for (const table of section.tables ?? []) table.sourceIndexes = remap(table.sourceIndexes)
  }
  return content
}

async function loadInvestmentRecommendationResumeCheckpoint(
  directory: string | undefined,
  currentSources: EvidenceSource[],
) {
  if (!directory) return undefined
  const candidates: Array<{ path: string; modifiedAt: number }> = []
  const directPath = path.join(directory, '.investment-recommendation-checkpoint.json')
  const directStat = await stat(directPath).catch(() => undefined)
  if (directStat?.isFile()) candidates.push({ path: directPath, modifiedAt: directStat.mtimeMs })
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('.gorden-super-ppt-')) continue
    const projectFactsPath = path.join(directory, entry.name, 'project-facts.json')
    const projectFactsStat = await stat(projectFactsPath).catch(() => undefined)
    if (projectFactsStat?.isFile()) {
      candidates.push({ path: projectFactsPath, modifiedAt: projectFactsStat.mtimeMs })
    }
  }
  for (const candidate of candidates.sort((left, right) => right.modifiedAt - left.modifiedAt)) {
    try {
      const parsed = JSON.parse(await readFile(candidate.path, 'utf8')) as Record<string, unknown>
      const content = parsed.content ?? parsed.verifiedContent
      const sourceSnapshots = Array.isArray(parsed.sources)
        ? parsed.sources.filter((source): source is Record<string, unknown> => (
            Boolean(source) && typeof source === 'object'
          ))
        : []
      if (!isBusinessContentCheckpoint(content) || !sourceSnapshots.length) continue
      return {
        content: remapInvestmentRecommendationCheckpointSources({
          content,
          checkpointSources: sourceSnapshots,
          currentSources,
        }),
        sourceSnapshots,
        checkpointPath: candidate.path,
      } satisfies InvestmentRecommendationResumeCheckpoint
    } catch {
      // Ignore incomplete or incompatible checkpoints and continue from scratch.
    }
  }
  return undefined
}

async function saveInvestmentRecommendationCheckpoint(input: {
  checkpointPath: string
  content: BusinessContent
  sources: EvidenceSource[]
}) {
  const temporaryPath = `${input.checkpointPath}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, JSON.stringify({
    schemaVersion: '1.0',
    content: input.content,
    sources: input.sources,
  }), 'utf8')
  await rename(temporaryPath, input.checkpointPath)
}

function requestedAttachmentFileIds(parameters: Record<string, unknown>) {
  const values = Array.isArray(parameters.attachmentFileIds)
    ? parameters.attachmentFileIds
    : []
  return [...new Set(values.filter((value): value is string =>
    typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
  ))].slice(0, 10)
}

async function waitForRequestedAttachments(
  taskId: string,
  projectId: string,
  fileIds: string[],
) {
  if (!fileIds.length) return true
  const timeoutMs = Math.max(
    10_000,
    Number(process.env.AI_TASK_ATTACHMENT_WAIT_MS || 5 * 60_000),
  )
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isCancellationRequested(taskId)) return false
    const rows = await db.select({
      id: projectFiles.id,
      name: projectFiles.name,
      parseStatus: projectFiles.parseStatus,
      parseError: projectFiles.parseError,
    }).from(projectFiles).where(and(
      eq(projectFiles.projectId, projectId),
      inArray(projectFiles.id, fileIds),
    ))
    const missingCount = fileIds.length - rows.length
    if (missingCount > 0) {
      throw Object.assign(new Error('本轮上传文件不存在或不属于当前项目'), {
        code: 'TASK_ATTACHMENT_NOT_FOUND',
      })
    }
    const failed = rows.filter((row) => row.parseStatus === '失败')
    if (failed.length > 0) {
      throw Object.assign(
        new Error(`本轮附件解析失败：${failed.map((row) =>
          `${row.name}${row.parseError ? `（${row.parseError}）` : ''}`).join('、')}`),
        { code: 'TASK_ATTACHMENT_PARSE_FAILED' },
      )
    }
    const completed = rows.filter((row) => row.parseStatus === '成功').length
    if (completed === rows.length) return true
    await updateStage(
      taskId,
      `等待本轮附件解析（${completed}/${rows.length}）`,
      12,
    )
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw Object.assign(new Error('本轮附件解析超时，请稍后重试生成'), {
    code: 'TASK_ATTACHMENT_PARSE_TIMEOUT',
  })
}

function isTemplatePreparationPending(parameters: Record<string, unknown> | null | undefined) {
  return parameters?._templatePreparationPending === true
}

async function cancelIfRequested(taskId: string) {
  if (!(await isCancellationRequested(taskId))) return false
  await aiTaskRepository.markTaskCancelledByLease({
    taskId,
    leaseOwner: AI_TASK_WORKER_OWNER,
    completedAt: new Date(),
  })
  return true
}

async function inspectGeneratedArtifact(
  filePath: string,
  format: 'docx' | 'pptx',
  options: {
    requireEndReferences?: boolean
    allowInheritedCjkLanguageMetadata?: boolean
    expectedSectionTitles?: string[]
    expectedTableCount?: number
    deliveryIntegrityOnly?: boolean
  } = {},
) {
  const fileStat = await stat(filePath)
  if (!fileStat.isFile() || fileStat.size < 1000) throw new Error('生成文件为空或不完整')
  const zip = await JSZip.loadAsync(await import('node:fs/promises').then((fs) => fs.readFile(filePath)))
  if (format === 'docx') {
    if (!zip.file('word/document.xml')) throw new Error('DOCX 缺少 document.xml')
    if (options.deliveryIntegrityOnly) {
      return {
        qualityStatus: 'passed',
        metadata: {
          bytes: fileStat.size,
          openXmlReadable: true,
          deliveryReady: true,
          validationScope: 'file-integrity-only',
        },
      }
    }
    const documentXml = await zip.file('word/document.xml')!.async('string')
    if (!documentXml.includes('<w:t')) throw new Error('DOCX 没有可编辑文本')
    if (documentXml.includes('\uFFFD')) throw new Error('DOCX 正文包含损坏的 Unicode 字符')
    if (/w:eastAsia="Arial Unicode MS"/.test(documentXml)) throw new Error('DOCX 使用了不兼容的中文字体')
    const requireEndReferences = options.requireEndReferences ?? true
    if (requireEndReferences && !documentXml.includes('引用资料')) {
      throw new Error('DOCX 文尾缺少引用资料')
    }
    const visibleText = documentXml.replace(/<[^>]+>/g, '')
    const expectedSectionTitles = options.expectedSectionTitles ?? []
    let sectionOffset = 0
    const sectionTreeValidated = expectedSectionTitles.every((title) => {
      const index = visibleText.indexOf(title, sectionOffset)
      if (index < 0) return false
      sectionOffset = index + title.length
      return true
    })
    const tableCount = (documentXml.match(/<w:tbl\b/g) || []).length
    const expectedTableCountValidated = options.expectedTableCount === undefined
      || tableCount === options.expectedTableCount
    const finalSection = [...documentXml.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)].at(-1)?.[0] ?? ''
    const pageSize = finalSection.match(/<w:pgSz\b[^>]*\/?>/)?.[0] ?? ''
    const pageWidth = Number.parseInt(pageSize.match(/\bw:w="(\d+)"/)?.[1] ?? '-1', 10)
    const pageHeight = Number.parseInt(pageSize.match(/\bw:h="(\d+)"/)?.[1] ?? '-1', 10)
    const a4PageValidated = pageWidth === 11906 && pageHeight === 16838
    return {
      qualityStatus: 'passed',
      metadata: {
        bytes: fileStat.size,
        editableText: true,
        encodingClean: true,
        cjkFontValidated: true,
        endReferencesValidated: requireEndReferences,
        stylesPartValidated: Boolean(zip.file('word/styles.xml')),
        fontTablePartValidated: Boolean(zip.file('word/fontTable.xml')),
        sectionTreeValidated,
        expectedSectionCount: expectedSectionTitles.length,
        tableCount,
        expectedTableCount: options.expectedTableCount,
        expectedTableCountValidated,
        a4PageValidated,
      },
    }
  }
  const pptxQualityError = (message: string, code: string) =>
    Object.assign(new Error(message), { code })
  if (!zip.file('ppt/presentation.xml')) {
    throw pptxQualityError('PPTX 缺少 presentation.xml', 'PPTX_OPENXML_INVALID')
  }
  if (options.deliveryIntegrityOnly) {
    return {
      qualityStatus: 'passed',
      metadata: {
        bytes: fileStat.size,
        openXmlReadable: true,
        deliveryReady: true,
        validationScope: 'file-integrity-only',
      },
    }
  }
  const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
  let editableTextElements = 0
  for (const name of slides) {
    const xml = await zip.file(name)!.async('string')
    if (xml.includes('\uFFFD')) {
      throw pptxQualityError(
        `PPTX ${name} 包含损坏的 Unicode 字符`,
        'PPTX_UNICODE_INVALID',
      )
    }
    const textRuns = [
      ...xml.matchAll(/<a:r\b[\s\S]*?<\/a:r>/g),
      ...xml.matchAll(/<a:fld\b[\s\S]*?<\/a:fld>/g),
    ].map((match) => match[0])
    if (
      !options.allowInheritedCjkLanguageMetadata
      && textRuns.some((run) =>
        /lang="en-US"/.test(run)
        && /<a:t\b[^>]*>[^<]*[\u3400-\u9FFF]/.test(run))
    ) {
      throw pptxQualityError(
        `PPTX ${name} 的中文文本语言标记错误`,
        'PPTX_CJK_LANGUAGE_INVALID',
      )
    }
    editableTextElements += (xml.match(/<a:t>/g) || []).length
  }
  const finalSlideXml = await zip.file(`ppt/slides/slide${slides.length}.xml`)?.async('string') || ''
  if (!/(?:资料来源与声明|引用资料与责任声明)/.test(finalSlideXml)) {
    throw pptxQualityError(
      'PPTX 最后一页缺少资料来源与声明',
      'PPTX_REFERENCES_MISSING',
    )
  }
  const themeXml = await zip.file('ppt/theme/theme1.xml')?.async('string')
  const themeFontTags = themeXml?.match(/<a:font\b[^>]*>/g) ?? []
  const hasEastAsiaThemeFont = !!themeXml && (
    /<a:ea[^>]+typeface="[^"]+"/.test(themeXml)
    || themeFontTags.some((tag) =>
      /script="Hans"/.test(tag) && /typeface="[^"]+"/.test(tag))
  )
  if (!hasEastAsiaThemeFont) {
    throw pptxQualityError('PPTX 缺少东亚主题字体', 'PPTX_CJK_THEME_MISSING')
  }
  if (slides.length < 3 || editableTextElements < slides.length * 2) {
    throw pptxQualityError(
      'PPTX 可编辑文本元素不足',
      'PPTX_EDITABLE_CONTENT_INSUFFICIENT',
    )
  }
  return {
    qualityStatus: 'passed',
    metadata: {
      bytes: fileStat.size,
      slideCount: slides.length,
      editableTextElements,
      openXmlValid: true,
      encodingClean: true,
      cjkFontValidated: true,
      endReferencesValidated: true,
    },
  }
}

async function executeTask(taskId: string) {
  return runWithAiTaskModelUsage({
    taskId,
    onModelCall: async (usage) => {
      await aiTaskRepository.addTaskModelUsage({
        taskId,
        usage,
        updatedAt: new Date(),
      }).catch((error) => {
        // Usage persistence must never turn a successfully generated document
        // into a failed document task. Coverage is exposed to the UI so a
        // missing provider usage payload remains visible rather than estimated.
        console.warn(`[aiTask] token usage persistence failed task=${taskId}:`, (error as Error).message)
      })
    },
  }, () => executeTaskWithinUsage(taskId))
}

async function executeTaskWithinUsage(taskId: string) {
  if (aiTaskWorkerStopping || running.has(taskId)) return
  running.add(taskId)
  let rescheduleAfterRecovery = false
  let leaseHeartbeat: NodeJS.Timeout | undefined
  try {
    const task = await aiTaskRepository.findTaskById(taskId)
    if (!task || !isAiExecutableTaskType(task.type) || ['succeeded', 'cancelled'].includes(task.status)) return
    const parameters = (task.parameters ?? {}) as Record<string, unknown>
    const retrySourceTask = task.type === 'investment_recommendation_ppt' && task.retryOfTaskId
      ? await aiTaskRepository.findTaskById(task.retryOfTaskId)
      : null
    const resumeProgressFloor = Math.max(
      0,
      Math.min(
        99,
        Math.max(
          Number(parameters._resumeProgressFloor ?? 0) || 0,
          task.type === 'investment_recommendation_ppt' && task.retryOfTaskId
            ? Number(retrySourceTask?.progress ?? 0) || 0
            : 0,
        ),
      ),
    )
    // 上传模板时会先创建正式任务记录，但模板分析完成前不能进入文档生成流水线。
    if (isTemplatePreparationPending(parameters)) return
    if (!(await claimAiTaskForExecution(taskId))) return
    if (await cancelIfRequested(taskId)) return
    leaseHeartbeat = setInterval(() => {
      void aiTaskRepository.heartbeatTaskLease({
        taskId,
        leaseOwner: AI_TASK_WORKER_OWNER,
        leaseExpiresAt: aiTaskLeaseExpiry(),
        updatedAt: new Date(),
      }).catch((error) => {
        console.warn(`[aiTask] lease heartbeat failed task=${taskId}:`, (error as Error).message)
      })
    }, Math.max(10_000, Math.floor(AI_TASK_LEASE_SECONDS * 1_000 / 3)))
    leaseHeartbeat.unref()
    const resolvedCustomTemplate = (
      task.type === 'custom_template_document'
    )
      ? await resolveAiCustomTemplateForTask({
          userId: task.userId,
          projectId: task.projectId,
          conversationId: task.conversationId ?? undefined,
          templateId: String(parameters.customTemplateId || ''),
          taskType: task.type,
        })
      : undefined
    const template = resolvedCustomTemplate?.template ?? AI_TEMPLATE_CATALOG[task.type as AiBusinessTaskType]
    if (!template) throw new Error('AI 任务模板不存在')
    if (resolvedCustomTemplate) {
      const expectedOutputFormat = template.outputFormat.toUpperCase()
      if (parameters.outputFormat !== expectedOutputFormat) {
        throw Object.assign(new Error(`上传模板输出格式应为 ${expectedOutputFormat}`), {
          status: 409,
          code: 'CUSTOM_TEMPLATE_FORMAT_MISMATCH',
        })
      }
    } else {
      if (
        task.type !== 'investment_recommendation_ppt'
        && !usesDirectQaOrDueDiligenceAgent(task.type)
      ) {
        assertAiTemplateReferences(template)
      }
    }
    const skill = resolvedCustomTemplate?.skill ?? await loadAiSkill(
      AI_TEMPLATE_CATALOG[task.type as AiBusinessTaskType].skillName,
    )
    const pptWorkflow: InvestmentRecommendationPptWorkflow | undefined
      = task.type === 'investment_recommendation_ppt'
        && !usesDirectInvestmentCommitteePptAgent(task.type)
        ? await prepareInvestmentRecommendationPptWorkflow(template)
        : undefined
    let complianceBlueprint: ComplianceDocumentBlueprint | undefined
    if (task.type === 'compliance_statement') {
      await updateStage(taskId, '加载 generate-investment-compliance-note Skill', 6)
      complianceBlueprint = await parseComplianceDocumentBlueprint(template)
    }
    if (task.type === 'investment_proposal') {
      await updateStage(taskId, '加载 draft-investment-proposal Skill', 6)
    }
    if (task.type === 'investment_recommendation_ppt') {
      await updateStage(taskId, '加载 investment-committee-ppt Skill', 6)
    }
    let qaTemplateProfile: QaTemplateProfile | undefined
    if (task.type === 'project_qa') {
      await updateStage(taskId, '加载 draft-investment-qa Skill', 6)
    }
    if (task.type === 'due_diligence_report') {
      await updateStage(taskId, '加载 draft-due-diligence-report Skill', 6)
    }
    if (task.type === 'project_qa' && !usesDirectQaOrDueDiligenceAgent(task.type)) {
      qaTemplateProfile = createProjectQaSkillProfile(skill)
    }
    const started = await aiTaskRepository.markTaskStarted({
      taskId,
      leaseOwner: AI_TASK_WORKER_OWNER,
      stage: resumeProgressFloor > 0 ? '读取断点续跑检查点' : '读取项目资料',
      progress: Math.max(10, resumeProgressFloor),
      startedAt: task.startedAt ?? new Date(),
      updatedAt: new Date(),
    })
    if (!started || await cancelIfRequested(taskId)) return

    const [project] = await db.select().from(projects).where(eq(projects.id, task.projectId)).limit(1)
    if (!project) throw new Error('项目不存在或已删除')
    const attachmentsReady = await waitForRequestedAttachments(
      taskId,
      project.id,
      requestedAttachmentFileIds(parameters),
    )
    if (!attachmentsReady) {
      await cancelIfRequested(taskId)
      return
    }
    const sourceCutoffDate = String(parameters.sourceCutoffDate || formatShanghaiDateKey(new Date()))
    const projectSourceLoad = await sourcesForProject(
      project.id,
      sourceCutoffDate,
      [
        'investment_proposal',
        'investment_recommendation_ppt',
        'project_qa',
        'due_diligence_report',
      ].includes(task.type)
        ? 240
        : task.type === 'compliance_statement'
          ? 500
          : task.type === 'custom_template_document'
            ? 80
          : 40,
      {
        completeProjectFileCoverage: [
          'investment_proposal',
          'investment_recommendation_ppt',
          'project_qa',
          'due_diligence_report',
        ].includes(task.type),
      },
    )
    const knowledgeSources = projectSourceLoad.sources
    const requiredProjectFiles = projectSourceLoad.requiredProjectFiles
    await updateStage(taskId, '整理当前项目资料库证据', 18)
    const userInstructions = typeof parameters.userInstructions === 'string'
      ? parameters.userInstructions.trim()
      : ''
    const researchIntent = typeof parameters.researchIntent === 'string'
      ? parameters.researchIntent.trim()
      : ''
    const rawSources: EvidenceSource[] = [
      ...knowledgeSources.filter((source) => evidenceSourceMatchesProject(source, project)),
      ...(formatShanghaiDateKey(project.updatedAt) <= sourceCutoffDate ? [{
        sourceType: 'project_record',
        sourceId: project.id,
        sourceName: '项目档案',
        chunkIndex: 0,
        versionOrDate: formatShanghaiDateKey(project.updatedAt),
        content: [
          `项目名称：${project.name}`,
          `公司主体：${project.companyName || '待核验'}`,
          `行业：${project.industry || '待核验'}`,
          `融资计划：${project.financing || '待核验'}`,
          `估值：${project.valuation || '待核验'}`,
          `项目概述：${project.summary || '待核验'}`,
          `商业模式：${project.businessModel || '待核验'}`,
          `市场：${project.market || '待核验'}`,
          `团队：${project.team || '待核验'}`,
        ].join('\n'),
      }] : []),
      ...(userInstructions ? [{
        sourceType: 'user_input',
        sourceName: '本次会话与用户补充输入',
        chunkIndex: 0,
        versionOrDate: sourceCutoffDate,
        content: userInstructions,
      }] : []),
    ]
    let evidenceScreening = screenEvidenceSources(rawSources, task.type)
    let sources = evidenceScreening.usable

    if (usesDirectInvestmentProposalAgent(task.type)) {
      assertCompleteProjectFileCoverage(requiredProjectFiles, sources)
      const userRow = await identityRepositories.users.findById(task.userId)
      if (!userRow) throw new Error('任务用户不存在或已删除')
      const taskDir = path.join(ARTIFACT_ROOT, task.userId, task.projectId, task.id)
      await mkdir(taskDir, { recursive: true })
      let incrementalUsageObserved = false
      const directResult = await runDirectInvestmentProposalAgent({
        taskDirectory: taskDir,
        project,
        sources,
        requiredProjectFiles,
        skill,
        sourceCutoffDate,
        instructions: userInstructions || researchIntent,
        userRole: userRow.role,
        onProgress: async (event) => {
          await updateStage(taskId, event.stage, event.progress)
        },
        onUsage: async (usage) => {
          incrementalUsageObserved = true
          await recordAiTaskModelCall(usage)
        },
        shouldCancel: () => isCancellationRequested(taskId),
      })
      if (!incrementalUsageObserved && directResult.session.usage) {
        await recordAiTaskModelCall(directResult.session.usage)
      }
      if (await cancelIfRequested(taskId)) return

      await updateStage(taskId, '登记文件并生成下载地址', 98)
      const quality = await inspectGeneratedArtifact(directResult.outputPath, 'docx', {
        deliveryIntegrityOnly: true,
      })
      const version = await aiTaskRepository.countArtifacts({
        userId: task.userId,
        projectId: task.projectId,
        format: 'docx',
      }) + 1
      const artifactId = randomUUID()
      const artifact: CreateAiArtifactRecord = {
        id: artifactId,
        taskId: task.id,
        userId: task.userId,
        projectId: task.projectId,
        conversationId: task.conversationId,
        fileName: path.basename(directResult.outputPath),
        format: 'docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        version,
        storagePath: directResult.outputPath,
        editableLevel: template.editableLevel,
        sourceCutoffDate,
        templateVersion: template.templateVersion,
        qualityStatus: quality.qualityStatus,
        metadata: {
          ...quality.metadata,
          documentSha256: directResult.documentSha256,
          bytes: directResult.bytes,
          directSkillAgent: true,
          skillInvoked: directResult.skillInvoked,
          rendererMode: 'agent-owned-skill-execution',
          skillName: skill.name,
          skillVersion: skill.version,
          skillSha256: skill.sha256,
          agentModel: directResult.session.model,
          agentTurns: directResult.session.numTurns,
          agentCostUsd: directResult.session.totalCostUsd,
          projectKnowledgeStudy: directResult.projectKnowledgeStudy,
          rejectedEvidenceChunks: evidenceScreening.rejected.length,
          acceptanceAuthority: 'direct-skill-agent-and-current-skill',
          acceptanceDecision: 'accepted-on-direct-agent-skill-completion',
          programmaticBusinessAcceptance: false,
          deliveryValidation: 'file-integrity-and-authorization-only',
          hostContentOrchestration: false,
          hostEvidenceFallback: false,
        },
        archived: false,
      }
      const sourceRecords = sources.map((source, index) => ({
        id: randomUUID(),
        taskId: task.id,
        artifactId,
        sourceType: source.sourceType,
        sourceId: source.sourceType.startsWith('public_web')
          ? createHash('sha256')
              .update(source.sourceId || source.sourceName)
              .digest('hex')
              .slice(0, 64)
          : source.sourceId ?? null,
        sourceName: source.sourceName,
        locator: source.locator || `知识片段 ${source.chunkIndex ?? index}`,
        verificationStatus: source.sourceType.startsWith('public_web')
          ? 'Skill公开核验'
          : 'Skill完整研读',
      }))
      const completed = await aiTaskRepository.completeTaskWithArtifacts({
        taskId,
        leaseOwner: AI_TASK_WORKER_OWNER,
        stage: 'DOCX 已生成',
        resultSummary: directResult.session.resultText
          || '文档 Agent 已直接执行 draft-investment-proposal Skill 并完成 DOCX。',
        completedAt: new Date(),
        artifacts: [artifact],
        sources: sourceRecords,
      })
      if (!completed) {
        await cancelIfRequested(taskId)
        return
      }
      await writeTaskAudit(
        { uid: userRow.id, name: userRow.name, role: userRow.role },
        '生成业务材料',
        `${template.label}：${project.name}`,
      ).catch((error) => {
        console.warn('[aiTask] 直接 Skill Agent 操作审计写入未完成，保留已生成 DOCX:', (error as Error).message)
      })
      return
    }

    if (usesDirectInvestmentCommitteePptAgent(task.type)) {
      assertCompleteProjectFileCoverage(requiredProjectFiles, sources)
      const userRow = await identityRepositories.users.findById(task.userId)
      if (!userRow) throw new Error('任务用户不存在或已删除')
      const taskDir = path.join(ARTIFACT_ROOT, task.userId, task.projectId, task.id)
      await mkdir(taskDir, { recursive: true })
      let incrementalUsageObserved = false
      const directResult = await runDirectInvestmentCommitteePptAgent({
        taskDirectory: taskDir,
        project,
        sources,
        requiredProjectFiles,
        skill,
        sourceCutoffDate,
        instructions: userInstructions || researchIntent,
        userRole: userRow.role,
        onProgress: async (event) => {
          await updateStage(taskId, event.stage, event.progress)
        },
        onUsage: async (usage) => {
          incrementalUsageObserved = true
          await recordAiTaskModelCall(usage)
        },
        shouldCancel: () => isCancellationRequested(taskId),
      })
      if (!incrementalUsageObserved && directResult.session.usage) {
        await recordAiTaskModelCall(directResult.session.usage)
      }
      if (await cancelIfRequested(taskId)) return

      await updateStage(taskId, '登记文件并生成下载地址', 98)
      const quality = await inspectGeneratedArtifact(directResult.outputPath, 'pptx', {
        deliveryIntegrityOnly: true,
      })
      const version = await aiTaskRepository.countArtifacts({
        userId: task.userId,
        projectId: task.projectId,
        format: 'pptx',
      }) + 1
      const artifactId = randomUUID()
      const artifact: CreateAiArtifactRecord = {
        id: artifactId,
        taskId: task.id,
        userId: task.userId,
        projectId: task.projectId,
        conversationId: task.conversationId,
        fileName: path.basename(directResult.outputPath),
        format: 'pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        version,
        storagePath: directResult.outputPath,
        editableLevel: template.editableLevel,
        sourceCutoffDate,
        templateVersion: template.templateVersion,
        qualityStatus: quality.qualityStatus,
        metadata: {
          ...quality.metadata,
          deckSha256: directResult.deckSha256,
          bytes: directResult.bytes,
          directSkillAgent: true,
          skillInvoked: directResult.skillInvoked,
          rendererMode: 'agent-owned-skill-execution',
          skillName: skill.name,
          skillVersion: skill.version,
          skillSha256: skill.sha256,
          agentModel: directResult.session.model,
          agentTurns: directResult.session.numTurns,
          agentCostUsd: directResult.session.totalCostUsd,
          projectKnowledgeStudy: directResult.projectKnowledgeStudy,
          rejectedEvidenceChunks: evidenceScreening.rejected.length,
          acceptanceAuthority: 'direct-skill-agent-and-current-skill',
          acceptanceDecision: 'accepted-on-direct-agent-skill-completion',
          programmaticBusinessAcceptance: false,
          deliveryValidation: 'file-integrity-and-authorization-only',
          hostContentOrchestration: false,
          hostEvidenceFallback: false,
        },
        archived: false,
      }
      const sourceRecords = sources.map((source, index) => ({
        id: randomUUID(),
        taskId: task.id,
        artifactId,
        sourceType: source.sourceType,
        sourceId: source.sourceType.startsWith('public_web')
          ? createHash('sha256')
              .update(source.sourceId || source.sourceName)
              .digest('hex')
              .slice(0, 64)
          : source.sourceId ?? null,
        sourceName: source.sourceName,
        locator: source.locator || `知识片段 ${source.chunkIndex ?? index}`,
        verificationStatus: source.sourceType.startsWith('public_web')
          ? 'Skill公开核验'
          : 'Skill完整研读',
      }))
      const completed = await aiTaskRepository.completeTaskWithArtifacts({
        taskId,
        leaseOwner: AI_TASK_WORKER_OWNER,
        stage: 'PPTX 已生成',
        resultSummary: directResult.session.resultText
          || 'PPT Agent 已直接执行 investment-committee-ppt Skill 并完成 PPTX。',
        completedAt: new Date(),
        artifacts: [artifact],
        sources: sourceRecords,
      })
      if (!completed) {
        await cancelIfRequested(taskId)
        return
      }
      await writeTaskAudit(
        { uid: userRow.id, name: userRow.name, role: userRow.role },
        '生成业务材料',
        `${template.label}：${project.name}`,
      ).catch((error) => {
        console.warn('[aiTask] 直接 Skill Agent 操作审计写入未完成，保留已生成 PPTX:', (error as Error).message)
      })
      return
    }

    if (usesDirectQaOrDueDiligenceAgent(task.type)) {
      assertCompleteProjectFileCoverage(requiredProjectFiles, sources)
      const userRow = await identityRepositories.users.findById(task.userId)
      if (!userRow) throw new Error('任务用户不存在或已删除')
      const taskDir = path.join(ARTIFACT_ROOT, task.userId, task.projectId, task.id)
      await mkdir(taskDir, { recursive: true })
      let incrementalUsageObserved = false
      const directResult = await runDirectBusinessDocumentAgent({
        taskType: task.type as 'project_qa' | 'due_diligence_report',
        taskDirectory: taskDir,
        project,
        sources,
        requiredProjectFiles,
        skill,
        sourceCutoffDate,
        instructions: userInstructions || researchIntent,
        userRole: userRow.role,
        onProgress: async (event) => {
          await updateStage(taskId, event.stage, event.progress)
        },
        onUsage: async (usage) => {
          incrementalUsageObserved = true
          await recordAiTaskModelCall(usage)
        },
        shouldCancel: () => isCancellationRequested(taskId),
      })
      if (!incrementalUsageObserved && directResult.session.usage) {
        await recordAiTaskModelCall(directResult.session.usage)
      }
      if (await cancelIfRequested(taskId)) return

      await updateStage(taskId, '登记文件并生成下载地址', 98)
      const quality = await inspectGeneratedArtifact(directResult.outputPath, 'docx', {
        deliveryIntegrityOnly: true,
      })
      const version = await aiTaskRepository.countArtifacts({
        userId: task.userId,
        projectId: task.projectId,
        format: 'docx',
      }) + 1
      const artifactId = randomUUID()
      const artifact: CreateAiArtifactRecord = {
        id: artifactId,
        taskId: task.id,
        userId: task.userId,
        projectId: task.projectId,
        conversationId: task.conversationId,
        fileName: path.basename(directResult.outputPath),
        format: 'docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        version,
        storagePath: directResult.outputPath,
        editableLevel: template.editableLevel,
        sourceCutoffDate,
        templateVersion: template.templateVersion,
        qualityStatus: quality.qualityStatus,
        metadata: {
          ...quality.metadata,
          documentSha256: directResult.documentSha256,
          bytes: directResult.bytes,
          directSkillAgent: true,
          skillInvoked: directResult.skillInvoked,
          rendererMode: 'agent-owned-skill-execution',
          skillName: skill.name,
          skillVersion: skill.version,
          skillSha256: skill.sha256,
          agentModel: directResult.session.model,
          agentTurns: directResult.session.numTurns,
          agentCostUsd: directResult.session.totalCostUsd,
          projectKnowledgeStudy: directResult.projectKnowledgeStudy,
          rejectedEvidenceChunks: evidenceScreening.rejected.length,
          acceptanceAuthority: 'direct-skill-agent-and-current-skill',
          acceptanceDecision: 'accepted-on-direct-agent-skill-completion',
          programmaticBusinessAcceptance: false,
          deliveryValidation: 'file-integrity-and-authorization-only',
          hostContentOrchestration: false,
          hostEvidenceFallback: false,
        },
        archived: false,
      }
      const sourceRecords = sources.map((source, index) => ({
        id: randomUUID(),
        taskId: task.id,
        artifactId,
        sourceType: source.sourceType,
        sourceId: source.sourceType.startsWith('public_web')
          ? createHash('sha256')
              .update(source.sourceId || source.sourceName)
              .digest('hex')
              .slice(0, 64)
          : source.sourceId ?? null,
        sourceName: source.sourceName,
        locator: source.locator || `知识片段 ${source.chunkIndex ?? index}`,
        verificationStatus: source.sourceType.startsWith('public_web')
          ? 'Skill公开核验'
          : 'Skill完整研读',
      }))
      const completed = await aiTaskRepository.completeTaskWithArtifacts({
        taskId,
        leaseOwner: AI_TASK_WORKER_OWNER,
        stage: 'DOCX 已生成',
        resultSummary: directResult.session.resultText
          || `文档 Agent 已直接执行 ${skill.name} Skill 并完成 DOCX。`,
        completedAt: new Date(),
        artifacts: [artifact],
        sources: sourceRecords,
      })
      if (!completed) {
        await cancelIfRequested(taskId)
        return
      }
      await writeTaskAudit(
        { uid: userRow.id, name: userRow.name, role: userRow.role },
        '生成业务材料',
        `${template.label}：${project.name}`,
      ).catch((error) => {
        console.warn('[aiTask] 直接 Skill Agent 操作审计写入未完成，保留已生成 DOCX:', (error as Error).message)
      })
      return
    }

    let complianceModelResearch: {
      agent?: DueDiligenceNetworkResearchAudit
      projectModel?: ComplianceModelResearchAudit
    } | undefined
    let dueDiligenceModelResearch: DueDiligenceNetworkResearchAudit | undefined
    let dueDiligencePageResearch: ProjectWebResearchAudit | undefined
    let sharedNetworkResearch: DueDiligenceNetworkResearchAudit | undefined
    let sharedModelResearch: ProjectWebResearchAudit | undefined
    let investmentRecommendationGapAgentResearch: DueDiligenceNetworkResearchAudit | undefined
    let investmentRecommendationGapPageResearch: ProjectWebResearchAudit | undefined
    let qaAgentResearch: DueDiligenceNetworkResearchAudit | undefined
    let qaModelResearch: ProjectQaModelResearchAudit | undefined
    let projectKnowledgeBrief: ProjectKnowledgeBrief | undefined
    if (task.type === 'compliance_statement') {
      const pendingTopics = complianceNetworkResearchTopics(sources, project, parameters)
      if (pendingTopics.length > 0) {
        await updateStage(taskId, '联网检索 Agent 补全公开证据', 22)
      }
      try {
        const research = await fetchDueDiligenceNetworkEvidence({
          project,
          sourceCutoffDate,
          pendingTopics,
          parameters,
          maxSources: 24,
        })
        complianceModelResearch = {
          ...complianceModelResearch,
          agent: research.audit,
        }
        if (research.sources.length > 0) {
          await cacheProjectNetworkEvidence(project.id, research.sources).catch((error) => {
            console.warn('[aiTask] 合规联网证据缓存失败，跳过缓存继续生成:', (error as Error).message)
          })
          rawSources.push(...research.sources)
          evidenceScreening = screenEvidenceSources(rawSources, task.type)
          sources = evidenceScreening.usable
        }
      } catch (error) {
        console.warn('[aiTask] 合规联网补充失败，使用项目资料继续生成:', (error as Error).message)
      }
      const remainingTopics = complianceNetworkResearchTopics(sources, project, parameters)
      if (remainingTopics.length > 0) {
        await updateStage(taskId, '项目大模型补全剩余公开证据', 24)
        try {
          const research = await fetchComplianceModelEvidence({
            project,
            sourceCutoffDate,
            missingSections: remainingTopics,
            parameters,
            maxSources: 24,
          })
          complianceModelResearch = {
            ...complianceModelResearch,
            projectModel: research.audit,
          }
          if (research.sources.length > 0) {
            await cacheProjectNetworkEvidence(project.id, research.sources).catch((error) => {
              console.warn('[aiTask] 合规项目大模型证据缓存失败，跳过缓存继续生成:', (error as Error).message)
            })
            rawSources.push(...research.sources)
            evidenceScreening = screenEvidenceSources(rawSources, task.type)
            sources = evidenceScreening.usable
          }
        } catch (error) {
          console.warn('[aiTask] 合规项目大模型补全失败，使用现有证据继续生成:', (error as Error).message)
        }
      }
    }
    if ([
      'investment_proposal',
      'investment_recommendation_ppt',
      'due_diligence_report',
      'custom_template_document',
    ].includes(task.type)) {
      let agentCandidates: EvidenceSource[] = []
      await updateStage(taskId, '联网检索 Agent 发现当前项目公开来源', 22)
      try {
        const research = await fetchDueDiligenceNetworkEvidence({
          project,
          sourceCutoffDate,
          pendingTopics: sharedInvestmentResearchTopics(task.type, project, parameters),
          parameters,
          maxSources: task.type === 'due_diligence_report'
            ? 24
            : task.type === 'investment_recommendation_ppt'
              ? 28
              : 18,
        })
        sharedNetworkResearch = research.audit
        agentCandidates = research.sources
      } catch (error) {
        console.warn('[aiTask] 联网检索 Agent 不可用，继续尝试页面核验与受控公开检索:', (error as Error).message)
      }

      await updateStage(taskId, '补充检索并核验公开资料', 24)
      try {
        const research = await fetchVerifiedProjectWebEvidence({
          project,
          currentSources: sources,
          candidateSources: agentCandidates,
          sourceCutoffDate,
          parameters: {
            ...parameters,
            nativeModelSearch: true,
          },
          requestedTopics: task.type === 'investment_recommendation_ppt'
            ? investmentRecommendationWebTopicsForSources(sources, 12)
            : projectWebResearchTopicsForSources(
                sources,
                task.type === 'due_diligence_report' ? 8 : 6,
              ),
          allowIndustryContext: task.type === 'investment_recommendation_ppt',
          maxSources: task.type === 'due_diligence_report'
            ? 20
            : task.type === 'investment_recommendation_ppt'
              ? 24
              : 14,
        })
        sharedModelResearch = research.audit
        if (research.sources.length > 0) {
          await cacheProjectNetworkEvidence(project.id, research.sources).catch((error) => {
            console.warn('[aiTask] 已核验公开证据缓存失败，跳过缓存继续生成:', (error as Error).message)
          })
          rawSources.push(...research.sources)
          evidenceScreening = screenEvidenceSources(rawSources, task.type)
          sources = evidenceScreening.usable
        }
      } catch (error) {
        console.warn('[aiTask] LLM Gateway 页面核验失败，使用项目资料继续生成:', (error as Error).message)
      }
    }
    if (await cancelIfRequested(taskId)) return

    if ([
      'compliance_statement',
      'investment_proposal',
      'investment_recommendation_ppt',
      'due_diligence_report',
    ].includes(task.type)) {
      if (task.type === 'investment_proposal') {
        assertCompleteProjectFileCoverage(requiredProjectFiles, sources)
      }
      await updateStage(
        taskId,
        task.type === 'investment_proposal'
          ? '分批研读全部项目资料片段并建立事实底稿'
          : '深度研读项目资料并建立事实底稿',
        26,
      )
      projectKnowledgeBrief = await buildProjectKnowledgeBrief({
        project,
        sources,
        sourceCutoffDate,
        requiredProjectFiles,
        includeAllSourceChunks: task.type === 'investment_proposal',
        onBatchProgress: task.type === 'investment_proposal'
          ? async ({ completedBatches, totalBatches }) => {
              await updateStage(
                taskId,
                `分批研读全部项目资料片段（${completedBatches}/${totalBatches}）`,
                26 + Math.floor(7 * completedBatches / Math.max(1, totalBatches)),
              )
            }
          : undefined,
      })
      if (task.type === 'investment_proposal' && !projectKnowledgeBrief.audit.completeProjectFileCoverage) {
        const missing = projectKnowledgeBrief.audit.missingRequiredSourceFiles
        throw new Error(
          `项目资料研读覆盖校验未通过，已停止生成提案：${missing.slice(0, 8).join('、')}`,
        )
      }
    }

    if (task.type === 'project_qa') {
      if (!qaTemplateProfile) throw new Error('Q&A 模板画像未生成')
      // 快捷任务不再暴露“Q&A 类型/问题深度”参数，统一由当前标准 Skill
      // 选择问题并执行深度门禁；历史任务中的旧参数只保留为审计数据。
      const qaMode: ProjectQaMode = '投资委员会 Q&A'
      const questionDepth = '标准版' as const

      const qaTopics = projectQaResearchTopicsForSources(sources)
      let qaAgentCandidates: EvidenceSource[] = []
      await updateStage(taskId, '联网检索 Agent 发现当前项目公开来源', 22)
      try {
        const agentResearch = await fetchDueDiligenceNetworkEvidence({
          project,
          sourceCutoffDate,
          pendingTopics: [...new Set([
            ...sharedInvestmentResearchTopics(task.type, project, parameters),
            ...qaTopics.map((topic) => `${project.companyName || project.name} ${topic}`),
          ])].slice(0, 8),
          parameters,
          maxSources: 18,
        })
        qaAgentResearch = agentResearch.audit
        qaAgentCandidates = agentResearch.sources
      } catch (error) {
        console.warn('[aiTask] Q&A 联网检索 Agent 不可用，继续尝试受控公开检索:', (error as Error).message)
      }
      await updateStage(taskId, '核验公开页面并补全项目证据', 24)
      try {
        const research = await fetchProjectQaModelEvidence({
          project,
          currentSources: sources,
          candidateSources: qaAgentCandidates,
          sourceCutoffDate,
          parameters,
          requestedTopics: qaTopics,
          maxSources: 14,
        })
        qaModelResearch = research.audit
        if (research.sources.length > 0) {
          await cacheProjectNetworkEvidence(project.id, research.sources).catch((error) => {
            console.warn('[aiTask] Q&A 联网证据缓存失败，跳过缓存继续生成:', (error as Error).message)
          })
          rawSources.push(...research.sources)
          evidenceScreening = screenEvidenceSources(rawSources, task.type)
          sources = evidenceScreening.usable
        }
      } catch (error) {
        console.warn('[aiTask] Q&A 联网补充失败，使用项目资料继续生成:', (error as Error).message)
      }
      if (await cancelIfRequested(taskId)) return

      await updateStage(taskId, '深度研读项目资料并建立事实底稿', 26)
      projectKnowledgeBrief = await buildProjectKnowledgeBrief({
        project,
        sources,
        sourceCutoffDate,
      })
      await updateStage(taskId, 'Question Generator 生成项目问题', 28)
      const duplicateCheck = await generateProjectQaQuestions({
        project,
        mode: qaMode,
        depth: questionDepth,
        sources,
        skill,
        userIntent: userInstructions || researchIntent,
        projectKnowledgeBrief,
      })
      if (duplicateCheck.questions.length === 0) {
        throw new Error('Question Generator 未生成有效问题')
      }
      if (await cancelIfRequested(taskId)) return

      await updateStage(taskId, 'Duplicate Checker 去重', 40)
      await updateStage(taskId, '基于当前项目资料生成投资问答', 52)
      const draftAnswers = await generateProjectQaAnswers({
        project,
        mode: qaMode,
        questions: duplicateCheck.questions,
        sources,
        skill,
        userIntent: userInstructions || researchIntent,
        projectKnowledgeBrief,
      })
      if (await cancelIfRequested(taskId)) return

      await updateStage(taskId, 'Reviewer 检查阶段建议与证据', 66)
      const reviewed = await reviewProjectQaAnswers({
        project,
        questions: duplicateCheck.questions,
        answers: draftAnswers,
        sources,
        duplicateCheck,
        skill,
        programmaticBusinessAcceptance: false,
      })
      const qaContent = buildProjectQaDocumentContent({
        project,
        mode: qaMode,
        depth: questionDepth,
        questions: duplicateCheck.questions,
        answers: reviewed.answers,
        review: reviewed.review,
      })
      if (await cancelIfRequested(taskId)) return

      await updateStage(taskId, 'draft-investment-qa 生成 DOCX', 80)
      const taskDir = path.join(ARTIFACT_ROOT, task.userId, task.projectId, task.id)
      await mkdir(taskDir, { recursive: true })
      const names = makeProjectQaFileNames(project.name, qaMode)
      const docxPath = path.join(taskDir, names.docx)
      const markdownPath = path.join(taskDir, '.draft-investment-qa.md')
      const docxGeneration = await retryDocumentStep('Q&A DOCX 生成', async () =>
        generateProjectQaWithSkill({
          outputPath: docxPath,
          markdownPath,
          projectName: project.companyName || project.name,
          content: qaContent,
          skill,
        }),
      )
      const docxQuality = await inspectGeneratedArtifact(docxPath, 'docx', {
        deliveryIntegrityOnly: true,
      })
      if (await cancelIfRequested(taskId)) return

      await updateStage(taskId, 'Agent 已按当前 Skill 规则完成生成与审阅', 96)
      await updateStage(taskId, '登记文件并生成下载地址', 98)
      const version = await aiTaskRepository.countArtifacts({
        userId: task.userId,
        projectId: task.projectId,
        format: 'docx',
      }) + 1
      const sharedMetadata = {
        referenceTemplate: path.basename(template.referencePath),
        referenceTemplates: (template.referencePaths ?? [template.referencePath])
          .map((referencePath) => path.basename(referencePath)),
        templateCorpusSha256: qaTemplateProfile.corpusSha256,
        templateParserVersion: qaTemplateProfile.parserVersion,
        skillName: skill.name,
        skillVersion: skill.version,
        skillSha256: skill.sha256,
        qaMode,
        questionDepth,
        questionCount: qaContent.questions.length,
        categoryCount: template.sections.length,
        duplicateQuestionsRemoved: duplicateCheck.removed.length,
        reviewerStatus: reviewed.review.status,
        reviewerChecks: reviewed.review.checks,
        missingAnswerCount: reviewed.review.dataGapCount,
        rejectedEvidenceChunks: evidenceScreening.rejected.length,
        evidencePolicy: 'project_knowledge_primary_model_network_supplement',
        projectKnowledgeSourceCount: sources.filter((source) =>
          source.sourceType !== 'project_record'
          && source.sourceType !== 'user_input'
          && !source.sourceType.startsWith('public_web')).length,
        modelNetworkResearch: {
          agent: qaAgentResearch,
          verifiedPages: qaModelResearch,
        },
        networkEvidenceSourceCount: sources.filter((source) =>
          source.sourceType === 'public_web_llm').length,
        projectRecordSourceCount: sources.filter((source) =>
          source.sourceType === 'project_record').length,
        userInputSourceCount: sources.filter((source) =>
          source.sourceType === 'user_input').length,
        visibleReferencesIncluded: false,
        visibleReviewerIncluded: false,
        downloadableFormats: ['docx'],
        projectKnowledgeStudy: projectKnowledgeBrief?.audit,
        acceptanceAuthority: 'agent-and-current-skill',
        acceptanceDecision: 'accepted-on-agent-skill-completion',
        programmaticBusinessAcceptance: false,
        deliveryValidation: 'file-integrity-and-authorization-only',
      }
      const qaArtifactId = randomUUID()
      const qaArtifact = {
        id: qaArtifactId,
        taskId: task.id,
        userId: task.userId,
        projectId: task.projectId,
        conversationId: task.conversationId,
        fileName: names.docx,
        format: 'docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        version,
        storagePath: docxPath,
        editableLevel: 'core-content',
        sourceCutoffDate,
        templateVersion: template.templateVersion,
        qualityStatus: docxQuality.qualityStatus,
        metadata: {
          ...docxQuality.metadata,
          ...docxGeneration,
          ...sharedMetadata,
        },
        archived: false,
      }
      const usedSourceIndexes = usedProjectQaSourceIndexes(reviewed.answers, sources.length)
      const qaSourceRecords = usedSourceIndexes.map((index) => {
          const source = sources[index]
          return {
            id: randomUUID(),
            taskId: task.id,
            artifactId: qaArtifactId,
            sourceType: source.sourceType,
            sourceId: source.sourceType.startsWith('public_web')
              ? createHash('sha256')
                  .update(source.sourceId || source.sourceName)
                  .digest('hex')
                  .slice(0, 64)
              : source.sourceId ?? null,
            sourceName: source.sourceName,
            locator: source.locator || `知识片段 ${source.chunkIndex ?? index}`,
            verificationStatus: source.sourceType.startsWith('public_web')
              ? '页面已核验，事实待交叉核验'
              : '资料记载',
          }
        })
      const completed = await aiTaskRepository.completeTaskWithArtifacts({
        taskId,
        leaseOwner: AI_TASK_WORKER_OWNER,
        stage: 'DOCX 已生成',
        resultSummary: qaContent.executiveSummary,
        completedAt: new Date(),
        artifacts: [qaArtifact],
        sources: qaSourceRecords,
      })
      if (!completed) {
        await cancelIfRequested(taskId)
        return
      }
      const userRow = await identityRepositories.users.findById(task.userId)
      if (userRow) {
        await writeTaskAudit(
          { uid: userRow.id, name: userRow.name, role: userRow.role },
          '生成业务材料',
          `${qaMode}：${project.name}`,
        ).catch((error) => {
          console.warn('[aiTask] Q&A 操作审计写入未完成，保留已生成 DOCX:', (error as Error).message)
        })
      }
      return
    }

    const taskDir = path.join(ARTIFACT_ROOT, task.userId, task.projectId, task.id)
    await mkdir(taskDir, { recursive: true })
    const proposalCheckpointPath = path.join(taskDir, '.investment-proposal-checkpoint.json')
    const retryCheckpointPath = task.retryOfTaskId
      ? path.join(
          ARTIFACT_ROOT,
          task.userId,
          task.projectId,
          task.retryOfTaskId,
          '.investment-proposal-checkpoint.json',
        )
      : undefined
    const investmentRecommendationResumeDirectory
      = task.type === 'investment_recommendation_ppt'
        ? task.retryOfTaskId
          ? path.join(ARTIFACT_ROOT, task.userId, task.projectId, task.retryOfTaskId)
          : taskDir
        : undefined
    const investmentRecommendationCheckpointPath = path.join(
      taskDir,
      '.investment-recommendation-checkpoint.json',
    )
    let investmentRecommendationResume = task.type === 'investment_recommendation_ppt'
      ? await loadInvestmentRecommendationResumeCheckpoint(
          investmentRecommendationResumeDirectory,
          sources,
        )
      : undefined
    if (investmentRecommendationResume) {
      const resumeQualityIssues = investmentRecommendationContentQualityIssues(
        investmentRecommendationResume.content,
        template.sections.length,
        {
          pageCount: parameters.pageCount as string | number | undefined,
          sourceCount: investmentRecommendationResume.sourceSnapshots.length,
        },
      )
      if (resumeQualityIssues.length > 0) {
        console.warn(
          '[aiTask] 投资建议书恢复检查点未通过当前专业性门禁，忽略旧正文并重新生成:',
          resumeQualityIssues.slice(0, 6).join('；'),
        )
        investmentRecommendationResume = undefined
      }
    }
    let checkpointWrite = Promise.resolve()
    let progressWrite = Promise.resolve()
    let proposalProgress = 35
    const dueDiligenceRuntime = (startProgress: number, endProgress: number) => ({
      timeoutMs: Number(process.env.AI_DUE_DILIGENCE_CHAPTER_TIMEOUT_MS || 120_000),
      concurrency: Number(process.env.AI_DUE_DILIGENCE_CHAPTER_CONCURRENCY || 3),
      maxGenerationAttempts: 2,
      onProgress: async (event: {
        chapterTitle: string
        chapterIndex: number
        chapterCount: number
        completedChapters: number
        phase: 'generating' | 'regenerating' | 'completed' | 'limited'
      }) => {
        const progress = Math.min(
          endProgress,
          startProgress + Math.round(
            (event.completedChapters / Math.max(1, event.chapterCount))
            * (endProgress - startProgress),
          ),
        )
        const phaseLabel = event.phase === 'regenerating'
          ? '重试受影响章节'
          : event.phase === 'completed'
            ? '章节生成完成'
            : event.phase === 'limited'
              ? '章节已使用受限内容'
              : '分章生成尽调正文'
        const stage = `${phaseLabel}（${event.chapterIndex + 1}/${event.chapterCount}）${event.chapterTitle}`
          .slice(0, 64)
        progressWrite = progressWrite.then(() => updateStage(taskId, stage, progress))
        await progressWrite
      },
    })

    let complianceWorkflow: ComplianceWorkflowResult | undefined
    let content: BusinessContent
    if (task.type === 'compliance_statement') {
      if (!complianceBlueprint) throw new Error('合规性说明缺少Document Blueprint')
      await updateStage(taskId, '建立章节级 Evidence', 25)
      await updateStage(taskId, '逐章节生成并执行 Reviewer', 35)
      complianceWorkflow = await composeComplianceStatement({
        template,
        skill,
        blueprint: complianceBlueprint,
        project,
        sources,
        sourceCutoffDate,
        parameters,
        projectKnowledgeBrief,
        programmaticBusinessAcceptance: false,
      })
      content = complianceWorkflow.content
    } else {
    await updateStage(
      taskId,
      investmentRecommendationResume
        ? '断点续跑：恢复已完成的投资建议书内容'
        : task.type === 'investment_proposal'
          ? '建立章节级 Evidence 并逐章节生成、执行 Reviewer'
          : task.type === 'custom_template_document'
            ? '基于项目资料与已核验联网证据重建标题和正文'
            : '生成结构化内容',
      investmentRecommendationResume ? 68 : 35,
    )
      const composeInitialContent = () => composeBusinessContent({
          type: task.type as AiExecutableTaskType,
          template,
          skill,
          project,
          sources,
          sourceCutoffDate,
          parameters,
          projectKnowledgeBrief,
          programmaticBusinessAcceptance: false,
          investmentRecommendationPass: task.type === 'investment_recommendation_ppt'
            ? 'gap-analysis'
            : undefined,
          // 投资建议书首轮只识别逐章缺口；联网补全后再执行最终专业性门禁。
          dueDiligencePass: task.type === 'due_diligence_report' ? 'final' : undefined,
          dueDiligenceRuntime: task.type === 'due_diligence_report'
            ? dueDiligenceRuntime(35, 49)
            : undefined,
          investmentProposalRuntime: task.type === 'investment_proposal'
            ? {
              timeoutMs: Number(process.env.AI_INVESTMENT_PROPOSAL_TIMEOUT_MS || 75_000),
              concurrency: Number(process.env.AI_PROPOSAL_CHAPTER_CONCURRENCY || 3),
              maxRequestAttempts: 1,
              maxGenerationAttempts: 1,
              loadCheckpoint: async () => {
                for (const checkpointPath of [
                  proposalCheckpointPath,
                  retryCheckpointPath,
                ].filter((value): value is string => Boolean(value))) {
                  try {
                    return JSON.parse(await readFile(checkpointPath, 'utf8')) as unknown
                  } catch {
                    // 当前任务首次执行或旧任务没有检查点时，从头开始生成。
                  }
                }
                return undefined
              },
              saveCheckpoint: async (checkpoint) => {
                checkpointWrite = checkpointWrite.then(async () => {
                  const temporaryPath = `${proposalCheckpointPath}.${randomUUID()}.tmp`
                  await writeFile(temporaryPath, JSON.stringify(checkpoint), 'utf8')
                  await rename(temporaryPath, proposalCheckpointPath)
                })
                await checkpointWrite
              },
              onProgress: async (event) => {
                const completedProgress = 35 + Math.round(
                  (event.completedChapters / Math.max(1, event.chapterCount)) * 32,
                )
                proposalProgress = Math.max(proposalProgress, Math.min(completedProgress, 67))
                const phaseLabel = event.phase === 'resumed'
                  ? '恢复已完成章节'
                  : event.phase === 'reviewing'
                    ? 'Reviewer 检查章节'
                    : event.phase === 'regenerating'
                      ? '按 Reviewer 意见重生章节'
                      : event.phase === 'completed'
                        ? '章节生成与 Reviewer 完成'
                        : event.phase === 'heartbeat'
                          ? '模型正在生成章节'
                          : '生成章节'
                const requestLabel = event.requestAttempt && event.requestAttempt > 1
                  ? `，请求重试${event.requestAttempt}`
                  : ''
                const waitLabel = event.phase === 'heartbeat' && event.elapsedMs
                  ? `，已等待${Math.max(1, Math.round(event.elapsedMs / 1000))}秒`
                  : ''
                const stage = `${phaseLabel}（${event.chapterIndex + 1}/${event.chapterCount}）${event.chapterTitle}${requestLabel}${waitLabel}`
                  .slice(0, 64)
                progressWrite = progressWrite.then(() =>
                  updateStage(taskId, stage, proposalProgress))
                await progressWrite
              },
              }
            : undefined,
        })
      content = investmentRecommendationResume
        ? investmentRecommendationResume.content
        : task.type === 'due_diligence_report'
          ? await withTaskHeartbeat(taskId, composeInitialContent, {
              startProgress: 35,
              endProgress: 49,
              stage: (elapsedSeconds) =>
                `大模型正在分章生成尽调正文（已等待 ${elapsedSeconds} 秒）`,
            })
          : task.type === 'investment_recommendation_ppt'
            ? await withTaskHeartbeat(taskId, composeInitialContent, {
                startProgress: 35,
                endProgress: 48,
                stage: (elapsedSeconds) =>
                  `大模型正在生成投资建议书初稿（已等待 ${elapsedSeconds} 秒）`,
              })
            : await composeInitialContent()
      if (task.type === 'due_diligence_report') {
        const pendingTopics = dueDiligencePendingResearchTopics(content)
        if (pendingTopics.length > 0) {
          let agentCandidates: EvidenceSource[] = []
          await updateStage(taskId, '联网检索 Agent 发现待核验事项来源', 52)
          try {
            const research = await fetchDueDiligenceNetworkEvidence({
              project,
              sourceCutoffDate,
              pendingTopics,
              parameters,
              maxSources: 20,
            })
            dueDiligenceModelResearch = research.audit
            agentCandidates = research.sources
          } catch (error) {
            console.warn('[aiTask] 尽调待核验事项来源发现失败，继续生成受限报告:', (error as Error).message)
          }

          await updateStage(taskId, '核验待确认事项的公开资料', 55)
          try {
            const research = await fetchVerifiedProjectWebEvidence({
              project,
              currentSources: sources,
              candidateSources: agentCandidates,
              sourceCutoffDate,
              parameters: {
                ...parameters,
                nativeModelSearch: true,
              },
              requestedTopics: projectWebResearchTopicsForSources(sources, 8),
              maxSources: 16,
            })
            dueDiligencePageResearch = research.audit
            if (research.sources.length > 0) {
              await cacheProjectNetworkEvidence(project.id, research.sources).catch((error) => {
                console.warn('[aiTask] 尽调已核验公开证据缓存失败，跳过缓存继续生成:', (error as Error).message)
              })
              rawSources.push(...research.sources)
              evidenceScreening = screenEvidenceSources(rawSources, task.type)
              sources = evidenceScreening.usable
            }
          } catch (error) {
            console.warn('[aiTask] 尽调公开页面核验失败，使用现有证据继续生成:', (error as Error).message)
          }

          await updateStage(taskId, '使用本地与联网证据重新生成尽调内容', 58)
          projectKnowledgeBrief = await buildProjectKnowledgeBrief({
            project,
            sources,
            sourceCutoffDate,
          })
          content = await withTaskHeartbeat(
            taskId,
            () => composeBusinessContent({
              type: task.type as AiExecutableTaskType,
              template,
              skill,
              project,
              sources,
              sourceCutoffDate,
              parameters,
              projectKnowledgeBrief,
              programmaticBusinessAcceptance: false,
              dueDiligencePass: 'final',
              dueDiligenceRuntime: dueDiligenceRuntime(58, 66),
            }),
            {
              startProgress: 58,
              endProgress: 66,
              stage: (elapsedSeconds) =>
                `大模型正在分章整合联网证据（已等待 ${elapsedSeconds} 秒）`,
            },
          )
          content = annotateDueDiligencePendingAfterResearch(
            content,
            dueDiligencePageResearch?.status
              ?? dueDiligenceModelResearch?.status
              ?? 'unavailable',
          )
        }
      }
      if (task.type === 'investment_recommendation_ppt' && !investmentRecommendationResume) {
        const pendingTopics = investmentRecommendationPendingResearchTopics(content)
        if (pendingTopics.length > 0) {
          let agentCandidates: EvidenceSource[] = []
          await updateStage(taskId, '识别内容缺口并定向联网检索', 50)
          try {
            const research = await fetchDueDiligenceNetworkEvidence({
              project,
              sourceCutoffDate,
              pendingTopics,
              parameters,
              maxSources: 24,
            })
            investmentRecommendationGapAgentResearch = research.audit
            agentCandidates = research.sources
          } catch (error) {
            console.warn(
              '[aiTask] 投资建议书缺口来源发现失败，继续使用已核验证据:',
              (error as Error).message,
            )
          }

          await updateStage(taskId, '核验市场、竞品及项目缺口网页', 54)
          try {
            const research = await fetchVerifiedProjectWebEvidence({
              project,
              currentSources: sources,
              candidateSources: agentCandidates,
              sourceCutoffDate,
              parameters: {
                ...parameters,
                nativeModelSearch: true,
              },
              requestedTopics: investmentRecommendationWebTopicsForSources(sources, 12),
              maxSources: 24,
              allowIndustryContext: true,
            })
            investmentRecommendationGapPageResearch = research.audit
            if (research.sources.length > 0) {
              await cacheProjectNetworkEvidence(project.id, research.sources).catch((error) => {
                console.warn(
                  '[aiTask] 投资建议书缺口证据缓存失败，跳过缓存继续生成:',
                  (error as Error).message,
                )
              })
              rawSources.push(...research.sources)
              evidenceScreening = screenEvidenceSources(rawSources, task.type)
              sources = evidenceScreening.usable
            }
          } catch (error) {
            console.warn(
              '[aiTask] 投资建议书缺口页面核验失败，使用首轮已核验证据继续生成:',
              (error as Error).message,
            )
          }
        }
        await updateStage(taskId, '按章节整合证据并执行投资专业性检查', 58)
        projectKnowledgeBrief = await buildProjectKnowledgeBrief({
          project,
          sources,
          sourceCutoffDate,
        })
        content = await withTaskHeartbeat(
          taskId,
          () => composeBusinessContent({
            type: task.type as AiExecutableTaskType,
            template,
            skill,
            project,
            sources,
            sourceCutoffDate,
            parameters,
            projectKnowledgeBrief,
            programmaticBusinessAcceptance: false,
            investmentRecommendationPass: 'final',
          }),
          {
            startProgress: 58,
            endProgress: 66,
            stage: (elapsedSeconds) =>
              `大模型正在逐章重写并复核投资建议书（已等待 ${elapsedSeconds} 秒）`,
          },
        )
      }
    }
    if (evidenceScreening.rejected.length && task.type !== 'custom_template_document') {
      const affectedFiles = [...new Set(evidenceScreening.rejected.map((item) => item.sourceName))]
      content.missing = dedupeTextList([
        ...content.missing,
        `有 ${evidenceScreening.rejected.length} 个重复、测试、占位或损坏的知识片段未用于正文；如其中包含有效资料，请重新上传原文件：${affectedFiles.slice(0, 5).join('、')}`,
      ], { limit: 8 })
    }
    if (task.type === 'investment_recommendation_ppt') {
      await saveInvestmentRecommendationCheckpoint({
        checkpointPath: investmentRecommendationCheckpointPath,
        content,
        sources,
      })
    }
    if (await cancelIfRequested(taskId)) return

    await updateStage(
      taskId,
      template.outputFormat === 'pptx'
        ? task.type === 'investment_recommendation_ppt'
          ? '先生成图片高保真版，再继续生成可编辑版'
          : '生成可编辑 PPTX'
        : task.type === 'compliance_statement'
          ? 'generate-investment-compliance-note 生成 Word'
          : task.type === 'investment_proposal'
            ? 'draft-investment-proposal 生成 Word'
          : task.type === 'due_diligence_report'
            ? 'draft-due-diligence-report 生成 Word'
          : '生成 DOCX',
      68,
    )
    const fileName = makeArtifactFileName(
      project.name,
      template,
      Date.now(),
      task.type === 'custom_template_document' ? content.title : undefined,
    )
    const outputPath = path.join(taskDir, fileName)
    const generateCurrentDocx = async (): Promise<Record<string, unknown>> => task.type === 'due_diligence_report'
      ? generateDueDiligenceReportWithSkill({
          outputPath,
          taskDirectory: taskDir,
          project,
          content,
          sources,
          sourceCutoffDate,
          diligenceScope: parameters.diligenceScope,
          sectionTitles: template.sections,
        })
      : generateBusinessDocx({
          outputPath,
          template,
          project,
          content,
          sourceCutoffDate,
          sources,
          blueprint: complianceBlueprint,
        })
    let imageDeckArtifactVersion: number | undefined
    const publishImageDeck = async (imageDeck: {
      path: string
      slideCount: number
      bytes: number
      sha256: string
      metadata: Record<string, unknown>
    }) => {
      if (task.type !== 'investment_recommendation_ppt') return
      const imageDeckFileName = fileName.replace(/\.pptx$/i, '_图片高保真版.pptx')
      const existingArtifact = await aiTaskRepository.findLatestImageDeck(task.id)
      const imageDeckPath = existingArtifact
        ? path.resolve(existingArtifact.storagePath)
        : path.join(taskDir, imageDeckFileName)
      if (!imageDeckPath.startsWith(`${path.resolve(taskDir)}${path.sep}`)) {
        throw Object.assign(
          new Error('图片高保真版产物路径超出当前任务目录'),
          { code: 'IMAGE_DECK_ARTIFACT_PATH_INVALID' },
        )
      }
      await copyFile(imageDeck.path, imageDeckPath)
      const copiedStat = await stat(imageDeckPath)
      if (!copiedStat.isFile() || copiedStat.size !== imageDeck.bytes) {
        throw Object.assign(
          new Error('图片高保真版复制后文件校验不一致'),
          { code: 'IMAGE_DECK_ARTIFACT_COPY_MISMATCH' },
        )
      }
      const imageDeckMetadata = buildImageDeckArtifactMetadata({
        existingMetadata: existingArtifact?.metadata,
        generationMetadata: imageDeck.metadata,
        skill,
        slideCount: imageDeck.slideCount,
        bytes: copiedStat.size,
        sha256: imageDeck.sha256,
        refreshedAfterResume: Boolean(existingArtifact),
      })
      if (existingArtifact) {
        imageDeckArtifactVersion = existingArtifact.version
        const { createdAt: _createdAt, ...storedArtifact } = existingArtifact
        await aiTaskRepository.upsertImageDeck({
          existingArtifactId: existingArtifact.id,
          artifact: {
            ...storedArtifact,
            storagePath: imageDeckPath,
            qualityStatus: 'passed',
            templateVersion: template.templateVersion,
            metadata: imageDeckMetadata,
          },
          updatedAt: new Date(),
        })
        await updateStage(
          taskId,
          '图片高保真版已重新生成，可重新下载；可编辑版继续生成中',
          78,
        )
        return
      }
      imageDeckArtifactVersion = await aiTaskRepository.countArtifacts({
        userId: task.userId,
        projectId: task.projectId,
        format: 'pptx',
      }) + 1
      await aiTaskRepository.upsertImageDeck({
        artifact: {
          id: randomUUID(),
          taskId: task.id,
          userId: task.userId,
          projectId: task.projectId,
          conversationId: task.conversationId,
          fileName: imageDeckFileName,
          format: 'pptx',
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          version: imageDeckArtifactVersion,
          storagePath: imageDeckPath,
          editableLevel: 'image',
          sourceCutoffDate,
          templateVersion: template.templateVersion,
          qualityStatus: 'passed',
          metadata: imageDeckMetadata,
          archived: false,
        },
        updatedAt: new Date(),
      })
      await updateStage(
        taskId,
        '图片高保真版已完成，可先下载；可编辑版继续生成中',
        78,
      )
    }
    let previewPath: string | undefined
    let previewMetadata: Record<string, unknown> | undefined
    const pptGenerationAudit = pptWorkflow
      ? buildInvestmentRecommendationGenerationAudit({
          workflow: pptWorkflow,
          content,
          sources,
        })
      : undefined
    let generationMetadata: Record<string, unknown> = template.outputFormat === 'pptx'
      ? await (async () => {
        const result = await generateBusinessPptx({
          outputPath,
          template,
          project,
          content,
          sources,
          sourceCutoffDate,
          pageCount: String(parameters.pageCount || '15'),
          resumeFromDirectory: investmentRecommendationResumeDirectory,
          onProgress: ({ stage, progress }) =>
            updateStage(taskId, stage, progress),
          onImageDeckReady: publishImageDeck,
        })
        previewPath = outputPath.replace(/\.pptx$/i, '.preview.png')
        try {
          const generatedPreviewSource = 'previewSourcePath' in result
            ? String(result.previewSourcePath || '')
            : ''
          if (generatedPreviewSource) {
            await copyFile(generatedPreviewSource, previewPath)
            previewMetadata = {
              previewSlide: 1,
              previewSource: 'gorden-generated-cover',
              templateApplied: false,
              inheritedCompanyAssets: 0,
              cjkFont: 'Microsoft YaHei',
            }
          } else {
            previewMetadata = await generateBusinessPptxPreview({
              outputPath: previewPath,
              template,
              project,
              content,
              sourceCutoffDate,
            })
          }
        } catch (error) {
          previewPath = undefined
          console.warn('[aiTask] PPT 预览生成失败，继续交付 PPTX:', (error as Error).message)
        }
        return result
      })()
      : await retryDocumentStep(
          task.type === 'due_diligence_report'
            ? 'draft-due-diligence-report 原生 DOCX Pipeline'
            : 'DOCX Formatter',
          generateCurrentDocx,
        )
    if (await cancelIfRequested(taskId)) return

    await updateStage(taskId, 'Agent 已按当前 Skill 规则完成生成与审阅', 96)
    await updateStage(taskId, '登记文件并生成下载地址', 98)
    const quality = await inspectGeneratedArtifact(
      outputPath,
      template.outputFormat as 'docx' | 'pptx',
      { deliveryIntegrityOnly: true },
    )
    const artifactCount = await aiTaskRepository.countArtifacts({
      userId: task.userId,
      projectId: task.projectId,
      format: template.outputFormat,
    })
    const version = imageDeckArtifactVersion ?? artifactCount + 1
    const artifactId = randomUUID()
    const artifactRecord = {
      id: artifactId,
      taskId: task.id,
      userId: task.userId,
      projectId: task.projectId,
      conversationId: task.conversationId,
      fileName,
      format: template.outputFormat,
      mimeType: template.outputFormat === 'pptx'
        ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      version,
      storagePath: outputPath,
      editableLevel: task.type === 'investment_recommendation_ppt'
        ? 'all'
        : template.editableLevel,
      sourceCutoffDate,
      templateVersion: template.templateVersion,
      qualityStatus: quality.qualityStatus,
      metadata: {
        ...quality.metadata,
        ...generationMetadata,
        ...(task.type === 'investment_recommendation_ppt'
          ? {
              artifactStage: 'editable',
              artifactLabel: '元素级可编辑版',
              editableScope: 'all',
              intermediateDeliverable: false,
              generationContinues: false,
              generationSkill: 'create-reference-driven-editable-ppt',
            }
          : {}),
        projectKnowledgeStudy: projectKnowledgeBrief?.audit,
        acceptanceAuthority: 'agent-and-current-skill',
        acceptanceDecision: 'accepted-on-agent-skill-completion',
        programmaticBusinessAcceptance: false,
        deliveryValidation: 'file-integrity-and-authorization-only',
        evidencePolicy: task.type === 'compliance_statement'
          ? 'project_knowledge_primary_model_network_supplement'
          : [
              'investment_proposal',
              'investment_recommendation_ppt',
              'due_diligence_report',
              'custom_template_document',
            ].includes(task.type)
            ? 'project_knowledge_primary_in_process_discovery_llm_page_verification'
            : 'project_knowledge_primary_in_process_network_supplement',
        ...(complianceModelResearch
          || dueDiligenceModelResearch
          || dueDiligencePageResearch
          || sharedNetworkResearch
          || sharedModelResearch
          || investmentRecommendationGapAgentResearch
          || investmentRecommendationGapPageResearch
          ? {
              projectModelNetworkSupplement:
                complianceModelResearch
                ?? {
                  initial: {
                    agentDiscovery: sharedNetworkResearch,
                    pageVerification: sharedModelResearch,
                  },
                  gapCompletion: {
                    agentDiscovery: dueDiligenceModelResearch
                      ?? investmentRecommendationGapAgentResearch,
                    pageVerification: dueDiligencePageResearch
                      ?? investmentRecommendationGapPageResearch,
                  },
                },
            }
          : {}),
        ...(complianceBlueprint
          ? complianceBlueprintMetadata(complianceBlueprint)
          : {}),
        ...(complianceWorkflow
          ? {
              generationMode: complianceWorkflow.generationMode,
              chapterEvidence: complianceWorkflow.evidencePackets.map((packet) => ({
                sectionTitle: packet.sectionTitle,
                sourceIndexes: packet.sourceIndexes,
                evidenceItemCount: packet.items.length,
              })),
            }
          : {}),
        ...(content.generationAudit
          ? {
              contentGenerationAudit: content.generationAudit,
              limitedDraft: content.generationAudit.limitedDraft ?? false,
              limitationCount: content.generationAudit.limitationCount ?? 0,
              limitationIssueCodes: content.generationAudit.limitationIssueCodes ?? [],
            }
          : {}),
        ...(pptWorkflow
          ? {
              pptWorkflow: {
                sourceMode: pptWorkflow.sourceMode,
                templateUsage: 'disabled',
                skills: pptWorkflow.skills,
              },
              gordenGenerationAudit: pptGenerationAudit,
            }
          : {}),
        referenceTemplate: task.type === 'investment_recommendation_ppt'
          ? ''
          : task.type === 'due_diligence_report'
            ? '尽调报告模板语料库'
            : path.basename(template.referencePath),
        referenceTemplates: task.type === 'investment_recommendation_ppt'
          ? []
          : (template.referencePaths?.length
              ? template.referencePaths
              : [template.referencePath]).map((referencePath) => path.basename(referencePath)),
        templateReferenceMode: task.type === 'investment_recommendation_ppt'
          ? 'create-reference-driven-editable-ppt'
          : task.type === 'due_diligence_report' ? 'corpus' : 'single',
        skillName: skill.name,
        skillVersion: skill.version,
        skillSha256: skill.sha256,
        ...(resolvedCustomTemplate
          ? {
              customTemplateId: resolvedCustomTemplate.row.id,
              customTemplateName: resolvedCustomTemplate.row.originalFileName,
              customTemplateSha256: resolvedCustomTemplate.row.sha256,
              customTemplateAnalysis: resolvedCustomTemplate.row.analysis,
            }
          : {}),
        rejectedEvidenceChunks: evidenceScreening.rejected.length,
      },
      archived: false,
    }
    const completionArtifacts: CreateAiArtifactRecord[] = [artifactRecord]
    if (previewPath && previewMetadata) {
      const previewStat = await stat(previewPath)
      if (previewStat.size < 1000) throw new Error('PPT 预览图为空或不完整')
      completionArtifacts.push({
        id: randomUUID(),
        taskId: task.id,
        userId: task.userId,
        projectId: task.projectId,
        conversationId: task.conversationId,
        fileName: fileName.replace(/\.pptx$/i, '.preview.png'),
        format: 'png',
        mimeType: 'image/png',
        version,
        storagePath: previewPath,
        editableLevel: 'preview-only',
        sourceCutoffDate,
        templateVersion: template.templateVersion,
        qualityStatus: 'passed',
        metadata: {
          bytes: previewStat.size,
          ...previewMetadata,
          referenceTemplate: task.type === 'investment_recommendation_ppt'
            ? ''
            : path.basename(template.referencePath),
          referenceTemplates: task.type === 'investment_recommendation_ppt'
            ? []
            : (template.referencePaths?.length
                ? template.referencePaths
                : [template.referencePath]).map((referencePath) => path.basename(referencePath)),
          skillName: skill.name,
          skillVersion: skill.version,
          skillSha256: skill.sha256,
          ...(pptWorkflow
            ? {
                pptWorkflow: {
                  sourceMode: pptWorkflow.sourceMode,
                  templateUsage: 'disabled',
                  skills: pptWorkflow.skills,
                },
              }
          : {}),
        },
        archived: false,
      })
    }
    const nativeDueDiligenceSourceIndexes = Array.isArray(generationMetadata.usedSourceIndexes)
      ? generationMetadata.usedSourceIndexes
          .map(Number)
          .filter((index) => Number.isInteger(index) && index >= 0 && index < sources.length)
      : []
    const usedSourceIndexes = task.type === 'due_diligence_report'
      ? [...new Set(nativeDueDiligenceSourceIndexes)]
      : task.type === 'investment_proposal'
        ? sources.map((_source, index) => index)
      : usedBusinessSourceIndexes(content, sources.length)
    const sourceRecords = auditableTaskSources(usedSourceIndexes, sources, rawSources).map((source, index) => {
          return {
            id: randomUUID(),
            taskId: task.id,
            artifactId,
            sourceType: source.sourceType,
            sourceId: source.sourceType.startsWith('public_web')
              ? createHash('sha256')
                  .update(source.sourceId || source.sourceName)
                  .digest('hex')
                  .slice(0, 64)
              : source.sourceId ?? null,
            sourceName: source.sourceName,
            locator: source.locator ?? (
              source.sourceType.startsWith('public_web')
                ? `公开网页 ${source.sourceId || source.sourceName}`
                : `知识片段 ${source.chunkIndex ?? index}`
            ),
            verificationStatus: source.sourceType.startsWith('public_web')
              ? '待核验'
              : '资料记载',
          }
        })
    const limitedProposal = task.type === 'investment_proposal'
      && (content.generationAudit?.limitedDraft ?? false)
    const completed = await aiTaskRepository.completeTaskWithArtifacts({
      taskId,
      leaseOwner: AI_TASK_WORKER_OWNER,
      stage: limitedProposal
        ? '受限初稿已生成'
        : task.type === 'investment_proposal'
          ? 'DOCX 已生成'
        : task.type === 'compliance_statement'
          ? 'DOCX 已生成'
          : '生成完成',
      resultSummary: content.executiveSummary,
      completedAt: new Date(),
      artifacts: completionArtifacts,
      sources: sourceRecords,
    })
    if (!completed) {
      await cancelIfRequested(taskId)
      return
    }
    const userRow = await identityRepositories.users.findById(task.userId)
    if (userRow) {
      await writeTaskAudit(
        { uid: userRow.id, name: userRow.name, role: userRow.role },
        '生成业务材料',
        `${template.label}：${project.name}`,
      ).catch((error) => {
        console.warn('[aiTask] 操作审计写入未完成，保留已生成主文档:', (error as Error).message)
      })
    }
  } catch (error) {
    if (await cancelIfRequested(taskId).catch(() => false)) return
    const errorId = `AI-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8)}`
    const internalMessage = (error as Error).message
    const diagnosticError = error as {
      code?: unknown
      upstreamCode?: unknown
      status?: unknown
      gatewayRequestId?: unknown
      responseBytes?: unknown
      requestAttempt?: unknown
      requestDurationMs?: unknown
      slideNumber?: unknown
      layer?: unknown
    }
    const context = await aiTaskRepository.findTaskById(taskId).catch(() => null)
    console.error(
      `[${errorId}] AI 任务失败 task=${taskId} user=${context?.userId ?? 'unknown'} project=${context?.projectId ?? 'unknown'} type=${context?.type ?? 'unknown'} stage=${context?.stage ?? 'unknown'}:`,
      internalMessage,
      {
        code: diagnosticError.code,
        upstreamCode: diagnosticError.upstreamCode,
        status: diagnosticError.status,
        gatewayRequestId: diagnosticError.gatewayRequestId,
        responseBytes: diagnosticError.responseBytes,
        requestAttempt: diagnosticError.requestAttempt,
        requestDurationMs: diagnosticError.requestDurationMs,
        slideNumber: diagnosticError.slideNumber,
        layer: diagnosticError.layer,
      },
    )
    const recoveryParameters = (context?.parameters ?? {}) as Record<string, unknown>
    const recoveryAttempt = Math.max(
      0,
      Number(recoveryParameters._systemDocumentRecoveryAttempt ?? 0) || 0,
    )
    const failure = classifyAiTaskFailure(error)
    if (
      context
      && isAiExecutableTaskType(context.type)
      && AUTO_RECOVERY_TASK_TYPES.has(context.type)
    ) {
      const existingMainArtifact = await aiTaskRepository.findLatestMainArtifact({
        taskId,
        requireEditableStage: context.type === 'investment_recommendation_ppt',
      }).catch(() => null)
      if (existingMainArtifact) {
        const restored = await aiTaskRepository.markSucceededFromExistingArtifact({
          taskId,
          leaseOwner: AI_TASK_WORKER_OWNER,
          stage: `${existingMainArtifact.format.toUpperCase()} 已生成`,
          completedAt: new Date(),
        }).catch(() => false)
        if (restored) {
          console.warn(`[${errorId}] 主文档已登记，任务状态恢复为已完成 task=${taskId}`)
        } else {
          await cancelIfRequested(taskId).catch(() => false)
        }
        return
      }
    }
    if (
      context
      && isAiExecutableTaskType(context.type)
      && AUTO_RECOVERY_TASK_TYPES.has(context.type)
      && recoveryAttempt < 1
      && failure.retryable
      && failure.errorCode !== 'PROJECT_KNOWLEDGE_COMPLETE_STUDY_FAILED'
    ) {
      const reset = await aiTaskRepository.resetTaskForAutomaticRecovery({
        taskId,
        leaseOwner: AI_TASK_WORKER_OWNER,
        stage: context.type === 'investment_recommendation_ppt'
          ? '正在从 Gorden 检查点继续生成'
          : '正在继续生成文档',
        progress: context.type === 'investment_recommendation_ppt'
          ? Number(context.progress ?? 0)
          : Math.min(Number(context.progress ?? 0), 20),
        parameters: {
          ...recoveryParameters,
          _systemDocumentRecoveryAttempt: recoveryAttempt + 1,
          ...(context.type === 'investment_recommendation_ppt'
            ? { _resumeProgressFloor: Number(context.progress ?? 0) }
            : {}),
        },
        updatedAt: new Date(),
      }).catch(() => false)
      if (reset) {
        rescheduleAfterRecovery = true
        console.warn(`[${errorId}] 主文档尚未完成，系统自动继续生成 task=${taskId}`)
        return
      }
    }
    await aiTaskRepository.markTaskFailed({
      taskId,
      leaseOwner: AI_TASK_WORKER_OWNER,
      stage: safeAiTaskFailureStage(error),
      errorId,
      errorCode: failure.errorCode,
      errorMessage: safeAiTaskFailureMessage(error),
      retryable: failure.retryable,
      completedAt: new Date(),
    }).catch(() => {})
  } finally {
    if (leaseHeartbeat) clearInterval(leaseHeartbeat)
    await aiTaskRepository.releaseTaskLease({
      taskId,
      leaseOwner: AI_TASK_WORKER_OWNER,
      updatedAt: new Date(),
    }).catch(() => {})
    running.delete(taskId)
    if (rescheduleAfterRecovery && !aiTaskWorkerStopping) scheduleTask(taskId)
  }
}

function scheduleTask(taskId: string) {
  if (aiTaskWorkerStopping) return
  setImmediate(() => { void executeTask(taskId) })
}

export async function validateAiTaskCoreReferences(
  user: AiTaskUser,
  input: {
    projectId: string
    conversationId?: string
    parameters?: Record<string, unknown>
  },
) {
  const userRecord = await identityRepositories.users.findById(user.uid)
  if (!userRecord || userRecord.status !== '启用') {
    throw Object.assign(new Error('用户不存在或已禁用'), {
      status: 403,
      code: 'USER_DISABLED_OR_MISSING',
    })
  }
  const stableUser = { uid: userRecord.id, name: userRecord.name, role: userRecord.role }
  const access = await userCanAccessProject(stableUser, input.projectId)
  if (!access.allowed || !access.project) {
    throw Object.assign(new Error(access.reason), {
      status: 403,
      code: 'PROJECT_FORBIDDEN',
    })
  }
  if (input.conversationId) {
    const conversation = await agentConversationRepository.findChatByIdForUser(stableUser.uid, input.conversationId)
    if (!conversation) {
      throw Object.assign(new Error('会话不存在或不属于当前用户'), {
        status: 404,
        code: 'CONVERSATION_NOT_FOUND',
      })
    }
    if (conversation.projectId !== input.projectId) {
      throw Object.assign(new Error('会话所属项目与任务项目不一致'), {
        status: 409,
        code: 'CONVERSATION_PROJECT_MISMATCH',
      })
    }
  }
  const parameters = { ...(input.parameters ?? {}) }
  if (Object.prototype.hasOwnProperty.call(parameters, 'attachmentFileIds')) {
    if (!Array.isArray(parameters.attachmentFileIds) || parameters.attachmentFileIds.length > 10) {
      throw Object.assign(new Error('任务附件引用必须是最多 10 个文件 ID'), {
        status: 400,
        code: 'INVALID_TASK_ATTACHMENT_REFERENCES',
      })
    }
    const rawFileIds = parameters.attachmentFileIds
    if (rawFileIds.some((value) => (
      typeof value !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ))) {
      throw Object.assign(new Error('任务附件包含无效文件 ID'), {
        status: 400,
        code: 'INVALID_TASK_ATTACHMENT_REFERENCES',
      })
    }
    const fileIds = [...new Set(rawFileIds as string[])]
    if (fileIds.length) {
      const rows = await db.select({
        id: projectFiles.id,
        name: projectFiles.name,
        parseStatus: projectFiles.parseStatus,
        parseError: projectFiles.parseError,
      }).from(projectFiles).where(and(
        eq(projectFiles.projectId, input.projectId),
        inArray(projectFiles.id, fileIds),
      ))
      if (rows.length !== fileIds.length) {
        throw Object.assign(new Error('任务附件不存在或不属于当前项目'), {
          status: 404,
          code: 'TASK_ATTACHMENT_NOT_FOUND',
        })
      }
      const failed = rows.filter((row) => row.parseStatus === '失败')
      if (failed.length) {
        throw Object.assign(new Error(`任务附件解析失败：${failed.map((row) => row.name).join('、')}`), {
          status: 409,
          code: 'TASK_ATTACHMENT_PARSE_FAILED',
        })
      }
    }
    parameters.attachmentFileIds = fileIds
  }
  return { project: access.project, user: stableUser, parameters }
}

export async function assertRegisteredAiTaskTemplate(template: AiTemplateDefinition) {
  const registered = await aiTaskRepository.isTaskTemplateRegistered({
    type: template.type,
    templateVersion: template.templateVersion,
    skillName: template.skillName,
    outputFormat: template.outputFormat,
  })
  if (!registered) {
    throw Object.assign(new Error('AI 任务模板未在 MySQL 注册或版本不一致'), {
      status: 503,
      code: 'AI_TEMPLATE_REGISTRY_MISMATCH',
    })
  }
  return { type: template.type }
}

export async function createInvestmentPptPreparationTask(
  user: AiTaskUser,
  input: CreateInvestmentPptPreparationInput,
) {
  const references = await validateAiTaskCoreReferences(
    user,
    { projectId: input.projectId, conversationId: input.conversationId },
  )
  user = references.user
  const project = references.project
  await assertRegisteredAiTaskTemplate(AI_TEMPLATE_CATALOG.investment_recommendation_ppt)
  const parameters: Record<string, unknown> = {
    sourceCutoffDate: input.sourceCutoffDate,
    outputFormat: input.outputFormat,
    language: input.language,
    structureMode: input.structureMode,
    customTemplateName: input.fileName,
    clientPreparationId: input.progressId,
    clientTimelineStartedAt: input.startedAt,
    _templatePreparationPending: true,
    ...(input.userInstructions?.trim()
      ? {
          userInstructions: input.userInstructions.trim().slice(0, 2_000),
          researchIntent: input.userInstructions.trim().slice(0, 2_000),
          conversationTriggered: input.userInstructions.includes('本次会话生成要求：'),
          requestedSkill: 'GordenSuperPPTSkill',
        }
      : {}),
  }
  const requestIdentity: CreateAiTaskInput = {
    type: 'investment_recommendation_ppt',
    projectId: input.projectId,
    conversationId: input.conversationId,
    parameters,
    idempotencyKey: input.idempotencyKey,
  }
  const hash = createRequestHash(requestIdentity)
  const existing = await findIdempotentAiTask(user.uid, requestIdentity)
  if (existing) {
    return getAiTask(user.uid, existing.id)
  }
  try {
    const now = new Date()
    const startedAt = new Date(input.startedAt)
    const task = await aiTaskRepository.createTask({
      userId: user.uid,
      projectId: input.projectId,
      conversationId: input.conversationId,
      type: 'investment_recommendation_ppt',
      parameters,
      templateVersion: '模板上传与预检',
      status: 'running',
      stage: '正在读取并上传模板',
      progress: 1,
      startedAt,
      idempotencyKey: input.idempotencyKey,
      requestHash: hash,
      updatedAt: now,
    })
    await writeTaskAudit(user, '创建 AI 任务', `投资建议书（PPT）模板准备：${project.name}`)
    return getAiTask(user.uid, task.id)
  } catch (error) {
    if (['ER_DUP_ENTRY', 'CONFLICT'].includes(String((error as { code?: string }).code))) {
      const raceWinner = await findIdempotentAiTask(user.uid, requestIdentity)
      if (raceWinner) return getAiTask(user.uid, raceWinner.id)
    }
    throw error
  }
}

export async function updateInvestmentPptPreparationTask(
  userId: string,
  taskId: string,
  update: { stage: string; progress: number },
  expected?: {
    projectId: string
    conversationId?: string
    progressId: string
  },
) {
  const task = await getTaskRow(userId, taskId)
  if (!task) return undefined
  const parameters = task.parameters as Record<string, unknown>
  if (expected && (
    task.projectId !== expected.projectId
    || task.conversationId !== (expected.conversationId ?? null)
    || parameters.clientPreparationId !== expected.progressId
    || task.type !== 'investment_recommendation_ppt'
    || !isTemplatePreparationPending(parameters)
  )) {
    throw Object.assign(new Error('模板分析请求与投资建议书任务不匹配'), {
      status: 409,
      code: 'TEMPLATE_TASK_MISMATCH',
    })
  }
  if (
    task.type !== 'investment_recommendation_ppt'
    || !isTemplatePreparationPending(parameters)
    || task.status !== 'running'
  ) return getAiTask(userId, taskId)
  await aiTaskRepository.updatePreparationProgress({
    taskId,
    userId,
    stage: update.stage.slice(0, 64),
    progress: Math.max(1, Math.min(10, Math.ceil(update.progress / 10))),
    updatedAt: new Date(),
  })
  return getAiTask(userId, taskId)
}

export async function failInvestmentPptPreparationTask(
  userId: string,
  taskId: string,
  errorMessage: string,
) {
  const task = await getTaskRow(userId, taskId)
  if (!task) return undefined
  const parameters = task.parameters as Record<string, unknown>
  if (
    task.type !== 'investment_recommendation_ppt'
    || !isTemplatePreparationPending(parameters)
    || ['succeeded', 'failed', 'cancelled'].includes(task.status)
  ) return getAiTask(userId, taskId)
  const now = new Date()
  await aiTaskRepository.failPreparation({
    taskId,
    userId,
    progress: Math.max(1, Math.min(10, task.progress || 1)),
    errorMessage: errorMessage.trim().slice(0, 2000) || '模板分析失败',
    completedAt: now,
  })
  return getAiTask(userId, taskId)
}

export async function startInvestmentPptTaskAfterPreparation(
  user: AiTaskUser,
  taskId: string,
  templateInput: { id: string; originalFileName: string },
) {
  const task = await getTaskRow(user.uid, taskId)
  if (!task) {
    throw Object.assign(new Error('投资建议书任务不存在'), {
      status: 404,
      code: 'TASK_NOT_FOUND',
    })
  }
  const currentParameters = task.parameters as Record<string, unknown>
  if (
    task.type !== 'investment_recommendation_ppt'
    || !isTemplatePreparationPending(currentParameters)
  ) return getAiTask(user.uid, taskId)
  if (task.cancellationRequested || task.status === 'cancelled') {
    await aiTaskRepository.cancelOwnedPreparation({
      taskId,
      userId: user.uid,
      completedAt: new Date(),
    })
    return getAiTask(user.uid, taskId)
  }
  const parameters: Record<string, unknown> = {
    ...currentParameters,
    customTemplateId: templateInput.id,
    customTemplateName: templateInput.originalFileName,
    _templatePreparationPending: false,
  }
  const resolved = await resolveAiCustomTemplateForTask({
    userId: user.uid,
    projectId: task.projectId,
    conversationId: task.conversationId ?? undefined,
    templateId: templateInput.id,
    taskType: 'investment_recommendation_ppt',
  })
  const expectedOutputFormat = resolved.template.outputFormat.toUpperCase()
  if (parameters.outputFormat !== expectedOutputFormat) {
    throw Object.assign(new Error(`上传模板输出格式应为 ${expectedOutputFormat}`), {
      status: 409,
      code: 'CUSTOM_TEMPLATE_FORMAT_MISMATCH',
    })
  }
  await prepareInvestmentRecommendationPptWorkflow(resolved.template)
  const now = new Date()
  await aiTaskRepository.finishPreparation({
    taskId,
    userId: user.uid,
    parameters,
    templateVersion: resolved.template.templateVersion,
    updatedAt: now,
  })
  await writeTaskAudit(user, '完成 AI 任务模板准备', taskId)
  scheduleTask(taskId)
  return getAiTask(user.uid, taskId)
}

export async function createAiTask(user: AiTaskUser, input: CreateAiTaskInput) {
  const references = await validateAiTaskCoreReferences(
    user,
    { projectId: input.projectId, conversationId: input.conversationId, parameters: input.parameters },
  )
  user = references.user
  input = { ...input, parameters: references.parameters }
  const project = references.project
  const resolvedCustomTemplate = (
    input.type === 'custom_template_document'
  )
    ? await resolveAiCustomTemplateForTask({
        userId: user.uid,
        projectId: input.projectId,
        conversationId: input.conversationId,
        templateId: String(input.parameters.customTemplateId || ''),
        taskType: input.type,
      })
    : undefined
  const template = resolvedCustomTemplate?.template ?? AI_TEMPLATE_CATALOG[input.type as AiBusinessTaskType]
  if (!template) throw Object.assign(new Error('AI 任务模板不存在'), { status: 400, code: 'INVALID_TASK_TYPE' })
  if (resolvedCustomTemplate) {
    const expectedOutputFormat = template.outputFormat.toUpperCase()
    if (input.parameters.outputFormat !== expectedOutputFormat) {
      throw Object.assign(new Error(`上传模板输出格式应为 ${expectedOutputFormat}`), {
        status: 409,
        code: 'CUSTOM_TEMPLATE_FORMAT_MISMATCH',
      })
    }
  } else {
    await assertRegisteredAiTaskTemplate(template)
    if (
      input.type !== 'investment_recommendation_ppt'
      && !usesDirectQaOrDueDiligenceAgent(input.type)
    ) {
      assertAiTemplateReferences(template)
    }
    await loadAiSkill(AI_TEMPLATE_CATALOG[input.type as AiBusinessTaskType].skillName)
  }
  if (input.type === 'investment_recommendation_ppt') {
    await prepareInvestmentRecommendationPptWorkflow(template)
  }
  const hash = createRequestHash(input)
  const existing = await findIdempotentAiTask(user.uid, input)
  if (existing) {
    return getAiTask(user.uid, existing.id)
  }
  try {
    const resumeProgressFloor = Math.max(
      0,
      Math.min(99, Number(input.parameters._resumeProgressFloor ?? 0) || 0),
    )
    const task = await aiTaskRepository.createTask({
      userId: user.uid,
      projectId: input.projectId,
      conversationId: input.conversationId,
      type: input.type,
      parameters: input.parameters,
      templateVersion: template.templateVersion,
      idempotencyKey: input.idempotencyKey,
      requestHash: hash,
      retryOfTaskId: input.retryOfTaskId,
      ...(resumeProgressFloor > 0
        ? {
            stage: '等待断点续跑',
            progress: resumeProgressFloor,
          }
        : {}),
    })
    await writeTaskAudit(user, '创建 AI 任务', `${template.label}：${project.name}`)
    scheduleTask(task.id)
    return getAiTask(user.uid, task.id)
  } catch (error) {
    if (['ER_DUP_ENTRY', 'CONFLICT'].includes(String((error as { code?: string }).code))) {
      const raceWinner = await findIdempotentAiTask(user.uid, input)
      if (raceWinner) return getAiTask(user.uid, raceWinner.id)
    }
    throw error
  }
}

export async function getAiTask(userId: string, taskId: string) {
  let task = await getTaskRow(userId, taskId)
  if (!task) return undefined
  const artifacts = await aiTaskRepository.listTaskArtifacts(task.id)
  if (task.type === 'investment_recommendation_ppt' && task.status === 'succeeded') {
    const hasImageDeck = artifacts.some((artifact) => (
      artifact.qualityStatus === 'passed'
      && (artifact.metadata?.artifactStage === 'image-deck' || artifact.editableLevel === 'image')
    ))
    const hasEditableDeck = artifacts.some((artifact) => (
      artifact.format === 'pptx'
      && artifact.qualityStatus === 'passed'
      && artifact.editableLevel !== 'image'
      && (
        artifact.metadata?.artifactStage === 'editable'
        || ['all', 'text-and-structure'].includes(artifact.editableLevel)
      )
    ))
    // 兼容修复旧任务：图片版属于中间交付物，不能单独把整项任务标记为成功。
    if (hasImageDeck && !hasEditableDeck) {
      await aiTaskRepository.markEditableArtifactMissing(task.id, new Date())
      task = await getTaskRow(userId, task.id) ?? task
    }
  }
  const sources = await aiTaskRepository.listTaskSources(task.id)
  const passedArtifacts = artifacts.filter((artifact) => artifact.qualityStatus === 'passed')
  const deliverables = task.type === 'investment_proposal'
    ? passedArtifacts.filter((artifact) => artifact.format === 'docx')
    : passedArtifacts
  const deliverableIds = new Set(deliverables.map((artifact) => artifact.id))
  return {
    ...task,
    usage: task.modelCalls > 0 ? {
      modelCalls: task.modelCalls,
      usageCalls: task.usageCalls,
      inputTokens: task.inputTokens,
      outputTokens: task.outputTokens,
      cacheCreationInputTokens: task.cacheCreationInputTokens,
      cacheReadInputTokens: task.cacheReadInputTokens,
      reasoningTokens: task.reasoningTokens,
      totalTokens: task.totalTokens,
      complete: task.usageCalls === task.modelCalls,
    } : null,
    artifacts: deliverables.map(publicArtifact),
    sources: sources.filter((source) => !source.artifactId || deliverableIds.has(source.artifactId)),
  }
}

export async function listAiTasks(userId: string, options: { projectId?: string; conversationId?: string; limit?: number } = {}) {
  const rows = await aiTaskRepository.listOwnedTasks({ userId, ...options })
  return Promise.all(rows.map((row) => getAiTask(userId, row.id)))
}

export async function cancelAiTask(user: AiTaskUser, taskId: string) {
  const task = await getTaskRow(user.uid, taskId)
  if (!task) return undefined
  if (['succeeded', 'failed', 'cancelled'].includes(task.status)) return getAiTask(user.uid, taskId)
  const templatePreparation = isTemplatePreparationPending(
    task.parameters as Record<string, unknown>,
  )
  const cancelImmediately = task.status === 'pending' || templatePreparation
  const cancelled = await aiTaskRepository.requestCancellation({
    taskId,
    userId: user.uid,
    cancelImmediately,
    updatedAt: new Date(),
  })
  if (cancelled) await writeTaskAudit(user, '取消 AI 任务', taskId)
  return getAiTask(user.uid, taskId)
}

export async function retryAiTask(user: AiTaskUser, taskId: string, idempotencyKey: string) {
  const task = await getTaskRow(user.uid, taskId)
  if (!task) return undefined
  if (!isAiExecutableTaskType(task.type)) throw new Error('不支持重试的任务类型')
  if (task.status !== 'failed') {
    throw Object.assign(new Error('只有失败任务可以重试'), { status: 409, code: 'TASK_NOT_RETRYABLE' })
  }
  if (task.retryable === false) {
    throw Object.assign(new Error('该错误不可直接重试，请修正资料、模板或参数后重新创建任务'), {
      status: 409,
      code: 'TASK_ERROR_NOT_RETRYABLE',
    })
  }
  if (isTemplatePreparationPending(task.parameters as Record<string, unknown>)) {
    throw Object.assign(new Error('模板分析尚未完成，请重新上传模板'), {
      status: 409,
      code: 'TEMPLATE_REUPLOAD_REQUIRED',
    })
  }
  const retryParameters: Record<string, unknown> = {
    ...(task.parameters as Record<string, unknown>),
    _resumeProgressFloor: Math.max(0, Math.min(99, Number(task.progress ?? 0))),
  }
  // 手动“继续生成”是一轮新的恢复流程，不能继承上一任务已经耗尽的自动恢复次数。
  delete retryParameters._systemDocumentRecoveryAttempt
  return createAiTask(user, {
    type: task.type,
    projectId: task.projectId,
    conversationId: task.conversationId ?? undefined,
    parameters: retryParameters,
    idempotencyKey,
    retryOfTaskId: task.id,
  })
}

export async function listAiArtifacts(userId: string, projectId?: string) {
  const rows = await aiTaskRepository.listOwnedArtifacts({ userId, projectId, limit: 100 })
  return rows
    .filter(({ artifact, taskType }) =>
      taskType !== 'investment_proposal' || artifact.format === 'docx')
    .map(({ artifact }) => publicArtifact(artifact))
}

export async function deleteAiArtifact(userId: string, artifactId: string) {
  return aiTaskRepository.archiveOwnedArtifact({ userId, artifactId })
}

export async function getArtifactDownload(userId: string, artifactId: string) {
  const row = await aiTaskRepository.findOwnedArtifactWithTaskType({ userId, artifactId })
  const artifact = row?.artifact
  if (!artifact || artifact.qualityStatus !== 'passed') return undefined
  if (row.taskType === 'investment_proposal' && artifact.format !== 'docx') return undefined
  const file = await authorizedArtifactPath(artifact.storagePath)
  if (!file) return undefined
  return { artifact, stream: createReadStream(file.resolved), size: file.size }
}

export async function getArtifactPreview(userId: string, artifactId: string) {
  const artifact = await aiTaskRepository.findOwnedArtifact(userId, artifactId)
  if (!artifact || artifact.qualityStatus !== 'passed' || artifact.format !== 'md') return undefined
  const file = await authorizedArtifactPath(artifact.storagePath)
  if (!file || file.size > 2 * 1024 * 1024) return undefined
  return { artifact, content: await readFile(file.resolved, 'utf8') }
}

export async function recoverAiTasks(options: { schedule?: boolean; taskIds?: string[] } = {}) {
  aiTaskWorkerStopping = false
  const shouldSchedule = options.schedule !== false
  if (options.taskIds && options.taskIds.length === 0) {
    return { found: 0, recovered: 0, templateFailed: 0, cancelled: 0 }
  }
  const staleWithoutLeaseBefore = new Date(Date.now() - AI_TASK_LEASE_SECONDS * 1_000)
  const recoverable = await aiTaskRepository.listRecoverableTasks({
    taskIds: options.taskIds,
    staleWithoutLeaseBefore,
    limit: 100,
  })
  let recovered = 0
  let templateFailed = 0
  let cancelled = 0
  for (const task of recoverable) {
    if (task.cancellationRequested) {
      const updated = await aiTaskRepository.markRecoverableCancelled({
        taskId: task.id,
        previousStatus: task.status,
        completedAt: new Date(),
      })
      if (updated) cancelled += 1
      continue
    }
    if (isTemplatePreparationPending(task.parameters)) {
      const updated = await aiTaskRepository.markRecoverableTemplateFailed({
        taskId: task.id,
        previousStatus: task.status,
        completedAt: new Date(),
      })
      if (updated) templateFailed += 1
      continue
    }
    if (task.status === 'running') {
      const updated = await aiTaskRepository.resetExpiredRunningTask({
        taskId: task.id,
        staleWithoutLeaseBefore,
        updatedAt: new Date(),
      })
      if (!updated) continue
    }
    if (shouldSchedule) scheduleTask(task.id)
    recovered += 1
  }
  return { found: recoverable.length, recovered, templateFailed, cancelled }
}

export async function aiTaskWorkerHealth() {
  try {
    const row = await aiTaskRepository.taskWorkerHealth()
    return {
      name: 'mysql-ai-tasks',
      ok: true,
      inProcess: true,
      stopping: aiTaskWorkerStopping,
      owner: AI_TASK_WORKER_OWNER,
      pending: row.pending,
      running: row.running,
      failed: row.failed,
      liveLeases: row.liveLeases,
      expiredLeases: row.expiredLeases,
      active: running.size,
    }
  } catch (error) {
    return {
      name: 'mysql-ai-tasks', ok: false, inProcess: true, owner: AI_TASK_WORKER_OWNER,
      error: (error as Error).message.slice(0, 1_000),
    }
  }
}

export async function stopAiTaskWorker() {
  aiTaskWorkerStopping = true
  const activeTaskIds = [...running]
  const stopped = await aiTaskRepository.stopOwnedRunningTasks({
    leaseOwner: AI_TASK_WORKER_OWNER,
    updatedAt: new Date(),
  })
  return {
    active: activeTaskIds.length,
    releasedLeases: stopped.released + stopped.cancelled,
    cancelled: stopped.cancelled,
  }
}
